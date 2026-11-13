import io
import json
import queue
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_trace import DETAIL_LIMIT, codex_trace
from server import CancellationToken, WhiteboardHandler, apply_staged_edits, read_events, source_hashes
from zcode_backend import read_turn


def encoded_source(path, source):
    return json.dumps({"path": path, "text": source, "nextOffset": None}, ensure_ascii=False)


class AgentTraceTests(unittest.TestCase):
    def test_ndjson_can_include_trace_kind_and_request_identity(self):
        handler = SimpleNamespace(_terminal_sent=False, _event_meta={"requestId": "request-fixture"}, wfile=io.BytesIO())
        self.assertTrue(WhiteboardHandler.send_event(handler, "trace", kind="read", step="step-fixture"))
        self.assertTrue(WhiteboardHandler.send_event(handler, "done"))
        self.assertFalse(WhiteboardHandler.send_event(handler, "trace", kind="edit"))
        events = [json.loads(line) for line in handler.wfile.getvalue().splitlines()]
        self.assertEqual(events, [{"type": "trace", "requestId": "request-fixture", "kind": "read", "step": "step-fixture"},
                                  {"type": "done", "requestId": "request-fixture"}])

    def test_codex_read_event_has_bounded_source_and_stays_separate_from_answer(self):
        source = 'PRESSURE_LIMIT = 61\nAPI_KEY = "fixture-must-be-hidden"\n' + "z" * 3000
        base = {"id": "item_0", "type": "mcp_tool_call", "server": "whiteboard", "tool": "read_file",
                "arguments": {"path": "repository/src/main.py"}}
        result = {"content": [{"type": "text", "text": encoded_source("repository/src/main.py", source)}]}
        messages = [
            {"type": "item.started", "item": base},
            {"type": "item.completed", "item": {**base, "result": result}},
            {"type": "item.completed", "item": {"type": "reasoning", "text": "private fixture"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "The answer is 61."}},
        ]
        stdout = "\n".join(json.dumps(item) for item in messages).encode()
        events = queue.SimpleQueue()
        read_events(SimpleNamespace(stdout=io.BytesIO(stdout)), events)
        running_kind, running = events.get_nowait()
        completed_kind, completed = events.get_nowait()
        self.assertEqual((running_kind, completed_kind), ("trace", "trace"))
        self.assertEqual((running["state"], completed["state"]), ("running", "done"))
        self.assertEqual(running["step"], completed["step"])
        self.assertEqual(completed["path"], "repository/src/main.py")
        self.assertEqual(completed["detailKind"], "code")
        self.assertIn("PRESSURE_LIMIT = 61", completed["detail"])
        self.assertNotIn("fixture-must-be-hidden", completed["detail"])
        self.assertLessEqual(len(completed["detail"]), DETAIL_LIMIT)
        self.assertEqual(events.get_nowait(), ("answer", "The answer is 61."))
        self.assertEqual(events.get_nowait(), ("eof", ""))
        self.assertTrue(events.empty())

    def test_unknown_tools_and_shell_do_not_forward_raw_arguments_or_results(self):
        item = {"id": "item_2", "type": "command_execution", "command": "Get-Content app.js | inspect-fixture-password",
                "aggregated_output": "fixture stdout", "status": "failed", "exit_code": 2}
        trace = codex_trace({"type": "item.completed", "item": item})
        self.assertEqual((trace["kind"], trace["path"], trace["state"]), ("read", "app.js", "error"))
        self.assertEqual(trace["detail"], "退出码 2")
        item = {"id": "item_3", "type": "mcp_tool_call", "server": "other", "tool": "read_file",
                "arguments": {"path": "repository/src/main.py"}, "result": {"text": "external tool output"}}
        trace = codex_trace({"type": "item.completed", "item": item})
        self.assertEqual(trace["kind"], "tool")
        self.assertNotIn("path", trace)
        self.assertNotIn("detail", trace)
        item.update(server="whiteboard", arguments={"path": "repository/.env"}, result={"text": "environment"})
        trace = codex_trace({"type": "item.completed", "item": item})
        self.assertNotIn("path", trace)
        self.assertNotIn("detail", trace)

    def test_zcode_uses_path_from_result_when_schedule_omits_input(self):
        def event(kind, payload):
            return {"method": "session/event", "params": {"sessionId": "session", "type": kind, "payload": payload}}

        def tool(phase, key, **fields):
            return event("tool.updated", {"kind": phase, "toolCallId": key, **fields})

        messages = iter([
            tool("scheduled", "read", toolName="mcp__whiteboard__read_file", inputOmitted=True),
            tool("started", "read", toolName="mcp__whiteboard__read_file"),
            tool("result", "read", result={"success": True, "content": encoded_source("repository/src/main.py", "value = 61")}),
            tool("scheduled", "denied", toolName="mcp__whiteboard__read_file"),
            event("permission.resolved", {"decision": "deny", "toolCallId": "denied", "reason": "internal diagnostic"}),
            event("turn.completed", {"resultType": "success", "response": "Result"}),
        ])
        events = queue.SimpleQueue()
        answer = read_turn(SimpleNamespace(receive=lambda: next(messages)), 7, "session", "ask", events)
        self.assertEqual(answer, "Result")
        seen = []
        while not events.empty():
            kind, payload = events.get_nowait()
            if kind == "trace":
                seen.append(payload)
        self.assertEqual([event["state"] for event in seen], ["running", "done", "running", "error"])
        self.assertEqual(seen[0]["step"], seen[1]["step"])
        self.assertEqual((seen[1]["path"], seen[1]["detail"]), ("repository/src/main.py", "value = 61"))
        self.assertNotIn("detail", seen[-1])

    def test_edit_diff_only_describes_committed_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            workspace = root / "workspace"
            workspace.mkdir()
            target = root / "app.js"
            target.write_text("const limit = 60;\n", encoding="utf-8")
            (workspace / "app.js").write_text("const limit = 61;\n", encoding="utf-8")
            with patch("server.ROOT", root), patch("server.STATIC", {"app.js": "text/javascript"}):
                before = source_hashes()
                token = CancellationToken()
                token.cancel()
                details = {}
                self.assertFalse(apply_staged_edits(workspace, before, cancellation=token, change_details=details))
                self.assertEqual(details, {})
                self.assertIn("60", target.read_text(encoding="utf-8"))
                self.assertTrue(apply_staged_edits(workspace, before, change_details=details))
                self.assertIn("-const limit = 60;", details["app.js"])
                self.assertIn("+const limit = 61;", details["app.js"])
                self.assertIn("61", target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
