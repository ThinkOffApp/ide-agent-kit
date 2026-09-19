#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/lead-desk.py.

Everything runs against a real HTTP server started in-process on port 0, so the
transport is exercised rather than mocked away. The rule that earns its keep
here is test_unreachable_never_renders_as_empty: the old wrong behaviour was a
uniform result, where a daemon that never answered and a daemon with nothing
queued produced the same silence. Its partner test asserts that a genuinely
empty queue still says `empty`, so neither half can pass by accident.

Run: python3 -m unittest test/lead-desk.test.py
"""

import importlib.util
import io
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "scripts", "lead-desk.py")
_spec = importlib.util.spec_from_file_location("lead_desk", _SCRIPT)
ld = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ld)

# A URL nothing listens on. Port 1 is privileged and unbound, so this refuses
# immediately instead of hanging the suite.
DEAD_URL = "http://127.0.0.1:1"


def make_server(responder):
    """Start a throwaway /intents server. `responder(hit_count)` -> (code, body)."""
    state = {"hits": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.startswith("/intents"):
                self.send_response(404)
                self.end_headers()
                return
            state["hits"] += 1
            code, body = responder(state["hits"])
            payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # poll_interval default is 0.5s and shutdown() waits a full interval, which
    # was costing half a second of teardown per test for no reason.
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1], state


def intent(iid, prompt, status="pending", decision=None):
    return {
        "id": iid, "prompt": prompt, "session": "claude-code-mb",
        "status": status, "createdAt": "2026-09-19T10:00:00Z",
        "decidedAt": None, "decision": decision,
    }


def once(daemons, as_json=False):
    """Run --once into a buffer, return (exit_code, [lines])."""
    buf = io.StringIO()
    code = ld.run_once(daemons, as_json=as_json, timeout=2.0, out=buf)
    return code, [l for l in buf.getvalue().splitlines() if l.strip()]


class ServerCase(unittest.TestCase):
    """Base that serves a fixed list of intents and always cleans the port up."""

    def serve(self, intents, code=200):
        srv, url, state = make_server(lambda hit: (code, intents))
        self.addCleanup(srv.shutdown)
        return url, state


class TestUnreachableVsEmpty(ServerCase):
    def test_unreachable_never_renders_as_empty(self):
        # The old wrong behaviour. An unreachable daemon that printed nothing,
        # or printed `empty`, made a dead host look like a quiet one.
        code, lines = once([("bogus", DEAD_URL)])
        self.assertEqual(len(lines), 1, lines)
        self.assertTrue(lines[0].startswith("bogus  UNREACHABLE  "), lines[0])
        self.assertNotIn("empty", lines[0])
        self.assertNotEqual(lines[0], "bogus  empty")
        # The reason has to be present, not an empty tail.
        self.assertTrue(lines[0].split("UNREACHABLE  ", 1)[1].strip(), lines[0])
        self.assertEqual(code, 3, "an unreachable daemon must signal via exit code too")

    def test_reachable_and_empty_says_empty(self):
        # Negative control for the test above: if `empty` were never printed at
        # all, that test would pass while the tool was useless.
        url, _ = self.serve([])
        code, lines = once([("local", url)])
        self.assertEqual(lines, ["local  empty"])
        self.assertEqual(code, 0)

    def test_mixed_fleet_keeps_the_two_apart_on_one_screen(self):
        url, _ = self.serve([])
        code, lines = once([("local", url), ("bogus", DEAD_URL)])
        self.assertEqual(lines[0], "local  empty")
        self.assertTrue(lines[1].startswith("bogus  UNREACHABLE  "), lines)
        self.assertEqual(code, 3)

    def test_http_error_is_unreachable_not_empty(self):
        # A 404 means we are talking to the wrong port or an older daemon. That
        # is a failure, not a quiet queue.
        url, _ = self.serve([], code=500)
        code, lines = once([("local", url)])
        self.assertIn("UNREACHABLE", lines[0])
        self.assertIn("HTTP 500", lines[0])
        self.assertEqual(code, 3)

    def test_malformed_json_is_unreachable_not_empty(self):
        srv, url, _ = make_server(lambda hit: (200, "not json at all"))
        self.addCleanup(srv.shutdown)
        code, lines = once([("local", url)])
        self.assertIn("UNREACHABLE", lines[0])
        self.assertIn("malformed JSON", lines[0])


class TestClassification(ServerCase):
    def line_class(self, prompt):
        url, _ = self.serve([intent("i1", prompt)])
        _, lines = once([("local", url)])
        self.assertEqual(len(lines), 1, lines)
        parts = lines[0].split("  ")
        self.assertEqual(parts[0], "local")
        self.assertEqual(parts[1], "i1")
        return parts[2]

    def test_rm_f_is_destructive(self):
        self.assertEqual(self.line_class("rm -f /tmp/iak-new-messages.txt"), "DESTRUCTIVE")

    def test_rm_rf_is_destructive(self):
        self.assertEqual(self.line_class("sudo rm -rf ~/ide-agent-kit/node_modules"), "DESTRUCTIVE")

    def test_force_push_is_destructive(self):
        self.assertEqual(self.line_class("git push --force origin main"), "DESTRUCTIVE")

    def test_principals_escalates(self):
        # Either class is correct: both route to the owner. What must not happen
        # is LEAD-OK.
        self.assertIn(self.line_class("Add @codex to the principals list"), ("AUTH-PATH", "CREDENTIAL"))

    def test_confirmations_patch_is_auth_path(self):
        self.assertEqual(self.line_class("Apply a patch to src/confirmations.mjs"), "AUTH-PATH")

    def test_credential_class(self):
        self.assertEqual(self.line_class("Rotate the room api_key in the poller config"), "CREDENTIAL")

    def test_paid_class(self):
        self.assertEqual(self.line_class("Deploy the site to prod on Vercel"), "PAID")

    def test_benign_is_lead_ok(self):
        self.assertEqual(self.line_class("Run the room poller unit tests and paste the summary line."), "LEAD-OK")

    def test_most_restrictive_wins(self):
        # Two rules match; the classification is a lower bound, so the more
        # restrictive one has to win rather than whichever matched first.
        cls, _ = ld.classify("rotate the api key then rm -rf the cache")
        self.assertEqual(cls, "DESTRUCTIVE")
        cls2, _ = ld.classify("patch confirmations.mjs and delete the old key")
        self.assertEqual(cls2, "AUTH-PATH")

    def test_owner_only_covers_the_four(self):
        self.assertEqual(set(ld.OWNER_ONLY), {"AUTH-PATH", "DESTRUCTIVE", "CREDENTIAL", "PAID"})
        self.assertNotIn("LEAD-OK", ld.OWNER_ONLY)


class TestPromptHandling(ServerCase):
    def test_excerpt_is_one_line_and_capped(self):
        url, _ = self.serve([intent("i1", "line one\nline two\twith   gaps " + "x" * 200)])
        _, lines = once([("local", url)])
        self.assertNotIn("\t", lines[0])
        body = lines[0].split("  ", 3)[3]
        self.assertTrue(body.startswith("line one line two with gaps"), body)
        self.assertLessEqual(len(body.replace("  [CLIPPED?]", "")), ld.EXCERPT_CHARS)

    def test_exactly_300_chars_is_flagged_clipped(self):
        # The width the room card clips at. The daemon prompt should be the full
        # text, so a prompt of exactly this length is a hint the source was the
        # clipped card, not the daemon.
        self.assertTrue(ld.looks_clipped("a" * 300))
        url, _ = self.serve([intent("i1", "run the build " + "b" * 286)])
        _, lines = once([("local", url)])
        self.assertTrue(lines[0].endswith("[CLIPPED?]"), lines[0])

    def test_short_prompt_is_not_flagged(self):
        # Negative control: if everything were flagged the flag would mean nothing.
        self.assertFalse(ld.looks_clipped("run the tests"))
        url, _ = self.serve([intent("i1", "run the tests")])
        _, lines = once([("local", url)])
        self.assertNotIn("CLIPPED", lines[0])

    def test_ellipsis_is_flagged(self):
        self.assertTrue(ld.looks_clipped("ssh into the mini and run the long thing..."))

    def test_decided_intents_are_not_listed(self):
        url, _ = self.serve([
            intent("i1", "rm -rf /tmp/x", status="decided", decision="deny"),
            intent("i2", "run the tests"),
        ])
        _, lines = once([("local", url)])
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("i2", lines[0])


class TestJson(ServerCase):
    def test_json_marks_unreachable_and_owner_only(self):
        url, _ = self.serve([intent("i1", "rm -f the log")])
        _, lines = once([("local", url), ("bogus", DEAD_URL)], as_json=True)
        doc = json.loads(lines[0])
        local, bogus = doc["daemons"]
        self.assertTrue(local["reachable"])
        self.assertEqual(local["pending"][0]["class"], "DESTRUCTIVE")
        self.assertTrue(local["pending"][0]["owner_only"])
        self.assertFalse(bogus["reachable"])
        self.assertTrue(bogus["reason"])
        self.assertEqual(bogus["pending"], [])


class TestWatch(unittest.TestCase):
    """Watch mode is driven by the hit counter, not by sleeping, so the
    sequence of polls is deterministic."""

    def watch(self, responder, polls):
        srv, url, _ = make_server(responder)
        self.addCleanup(srv.shutdown)
        buf = io.StringIO()
        ld.run_watch([("local", url)], 0.01, timeout=2.0, max_polls=polls, out=buf)
        return [l for l in buf.getvalue().splitlines() if l.strip()]

    def test_new_intent_emits_one_line_and_no_change_emits_nothing(self):
        # Poll 1 empty, polls 2+ hold one intent. Polls 3 and 4 change nothing.
        rows = [intent("i1", "rm -f /var/log/thing")]
        lines = self.watch(lambda hit: (200, [] if hit == 1 else rows), 4)
        self.assertEqual(len(lines), 2, lines)
        self.assertIn("UP  local  0 pending", lines[0])
        self.assertIn("NEW  local  i1  DESTRUCTIVE", lines[1])

    def test_steady_state_is_silent(self):
        # Four polls, nothing ever changes: only the startup UP line.
        lines = self.watch(lambda hit: (200, []), 4)
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("UP", lines[0])

    def test_leaving_pending_reports_the_decision(self):
        pending = [intent("i1", "run the tests")]
        settled = [intent("i1", "run the tests", status="decided", decision="approve")]
        lines = self.watch(lambda hit: (200, pending if hit <= 2 else settled), 3)
        self.assertEqual(len(lines), 3, lines)
        self.assertIn("NEW", lines[1])
        self.assertIn("DONE  local  i1  LEAD-OK  approve", lines[2])

    def test_vanished_intent_is_called_out_not_treated_as_approved(self):
        # The in-memory Map signature: a restart drops the queue. Reporting that
        # as a decision would be a fabricated approval.
        pending = [intent("i1", "run the tests")]
        lines = self.watch(lambda hit: (200, pending if hit <= 2 else []), 3)
        self.assertIn("vanished", lines[-1])

    def test_unreachable_to_reachable_transition(self):
        srv, url, _ = make_server(lambda hit: (200, []))
        self.addCleanup(srv.shutdown)
        buf = io.StringIO()
        ld.run_watch([("dead", DEAD_URL), ("live", url)], 0.01, timeout=2.0, max_polls=2, out=buf)
        lines = [l for l in buf.getvalue().splitlines() if l.strip()]
        # One DOWN for the dead one, one UP for the live one, and no repeats on
        # the second poll because neither state flipped.
        self.assertEqual(len(lines), 2, lines)
        self.assertIn("DOWN  dead", lines[0])
        self.assertIn("UP  live", lines[1])
        self.assertNotIn("empty", " ".join(lines))


class TestCli(unittest.TestCase):
    def test_default_daemon_is_local_8788(self):
        self.assertEqual(ld.parse_daemon(ld.DEFAULT_DAEMONS[0]), ("local", "http://127.0.0.1:8788"))

    def test_bare_url_is_rejected(self):
        with self.assertRaises(Exception):
            ld.parse_daemon("http://127.0.0.1:8788")

    def test_no_em_dashes_in_the_script(self):
        # Standing rule for anything a human reads.
        with open(_SCRIPT, encoding="utf-8") as f:
            self.assertNotIn("\u2014", f.read())  # em dash


if __name__ == "__main__":
    unittest.main()
