import io
import json
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_trace import DETAIL_LIMIT, codex_trace
from server import CancellationToken, WhiteboardHandler, apply_staged_edits, read_events, source_hashes
from zcode_backend import OUTPUT_LIMIT, read_turn, read_zcode_stderr


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

    def test_zcode_stream_only_emits_public_text_and_real_retries(self):
        def event(kind, payload, session="session"):
            return {"method": "session/event", "params": {"sessionId": session, "type": kind, "payload": payload}}

        messages = iter([
            event("model.streaming", {"kind": "reasoning_delta", "delta": "internal reasoning"}),
            event("model.streaming", {"kind": "tool_input_delta", "delta": "private tool arguments"}),
            event("model.streaming", {"kind": "text_delta", "delta": "other request"}, "other"),
            event("model.streaming", {"kind": "text_delta", "delta": "公开预览"}),
            event("streamRecovery.updated", {"checkpointId": "normal anchor"}),
            event("streamRecovery.updated", {"retryNumber": 1, "message": "private network message"}),
            event("model.streaming", {"kind": "text_delta", "delta": "Z" * (OUTPUT_LIMIT + 50)}),
            event("model.streaming", {"kind": "text_delta", "delta": "outside preview limit"}),
            event("turn.completed", {"resultType": "success", "response": "Final result"}),
        ])
        events = queue.SimpleQueue()
        answer = read_turn(SimpleNamespace(receive=lambda: next(messages)), 7, "session", "ask", events)
        self.assertEqual(answer, "Final result")
        self.assertEqual(events.get_nowait(), ("output", "公开预览"))
        self.assertEqual(events.get_nowait(), ("status", "ZCode 正在恢复模型输出流（第 1 次）…"))
        self.assertEqual(events.get_nowait(), ("output", "Z" * (OUTPUT_LIMIT + 1 - len("公开预览"))))
        self.assertTrue(events.empty())

    def test_zcode_stderr_is_drained_and_only_reports_known_diagnostics(self):
        stream = io.BytesIO(
            b'Fatal: HTTP 429 token=fixture\n'
            b'Fatal: {"statusCode":429,"data":"PRIVATE_PAYLOAD"}\n'
            b'ECONNREFUSED from https://private-endpoint\n'
            b'arbitrary plugin stdout secret=value\n'
        )
        events = queue.SimpleQueue()
        read_zcode_stderr(stream, events)
        self.assertEqual(events.get_nowait(), ("stderr", "HTTP 429"))
        self.assertEqual(events.get_nowait(), ("stderr", "连接被拒绝（ECONNREFUSED）"))
        self.assertEqual(events.get_nowait(), ("stderr", "CLI 写入诊断信息"))
        self.assertTrue(events.empty())

    def test_zcode_http_emits_live_preview_and_stderr_before_final_answer(self):
        from unittest.mock import Mock

        observed = threading.Event()
        handler = SimpleNamespace(events=[], headers_for=lambda *args: None)
        def record(kind, **fields):
            handler.events.append((kind, fields))
            if kind == "output":
                observed.set()
        handler.send_event = record
        process = Mock(returncode=0, stderr=io.BytesIO(b'HTTP 502 auth=fixture-not-visible\n'))
        streamed = []
        def emit(_process, _prompt, _model, _mode, _workspace, events, _attachments):
            events.put(("output", "可见阶段\nAPI_KEY = '*secret fixture*'"))
            streamed.append(observed.wait(3))
            events.put(("answer", "最终答案"))
            events.put(("eof", ""))
        with patch("server.ZCODE_COMMAND", ["fake-zcode"]), patch("server.subprocess.Popen", return_value=process), \
             patch("server.run_zcode", emit), patch("server.terminate"):
            WhiteboardHandler.run_agent(handler, "zcode", "", "ask", "fixture", {}, None, Path.cwd(), {}, [])
        self.assertEqual(streamed, [True])
        self.assertIn(("output", {"text": "可见阶段\n〔敏感内容已隐藏〕"}), handler.events)
        self.assertIn(("log", {"channel": "stderr", "text": "HTTP 502"}), handler.events)
        self.assertNotIn("fixture-not-visible", str(handler.events))
        self.assertEqual(handler.events[-2], ("answer", {"text": "最终答案"}))
        self.assertEqual(handler.events[-1][0], "done")

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
