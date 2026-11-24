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
import card_search
import jev_decision
import server
import zcode_backend
import zcode_workspace
from agent_trace import DETAIL_LIMIT
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

    def test_explicit_multilevel_tasks_emit_real_parent_indices(self):
        request = self.request_body()
        request["minimumDepth"] = 2
        request["decomposition"]["limit"] = 3
        root = self.children()[0]
        children = [
            {**root, "parentIndex": None},
            {**root, "title": "盘点键名", "parentIndex": 0},
            {**root, "title": "检查序列化结果", "parentIndex": 1},
        ]
        body = json.dumps(request).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps({"children": children})) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "children", "done"])
        self.assertEqual(events[2]["children"], children)
        self.assertIn("at least two and at most 3 new task levels", api.call_args.args[2])
        self.assertIn("parentIndex", api.call_args.args[4]["properties"]["children"]["items"]["required"])
        self.assertEqual(events[-1]["changedFiles"], [])

    def test_multilevel_tasks_validate_before_emitting_candidates(self):
        request = self.request_body()
        request["minimumDepth"] = 2
        request["decomposition"]["limit"] = 4
        body = json.dumps(request).encode()
        base = self.children()[0]
        for parents, message in (
                ([None, None], "多级拆分至少需要"),
                ([None, 1], "parentIndex"),
                ([None, True], "parentIndex"),
                ([None, -1], "parentIndex"),
                ([None, 0, 1, 2], "层级超出")):
            with self.subTest(parents=parents):
                candidate = {"children": [{**base, "title": f"任务 {index}", "parentIndex": parent}
                                          for index, parent in enumerate(parents)]}
                context = server.parse_request(body)[2]
                with self.assertRaisesRegex(ValueError, message):
                    server.structured_candidate(json.dumps(candidate), context)
        candidate = {"children": [base, {**base, "title": "附带细节", "parentIndex": 0}]}
        legacy_context = server.parse_request(json.dumps(self.request_body()).encode())[2]
        with self.assertRaisesRegex(ValueError, "层级超出"):
            server.structured_candidate(json.dumps(candidate), legacy_context)
        request["decomposition"]["limit"] = 1
        with self.assertRaisesRegex(ValueError, "预留两个"):
            server.parse_request(json.dumps(request).encode())

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

        def emit_zcode(process, prompt, model, mode, workspace, events, files, **kwargs):
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


class CardExpansionAcceptanceTests(unittest.TestCase):
    @staticmethod
    def request_body():
        root = {"id": "E04", "parentId": None, "title": "项目", "summary": "优先保护用户数据。", "pinned": True}
        target = {"id": "E12", "parentId": "E04", "title": "数据恢复", "summary": "从本地备份恢复状态。", "pinned": False}
        child = {"id": "E13", "parentId": "E12", "title": "备份入口", "summary": "用户可导出备份。", "pinned": False}
        return {
            "backend": "api", "model": "fixture", "mode": "ask", "scope": "expandCard",
            "question": "恢复失败时怎么验证数据完整性？",
            "api": {"baseUrl": "https://example.invalid/v1", "apiKey": TEST_ONLY_KEY},
            "anchor": {"elementIds": ["E12"]},
            "project": {"expansion": {"targetId": "E12", "path": [root, target], "children": [child], "pinned": [root]}},
        }

    @staticmethod
    def candidate():
        return {"children": [
            {"title": "校验备份格式", "summary": "待查证：恢复前是否拒绝格式错误的备份？"},
            {"title": "验证失败时保留数据", "summary": "用损坏备份触发恢复失败，并比较失败前后的现有数据。"},
        ]}

    def test_api_receives_path_pins_and_question_without_board_tools(self):
        request = self.request_body()
        candidate = self.candidate()
        body = json.dumps(request).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(candidate)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "children", "done"])
        self.assertEqual(events[2]["children"], candidate["children"])
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        self.assertEqual(set(api.call_args.args[4]["properties"]["children"]["items"]["required"]),
                         {"title", "summary"})
        for phrase in (request["question"], "优先保护用户数据。", "备份入口", "flag what needs a source check"):
            self.assertIn(phrase, api.call_args.args[2])
        self.assertNotIn(TEST_ONLY_KEY, raw.decode())
        parsed = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual((parsed.intent, parsed.permissions), ("expandCard", ()))

    def test_api_expands_a_blank_confirmation_directly(self):
        request = {**self.request_body(), "question": ""}
        result = self.candidate()
        body = json.dumps(request).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(result)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "children", "done"])
        self.assertEqual(events[2]["children"], result["children"])
        self.assertEqual(api.call_count, 1)
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        self.assertEqual(api.call_args.args[4]["required"], ["children"])
        for phrase in ("most useful unresolved detail", "Generate the new cards immediately", "数据恢复", "备份入口",
                       "优先保护用户数据。"):
            self.assertIn(phrase, api.call_args.args[2])
        self.assertNotIn(TEST_ONLY_KEY, raw.decode())
        parsed = server.backend_request_from_body(body, server.parse_request(body))
        self.assertEqual((parsed.intent, parsed.question, parsed.permissions), ("expandCard", "", ()))

    def test_request_rejects_nonmatching_tree_and_write_scope(self):
        expansion = self.request_body()["project"]["expansion"]
        invalid_project = {"expansion": {**expansion, "children": [{**expansion["children"][0], "parentId": "E04"}]}}
        request = self.request_body()
        for update in ({"project": invalid_project}, {"anchor": {"elementIds": ["E04"]}}, {"mode": "edit"},
                       {"board": board_snapshot()}, {"minimumDepth": 2}):
            with self.subTest(scope=request["scope"], update=update), self.assertRaises(ValueError):
                server.parse_request(json.dumps({**request, **update}).encode())

    def test_candidate_rejects_reparenting_duplicate_and_invalid_card_lengths(self):
        context = server.parse_request(json.dumps(self.request_body()).encode())[2]
        first, second = self.candidate()["children"]
        self.assertEqual(server.structured_candidate(json.dumps({"children": [first]}), context),
                         ("children", {"children": [first]}))
        for children in ([], [{**first, "parentIndex": None}, second], [{**first, "title": "备份入口"}, second],
                         [first, {**second, "summary": "详" * 241}], [first, {**second, "title": "查" * 33}],
                         [first, {"title": second["title"]}], [first, {**second, "summary": ""}]):
            with self.subTest(children=children), self.assertRaises(ValueError):
                server.structured_candidate(json.dumps({"children": children}), context)

    def test_blank_question_is_only_valid_for_card_expansion(self):
        request = {**self.request_body(), "scope": "board", "question": " "}
        with self.assertRaises(ValueError):
            server.parse_request(json.dumps(request).encode())


class CardSearchAcceptanceTests(unittest.TestCase):
    def test_offline_search_http_boundary_and_lexical_ranking(self):
        cards = [
            {"id": "E12", "title": "检测框还原", "summary": "去掉补边，换算回原图坐标。", "path": "识别流程"},
            {"id": "E14", "title": "分类图像", "summary": "裁图后把像素转换成张量。", "path": "识别流程"},
        ]
        body = json.dumps({"query": "检测框怎么换回坐标？", "cards": cards}).encode()
        with isolated_server() as (port, host), patch.object(card_search, "semantic_scores", return_value=None):
            status, _, raw = post(port, "/api/card-search", body, good_headers(host, body))
            self.assertEqual((status, json.loads(raw)), (200, {"matches": ["E12"], "mode": "lexical"}))
            foreign = {**good_headers(host, body), "Origin": "https://outside.example"}
            self.assertEqual(post(port, "/api/card-search", body, foreign)[0], 403)
            invalid = json.dumps({"query": "坐标", "cards": [cards[0], cards[0]]}).encode()
            self.assertEqual(post(port, "/api/card-search", invalid, good_headers(host, invalid))[0], 400)

    def test_offline_semantic_ranking_can_find_a_card_without_a_keyword_match(self):
        payload = {"query": "停电会怎样", "cards": [
            {"id": "E12", "title": "事件传输断线恢复", "summary": "断点持久化后可重连。", "path": ""},
            {"id": "E14", "title": "分类图像", "summary": "裁图后把像素转换成张量。", "path": ""},
        ]}
        with patch.object(card_search, "semantic_scores", return_value=[0.81, 0.24]):
            self.assertEqual(card_search.search_cards(payload), {"matches": ["E12"], "mode": "semantic"})

    def test_long_board_sends_every_card_to_the_local_ranker(self):
        cards = [{"id": f"E{index:02}", "title": f"项目条目 {index}", "summary": "", "path": ""}
                 for index in range(4, 130)]
        with patch.object(card_search, "semantic_scores", return_value=[0.1] * 125 + [0.81]) as scorer:
            self.assertEqual(card_search.search_cards({"query": "停电怎样重连", "cards": cards}),
                             {"matches": ["E129"], "mode": "semantic"})
        scorer.assert_called_once_with("停电怎样重连", cards)

    def test_indexing_returns_accepted_then_exposes_search_results(self):
        cards = [{"id": "E12", "title": "事件回放", "summary": "", "path": ""}]
        with isolated_server() as (port, host), patch.object(card_search, "semantic_scores", side_effect=["indexing", [0.81]]):
            warm = json.dumps({"query": "", "cards": cards}).encode()
            status, _, raw = post(port, "/api/card-search", warm, good_headers(host, warm))
            self.assertEqual((status, json.loads(raw)), (202, {"matches": [], "mode": "indexing"}))
            body = json.dumps({"query": "如何回放", "cards": cards}).encode()
            status, _, raw = post(port, "/api/card-search", body, good_headers(host, body))
            self.assertEqual((status, json.loads(raw)), (200, {"matches": ["E12"], "mode": "semantic"}))

    def test_openjev_reranks_only_first_eight_local_candidates(self):
        cards = [{"id": f"E{index:02}", "title": f"项目条目 {index}", "summary": "摘要", "path": ""}
                 for index in range(4, 16)]
        scores = {card["id"]: 0.2 if index == 0 else 0.5 for index, card in enumerate(cards[:8])}
        scores["E11"] = 0.91
        body = json.dumps({"engine": "jev", "query": "测试问题", "cards": cards}).encode()
        with isolated_server() as (port, host), patch.object(card_search, "semantic_scores", return_value=[0.81] * 12), \
             patch.object(card_search, "relevance", return_value=scores) as relevance:
            status, _, raw = post(port, "/api/card-search", body, good_headers(host, body))
            result = json.loads(raw)
            self.assertEqual(status, 200)
            self.assertEqual(result, {"matches": ["E11", "E05", "E06", "E07", "E08", "E09", "E10"],
                                      "mode": "semantic", "engine": "jev"})
            relevance.assert_called_once_with("测试问题", cards[:8])

    def test_openjev_reports_fallback_but_exact_id_skips_decision(self):
        cards = [{"id": "E12", "title": "事件回放", "summary": "", "path": ""}]
        with patch.object(card_search, "semantic_scores", return_value=[0.81]), \
             patch.object(card_search, "relevance", return_value=None) as relevance:
            exact = card_search.search_cards({"engine": "jev", "query": "e12", "cards": cards})
            relevance.assert_not_called()
            self.assertEqual(exact, {"matches": ["E12"], "mode": "semantic", "engine": "bge"})
            fallback = card_search.search_cards({"engine": "jev", "query": "如何回放", "cards": cards})
            self.assertEqual(fallback, {**exact, "engineUnavailable": True})

    def test_openjev_transport_sends_typed_questions_to_fixed_loopback(self):
        card = {"id": "E12", "title": "事件回放", "summary": "断点持久化", "path": "运行时"}
        with patch.object(jev_decision, "HTTPConnection") as client:
            connection = client.return_value
            response = connection.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"answers":{"E12":{"type":"noul","noul":0.91}}}'
            self.assertEqual(jev_decision.relevance("怎么恢复？", [card]), {"E12": 0.91})
            client.assert_called_once_with("127.0.0.1", 8793, timeout=6)
            method, path, body, headers = connection.request.call_args.args
            self.assertEqual((method, path, headers), ("POST", "/v1/systemone", {"Content-Type": "application/json"}))
            request = json.loads(body)
            self.assertEqual((request["model"], request["state"]), ("laya-1.0", "怎么恢复？"))
            self.assertEqual(request["questions"]["E12"]["type"], "noul")
            self.assertIn("断点持久化", request["questions"]["E12"]["instructions"])
            response.read.return_value = b'{"answers":{"E12":{"type":"noul","noul":true}}}'
            self.assertIsNone(jev_decision.relevance("怎么恢复？", [card]))
            response.status = 302
            self.assertIsNone(jev_decision.relevance("怎么恢复？", [card]))


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
        self.assertIn("标题", events[-1]["text"])
        self.assertIn("重复", events[-1]["text"])

    def test_explicit_multi_level_explanation_retains_parent_indexes(self):
        body = json.dumps({**self.request_body(), "minimumDepth": 2}).encode()
        explanation = {
            "summary": "启动过程",
            "sections": [
                {"title": "加载", "text": "从存储读取信息。", "parentIndex": None},
                {"title": "恢复", "text": "恢复已保存的回复。", "parentIndex": 0},
                {"title": "验证", "text": "检查旧回复是否显示。", "parentIndex": 1},
                {"title": "绘制", "text": "呈现当前白板。", "parentIndex": None},
            ],
        }
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(explanation)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "explanation", "done"])
        self.assertEqual(events[2]["explanation"], explanation)
        self.assertIn("An entirely flat answer is invalid.", api.call_args.args[2])
        schema = api.call_args.args[4]["properties"]["sections"]["items"]
        self.assertIn("parentIndex", schema["required"])

    def test_explicit_multi_level_explanation_rejects_flat_output(self):
        body = json.dumps({**self.request_body(), "minimumDepth": 2}).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(self.explanation())):
            _, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual([event["type"] for event in events], ["status", "context", "error"])
        self.assertIn("多级说明", events[-1]["text"])

    def test_explanation_rejects_invalid_parents_and_excess_depth(self):
        for parents, error in (
            ((0, None), "parentIndex"),
            ((None, 2, 1), "parentIndex"),
            ((None, True), "parentIndex"),
            ((None, -1), "parentIndex"),
            ((None, 0, 1, 2), "层级"),
        ):
            with self.subTest(parents=parents):
                explanation = {
                    "summary": "启动过程",
                    "sections": [
                        {"title": f"步骤 {index}", "text": "加载相关内容。", "parentIndex": parent}
                        for index, parent in enumerate(parents)
                    ],
                }
                with self.assertRaisesRegex(ValueError, error):
                    server.structured_candidate(json.dumps(explanation), {"scope": "explain"})

    def cli_explanation_events(self, backend, answer):
        parsed = server.parse_request(json.dumps(self.request_body()).encode())
        schema = server.write_explanation_schema()
        self.addCleanup(schema.unlink)

        def emit(_process, events):
            events.put(("answer", answer))
            events.put(("eof", ""))

        def emit_zcode(process, prompt, model, mode, workspace, events, files, **kwargs):
            emit(process, events)

        runtime = RecordingRuntime()
        process = Mock(returncode=0)
        with patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
             patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
             patch.object(server.subprocess, "Popen", return_value=process), \
             patch.object(server, "send_prompt"), patch.object(server, "read_events", emit), \
             patch.object(server, "run_zcode", emit_zcode), patch.object(server, "terminate"):
            server.WhiteboardHandler.run_agent(runtime, backend, "fixture", "ask", parsed[1], parsed[2],
                                               schema, ROOT, {}, [])
        return runtime.events

    def zcode_repair_run(self, first, second, **request_options):
        parsed = server.parse_request(json.dumps({**self.request_body(), **request_options}).encode())
        schema = server.write_explanation_schema()
        self.addCleanup(schema.unlink)
        runtime = RecordingRuntime()
        process = Mock(returncode=0, stdin=io.BytesIO())
        connection = Mock()
        connection.request.return_value = {
            "session": {"sessionId": "fixture-session"},
            "settings": {"model": {"available": [], "current": {"modelId": "fixture"}}},
        }
        connection.begin_request.side_effect = [11, 12]
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        workspace = Path(directory.name)
        (workspace / "fixture.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        files = [{"path": "fixture.png", "name": "fixture.png"}]
        with patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
             patch.object(server.subprocess, "Popen", return_value=process) as start_process, \
             patch.object(server, "terminate"), \
             patch.object(zcode_backend, "ZCodeConnection", return_value=connection), \
             patch.object(zcode_backend, "read_turn", side_effect=[first, second]) as read_turn:
            server.WhiteboardHandler.run_agent(runtime, "zcode", "fixture", "ask", parsed[1], parsed[2],
                                               schema, workspace, {}, files)
        start_process.assert_called_once()
        self.assertEqual([call.args[0] for call in connection.request.call_args_list].count("session/create"), 1)
        sends = connection.begin_request.call_args_list
        self.assertEqual(len(sends), read_turn.call_count)
        for call in sends:
            method, params = call.args
            self.assertEqual(method, "session/send")
            self.assertEqual(params["sessionId"], "fixture-session")
        return runtime.events, [call.args[1] for call in sends]

    def test_zcode_repairs_invalid_explanation_once_in_the_same_session(self):
        explanation = self.explanation()
        invalid = json.dumps({**explanation, "sections": explanation["sections"][:1]})
        events, sends = self.zcode_repair_run(invalid, json.dumps(explanation))
        self.assertEqual(len(sends), 2)
        self.assertEqual([attachment["filename"] for attachment in sends[0]["attachments"]], ["fixture.png"])
        self.assertEqual(sends[1]["attachments"], [])
        self.assertIn("本次收到 1 张", sends[1]["content"])
        self.assertEqual([event["type"] for event in events],
                         ["status", "context", "status", "status", "status", "explanation", "done"])
        self.assertIn("创建会话", events[2]["text"])
        self.assertIn("会话已连接", events[3]["text"])
        self.assertIn("自动修正", events[4]["text"])
        self.assertEqual(events[-2]["explanation"], explanation)

    def test_zcode_valid_explanation_does_not_request_repair(self):
        explanation = self.explanation()
        events, sends = self.zcode_repair_run(json.dumps(explanation), "不得使用的第二次结果")
        self.assertEqual(len(sends), 1)
        self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "explanation", "done"])
        self.assertEqual(events[-2]["explanation"], explanation)

    def test_zcode_repairs_flat_output_when_explicit_depth_is_requested(self):
        explanation = self.explanation()
        nested = {**explanation, "sections": [
            {**explanation["sections"][0], "parentIndex": None},
            {**explanation["sections"][1], "parentIndex": 0},
        ]}
        events, sends = self.zcode_repair_run(json.dumps(explanation), json.dumps(nested), minimumDepth=2)
        self.assertEqual(len(sends), 2)
        self.assertIn("多级说明", sends[1]["content"])
        self.assertEqual([event["type"] for event in events],
                         ["status", "context", "status", "status", "status", "explanation", "done"])
        self.assertEqual(events[-2]["explanation"], nested)

    def test_zcode_invalid_repair_keeps_diagnostic_without_partial_cards(self):
        explanation = self.explanation()
        duplicate = [explanation["sections"][0]] * 2
        invalid = json.dumps({**explanation, "sections": duplicate}, ensure_ascii=False)
        events, sends = self.zcode_repair_run("原回答没有 JSON。", invalid)
        self.assertEqual(len(sends), 2)
        self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "status", "error"])
        self.assertIn("标题与前面的卡片重复", events[-1]["text"])
        self.assertIn("白板初始化", events[-1]["responsePreview"])
        self.assertEqual(events[-1]["changedFiles"], [])

    def test_zcode_repair_transport_failure_keeps_original_preview(self):
        original = "原回答没有 JSON，仍需保留用于诊断。"
        events, sends = self.zcode_repair_run(original, zcode_backend.ZCodeError("fixture turn failed"))
        self.assertEqual(len(sends), 2)
        self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "status", "error"])
        self.assertIn("自动修正未返回可用", events[-1]["text"])
        self.assertEqual(events[-1]["responsePreview"], original)

    def test_zcode_repair_with_identical_invalid_response_reports_validation_reason(self):
        invalid = "仍然只返回普通文字。"
        events, sends = self.zcode_repair_run(invalid, invalid)
        self.assertEqual(len(sends), 2)
        self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "status", "error"])
        self.assertIn("找不到可解析的 JSON", events[-1]["text"])
        self.assertEqual(events[-1]["responsePreview"], invalid)

    def test_cli_adapters_emit_same_explanation_candidates(self):
        explanation = self.explanation()
        answer = json.dumps(explanation)
        fence = chr(96) * 3
        wrapped = f"下面是拆解。\n{fence}json\n{answer}\n{fence}\n以上是结构化结果。"
        plain_wrapped = f"下面是拆解：\n{answer}\n以上是结构化结果。"
        for backend, reply in (("codex", answer), ("zcode", wrapped), ("zcode", plain_wrapped)):
            with self.subTest(backend=backend, reply=reply):
                events = self.cli_explanation_events(backend, reply)
                self.assertEqual([event["type"] for event in events], ["status", "context", "explanation", "done"])
                self.assertEqual(events[-2]["explanation"], explanation)

    def test_explanation_validation_identifies_rejected_structure(self):
        explanation = self.explanation()
        duplicate = [explanation["sections"][0]] * 2
        long_title = [{"title": "字" * 73, "text": "正文"}, explanation["sections"][1]]
        long_body = [{**explanation["sections"][0], "text": "字" * 701}, explanation["sections"][1]]
        fence = chr(96) * 3
        valid = json.dumps(explanation)
        block = f"{fence}json\n{valid}\n{fence}"
        invalid = [
            (json.dumps({**explanation, "summary": "字" * 281}), "总览超过 280 字"),
            (json.dumps({**explanation, "sections": explanation["sections"][:1]}), "本次收到 1 张"),
            (json.dumps({**explanation, "sections": duplicate}), "标题与前面的卡片重复"),
            (json.dumps({**explanation, "sections": long_title}), "第 1 张说明卡的标题超过 72 字"),
            (json.dumps({**explanation, "sections": long_body}), "第 1 张说明卡的正文超过 700 字"),
            (json.dumps({"summary": "总览", "children": explanation["sections"]}), "顶层字段必须是 summary 和 sections"),
            ('{"summary":', "找不到可解析的 JSON"),
            (f"说明\n{block}\n另一个候选\n{block}", "多个代码块"),
            (f"说明\n{valid}\n另一个候选\n{valid}", "多个"),
        ]
        for answer, expected in invalid:
            with self.subTest(expected=expected):
                with self.assertRaises(ValueError) as rejected:
                    server.structured_candidate(answer, {"scope": "explain"})
                self.assertIn(expected, str(rejected.exception))

    def test_zcode_invalid_reply_preview_is_redacted_and_bounded(self):
        secret = "fixture-only-key-value"
        answer = f"没有返回结构化结果。\napi_key: {secret}\n" + "样例正文" * 800
        events = self.cli_explanation_events("zcode", answer)
        self.assertEqual([event["type"] for event in events], ["status", "context", "error"])
        preview = events[-1]["responsePreview"]
        self.assertIn("没有返回结构化结果", preview)
        self.assertNotIn(secret, json.dumps(events, ensure_ascii=False))
        self.assertLessEqual(len(preview), DETAIL_LIMIT)


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

    def test_regeneration_sends_the_correction_and_rewrites_the_complete_branch(self):
        request = self.request_body()
        request.update(branchIntent="regenerate", question="补充入口、边界和验证用例。")
        original = request["board"]["nodes"]
        expected = {"items": [
            {"id": node["id"], "parentId": node["layoutParentId"], "title": f"{node['id']} 入口与边界",
             "summary": f"{node['id']} 的证据与验证方法。"}
            for node in original
        ]}
        body = json.dumps(request).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(expected)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["status", "context", "branch", "done"])
        self.assertEqual(events[2]["branch"], expected)
        prompt = api.call_args.args[2]
        self.assertIn("selected root and every descendant", prompt)
        self.assertIn("Every item's parentId must equal its supplied layoutParentId", prompt)
        self.assertIn(request["question"], prompt)
        self.assertNotIn("Reparent other cards", prompt)
        self.assertNotIn("Verify implementation details against", prompt)

    def test_regeneration_rejects_reparenting_and_other_operations(self):
        request = self.request_body()
        request["branchIntent"] = "regenerate"
        context = server.parse_request(json.dumps(request).encode())[2]
        with self.assertRaisesRegex(ValueError, "原有的父节点"):
            server.structured_candidate(json.dumps(self.candidate()), context)
        with self.assertRaises(ValueError):
            server.structured_candidate(json.dumps({"items": self.candidate()["items"][:2]}), context)
        for update in ({"scope": "plan"}, {"branchIntent": "rearrange"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                server.parse_request(json.dumps({**request, **update}).encode())

    def test_card_opinion_returns_optional_fields_and_never_writes(self):
        request = self.request_body()
        request.update(branchIntent="revise", question="只补充入口卡的正文。")
        result = {"items": [{"id": "E02", "title": None, "summary": "新增的入口说明"}]}
        body = json.dumps(request).encode()
        with isolated_server() as (port, host), patch.object(server, "run_api", return_value=json.dumps(result)) as api:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual(events[2]["branch"], result)
        self.assertEqual(events[3]["changedFiles"], [])
        self.assertIsNone(api.call_args.kwargs["board_tools"])
        context = server.parse_request(body)[2]
        for item in ({"id": "E99", "title": "越界卡片", "summary": None},
                     {"id": "E02", "title": None, "summary": "正文", "parentId": "E03"}):
            with self.assertRaises(ValueError):
                server.structured_candidate(json.dumps({"items": [item]}), context)


class StructuredZCodeAcceptanceTests(unittest.TestCase):
    def exchange(self, fields, *answers):
        body = json.dumps({
            "backend": "zcode", "model": "", "mode": "ask", "question": "结构化操作测试",
            "requestId": "structured-fixture", "baseRevision": "fixture-revision", **fields,
        }).encode()
        connection = Mock()
        connection.request.return_value = {
            "session": {"sessionId": "fixture-session"},
            "settings": {"model": {"available": [], "current": {"modelId": "fixture"}}},
        }
        connection.begin_request.side_effect = [11, 12]
        process = Mock(returncode=0, stdin=io.BytesIO())
        with isolated_server() as (port, host), \
             patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
             patch.object(server.subprocess, "Popen", return_value=process) as start_process, \
             patch.object(server, "terminate"), \
             patch.object(zcode_backend, "ZCodeConnection", return_value=connection), \
             patch.object(zcode_backend, "read_turn", side_effect=answers) as read_turn:
            status, _, raw = post(port, "/api/codex", body, good_headers(host, body))
        self.assertEqual(status, 200, raw.decode())
        start_process.assert_called_once()
        self.assertEqual([call.args[0] for call in connection.request.call_args_list].count("session/create"), 1)
        sends = connection.begin_request.call_args_list
        self.assertEqual(len(sends), read_turn.call_count)
        for call in sends:
            method, params = call.args
            self.assertEqual(method, "session/send")
            self.assertEqual(params["sessionId"], "fixture-session")
        events = [json.loads(line) for line in raw.splitlines()]
        for event in events:
            self.assertEqual(event["requestId"], "structured-fixture")
            self.assertEqual(event["baseRevision"], "fixture-revision")
        return events, [call.args[1] for call in sends]

    @staticmethod
    def cases(repository):
        node_fields = BranchOrganizationAcceptanceTests.request_body()
        branch = BranchOrganizationAcceptanceTests.candidate()
        invalid_branch = copy.deepcopy(branch)
        invalid_branch["items"][3]["parentId"] = "E02"
        unchanged_branch = {"items": [
            {**item, "parentId": next(node["layoutParentId"] for node in node_fields["board"]["nodes"]
                                     if node["id"] == item["id"])}
            for item in branch["items"]
        ]}
        map_value = {
            "title": "Project", "summary": "Organized project",
            "layout": {"flow": "columns", "density": "normal"},
            "items": [
                {"id": "E01", "parentId": None, "category": "main", "title": "Project", "summary": "Root"},
                {"id": "A01", "parentId": "E01", "category": "reference", "title": "Note", "summary": "Context"},
            ],
        }
        main_value = {**map_value, "items": [*map_value["items"],
            {"id": "E04", "parentId": "E01", "category": "main", "title": "Core", "summary": "New chapter"},
        ]}
        intro = {
            "title": "Repository", "summary": "Source-supported introduction",
            "layout": {"flow": "horizontal", "density": "compact"},
            "items": [
                {"id": identifier, "parentId": parent, "category": "main" if parent is None else "reference",
                 "title": identifier, "summary": "Open a project and continue reading.", "sources": [],
                 "repositoryFiles": ["src/main.py"],
                 "capability": {"version": 1, "audience": "Project reader", "input": "A project folder",
                                "outcome": "A readable project overview", "boundary": "Local projects",
                                "verification": "Open a known folder and check the displayed project"}}
                for identifier, parent in (
                    ("E04", None), ("E05", "E04"), ("E06", "E04"), ("E07", "E04"), ("E08", "E05"),
                )
            ],
        }
        invalid_intro = copy.deepcopy(intro)
        invalid_intro["items"][-1]["repositoryFiles"] = ["src/missing.py"]
        child_fields = DecompositionAcceptanceTests.request_body()
        children = DecompositionAcceptanceTests.children()
        expansion_fields = CardExpansionAcceptanceTests.request_body()
        expansion = CardExpansionAcceptanceTests.candidate()
        filing = {
            "orphans": [{"id": "E04", "title": "Unfiled", "summary": "Detached"}],
            "parents": [{"id": "E01", "parentId": None, "title": "Root", "summary": "Overview"}],
        }
        return (
            ("plan", {"scope": "plan"}, "answer",
             {"action": "ask"}, {"action": "write"}),
            ("decompose", {key: child_fields[key] for key in ("scope", "anchor", "decomposition")}, "children",
             {"children": children}, {"children": [{**children[0], "title": "盘点键名"}]}),
            ("expandCard", {key: expansion_fields[key] for key in ("scope", "anchor", "project")}, "children",
             expansion, {"children": []}),
            ("organizeBranch", {key: node_fields[key] for key in ("scope", "board", "branchRootId")}, "branch",
             branch, invalid_branch),
            ("regenerate", {key: node_fields[key] for key in ("scope", "board", "branchRootId")} | {"branchIntent": "regenerate"},
             "branch", unchanged_branch, branch),
            ("organize", {"scope": "organize", "board": board_snapshot()}, "map",
             map_value, {key: value for key, value in map_value.items() if key != "layout"}),
            ("main", {"scope": "organize", "board": board_snapshot(), "boardIntent": "main"}, "map",
             main_value, {**main_value, "items": [item for item in main_value["items"] if item["id"] != "A01"]}),
            ("repository_init", {
                "scope": "organize", "boardIntent": "repository_init", "repositoryPath": str(repository),
                "board": {"nodes": [], "newIds": [f"E{number:02}" for number in range(4, 12)]},
            }, "map", intro, invalid_intro),
            ("fileOrphans", {"scope": "fileOrphans", "project": {"filing": filing}}, "answer",
             {"links": [{"childId": "E04", "parentId": "E01"}]}, {"links": [{"childId": "E04", "parentId": "E99"}]}),
        )

    def assert_result(self, events, kind, expected):
        result = events[-2]
        self.assertEqual(result["type"], kind)
        if kind == "answer":
            self.assertEqual(json.loads(result["text"]), expected)
        elif kind == "children":
            self.assertEqual(result["children"], expected["children"])
        else:
            self.assertEqual(result[kind], expected)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["changedFiles"], [])

    def test_zcode_expansion_preserves_the_full_135_character_summary(self):
        expansion = CardExpansionAcceptanceTests.request_body()
        fields = {key: expansion[key] for key in ("scope", "anchor", "project")}
        candidate = CardExpansionAcceptanceTests.candidate()
        candidate["children"][1]["summary"] = "详" * 134 + "。"
        events, sends = self.exchange(fields, json.dumps(candidate))
        self.assertEqual(len(sends), 1)
        self.assert_result(events, "children", candidate)

    def test_wrapped_json_and_scoped_repair_share_the_same_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory).resolve()
            (repository / "src").mkdir()
            (repository / "src" / "main.py").write_text("def main():\n    return 61\n", encoding="utf-8")
            for name, fields, kind, expected, invalid in self.cases(repository):
                with self.subTest(operation=name):
                    wrapped = "以下是整理结果：\n" + json.dumps(expected) + "\n以上是结果。"
                    result = ({**expected, "items": [{**item, "repositoryFiles": ["src/main.py"]} for item in expected["items"]]}
                              if name == "repository_init" else expected)
                    events, sends = self.exchange(fields, wrapped)
                    self.assertEqual(len(sends), 1)
                    self.assert_result(events, kind, result)
                    events, sends = self.exchange(fields, json.dumps(invalid), wrapped)
                    self.assertEqual(len(sends), 2)
                    self.assertEqual(sends[1]["attachments"], [])
                    self.assertIn("JSON", sends[1]["content"])
                    self.assertEqual([event["type"] for event in events],
                                     ["status", "context", "status", "status", "status", kind, "done"])
                    self.assertEqual(events[4].get("phase"), "repair")
                    self.assertIn("自动修正", events[4]["text"])
                    self.assert_result(events, kind, result)

    def test_branch_repair_rejects_a_second_invalid_result_without_partial_events(self):
        branch = BranchOrganizationAcceptanceTests.request_body()
        fields = {key: branch[key] for key in ("scope", "board", "branchRootId")} | {"branchIntent": "regenerate"}
        invalid = json.dumps(BranchOrganizationAcceptanceTests.candidate(), ensure_ascii=False)
        for second, expected_preview in (
            (invalid, "整理后的说明"),
            (zcode_backend.ZCodeError("fixture turn failed"), "首轮只有说明文字"),
        ):
            with self.subTest(second=second):
                events, sends = self.exchange(fields, "首轮只有说明文字", second)
                self.assertEqual(len(sends), 2)
                self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "status", "error"])
                self.assertIn(expected_preview, events[-1]["responsePreview"])
                if isinstance(second, str):
                    self.assertIn("原有的父节点", events[-1]["text"])
                self.assertEqual(events[-1]["changedFiles"], [])

    def test_ambiguous_fenced_and_unfenced_candidates_are_rejected(self):
        fence = chr(96) * 3
        payload = '{"action":"ask"}'
        first = f"说明\n{fence}json\n{payload}\n{fence}\n另一个候选：\n{payload}"
        with self.assertRaisesRegex(ValueError, "多个"):
            server.structured_candidate(first, {"scope": "plan"})

    def test_duplicate_json_keys_are_rejected_instead_of_overwriting_action(self):
        duplicate = '{"action":"ask","action":"edit"}'
        fence = chr(96) * 3
        for answer in (duplicate, f"说明\n{duplicate}\n结束", f"说明\n{fence}json\n{duplicate}\n{fence}"):
            with self.subTest(answer=answer), self.assertRaisesRegex(ValueError, "重复"):
                server.structured_candidate(answer, {"scope": "plan"})

    def test_plain_zcode_answer_remains_plain_and_does_not_trigger_repair(self):
        answer = "这是一段普通回答，用户没有要求生成卡片。"
        events, sends = self.exchange({}, answer)
        self.assertEqual(len(sends), 1)
        self.assertEqual([event["type"] for event in events], ["status", "context", "status", "status", "answer", "done"])
        self.assertEqual(events[-2]["text"], answer)


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
        for backend in ("codex", "zcode"):
            for budget in (None, {"timeoutSeconds": 999}):
                with self.subTest(backend=backend, budget=budget):
                    body = json.dumps({**cli, "backend": backend, "budget": budget}).encode("utf-8")
                    cli_request = server.backend_request_from_body(body, server.parse_request(body))
                    self.assertEqual(cli_request.budget, budget or {})
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
    def test_parallel_requests_have_independent_slots_and_cancellation(self):
        ids = [f"parallel-{n:02}" for n in range(4)]
        entered = {key: threading.Event() for key in ids}
        release = {key: threading.Event() for key in ids}
        result = {}

        def fake_run_turn(handler, *, request, cancellation):
            handler.headers_for(200, "application/x-ndjson; charset=utf-8")
            if request.requestId in entered:
                cancellation.register(release[request.requestId].set)
                entered[request.requestId].set()
                release[request.requestId].wait(6)
            if not cancellation.cancelled():
                handler.send_event("answer", text=request.requestId)
                handler.send_event("done", changedFiles=[])

        with isolated_server() as (port, host), \
             patch.object(server, "CODEX_EXECUTABLE", "fake-codex"), \
             patch.object(server, "ZCODE_COMMAND", ["fake-zcode"]), \
             patch.object(server.WhiteboardHandler, "run_turn", fake_run_turn):
            def send(request_id, backend="codex", mode="ask"):
                body = json.dumps({"backend": backend, "mode": mode, "model": "", "question": "fixture",
                                   "requestId": request_id}).encode()
                return post(port, "/api/codex", body, good_headers(host, body))

            def worker(key, backend):
                result[key] = send(key, backend)

            def cancel(key):
                body = json.dumps({"requestId": key}).encode()
                return post(port, "/api/cancel", body, good_headers(host, body))[0]

            workers = []
            try:
                for index, key in enumerate(ids):
                    thread = threading.Thread(target=worker, args=(key, "zcode" if index == 1 else "codex"))
                    workers.append(thread)
                    thread.start()
                    self.assertTrue(entered[key].wait(2), f"{key} should enter while earlier requests are held")
                self.assertEqual(send("parallel-overflow")[0], 409)
                self.assertEqual(send(ids[0])[0], 409)
                self.assertEqual(cancel(ids[1]), 202)
                workers[1].join(3)
                self.assertEqual(result[ids[1]][0], 200)
                self.assertEqual(result[ids[1]][2], b"")
                self.assertTrue(all(not release[key].is_set() for key in (ids[0], *ids[2:])))
                self.assertEqual(send("parallel-edit", mode="edit")[0], 409)
                self.assertEqual(send("parallel-recovered")[0], 200)
            finally:
                for event in release.values():
                    event.set()
                for thread in workers:
                    thread.join(3)
            for key in (ids[0], *ids[2:]):
                code, _, raw = result[key]
                self.assertEqual(code, 200)
                self.assertEqual(json.loads(raw.splitlines()[0])["text"], key)
            self.assertEqual(send("parallel-edit", mode="edit")[0], 200)

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
