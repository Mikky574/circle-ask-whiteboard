"""Offline regression tests for the real-acceptance telemetry fixture.

All transports below are local fakes.  No key, account, provider, browser, or
port 8791 is used by this module.
"""
from __future__ import annotations

import errno
import json
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
import urllib.error
import urllib.request

from acceptance import real_deepseek_controller as fixture


class FakeResponse:
    status = 200

    def __init__(self, body):
        self.body = body
        self.closed = False

    def read(self, _amount=-1):
        return self.body

    def close(self):
        self.closed = True

    def geturl(self):
        return fixture.TARGET_URL


class TelemetryFixtureTests(unittest.TestCase):
    def state(self, root: Path, delegate):
        store = fixture.TelemetryStore(root, "offline-test-run")
        state = fixture.RunState(store=store, delegate=delegate)
        state.persist("run_intent")
        return state, store

    @staticmethod
    def request():
        return urllib.request.Request(
            fixture.TARGET_URL,
            data=b'{"model":"deepseek-flash"}',
            headers={"Authorization": "Bearer offline-test"},
        )

    def test_200_usage_is_sanitized_and_durably_recorded(self):
        class Transport:
            def open(self, *_args, **_kwargs):
                return FakeResponse(b'{"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}')

        with tempfile.TemporaryDirectory() as directory:
            state, store = self.state(Path(directory), Transport())
            with state.transport.open(self.request()) as response:
                response.read()
            saved = json.loads(store.snapshot_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["telemetry"]["http"], {"attempted": 1, "succeeded": 1, "outcome": "succeeded"})
            self.assertEqual(saved["telemetry"]["vendorUsage"]["total_tokens"], 8)
            journal = store.journal_path.read_text(encoding="utf-8")
            self.assertIn("http_send_intent", journal)
            self.assertIn("provider_usage_received", journal)
            self.assertNotIn("Bearer", journal)

    def test_timeout_is_attempted_not_success_or_zero(self):
        class Transport:
            def open(self, *_args, **_kwargs):
                raise TimeoutError("provider text must not persist")

        with tempfile.TemporaryDirectory() as directory:
            state, store = self.state(Path(directory), Transport())
            with self.assertRaises(TimeoutError):
                state.transport.open(self.request())
            saved = json.loads(store.snapshot_path.read_text(encoding="utf-8"))["telemetry"]
            self.assertEqual(saved["http"], {"attempted": 1, "succeeded": 0, "outcome": "failed"})
            self.assertEqual(saved["providerError"], {"kind": "TimeoutError", "category": "timeout"})

    def test_url_errors_record_only_a_fixed_transport_category(self):
        private_detail = "proxy-user:synthetic-secret@example.test/path?key=private-token"
        cases = (
            ("dns", socket.gaierror(socket.EAI_NONAME, private_detail)),
            ("tls", ssl.SSLCertVerificationError(1, private_detail)),
            ("timeout", OSError(errno.ETIMEDOUT, private_detail)),
            ("connection-refused", ConnectionRefusedError(errno.ECONNREFUSED, private_detail)),
            ("connection-refused", OSError(10061, private_detail)),
            ("connection-reset", ConnectionResetError(errno.ECONNRESET, private_detail)),
            ("proxy", OSError("Tunnel connection failed: 407 " + private_detail)),
            ("unknown", private_detail),
        )

        for category, reason in cases:
            with self.subTest(category=category), tempfile.TemporaryDirectory() as directory:
                class Transport:
                    calls = 0

                    def open(self, *_args, **_kwargs):
                        self.calls += 1
                        raise urllib.error.URLError(reason)

                transport = Transport()
                state, store = self.state(Path(directory), transport)
                with self.assertRaises(urllib.error.URLError):
                    state.transport.open(self.request())
                snapshot = store.snapshot_path.read_text(encoding="utf-8")
                journal = store.journal_path.read_text(encoding="utf-8")
                saved = json.loads(snapshot)["telemetry"]
                self.assertEqual(transport.calls, 1)
                self.assertEqual(saved["http"], {"attempted": 1, "succeeded": 0, "outcome": "failed"})
                self.assertIsNone(saved["providerHttpStatus"])
                self.assertIsNone(saved["vendorUsage"])
                self.assertEqual(saved["providerError"], {"kind": "URLError", "category": category})
                self.assertEqual([json.loads(line)["event"] for line in journal.splitlines()],
                                 ["run_intent", "http_send_intent", "http_exception"])
                for secret in ("synthetic-secret", "example.test", "private-token", "Bearer"):
                    self.assertNotIn(secret, snapshot + journal)

    def test_send_then_crash_leaves_pre_send_intent_for_recovery(self):
        class CrashAfterSend:
            def open(self, *_args, **_kwargs):
                raise KeyboardInterrupt()

        with tempfile.TemporaryDirectory() as directory:
            state, store = self.state(Path(directory), CrashAfterSend())
            with self.assertRaises(KeyboardInterrupt):
                state.transport.open(self.request())
            saved = json.loads(store.snapshot_path.read_text(encoding="utf-8"))["telemetry"]
            self.assertEqual(saved["http"], {"attempted": 1, "succeeded": 0, "outcome": "unknown"})
            self.assertIn("http_send_intent", store.journal_path.read_text(encoding="utf-8"))

    def test_journal_failure_is_fail_closed_before_fake_transport(self):
        class Transport:
            called = False
            def open(self, *_args, **_kwargs):
                self.called = True
                return FakeResponse(b"{}")

        with tempfile.TemporaryDirectory() as directory:
            transport = Transport()
            state, _store = self.state(Path(directory), transport)
            state.store.persist = lambda *_args: (_ for _ in ()).throw(fixture.TelemetryPersistenceError("fail"))
            with self.assertRaises(fixture.TelemetryPersistenceError):
                state.transport.open(self.request())
            self.assertFalse(transport.called)

    def test_process_lifecycle_snapshots_exist_before_and_after_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            state, store = self.state(Path(directory), object())
            before = json.loads(store.snapshot_path.read_text(encoding="utf-8"))
            self.assertEqual(before["lastEvent"], "run_intent")
            state.telemetry["terminalEvent"] = "error"
            state.persist("process_terminating")
            after = json.loads(store.snapshot_path.read_text(encoding="utf-8"))
            self.assertEqual(after["lastEvent"], "process_terminating")
            self.assertEqual(after["telemetry"]["terminalEvent"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)
