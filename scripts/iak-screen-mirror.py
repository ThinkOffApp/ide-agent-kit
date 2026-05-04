#!/usr/bin/env python3
"""
IAK screen-mirror daemon — bridges Electron IDE permission popups
(Claude.app / Codex.app / Antigravity.app / Cursor.app) to CodeWatch
without needing Anthropic / OpenAI / Google to expose any API.

How it works:

1. Polls each IDE app every POLL_SEC seconds.
2. For each, asks osascript for the window bounds, then screencaptures
   that window region.
3. Runs Apple Vision OCR (via the `vision` Swift one-liner if available,
   else tesseract fallback) on the captured PNG.
4. If OCR finds permission-popup keywords ("Allow", "Deny", "approve",
   "Run this command", etc.) AND we haven't seen this exact prompt
   recently, fires an IAK intent on the local daemon with the OCR'd text.
5. Watches the daemon for the intent's decision.
6. On Approve/Deny, uses cliclick to click the corresponding button at a
   coordinate computed from the captured region (button positions are
   known per IDE — for prototype, hardcoded for Claude.app).

This is a HACKY but real workaround for the Electron-blocks-AX problem.
RPA tools have done this for years — e.g., to script Cloudflare-protected
sites or closed proprietary apps.

Requires:
- macOS Screen Recording permission for the launching binary (Terminal /
  iTerm / your shell). Grant in System Settings → Privacy & Security →
  Screen Recording.
- macOS Accessibility permission for `cliclick` (so it can synthesize
  mouse clicks). Grant in System Settings → Privacy & Security →
  Accessibility.
- `cliclick` installed: `brew install cliclick`
- `tesseract` installed (optional fallback if Apple Vision unavailable):
  `brew install tesseract`
- Python 3.9+

Run via launchd or directly:
    /Users/petrus/.openclaw/iak-screen-mirror.py

Logs to /tmp/iak-screen-mirror.log

Author: claudeMB 2026-05-04 — proof-of-concept screen-capture mirror
for petrus's "real existing IDE confirmations in CodeWatch" requirement.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass

# ─────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────

DAEMON_URL = os.environ.get("IAK_DAEMON_URL", "http://localhost:8788")
POLL_SEC = float(os.environ.get("IAK_MIRROR_POLL_SEC", "2.0"))
LOG_PATH = os.environ.get("IAK_MIRROR_LOG", "/tmp/iak-screen-mirror.log")
DEDUP_WINDOW_SEC = 300.0  # 5 min — don't re-fire same prompt within this window

# Per-IDE config: how to identify the app, what keywords mean a popup,
# and where Approve/Deny buttons are roughly located within the popup.
# For prototype we focus on Claude.app — others can be added once the
# detection heuristics are tuned for them.
@dataclass
class IdeConfig:
    process_name: str       # macOS process name, e.g. "Claude"
    from_handle: str        # @handle to attribute the intent under
    popup_keywords: list[str]  # OCR text fragments that indicate a popup
    # Button positions within the popup region (relative offsets, computed
    # from OCR layout in v2). For prototype we'll just locate by OCR'ing
    # button labels and clicking their bounding box.
    approve_labels: list[str]  # button text variants for "approve"
    deny_labels: list[str]     # button text variants for "deny"


IDES = [
    IdeConfig(
        process_name="Claude",
        from_handle="@claudeMB",
        popup_keywords=[
            # Claude Code permission popup wording (verify on first capture)
            "Allow this command",
            "Run this command",
            "Allow once",
            "Always allow",
            "Don't allow",
            "Permission to",
        ],
        approve_labels=["Allow", "Allow once", "Always allow", "Run", "Yes"],
        deny_labels=["Don't allow", "Deny", "Cancel", "No"],
    ),
    IdeConfig(
        process_name="Codex",
        from_handle="@CodexMB",
        popup_keywords=[
            "Approve",
            "Deny",
            "Codex wants to",
        ],
        approve_labels=["Approve", "Allow", "Yes"],
        deny_labels=["Deny", "Cancel", "Don't allow", "No"],
    ),
    # Antigravity / Cursor TBD once we capture their popup styles
]


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    line = f"[{time.strftime('%FT%TZ', time.gmtime())}] {msg}\n"
    sys.stdout.write(line)
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line)
    except Exception:
        pass


_osascript_blocked = False  # set true after timeout/permission denial

def osascript(script: str) -> str:
    global _osascript_blocked
    if _osascript_blocked:
        return ""
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=3,
        )
        if "not allowed assistive access" in (r.stderr or ""):
            _osascript_blocked = True
            log("osascript blocked: System Events accessibility denied. "
                "Falling back to full-screen capture for all IDEs.")
            return ""
        return (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        _osascript_blocked = True
        log("osascript blocked: query timed out (likely Accessibility "
            "permission needed for python3 / com.apple.python3). "
            "Falling back to full-screen capture for all IDEs.")
        return ""
    except Exception as e:
        log(f"osascript error: {e}")
        return ""


def get_window_bounds(process_name: str) -> tuple[int, int, int, int] | None:
    """Return (x, y, w, h) in screen coords for the front window of the
    given process, or None if app isn't running / has no visible window."""
    out = osascript(
        f'''tell application "System Events"
              if exists process "{process_name}" then
                tell process "{process_name}"
                  if exists window 1 then
                    set p to position of window 1
                    set s to size of window 1
                    return (item 1 of p) & "," & (item 2 of p) & "," & ¬
                           (item 1 of s) & "," & (item 2 of s)
                  end if
                end tell
              end if
            end tell'''
    )
    if not out:
        return None
    try:
        parts = [int(p.strip()) for p in out.split(",")]
        if len(parts) != 4:
            return None
        x, y, w, h = parts
        return (x, y, w, h)
    except Exception:
        return None


_screencap_logged = False

def screencapture_region(x: int, y: int, w: int, h: int, dest: str) -> bool:
    """Capture screen region to dest PNG. Returns True on success.
    Requires Screen Recording permission for the parent process.

    If w or h are >= 9999 we treat it as 'whole screen' and skip -R
    (screencapture rejects oversize rects with "could not create
    image from rect")."""
    global _screencap_logged
    try:
        if w >= 9999 or h >= 9999:
            cmd = ["screencapture", "-x", dest]
        else:
            cmd = ["screencapture", "-x", "-R", f"{x},{y},{w},{h}", dest]
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=5,
        )
        # Treat any "could not create image" stderr as failure even if a
        # stale destination file exists from a prior test run. Otherwise
        # we'll OCR the stale PNG and false-positive permission keywords.
        if r.returncode != 0 or "could not create image" in (r.stderr or ""):
            ok = False
        else:
            ok = os.path.exists(dest) and os.path.getsize(dest) > 1024
        if not _screencap_logged:
            # Log diagnostic on first call so we see whether Screen
            # Recording permission is granted or capture is failing.
            log(f"first screencapture diagnostic: rc={r.returncode} "
                f"stderr={r.stderr[:120]!r} dest={dest} "
                f"exists={os.path.exists(dest)} "
                f"size={os.path.getsize(dest) if os.path.exists(dest) else 'N/A'}")
            _screencap_logged = True
        return ok
    except Exception as e:
        log(f"screencapture error: {e}")
        return False


def ocr_image(png_path: str) -> str:
    """OCR an image. Try Apple Vision (fast, accurate) first, fall back
    to tesseract. Returns extracted text or "" on failure."""
    # Apple Vision via the `swift` script — only if user has compiled
    # the helper. For prototype, just use tesseract.
    if shutil.which("tesseract"):
        try:
            r = subprocess.run(
                ["tesseract", png_path, "-", "--psm", "6"],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout or ""
        except Exception as e:
            log(f"tesseract error: {e}")
    return ""


def detect_popup_keywords(ocr_text: str, ide: IdeConfig) -> bool:
    low = ocr_text.lower()
    for kw in ide.popup_keywords:
        if kw.lower() in low:
            return True
    return False


def clean_prompt_text(ocr_text: str, ide: IdeConfig) -> str:
    """Pull the user-facing prompt text out of the OCR mess. Strip button
    labels and excess whitespace."""
    txt = ocr_text.strip()
    for lbl in ide.approve_labels + ide.deny_labels:
        txt = re.sub(rf"\b{re.escape(lbl)}\b", "", txt, flags=re.IGNORECASE)
    txt = re.sub(r"\s+", " ", txt).strip()
    if len(txt) > 800:
        txt = txt[:797] + "..."
    return txt or "(could not extract popup text)"


def fingerprint(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:12]


def post_intent(prompt: str, ide: IdeConfig) -> str | None:
    """POST a confirmation intent to the IAK daemon. Returns intent id
    or None on failure."""
    payload = {
        "prompt": f"[Mirror of {ide.process_name} popup]\n\n{prompt}\n\n"
                  f"[ON APPROVE] click Approve in the actual {ide.process_name} popup\n"
                  f"[ON DENY] click Deny in the actual {ide.process_name} popup",
        "session": f"screen-mirror-{ide.process_name.lower()}",
        "channels": ["groupmind"],
        "from_handle": ide.from_handle,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{DAEMON_URL}/intent",
        data=body, method="POST",
    )
    req.add_header("Content-Type", "application/json")
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return data.get("id")
    except Exception as e:
        log(f"post_intent error: {e}")
        return None


def get_intent_status(intent_id: str) -> dict | None:
    """Poll the daemon for an intent's status."""
    try:
        resp = urllib.request.urlopen(
            f"{DAEMON_URL}/intents", timeout=5,
        )
        data = json.loads(resp.read())
        for i in data:
            if i.get("id") == intent_id:
                return i
        return None
    except Exception as e:
        log(f"get_intent_status error: {e}")
        return None


def click_button_by_label(window_x: int, window_y: int,
                          png_path: str, label: str) -> bool:
    """Find `label` text in the captured PNG via OCR, compute its
    absolute screen coordinates, and click via cliclick. Returns
    True on success.

    Prototype: uses tesseract HOCR to get bounding boxes. For Apple
    Vision we'd swap in a Swift helper.
    """
    if not shutil.which("cliclick"):
        log("cliclick not installed — skipping click-back")
        return False
    if not shutil.which("tesseract"):
        log("tesseract not installed — can't locate button bbox")
        return False
    try:
        r = subprocess.run(
            ["tesseract", png_path, "-", "--psm", "6", "tsv"],
            capture_output=True, text=True, timeout=10,
        )
        # tsv columns: level page block para line word x y w h conf text
        for line in (r.stdout or "").splitlines()[1:]:
            cols = line.split("\t")
            if len(cols) < 12:
                continue
            text = cols[-1].strip()
            if text.lower() == label.lower():
                bx, by, bw, bh = int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9])
                cx = window_x + bx + bw // 2
                cy = window_y + by + bh // 2
                log(f"clicking '{label}' at ({cx}, {cy})")
                subprocess.run(
                    ["cliclick", f"c:{cx},{cy}"],
                    capture_output=True, text=True, timeout=5,
                )
                return True
        log(f"button '{label}' not found in OCR")
        return False
    except Exception as e:
        log(f"click_button error: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────
# Main loop
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    log("iak-screen-mirror starting")
    log(f"daemon = {DAEMON_URL}, poll = {POLL_SEC}s")

    seen_fingerprints: dict[str, float] = {}    # fp → last-seen ts
    pending_intents: dict[str, tuple[IdeConfig, str, int, int]] = {}
    # intent_id → (ide, png_path, window_x, window_y)

    while True:
        now = time.time()
        # 1. Detect popups across IDEs
        for ide in IDES:
            bounds = get_window_bounds(ide.process_name)
            if bounds is None:
                # Fallback: osascript may not have Accessibility permission,
                # or app isn't open. Capture entire screen and OCR — slower
                # but doesn't depend on AX. We still attribute the intent
                # to the IDE if its keywords appear in the OCR text.
                # Use 0,0,9999,9999 → screencapture clips to full screen.
                x, y, w, h = 0, 0, 9999, 9999
            else:
                x, y, w, h = bounds
                if w < 100 or h < 100:
                    continue
            # /tmp is a symlink to /private/tmp on macOS; tesseract/
            # leptonica fails to follow it for some weird reason
            # ("failed to open locally with tail X for filename /tmp/X").
            # Use the realpath /private/tmp directly to avoid the bug.
            png = f"/private/tmp/iak-mirror-{ide.process_name.lower()}.png"
            if not screencapture_region(x, y, w, h, png):
                continue
            text = ocr_image(png)
            if not detect_popup_keywords(text, ide):
                continue
            prompt = clean_prompt_text(text, ide)
            fp = fingerprint(prompt)
            last = seen_fingerprints.get(fp, 0)
            if now - last < DEDUP_WINDOW_SEC:
                continue
            # Also suppress if there's already an undecided intent for
            # this IDE — don't spam the user with multiple captures of
            # the same persistent popup before they've decided one.
            if any(p[0].process_name == ide.process_name
                   for p in pending_intents.values()):
                continue
            seen_fingerprints[fp] = now
            log(f"popup detected in {ide.process_name}: {prompt[:80]}")
            intent_id = post_intent(prompt, ide)
            if intent_id:
                pending_intents[intent_id] = (ide, png, x, y)

        # 2. Watch decisions on pending intents
        for intent_id in list(pending_intents.keys()):
            status = get_intent_status(intent_id)
            if not status:
                continue
            if status.get("status") != "decided":
                continue
            ide, png, wx, wy = pending_intents.pop(intent_id)
            decision = (status.get("decision") or "").lower()
            labels = ide.approve_labels if decision == "approve" else ide.deny_labels
            log(f"intent {intent_id} decided={decision} — clicking {labels[0]}")
            for lbl in labels:
                if click_button_by_label(wx, wy, png, lbl):
                    break

        # Trim old fingerprints
        for fp, ts in list(seen_fingerprints.items()):
            if now - ts > DEDUP_WINDOW_SEC * 5:
                del seen_fingerprints[fp]

        time.sleep(POLL_SEC)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("interrupted")
        sys.exit(0)
