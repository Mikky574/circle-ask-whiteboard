"""External-agent handoff through a real HTTP endpoint and temporary SQLite."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import board_store


HELPER = Path(__file__).parent / ".agents/skills/whiteboard-service/scripts/whiteboard_service.py"
spec = importlib.util.spec_from_file_location("whiteboard_service", HELPER)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
IDENTITY = "board-" + "c" * 32


def fixture():
    memory = {"project": {"goal": "保留目标", "constraints": ["保留约束"], "decisions": []},
              "notes": [{"id": "A30", "answer": "原始模型回答", "payload": {"question": "原问题"}}],
              "pinnedIds": ["E04"], "deletedIds": ["E80"], "futureMemory": {"data": [1, 2]}}
    items = [{"id": "E04", "parentId": None, "title": "项目", "summary": "总览", "category": "main", "unknown": 3},
             {"id": "E18", "parentId": "E04", "title": "存储", "summary": "旧说明", "category": "reference"},
             {"id": "A30", "parentId": "E18", "title": "讨论", "summary": "原始摘要", "category": "reference", "nativeFace": True},
             {"id": "E50", "parentId": None, "title": "其他树", "summary": "不要碰", "category": "reference"}]
    organization = {"current": {"items": items, "positions": {"E04": {"x": 10, "y": 20}},
                                 "collapsedBranches": ["E18"], "unknownLayout": {"x": True}},
                    "previous": {"items": [{"id": "E90", "parentId": None}]}, "undoAvailable": True,
                    "rawPositions": {"E50": {"x": 300, "y": 200}}, "futureOrganization": "keep"}
    return {"memory": json.dumps(memory, ensure_ascii=False, indent=2),
            "organization": json.dumps(organization, ensure_ascii=False, indent=2),
            "templateBackup": '["{\\"id\\":\\"E99\\"}",null]',
            "guideBackup": '{"values":[null,null],"unknown":"keep"}'}


class Handler(BaseHTTPRequestHandler):
    calls = []
    redirect = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        if self.headers.get("Origin") != origin:
            self.send_error(403)
            return
        if type(self).redirect:
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/should-not-follow")
            self.end_headers()
            return
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append(data["action"])
        try:
            result = board_store.board_store_request(data)
            status = 200
        except board_store.BoardStoreError as error:
            result = {"text": str(error), **error.details}
            status = error.status
        raw = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="whiteboard-service-test-")
        self.env = patch.dict(os.environ, {"WHITEBOARD_BOARDS_FILE": str(Path(self.tmp.name) / "boards.sqlite3")})
        self.env.start()
        Handler.redirect = False
        self.client = service.Client(self.url)
        self.original = self.client.call("save", id=IDENTITY, expectedRevision=0,
                                         metadata={"title": "测试白板", "repositoryPath": "C:/example"}, storage=fixture())["board"]
        Handler.calls.clear()
        Handler.redirect = False

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def proposal(self):
        return {"rootId": "E04", "updates": [{"id": "E18", "summary": "服务端保存并发与刷新"}],
                "children": [{"ref": "chapter", "parentId": "E18", "title": "共享存储", "summary": "新增一层", "collapsed": True,
                              "position": {"x": 500, "y": 200, "width": 320},
                              "children": [{"ref": "detail", "title": "CAS", "summary": "新版本号校验", "repositoryFiles": [".agents/skills/whiteboard-service/SKILL.md"]}]}]}

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = service.main(["--url", self.url, *args])
        return status, json.loads(out.getvalue() or err.getvalue())

    def file(self, proposal):
        path = Path(self.tmp.name) / "proposal.json"
        path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def test_read_find_and_dry_run_never_save(self):
        status, read = self.cli("read", "--board", IDENTITY, "--node", "E18")
        self.assertEqual(status, 0)
        self.assertEqual([entry["id"] for entry in read["path"]], ["E04", "E18"])
        self.assertEqual(read["children"][0]["id"], "A30")
        status, found = self.cli("find", "--board", IDENTITY, "--query", "存储")
        self.assertEqual(found["matches"][0]["id"], "E18")
        status, preview = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(self.proposal()))
        self.assertEqual(status, 0)
        self.assertFalse(preview["committed"])
        self.assertEqual(preview["assigned"], {"chapter": "E100", "detail": "E101"})
        self.assertNotIn("save", Handler.calls)
        self.assertEqual(self.client.call("load", id=IDENTITY)["board"]["storage"], self.original["storage"])

    def test_commits_nested_tree_once_preserving_every_other_field(self):
        receipt = Path(self.tmp.name) / "receipt.json"
        status, result = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(self.proposal()), "--commit", "--receipt", str(receipt))
        self.assertEqual(status, 0, result)
        self.assertTrue(result["verified"])
        self.assertEqual(result["revision"], 2)
        self.assertEqual(Handler.calls.count("save"), 1)
        saved = self.client.call("load", id=IDENTITY)["board"]
        for key in ("memory", "templateBackup", "guideBackup"):
            self.assertEqual(saved["storage"][key], self.original["storage"][key])
        old = json.loads(self.original["storage"]["organization"])
        new = json.loads(saved["storage"]["organization"])
        for key, value in old.items():
            if key != "current": self.assertEqual(new[key], value)
        self.assertEqual(new["current"]["items"][3], old["current"]["items"][3])
        self.assertEqual(new["current"]["items"][0], old["current"]["items"][0])
        self.assertEqual(new["current"]["positions"]["E04"], old["current"]["positions"]["E04"])
        self.assertEqual(new["current"]["collapsedBranches"], ["E18", "E100"])
        self.assertEqual(new["current"]["items"][-1]["parentId"], "E100")
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8")), result)

    def test_forward_reference_and_note_overlay_preserve_original_answer(self):
        proposal = {"rootId": "E04", "updates": [{"id": "A30", "summary": "修订后的讨论"}],
                    "children": [{"ref": "detail", "parentId": "@chapter", "title": "详细", "summary": "说明"},
                                 {"ref": "chapter", "parentId": "E18", "title": "章", "summary": "说明"}]}
        candidate, receipt = service.propose(self.original, proposal, 1)
        org = json.loads(candidate["storage"]["organization"])
        notes = {item["id"]: item for item in org["current"]["items"]}
        self.assertTrue(notes["A30"]["localContent"])
        self.assertEqual(notes[receipt["assigned"]["detail"]]["parentId"], receipt["assigned"]["chapter"])
        self.assertEqual(candidate["storage"]["memory"], self.original["storage"]["memory"])

    def test_invalid_scope_cycle_pin_and_render_truncation_make_no_save(self):
        proposals = [
            {"rootId": "E18", "updates": [{"id": "E50", "summary": "越界"}]},
            {"rootId": "E04", "updates": [{"id": "E04", "category": "archive"}]},
            {"rootId": "E04", "children": [{"parentId": "E50", "title": "越界", "summary": "无"}]},
            {"rootId": "E04", "children": [{"ref": "a", "parentId": "@b", "title": "a", "summary": "a"},
                                             {"ref": "b", "parentId": "@a", "title": "b", "summary": "b"}]},
            {"rootId": "E04", "updates": [{"id": "E18", "parentId": "E50"}]},
            {"rootId": "E04", "updates": [{"id": "E18", "summary": "长" * 801}]},
            {"rootId": "E04", "updates": [{"id": "E18", "sources": ["ignored-file.md"]}]},
            {"rootId": "E04", "updates": [{"id": "E18", "repositoryFiles": ["../secret"]}]},
        ]
        for proposal in proposals:
            with self.subTest(proposal=proposal):
                status, result = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(proposal), "--commit")
                self.assertEqual(status, 1, result)
        self.assertNotIn("save", Handler.calls)

    def test_stale_precondition_and_cas_race_never_retry(self):
        candidate, _ = service.propose(self.original, self.proposal(), 1)
        self.client.call("save", id=IDENTITY, expectedRevision=1, metadata={"title": "新版本"}, storage=candidate["storage"])
        Handler.calls.clear()
        with self.assertRaises(service.ServiceError):
            self.client.call("save", id=IDENTITY, expectedRevision=1, metadata={"title": "旧提案"}, storage=self.original["storage"])
        self.assertEqual(Handler.calls.count("save"), 1)
        Handler.calls.clear()
        status, _ = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(self.proposal()), "--commit")
        self.assertEqual(status, 1)
        self.assertNotIn("save", Handler.calls)

    def test_only_loopback_http_without_proxy_or_redirect(self):
        for url in ("https://127.0.0.1:8791", "http://example.com:8791", "http://127.0.0.1:0", "http://127.0.0.1:8791@other.test", "http://127.0.0.1:8791/path", "http://localhost:8791/?key=secret"):
            with self.subTest(url=url), self.assertRaises(service.ServiceError):
                service.Client(url)
        Handler.redirect = True
        with self.assertRaisesRegex(service.ServiceError, "重定向"):
            self.client.call("list")


if __name__ == "__main__":
    unittest.main()
