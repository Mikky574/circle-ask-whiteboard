"""External skill acceptance over HTTP and an isolated canonical SQLite store."""

from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

from board_store import BoardStoreError, board_store_request


HELPER = Path(__file__).parent / ".agents/skills/whiteboard-service/scripts/whiteboard_service.py"
spec = importlib.util.spec_from_file_location("whiteboard_service_skill", HELPER)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append(request)
        self.server.origins.append(self.headers.get("Origin"))
        status = 200
        if self.server.mode == "unsupported":
            status, result = 404, {"text": "No API in this legacy service"}
        elif self.server.mode == "html":
            result = "<!doctype html><title>Legacy board</title>"
        elif self.server.mode == "wrong-api":
            result = {"ok": True}
        else:
            try:
                result = board_store_request(request)
            except BoardStoreError as error:
                status, result = error.status, {"text": str(error)}
        raw = (result if isinstance(result, str) else json.dumps(result)).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class WhiteboardServiceSkillTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        configured = patch.dict(os.environ, WHITEBOARD_BOARDS_FILE=str(self.directory / "boards.sqlite3"))
        configured.start()
        self.addCleanup(configured.stop)
        self.identity = "board-" + "a" * 32
        self.storage = {
            "memory": json.dumps({"project": {"goal": "Understand the project"},
                                  "pinnedIds": ["E04"], "notes": [{"id": "A02", "answer": "Original full answer"}]}),
            "organization": json.dumps({
                "current": {"title": "Project", "items": [
                    {"id": "E04", "parentId": None, "title": "Overview", "summary": "Root", "category": "main"},
                    {"id": "E05", "parentId": "E04", "title": "Events", "summary": "Old explanation", "category": "reference"},
                    {"id": "A02", "parentId": "E05", "title": "Discussion", "summary": "Original full answer", "category": "reference"},
                    {"id": "E06", "parentId": "E04", "title": "Another branch", "summary": "Keep this", "category": "reference"}],
                    "positions": {"E05": {"x": 200, "y": 100}}, "collapsedBranches": ["E05"]},
                "previous": {"items": [{"id": "E88"}]}}),
            "templateBackup": '[null,"{}"]', "guideBackup": '{"values":[null,"{}"],"guideId":"v1"}',
        }
        self.saved = board_store_request({"action": "save", "id": self.identity, "expectedRevision": 0,
                                           "metadata": {"title": "Shared project", "repositoryPath": "C:/project"},
                                           "storage": self.storage})["board"]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.calls, self.server.origins, self.server.mode = [], [], "normal"
        thread = Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def run_command(self, *arguments):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = skill.main(["--url", self.origin, *arguments])
        return code, json.loads(out.getvalue() or err.getvalue())

    def proposal_file(self, proposal):
        path = self.directory / "proposal.json"
        path.write_text(json.dumps(proposal), encoding="utf-8")
        return str(path)

    def test_probe_only_reads_the_http_catalog(self):
        code, result = self.run_command("probe")
        self.assertEqual(code, 0)
        self.assertEqual(result, {"url": self.origin, "sharedBoards": True, "boardCount": 1, "readOnly": True})
        self.assertEqual(self.server.calls, [{"action": "list"}])
        self.assertEqual(self.server.origins, [self.origin])

    def test_missing_api_or_html_never_falls_back_or_attempts_a_write(self):
        proposal = self.proposal_file({"rootId": "E05", "updates": [{"id": "E05", "summary": "New"}]})
        for mode in ("unsupported", "html", "wrong-api"):
            with self.subTest(mode=mode):
                self.server.mode, self.server.calls = mode, []
                code, result = self.run_command("apply", "--board", self.identity, "--expected-revision", "1",
                                                "--file", proposal, "--commit")
                self.assertEqual(code, 1)
                self.assertIs(result["committed"], False)
                self.assertEqual(self.server.calls, [{"action": "list"}])
        self.assertEqual(board_store_request({"action": "load", "id": self.identity})["board"], self.saved)

    def test_unknown_board_is_not_replaced_by_a_same_title_board(self):
        code, result = self.run_command("read", "--board", "board-" + "b" * 32)
        self.assertEqual(code, 1)
        self.assertIn("未新建同名白板", result["error"])
        self.assertEqual(self.server.calls, [{"action": "list"}])

    def test_read_and_find_return_the_actual_parent_path_and_project_binding(self):
        code, result = self.run_command("read", "--board", self.identity, "--node", "E05")
        self.assertEqual(code, 0)
        self.assertEqual(result["repositoryPath"], "C:/project")
        self.assertEqual([node["id"] for node in result["path"]], ["E04", "E05"])
        self.assertEqual([node["id"] for node in result["children"]], ["A02"])
        code, result = self.run_command("find", "--board", self.identity, "--query", "Discussion")
        self.assertEqual(code, 0)
        self.assertEqual(result["matches"][0]["path"][-2]["id"], "E05")

    def test_preview_is_read_only_and_http_commit_is_visible_to_a_fresh_client(self):
        proposal = self.proposal_file({"rootId": "E05", "updates": [{"id": "E05", "summary": "New evidence"}],
                                      "children": [{"ref": "decoder", "parentId": "E05", "title": "Decoder",
                                                    "summary": "Concrete implementation", "collapsed": True,
                                                    "children": [{"ref": "test", "title": "Decoder test", "summary": "Actual assertion"}]}]})
        arguments = ("apply", "--board", self.identity, "--expected-revision", "1", "--file", proposal)
        code, preview = self.run_command(*arguments)
        self.assertEqual(code, 0)
        self.assertFalse(preview["committed"])
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))
        receipt = self.directory / "receipt.json"
        code, committed = self.run_command(*arguments, "--commit", "--receipt", str(receipt))
        self.assertEqual(code, 0)
        self.assertTrue(committed["committed"])
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8")), committed)
        fresh = skill.Client(self.origin).call("load", id=self.identity)["board"]
        self.assertGreater(fresh["revision"], 1)
        content = json.loads(fresh["storage"]["organization"])
        by_id = {item["id"]: item for item in content["current"]["items"]}
        self.assertEqual(committed["assigned"], {"decoder": "E89", "test": "E90"})
        self.assertEqual(by_id["E89"]["parentId"], "E05")
        self.assertEqual(by_id["E90"]["parentId"], "E89")
        self.assertEqual(by_id["E06"]["summary"], "Keep this")
        self.assertEqual(content["current"]["positions"], {"E05": {"x": 200, "y": 100}})
        self.assertIn("E05", content["current"]["collapsedBranches"])
        for field in ("memory", "templateBackup", "guideBackup"):
            self.assertEqual(fresh["storage"][field], self.storage[field])

    def test_out_of_scope_and_stale_proposals_do_not_write(self):
        for proposal, revision in (({"rootId": "E05", "updates": [{"id": "E06", "summary": "Wrong branch"}]}, "1"),
                                   ({"rootId": "E05", "updates": [{"id": "E05", "summary": "Stale"}]}, "2")):
            with self.subTest(proposal=proposal):
                self.server.calls = []
                code, result = self.run_command("apply", "--board", self.identity, "--expected-revision", revision,
                                                "--file", self.proposal_file(proposal), "--commit")
                self.assertEqual(code, 1)
                self.assertIs(result["committed"], False)
                self.assertFalse(any(call["action"] == "save" for call in self.server.calls))

    def test_remote_targets_and_credentials_are_rejected(self):
        for url in ("https://127.0.0.1:8791", "http://example.com", "http://user:secret@localhost:8791",
                    self.origin + "/?board=other", self.origin + "/api/board-store"):
            with self.subTest(url=url), self.assertRaises(skill.ServiceError):
                skill.Client(url)


if __name__ == "__main__":
    unittest.main()
