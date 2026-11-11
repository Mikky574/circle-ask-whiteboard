"""Offline contract tests for the design-stage whiteboard acceptance gate.

Every transport is fake.  The only listener is the temporary loopback server
created by ``isolated_server``; it never binds the product port 8791.
"""

from __future__ import annotations

import copy
import hashlib
import http.client
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api_backend
import server
import zcode_workspace
from backends import BackendRequest, CodexAdapter, FACTORY
from board_tools import BoardTools
from fixtures import TEST_ONLY_KEY, api_settings, board_snapshot, response, tool_call


LOOPBACK_PORTS = []


def case_ids(*ids):
    def decorate(function):
        function.case_ids = list(ids)
        return function
    return decorate


def method_case_ids(test):
    return getattr(getattr(test, test._testMethodName), "case_ids", [])


class RecordingRuntime:
    """A handler-shaped recording sink; never writes to browser storage."""

    def __init__(self, disconnected=False):
        self.events = []
        self.headers = []
        self._disconnected = disconnected

    def headers_for(self, *values):
        self.headers.append(values)

    def send_event(self, kind, **fields):
        self.events.append({"type": kind, **fields})

    def disconnected(self):
        return self._disconnected


class FakeEndpointAdapter:
    def __init__(self, events, entered=None, release=None):
        self.events = events
        self.entered = entered
        self.release = release
        self.validated = []
        self.requests = []

    def validate(self, request, runtime):
        self.validated.append(request.backend)
        self.requests.append(request)

    def execute(self, request, runtime):
        runtime.headers_for(200, "application/x-ndjson; charset=utf-8")
        if self.entered:
            self.entered.set()
        for kind, fields in self.events:
            runtime.send_event(kind, **fields)
        if self.release:
            self.release.wait(2)


@contextmanager
def isolated_server():
    """Start one test-only random-port loopback server and always close it."""
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.WhiteboardHandler)
    port = httpd.server_address[1]
    host = f"127.0.0.1:{port}"
    LOOPBACK_PORTS.append(port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    with patch.object(server, "ALLOWED_HOSTS", {host, f"localhost:{port}"}), \
         patch.object(server.WhiteboardHandler, "log_message", lambda *_: None):
        thread.start()
        try:
            yield port, host
        finally:
            httpd.shutdown()
            thread.join(timeout=2)
            httpd.server_close()


def post(port, path, body=b"", headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    request_headers = dict(headers or {})
    request_headers.setdefault("Content-Length", str(len(body)))
    connection.putrequest("POST", path, skip_host=True, skip_accept_encoding=True)
    for name, value in request_headers.items():
        connection.putheader(name, value)
    connection.endheaders(body)
    try:
        result = connection.getresponse()
        return result.status, dict(result.getheaders()), result.read()
    finally:
        connection.close()


def good_headers(host, body):
    return {
        "Host": host,
        "Origin": f"http://{host}",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }


def valid_request(backend="codex"):
    return json.dumps({"backend": backend, "model": "", "mode": "ask", "question": "fixture question"}).encode("utf-8")


class FactoryAcceptanceTests(unittest.TestCase):
    @case_ids("F01")
    def test_factory_request_contract_is_explicit(self):
        request = BackendRequest("api", "fixture", "ask", "question", {}, [])
        required = {"requestId", "intent", "boardId", "baseRevision", "permissions", "budget", "backendOptions"}
        missing = sorted(name for name in required if not hasattr(request, name))
        self.assertEqual(missing, [], "Unified BackendRequest must expose every design-contract field.")

    @case_ids("F01")
    def test_three_adapters_expose_one_cancel_contract(self):
        # The fixed snapshot is deliberately shared by the three selection paths;
        # no adapter may infer a provider-specific cancellation shape from it.
        fixture_id = board_snapshot()["nodes"][0]["id"]
        cancel_functions = {name: getattr(FACTORY.get(name), "cancel", None) for name in ("api", "codex", "zcode")}
        self.assertEqual(fixture_id, "E01")
        self.assertTrue(
            all(callable(cancel) for cancel in cancel_functions.values()),
            "Every adapter must expose cancel(requestId); current cancellation is transport-internal.",
        )

    @case_ids("F01", "L05", "C02")
    def test_cancel_tokens_reach_each_adapter_transport_boundary(self):
        # No real provider/CLI is invoked.  The fake runtimes prove that a
        # shared cancel(requestId) reaches API discard state and the CLI hook
        # that terminates a local child process.
        for name, method in (("api", "run_api_turn"), ("codex", "run_turn"), ("zcode", "run_turn")):
            adapter = FACTORY.get(name)
            request = BackendRequest(name, "fixture", "ask", "q", {}, [], requestId=f"cancel-{name}")
            observed = []

            def invoke(*, request, cancellation):
                cancellation.register(lambda: observed.append("transport-stopped"))
                self.assertTrue(adapter.cancel(request.requestId))
                self.assertTrue(cancellation.cancelled())

            runtime = SimpleNamespace(**{method: invoke})
            adapter.execute(request, runtime)
            self.assertEqual(observed, ["transport-stopped"], name)
            self.assertFalse(adapter.cancel(request.requestId), "completed requests must not remain cancellable")

    @case_ids("F02")
    def test_factory_rejects_unknown_without_adapter(self):
        for value in ("other", None, [], {"backend": "api"}):
            with self.assertRaises(ValueError):
                FACTORY.get(value)

    @case_ids("F03")
    def test_status_distinguishes_installation_configuration_and_verification(self):
        statuses = {item["id"]: item for item in FACTORY.status(SimpleNamespace(CODEX_EXECUTABLE="fake", ZCODE_COMMAND=None))}
        self.assertTrue(statuses["codex"]["installed"])
        self.assertFalse(statuses["zcode"]["installed"])
        self.assertFalse(statuses["api"]["configured"])
        self.assertTrue(all(item["verified"] is False for item in statuses.values()))

    @case_ids("F04")
    def test_api_legacy_source_edit_is_rejected_before_dispatch(self):
        request = BackendRequest("api", "fixture", "edit", "question", {}, [], api={"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY})
        with self.assertRaises(ValueError):
            FACTORY.get("api").validate(request, SimpleNamespace())


class DecompositionAcceptanceTests(unittest.TestCase):
    @staticmethod
    def request_body():
        return {
            "backend": "api", "model": "fixture", "mode": "ask", "scope": "decompose",
            "question": "拆出任务、依赖和验收标准", "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY},
            "anchor": {"elementIds": ["A02"]},
            "decomposition": {
                "targetId": "A02", "limit": 2,
                "path": [{"id": "E04", "title": "项目", "summary": "项目现状"},
                         {"id": "A02", "title": "数据", "summary": "浏览器本地存储"}],
                "existingChildren": [{"id": "E05", "title": "盘点键名", "summary": "已记录"}],
            },
        }

    @staticmethod
    def children():
        return [{"title": "验证备份", "task": "用合成数据验证备份和恢复。", "dependencies": ["盘点键名"],
                 "acceptance": ["恢复后两份存储值逐字节一致。"]}]

    def test_api_returns_scoped_children_without_tools_or_map(self):
        body = json.dumps(self.request_body()).encode()
        children = self.children()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps({"children": children})) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "children", "done"])
        self.assertEqual(events[2]["children"], children)
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        self.assertIn("children", api.call_args.args[4]["properties"])
        self.assertNotIn(TEST_ONLY_KEY, raw.decode())
        parsed = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual((parsed.intent, parsed.permissions), ("decompose", ()))

    def test_request_rejects_mismatched_anchor_full_board_and_edit_mode(self):
        for update in ({"anchor": {"elementIds": ["E04", "A02"]}}, {"mode": "edit"}, {"board": board_snapshot()},
                       {"decomposition": {**self.request_body()["decomposition"], "limit": 7}}):
            with self.subTest(update=update):
                with self.assertRaises(ValueError):
                    server.parse_request(json.dumps({**self.request_body(), **update}).encode())

    def test_api_discards_invalid_response_as_a_batch(self):
        valid = self.children()[0]
        for invalid in ({**valid, "parentId": "E04"}, {**valid, "title": " 盘点键名 "},
                        {**valid, "title": "另一个任务", "acceptance": []}):
            with self.subTest(invalid=invalid), isolated_server() as (port, host):
                body = json.dumps(self.request_body()).encode()
                with patch.object(server, "run_api", return_value=json.dumps({"children": [valid, invalid]})):
                    _, _, raw = post(port, "/api/codex", body, good_headers(host, body))
                events = [json.loads(line) for line in raw.splitlines()]
                self.assertEqual([event["type"] for event in events], ["status", "context", "error"])

    def test_cli_adapters_emit_same_child_candidates(self):
        children = self.children()
        answer = json.dumps({"children": children})
        body = self.request_body()
        body["backend"] = "codex"
        parsed = server.parse_request(json.dumps(body).encode())

        def emit(_process, events):
            events.put(("answer", answer))
            events.put(("eof", ""))

        def emit_zcode(process, prompt, model, mode, workspace, events, files):
            emit(process, events)

        with tempfile.TemporaryDirectory() as directory:
            schema = Path(directory) / "children.json"
            schema.write_text("{}", encoding="utf-8")
            for backend in ("codex", "zcode"):
                with self.subTest(backend=backend):
                    runtime = RecordingRuntime()
                    process = Mock(returncode=0)
                    with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
                         patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
                         patch.object(server.subprocess, "Popen", return_value=process), \
                         patch.object(server, "send_prompt"), patch.object(server, "read_events", emit), \
                         patch.object(server, "run_zcode", emit_zcode), patch.object(server, "terminate"):
                        server.WhiteboardHandler.run_agent(runtime, backend, "fixture", "ask", parsed[1], parsed[2],
                                                           schema, ROOT, {}, [])
                    self.assertEqual([event["type"] for event in runtime.events], ["status", "context", "children", "done"])
                    self.assertEqual(runtime.events[-2]["children"], children)


class ExplanationAcceptanceTests(unittest.TestCase):
    @staticmethod
    def request_body():
        return {
            "backend": "api", "model": "fixture", "mode": "ask", "scope": "explain",
            "question": "把旧回复整理成子卡", "anchor": {"elementIds": ["A02"]},
            "sourceAnswer": {"question": "启动时加载什么？", "answer": "初始化加载白板，然后恢复会话。"},
            "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY},
        }

    @staticmethod
    def explanation():
        return {
            "summary": "启动时先加载白板，再恢复会话。",
            "sections": [
                {"title": "白板初始化", "text": "加载白板的结构和选项。"},
                {"title": "会话恢复", "text": "读取已保存的回复。"},
            ],
        }

    def test_api_returns_read_only_explanation_with_original_answer(self):
        body = json.dumps(self.request_body()).encode()
        explanation = self.explanation()
        answer = "```json\n" + json.dumps(explanation) + "\n```"
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=answer) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "explanation", "done"])
        self.assertEqual(events[2]["explanation"], explanation)
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        self.assertIn("sections", api.call_args.args[4]["properties"])
        self.assertIn(self.request_body()["sourceAnswer"]["answer"], api.call_args.args[2])
        self.assertNotIn(TEST_ONLY_KEY, raw.decode())
        parsed = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual((parsed.intent, parsed.permissions), ("explain", ()))

    def test_invalid_explanation_has_no_partial_candidate(self):
        body = json.dumps(self.request_body()).encode()
        explanation = self.explanation()
        explanation["sections"][1]["title"] = " 白板初始化 "
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(explanation)):
            _, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual([event["type"] for event in events], ["status", "context", "error"])

    def test_cli_adapters_emit_same_explanation_candidates(self):
        explanation = self.explanation()
        answer = json.dumps(explanation)
        parsed = server.parse_request(json.dumps(self.request_body()).encode())
        schema = server.write_explanation_schema()
        self.addCleanup(schema.unlink)

        def emit(_process, events):
            events.put(("answer", answer))
            events.put(("eof", ""))

        def emit_zcode(process, prompt, model, mode, workspace, events, files):
            emit(process, events)

        for backend in ("codex", "zcode"):
            with self.subTest(backend=backend):
                runtime = RecordingRuntime()
                process = Mock(returncode=0)
                with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
                     patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
                     patch.object(server.subprocess, "Popen", return_value=process), \
                     patch.object(server, "send_prompt"), patch.object(server, "read_events", emit), \
                     patch.object(server, "run_zcode", emit_zcode), patch.object(server, "terminate"):
                    server.WhiteboardHandler.run_agent(runtime, backend, "fixture", "ask", parsed[1], parsed[2],
                                                       schema, ROOT, {}, [])
                self.assertEqual([event["type"] for event in runtime.events], ["status", "context", "explanation", "done"])
                self.assertEqual(runtime.events[-2]["explanation"], explanation)


class BranchOrganizationAcceptanceTests(unittest.TestCase):
    @staticmethod
    def request_body():
        box = {"x": 0, "y": 0, "width": 200, "height": 100}
        nodes = [
            {"id": node_id, "kind": kind, "title": node_id, "text": "分支材料",
             "parentIds": [parent] if parent else [], "layoutParentId": parent, "box": box, "pinned": pinned}
            for node_id, parent, kind, pinned in (
                ("E02", None, "card", False), ("E03", "E02", "card", False),
                ("E04", "E03", "card", True), ("A01", "E02", "note", False),
                ("E05", "E02", "card", False),
            )
        ]
        return {
            "backend": "api", "model": "fixture", "mode": "ask", "scope": "organizeBranch",
            "question": "整理这条分支", "branchRootId": "E02",
            "board": {"nodes": nodes, "layout": {"flow": "vertical", "density": "normal"}},
            "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY},
        }

    @staticmethod
    def candidate():
        return {"items": [
            {"id": node_id, "parentId": parent, "title": node_id, "summary": "整理后的说明"}
            for node_id, parent in (
                ("E02", None), ("E05", "E03"), ("E03", "E02"), ("E04", "E03"), ("A01", "E02"),
            )
        ]}

    def test_branch_turn_returns_scoped_result_without_board_tools(self):
        body = json.dumps(self.request_body()).encode()
        candidate = self.candidate()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(candidate)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "branch", "done"])
        self.assertEqual(events[2]["branch"], candidate)
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        self.assertEqual(set(api.call_args.args[4]["properties"]), {"items"})
        parsed = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual((parsed.intent, parsed.permissions), ("organizeBranch", ("read_board",)))

    def test_branch_request_rejects_unclosed_snapshot_or_edit(self):
        for name, update in (
            ("edit", lambda request: request.update(mode="edit")),
            ("absent root", lambda request: request.update(branchRootId="E99")),
            ("reserved node", lambda request: request["board"].update(newIds=["E06"])),
            ("missing layout parent", lambda request: request["board"]["nodes"][1].pop("layoutParentId")),
            ("detached", lambda request: request["board"]["nodes"][1].update(layoutParentId=None)),
            ("cycle", lambda request: request["board"]["nodes"][1].update(layoutParentId="E04")),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                request = self.request_body()
                update(request)
                server.parse_request(json.dumps(request).encode())

    def test_branch_candidate_rejects_detachment_scope_escape_and_locked_edges(self):
        context = server.parse_request(json.dumps(self.request_body()).encode())[2]
        for name, update in (
            ("detached", lambda items: items[1].update(parentId=None)),
            ("external parent", lambda items: items[1].update(parentId="E99")),
            ("duplicate", lambda items: items[1].update(id="E03")),
            ("missing", lambda items: items.pop()),
            ("cycle", lambda items: items[2].update(parentId="E05")),
            ("pinned changed", lambda items: items[3].update(parentId="E02")),
            ("note moved", lambda items: items[4].update(parentId="E03")),
            ("root moved", lambda items: items[0].update(parentId="E03")),
            ("category changed", lambda items: items[1].update(category="archive")),
            ("oversize", lambda items: items[1].update(summary="长" * 651)),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                candidate = self.candidate()
                update(candidate["items"])
                server.structured_candidate(json.dumps(candidate), context)


class BoardToolAcceptanceTests(unittest.TestCase):
    def new_tools(self, writable=True):
        return BoardTools(board_snapshot(), server.parse_map, writable=writable)

    @case_ids("T01")
    def test_read_results_are_copy_isolated(self):
        tools = self.new_tools()
        board = tools.call("get_board", {})
        board["board"]["items"].clear()
        self.assertEqual(len(tools.plan["items"]), 2)
        node = tools.call("get_node", {"id": "E01"})
        node["title"] = "caller mutation"
        self.assertEqual(tools.plan["items"][0]["title"], "Pinned root", "Read tools must not expose mutable draft references.")

    @case_ids("T02")
    def test_create_update_and_reparent_are_staged(self):
        tools = self.new_tools()
        tools.call("create_node", {"id": "E04", "title": "New", "summary": "Evidence", "category": "reference", "parentId": "E01"})
        tools.call("update_node", {"id": "E04", "title": "Updated"})
        tools.call("reparent_node", {"id": "A01", "parentId": "E04", "side": "left"})
        by_id = {item["id"]: item for item in tools.plan["items"]}
        self.assertEqual(by_id["E04"]["title"], "Updated")
        self.assertEqual(by_id["A01"]["parentId"], "E04")
        self.assertTrue(tools.dirty)

    @case_ids("T03", "T04", "T05", "T09")
    def test_invalid_mutations_are_atomic(self):
        tools = self.new_tools()
        invalid = [
            ("archive_node", {"id": "E01", "archived": True}),
            ("reparent_node", {"id": "E01", "parentId": "A01", "side": "auto"}),
            ("update_node", {"id": "E99", "title": "missing"}),
            ("create_node", {"id": "E99", "title": "x", "summary": "x", "category": "reference", "parentId": None}),
            ("update_node", {"id": "A01", "title": "x" * 161}),
            ("update_node", {"id": "A01", "title": False}),
            ("archive_node", {"id": "A01", "archived": "true"}),
            ("update_node", {"id": "A01", "command": "not allowed"}),
        ]
        for name, arguments in invalid:
            before = copy.deepcopy(tools.plan)
            with self.assertRaises(ValueError, msg=f"{name} must be rejected"):
                tools.call(name, arguments)
            self.assertEqual(before, tools.plan)

    @case_ids("T06", "T07")
    def test_archive_restore_and_layout_density(self):
        tools = self.new_tools()
        tools.call("archive_node", {"id": "A01", "archived": True})
        self.assertEqual(tools.call("get_node", {"id": "A01"})["category"], "archive")
        tools.call("archive_node", {"id": "A01", "archived": False})
        tools.call("set_layout", {"flow": "vertical", "density": "compact"})
        before = copy.deepcopy(tools.plan)
        with self.assertRaises(ValueError):
            tools.call("set_layout", {"flow": "diagonal", "density": "compact"})
        self.assertEqual(before, tools.plan)

    @case_ids("T08")
    def test_read_only_refuses_every_write_tool(self):
        tools = self.new_tools(writable=False)
        denied = [
            ("create_node", {"id": "E04", "title": "x", "summary": "x", "category": "reference", "parentId": None}),
            ("update_node", {"id": "A01", "title": "x"}),
            ("reparent_node", {"id": "A01", "parentId": None, "side": "auto"}),
            ("archive_node", {"id": "A01", "archived": True}),
            ("set_layout", {"flow": "vertical", "density": "normal"}),
            ("execute_command", {"command": "x"}),
        ]
        for name, arguments in denied:
            before = copy.deepcopy(tools.plan)
            with self.assertRaises(ValueError, msg=name):
                tools.call(name, arguments)
            self.assertEqual(before, tools.plan)


class ApiLoopAcceptanceTests(unittest.TestCase):
    def test_api_context_describes_available_inputs_and_is_visible(self):
        runtime = RecordingRuntime()
        context = {"scope": "organize", "board": board_snapshot()}
        with patch.object(server, "run_api", return_value="complete") as transport:
            server.WhiteboardHandler.run_api_turn(runtime, api_settings(), "fixture", "q", context, None, [])

        prompt = transport.call_args.args[2]
        self.assertNotIn("first inspect", prompt)
        self.assertNotIn("verify current code", prompt)
        self.assertNotIn("Return exactly one item", prompt)
        self.assertNotIn(TEST_ONLY_KEY, prompt)
        self.assertIn({"type": "context", "text": prompt}, runtime.events)
        self.assertIn("verify current code", server.build_prompt("ask", "q", context))

    @case_ids("L01")
    def test_native_tool_roundtrip_uses_shared_fixture(self):
        tools = BoardTools(board_snapshot(), server.parse_map, writable=True)
        opener = Mock()
        opener.open.side_effect = [
            response({"content": None, "tool_calls": [tool_call("update_node", {"id": "A01", "title": "Updated"})]}),
            response({"content": "complete"}),
        ]
        self.assertEqual(api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener, board_tools=tools), "complete")
        payload = json.loads(opener.open.call_args.args[0].data)
        self.assertEqual(payload["messages"][-1]["role"], "tool")
        self.assertNotIn(TEST_ONLY_KEY, json.dumps(payload))

    @case_ids("L02")
    def test_invalid_tool_then_valid_correction_is_safe(self):
        tools = BoardTools(board_snapshot(), server.parse_map, writable=True)
        opener = Mock()
        opener.open.side_effect = [
            response({"content": None, "tool_calls": [tool_call("execute_command", {})]}),
            response({"content": None, "tool_calls": [tool_call("update_node", {"id": "A01", "title": "Corrected"})]}),
            response({"content": "corrected"}),
        ]
        self.assertEqual(api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener, board_tools=tools), "corrected")
        self.assertEqual(tools.call("get_node", {"id": "A01"})["title"], "Corrected")

    @case_ids("L03", "L05")
    def test_budget_or_cancel_after_draft_change_never_emits_map(self):
        for error_text in ("工具调用次数超限，未应用白板改动。", "请求已取消，未应用白板改动。"):
            runtime = RecordingRuntime()
            original = board_snapshot()
            with tempfile.TemporaryDirectory() as directory:
                schema_path = Path(directory) / "map-schema.json"
                schema_path.write_text("{}", encoding="utf-8")

                def mutate_then_abort(*args, **kwargs):
                    kwargs["board_tools"].call("update_node", {"id": "A01", "title": "Should remain staged"})
                    raise ValueError(error_text)

                with patch.object(server, "run_api", mutate_then_abort):
                    server.WhiteboardHandler.run_api_turn(
                        runtime, api_settings(), "fixture", "q", {"board": original, "scope": "organize"}, schema_path, []
                    )
            self.assertEqual(original, board_snapshot())
            self.assertFalse(any(event["type"] == "map" for event in runtime.events))
            self.assertEqual(runtime.events[-1]["type"], "error")

    @case_ids("L04")
    def test_transport_errors_redact_test_material(self):
        for failure in (TimeoutError(), ValueError("not used")):
            opener = Mock()
            opener.open.side_effect = failure
            with self.assertRaises(ValueError) as captured:
                api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener)
            self.assertNotIn(TEST_ONLY_KEY, str(captured.exception))

    @case_ids("L01", "T09")
    def test_tool_call_ids_pair_results_and_invalid_batches_execute_nothing(self):
        tools = BoardTools(board_snapshot(), server.parse_map, writable=True)
        opener = Mock()
        opener.open.side_effect = [
            response({"content": None, "tool_calls": [
                tool_call("update_node", {"id": "A01", "title": "First"}, "call-first"),
                tool_call("get_node", {"id": "A01"}, "call-second"),
            ]}),
            response({"content": "complete"}),
        ]
        self.assertEqual(api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener, board_tools=tools), "complete")
        request_payload = json.loads(opener.open.call_args.args[0].data)
        tool_messages = [message for message in request_payload["messages"] if message["role"] == "tool"]
        self.assertEqual([message["tool_call_id"] for message in tool_messages], ["call-first", "call-second"])

        invalid_batches = [
            [tool_call("update_node", {"id": "A01", "title": "first"}, "duplicate"),
             tool_call("update_node", {"id": "A01", "title": "second"}, "duplicate")],
            [tool_call("update_node", {"id": "A01", "title": "first"}, "valid-before-bad"),
             {"type": "function", "function": {"name": "update_node", "arguments": "{}"}}],
            [tool_call("update_node", {"id": "A01", "title": "first"}, "bad-json"),
             {"id": "wrong-type", "type": "not-function", "function": {"name": "update_node", "arguments": "{}"}}],
        ]
        for calls in invalid_batches:
            candidate = BoardTools(board_snapshot(), server.parse_map, writable=True)
            before = copy.deepcopy(candidate.plan)
            bad_opener = Mock()
            bad_opener.open.return_value = response({"content": None, "tool_calls": calls})
            with self.assertRaisesRegex(ValueError, "工具调用"):
                api_backend.run_api(api_settings(), "fixture", "q", [], opener=bad_opener, board_tools=candidate)
            self.assertEqual(candidate.plan, before, "A malformed batch must run no earlier valid call.")

    @case_ids("L02", "T09")
    def test_conflicting_tool_batch_rolls_back_but_later_round_can_correct(self):
        tools = BoardTools(board_snapshot(), server.parse_map, writable=True)
        before = copy.deepcopy(tools.plan)
        opener = Mock()
        opener.open.side_effect = [
            response({"content": None, "tool_calls": [
                tool_call("update_node", {"id": "A01", "title": "would-write"}, "valid"),
                tool_call("archive_node", {"id": "E01", "archived": True}, "conflict"),
            ]}),
            response({"content": "after correction"}),
        ]
        self.assertEqual(api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener, board_tools=tools), "after correction")
        self.assertEqual(tools.plan, before, "A semantically rejected call rolls back its whole round.")

    @case_ids("L03")
    def test_normalized_smaller_api_budget_is_the_execution_budget(self):
        payload = {
            "backend": "api", "model": "fixture", "mode": "ask", "question": "fixture question",
            "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY},
            "budget": {"timeoutSeconds": 7, "maxRounds": 1, "maxToolCalls": 1},
        }
        body = json.dumps(payload).encode("utf-8")
        request = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual(request.budget, {"timeoutSeconds": 7, "maxRounds": 1, "maxToolCalls": 1})
        tools = BoardTools(board_snapshot(), server.parse_map, writable=True)
        opener = Mock()
        opener.open.side_effect = [
            response({"content": None, "tool_calls": [tool_call("update_node", {"id": "A01", "title": "staged"})]}),
            response({"content": "too late"}),
        ]
        with self.assertRaisesRegex(ValueError, "轮次"):
            api_backend.run_api(api_settings(), "fixture", "q", [], opener=opener, board_tools=tools, budget=request.budget)
        self.assertTrue(tools.dirty, "The test exercised a staged tool change before the budget boundary.")
        # `run_api` returned no answer, so the controller cannot emit a map; the
        # existing L03 controller test asserts that no staged candidate commits.

    @case_ids("L03")
    def test_budget_rejects_invalid_values_and_clamps_browser_upward_requests(self):
        base = {"backend": "api", "model": "fixture", "mode": "ask", "question": "fixture question",
                "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY}}
        for budget in ({"timeoutSeconds": 0}, {"maxRounds": -1}, {"maxToolCalls": "40"}, {"unknown": 1}):
            body = json.dumps({**base, "budget": budget}).encode("utf-8")
            with self.assertRaises(ValueError):
                server.backend_request_from_body(body, server.parse_request(body))
        raised = json.dumps({**base, "budget": {"timeoutSeconds": 999, "maxRounds": 99, "maxToolCalls": 99}}).encode("utf-8")
        request = server.backend_request_from_body(raised, server.parse_request(raised))
        self.assertEqual(request.budget, {"timeoutSeconds": 180, "maxRounds": 12, "maxToolCalls": 40})
        cli = {"backend": "codex", "model": "", "mode": "ask", "question": "fixture question"}
        cli_raised = json.dumps({**cli, "budget": {"timeoutSeconds": 999}}).encode("utf-8")
        cli_request = server.backend_request_from_body(cli_raised, server.parse_request(cli_raised))
        self.assertEqual(cli_request.budget, {"timeoutSeconds": 300})
        cli_unsupported = json.dumps({**cli, "budget": {"maxRounds": 1}}).encode("utf-8")
        with self.assertRaises(ValueError):
            server.backend_request_from_body(cli_unsupported, server.parse_request(cli_unsupported))


class HttpBoundaryAcceptanceTests(unittest.TestCase):
    @case_ids("F01")
    def test_normalized_request_crosses_http_adapter_and_event_boundary(self):
        fake = FakeEndpointAdapter([("answer", {"text": "answer"}), ("done", {"changedFiles": []})])
        payload = {"backend": "codex", "model": "", "mode": "ask", "question": "fixture question",
                   "requestId": "request-001", "boardId": "fixture-board", "baseRevision": "rev-001"}
        body = json.dumps(payload).encode("utf-8")
        with isolated_server() as (port, host), patch.object(server.FACTORY, "get", return_value=fake):
            status, _, data = post(port, "/api/codex", body, good_headers(host, body))
        self.assertEqual(status, 200)
        request = fake.requests[0]
        self.assertEqual((request.requestId, request.intent, request.boardId, request.baseRevision),
                         ("request-001", "ask", "fixture-board", "rev-001"))
        self.assertEqual(request.permissions, ())
        events = [json.loads(line) for line in data.splitlines()]
        self.assertTrue(all(event["requestId"] == "request-001" and event["baseRevision"] == "rev-001" for event in events))

    @case_ids("H01")
    def test_host_origin_type_and_body_limits_reject_before_adapter(self):
        body = valid_request()
        fake = FakeEndpointAdapter([("answer", {"text": "unused"}), ("done", {"changedFiles": []})])
        with isolated_server() as (port, host), patch.object(server.FACTORY, "get", return_value=fake):
            self.assertNotEqual(port, 8791)
            status, _, _ = post(port, "/api/codex", body, {**good_headers(host, body), "Host": "evil.invalid"})
            self.assertEqual(status, 403)
            status, _, _ = post(port, "/api/codex", body, {**good_headers(host, body), "Origin": "http://evil.invalid"})
            self.assertEqual(status, 403)
            status, _, _ = post(port, "/api/codex", body, {**good_headers(host, body), "Content-Type": "text/plain"})
            self.assertEqual(status, 415)
            too_large = {**good_headers(host, b""), "Content-Length": str(server.MAX_BODY + 1)}
            status, _, _ = post(port, "/api/codex", b"", too_large)
            self.assertEqual(status, 413)
            self.assertEqual(fake.validated, [])

    @case_ids("H02")
    def test_turn_lock_returns_409_then_releases(self):
        entered, release = threading.Event(), threading.Event()
        fake = FakeEndpointAdapter([("status", {"text": "held"}), ("done", {"changedFiles": []})], entered, release)
        body = valid_request()
        with isolated_server() as (port, host), patch.object(server.FACTORY, "get", return_value=fake):
            result = {}

            def first_request():
                result["first"] = post(port, "/api/codex", body, good_headers(host, body))[0]

            worker = threading.Thread(target=first_request)
            worker.start()
            self.assertTrue(entered.wait(2))
            status, _, _ = post(port, "/api/codex", body, good_headers(host, body))
            self.assertEqual(status, 409)
            release.set()
            worker.join(timeout=3)
            self.assertEqual(result.get("first"), 200)
            status, _, _ = post(port, "/api/codex", body, good_headers(host, body))
            self.assertEqual(status, 200)

    @case_ids("H03")
    def test_fake_backends_have_same_ndjson_happy_path(self):
        events = [("status", {"text": "fixture"}), ("answer", {"text": "answer"}), ("done", {"changedFiles": []})]
        with isolated_server() as (port, host):
            for backend in ("api", "codex", "zcode"):
                fake = FakeEndpointAdapter(events)
                body = valid_request(backend)
                with patch.object(server.FACTORY, "get", return_value=fake):
                    status, headers, data = post(port, "/api/codex", body, good_headers(host, body))
                decoded = [json.loads(line) for line in data.splitlines()]
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "application/x-ndjson; charset=utf-8")
                self.assertEqual([event["type"] for event in decoded], ["status", "answer", "done"])

    @case_ids("H03")
    def test_controller_rejects_second_terminal_event(self):
        body = valid_request()
        fake = FakeEndpointAdapter([("answer", {"text": "answer"}), ("done", {"changedFiles": []}),
                                    ("map", {"map": {"title": "late"}}), ("error", {"text": "late", "changedFiles": []})])
        with isolated_server() as (port, host), patch.object(server.FACTORY, "get", return_value=fake):
            status, _, data = post(port, "/api/codex", body, good_headers(host, body))
        decoded = [json.loads(line) for line in data.splitlines()]
        terminal = [event for event in decoded if event["type"] in ("done", "error")]
        self.assertEqual(status, 200)
        self.assertEqual(len(terminal), 1, "The service boundary must enforce exactly one terminal event.")
        self.assertNotIn("map", [event["type"] for event in decoded], "A board candidate after terminal must be rejected too.")

    @case_ids("F01", "L05", "C02")
    def test_same_origin_cancel_routes_active_adapter_token_to_fake_process_only(self):
        adapter = CodexAdapter()
        entered, released, terminated = threading.Event(), threading.Event(), threading.Event()
        fake_process = SimpleNamespace(pid=424242)

        def fake_run_turn(handler, *, request, cancellation):
            handler.headers_for(200, "application/x-ndjson; charset=utf-8")
            cancellation.register(lambda: (terminated.set(), released.set()))
            entered.set()
            released.wait(2)

        active_body = json.dumps({"backend": "codex", "model": "", "mode": "ask", "question": "fixture question",
                                  "requestId": "active-cancel-001"}).encode("utf-8")
        outcome = {}
        with isolated_server() as (port, host), \
             patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
             patch.object(server.FACTORY, "get", return_value=adapter), \
             patch.object(server.WhiteboardHandler, "run_turn", fake_run_turn):
            def active_request():
                outcome["status"] = post(port, "/api/codex", active_body, good_headers(host, active_body))[0]

            worker = threading.Thread(target=active_request)
            worker.start()
            self.assertTrue(entered.wait(2))
            unknown = json.dumps({"requestId": "other-cancel-001"}).encode("utf-8")
            unknown_status, _, _ = post(port, "/api/cancel", unknown, good_headers(host, unknown))
            self.assertEqual(unknown_status, 404)
            self.assertFalse(terminated.is_set(), "An unrelated ID must not stop the active request.")
            cancel = json.dumps({"requestId": "active-cancel-001"}).encode("utf-8")
            cancel_status, _, _ = post(port, "/api/cancel", cancel, good_headers(host, cancel))
            released.set()
            worker.join(timeout=3)
            self.assertEqual(cancel_status, 202)
            self.assertTrue(terminated.is_set(), "The endpoint must reach the adapter token's process hook.")
            repeat_status, _, _ = post(port, "/api/cancel", cancel, good_headers(host, cancel))
            self.assertIn(repeat_status, (404, 409))
            self.assertEqual(outcome.get("status"), 200)


class CliAndWorkspaceAcceptanceTests(unittest.TestCase):
    def test_backend_sources_are_readable_and_valid_organization_evidence(self):
        files = ["backends.py", "api_backend.py", "board_tools.py"]
        self.assertEqual(server.parse_sources(files), files)
        for name in files:
            self.assertIn("text", zcode_workspace.call_tool(ROOT, "ask", "read_file", {"path": name, "limit": 80}))
            with self.assertRaises(ValueError):
                zcode_workspace.file_path(ROOT, name, write=True)

    @case_ids("C02")
    def test_codex_edit_without_attachments_uses_temporary_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            original = root / "app.js"
            original.write_text("before", encoding="utf-8")
            token = server.CancellationToken()
            handler = object.__new__(server.WhiteboardHandler)

            def run_staged_agent(backend, model, mode, question, context, schema_path,
                                 workspace, before, files, *, request, cancellation):
                self.assertEqual((backend, mode, files), ("codex", "edit", []))
                self.assertNotEqual(workspace, root)
                staged = workspace / "app.js"
                self.assertEqual(staged.read_text(encoding="utf-8"), "before")
                staged.write_text("after", encoding="utf-8")
                self.assertEqual(original.read_text(encoding="utf-8"), "before")
                self.assertTrue(cancellation.cancel())
                self.assertFalse(server.apply_staged_edits(workspace, before, cancellation=cancellation))

            handler.run_agent = run_staged_agent
            with patch.object(server, "ROOT", root), patch.object(server, "MAP_SOURCE_FILES", ("app.js",)), \
                 patch.object(server, "STATIC", {"app.js": "text/javascript"}):
                handler.run_turn("codex", "", "edit", "Edit app.js", {}, attachments=[], cancellation=token)
            self.assertEqual(original.read_text(encoding="utf-8"), "before")

    @case_ids("C02", "L05")
    def test_staged_edit_cancel_and_commit_are_linearized_without_sleep(self):
        """Barrier/Event orders prove cancellation cannot pass the write boundary."""
        class CommitFirstToken(server.CancellationToken):
            def __init__(self, claimed, allow_write):
                super().__init__()
                self.claimed = claimed
                self.allow_write = allow_write

            def claim_commit(self):
                outcome = super().claim_commit()
                self.claimed.set()
                self.allow_write.wait(2)
                return outcome

        def stage(root, workspace):
            (root / "app.js").write_text("before", encoding="utf-8")
            (workspace / "app.js").write_text("after", encoding="utf-8")
            return {"app.js": hashlib.sha256(b"before").digest()}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"; workspace = Path(directory) / "workspace"
            root.mkdir(); workspace.mkdir(); before = stage(root, workspace)
            token = server.CancellationToken()
            cancelled = threading.Event()
            started = threading.Barrier(2)

            def cancel_first():
                started.wait(2)
                self.assertTrue(token.cancel())
                cancelled.set()

            worker = threading.Thread(target=cancel_first)
            worker.start()
            started.wait(2)
            self.assertTrue(cancelled.wait(2))
            with patch.object(server, "ROOT", root), patch.object(server, "STATIC", {"app.js": "text/javascript"}):
                self.assertFalse(server.apply_staged_edits(workspace, before, cancellation=token))
            worker.join(timeout=2)
            self.assertEqual((root / "app.js").read_text(encoding="utf-8"), "before")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"; workspace = Path(directory) / "workspace"
            root.mkdir(); workspace.mkdir(); before = stage(root, workspace)
            claimed, allow_write, cancel_done = threading.Event(), threading.Event(), threading.Event()
            token = CommitFirstToken(claimed, allow_write)
            cancel_result = []

            def cancel_after_claim():
                self.assertTrue(claimed.wait(2))
                cancel_result.append(token.cancel())
                cancel_done.set()

            worker = threading.Thread(target=cancel_after_claim)
            worker.start()
            with patch.object(server, "ROOT", root), patch.object(server, "STATIC", {"app.js": "text/javascript"}):
                def release_after_cancel():
                    self.assertTrue(cancel_done.wait(2))
                    allow_write.set()
                releaser = threading.Thread(target=release_after_cancel)
                releaser.start()
                self.assertTrue(server.apply_staged_edits(workspace, before, cancellation=token))
                releaser.join(timeout=2)
            worker.join(timeout=2)
            self.assertEqual(cancel_result, [False], "commit winner must not report cancellation prevented it")
            self.assertEqual((root / "app.js").read_text(encoding="utf-8"), "after")

    @case_ids("C01")
    def test_missing_cli_is_specific_and_never_falls_back(self):
        runtime = RecordingRuntime()
        with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), patch.object(server.subprocess, "Popen", side_effect=OSError("missing")):
            server.WhiteboardHandler.run_agent(runtime, "codex", "", "ask", "q", {}, None, HERE, {}, [])
        self.assertEqual([event["type"] for event in runtime.events], ["status", "error"])
        self.assertIn("无法启动本机 Codex CLI", runtime.events[-1]["text"])

    @case_ids("C02")
    def test_cancelled_fake_cli_with_attachment_is_terminated(self):
        class FakeProcess:
            pid = 999999
            returncode = 0

            def __init__(self):
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO()

            def poll(self):
                return None

            def wait(self, timeout=None):
                return 0

        runtime = RecordingRuntime(disconnected=True)
        process = FakeProcess()
        attachment = HERE / "fixtures" / "attachment.txt"
        before = hashlib.sha256(attachment.read_bytes()).hexdigest()
        files = [{"path": "attachment.txt", "name": "attachment.txt", "size": attachment.stat().st_size}]
        terminated = []
        with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
             patch.object(server.subprocess, "Popen", return_value=process), \
             patch.object(server, "terminate", side_effect=lambda value: terminated.append(value)):
            server.WhiteboardHandler.run_agent(runtime, "codex", "", "ask", "q", {}, None, attachment.parent, {}, files)
        self.assertEqual(terminated, [process])
        self.assertEqual(hashlib.sha256(attachment.read_bytes()).hexdigest(), before)

    @case_ids("C02", "L05")
    def test_cli_eof_then_cancel_never_applies_staged_edits_or_success_events(self):
        class Runtime(RecordingRuntime):
            def __init__(self):
                super().__init__()
                self.after_eof = False

            def disconnected(self):
                return self.after_eof

        class FakeProcess:
            pid = 777777
            returncode = 0

            def __init__(self, runtime):
                self.runtime = runtime
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO()

            def poll(self):
                return None

            def wait(self, timeout=None):
                self.runtime.after_eof = True
                return 0

        runtime = Runtime()
        process = FakeProcess(runtime)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            applied = []

            def emit_eof(_process, events):
                events.put(("answer", "finished edit"))
                events.put(("eof", ""))

            with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
                 patch.object(server.subprocess, "Popen", return_value=process), \
                 patch.object(server, "read_events", emit_eof), \
                 patch.object(server, "terminate"), \
                 patch.object(server, "apply_staged_edits", side_effect=lambda *args: applied.append(args)):
                server.WhiteboardHandler.run_agent(runtime, "codex", "", "edit", "q", {}, None, workspace,
                                                   server.source_hashes(), [])
        self.assertEqual(applied, [], "Cancellation after EOF must win before staged source application.")
        self.assertFalse(any(event["type"] in ("map", "answer", "done") for event in runtime.events))

    @case_ids("C03")
    def test_workspace_tools_reject_invalid_and_read_only_writes(self):
        workspace = HERE / "fixtures" / "zcode_workspace"
        index = workspace / "index.html"
        before = index.read_bytes()
        with self.assertRaises(ValueError):
            zcode_workspace.call_tool(workspace, "ask", "replace_text", {"path": "index.html", "before": "fixture", "after": "changed"})
        with self.assertRaises(ValueError):
            zcode_workspace.call_tool(workspace, "edit", "replace_text", {"path": "../server.py", "before": "x", "after": "y"})
        self.assertEqual(index.read_bytes(), before)


class BrowserGateStaticEvidenceTests(unittest.TestCase):
    @case_ids("U02")
    def test_static_key_nonpersistence_evidence(self):
        source = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("delete lastPayload.api", source)
        self.assertNotIn("connection.apiKey", source)

    @case_ids("U04")
    def test_conflict_protection_is_not_api_only(self):
        source = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertNotIn(
            'target.backend === "api" ? JSON.stringify(organization) : null',
            source,
            "Stale-result protection must apply to Codex and ZCode as well as API.",
        )

    @case_ids("U05")
    def test_static_stop_control_aborts_fetch_and_uses_same_origin_cancel(self):
        source = (ROOT / "app.js").read_text(encoding="utf-8")
        gate = (ROOT / "run_gate.js").read_text(encoding="utf-8")
        markup = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="stop-ai"', markup)
        self.assertIn('src="run_gate.js"', markup)
        self.assertIn('fetch("/api/cancel"', source)
        self.assertIn("acceptsRunEvent(run)", source)
        self.assertIn("run.stopping", gate)
        self.assertIn("run.controller.abort()", gate)

    @case_ids("U05")
    def test_delayed_cancel_behavior_blocks_late_map_and_done(self):
        completed = subprocess.run(["node", str(ROOT / "test_run_gate.js")], cwd=ROOT,
                                   text=True, capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("run gate behavior: PASS", completed.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
