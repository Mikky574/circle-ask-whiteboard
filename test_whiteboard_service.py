"""External skill acceptance over HTTP and an isolated canonical SQLite store."""

from contextlib import redirect_stderr, redirect_stdout
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from threading import Thread
import unittest
from unittest.mock import patch

import board_store
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
        elif self.server.mode == "save-unavailable" and request["action"] == "save":
            status, result = 503, {"text": "Save did not run"}
        else:
            try:
                result = board_store_request(request)
                if self.server.mode == "save-ack-lost" and request["action"] == "save":
                    status, result = 503, {"text": "Save committed but the acknowledgement was lost"}
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

    def checkout_directory(self, name="work", root="E05"):
        directory = self.directory / name
        code, result = self.run_command("checkout", "--board", self.identity, "--node", root, "--out", str(directory))
        self.assertEqual(code, 0, result)
        return directory

    def write_workspace_proposal(self, directory, proposal=None):
        if proposal is None:
            proposal = {"structure": "project-summary", "updates": [{"id": "E05", "summary": "File-based evidence"}],
                        "children": [{"ref": "detail", "parentId": "E05", "title": "Decoder", "summary": "Implementation",
                                      "children": [{"ref": "test", "title": "Decoder test", "summary": "Concrete acceptance"}]}]}
        (directory / "proposal.json").write_text(json.dumps(proposal), encoding="utf-8")

    def test_checkout_exports_complete_scoped_context_and_original_answers_without_writing(self):
        organization = json.loads(self.storage["organization"])
        organization["current"]["items"].append(
            {"id": "E07", "parentId": "A02", "title": "Deep implementation", "summary": "Second descendant level"})
        memory = json.loads(self.storage["memory"])
        memory["project"] = {"goal": "Understand the project", "constraints": ["Keep behavior"], "decisions": []}
        memory["notes"][0].update({"answer": "Long real answer " * 100, "originalAnswer": "Old answer",
                                   "payload": {"question": "How does it work?", "anchor": {"elementIds": ["E05"]}},
                                   "attachments": [{"id": "a" * 32, "name": "evidence.txt", "size": 20}]})
        storage = {**self.storage, "organization": json.dumps(organization), "memory": json.dumps(memory)}
        latest = board_store_request({"action": "save", "id": self.identity, "expectedRevision": 1,
                                       "metadata": {"title": "Shared project", "repositoryPath": "C:/project"},
                                       "storage": storage})["board"]
        self.server.calls = []
        directory = self.checkout_directory()
        context = json.loads((directory / "context.json").read_text(encoding="utf-8"))
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual({node["id"] for node in context["subtree"]}, {"E05", "A02", "E07"})
        self.assertEqual([node["id"] for node in context["ancestors"]], ["E04"])
        self.assertEqual(context["project"], memory["project"])
        self.assertEqual(context["notes"], memory["notes"])
        self.assertEqual(context["repositoryPath"], "C:/project")
        self.assertEqual(manifest["revision"], 2)
        self.assertEqual(manifest["contextSha256"], skill.digest(context))
        overview_other = next(node for node in context["overview"]["nodes"] if node["id"] == "E06")
        self.assertNotIn("summary", overview_other, "Unrelated branch full text must not be copied")
        self.assertEqual(json.loads((directory / "proposal.json").read_text(encoding="utf-8")), {"updates": [], "children": []})
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))
        self.assertEqual(board_store_request({"action": "load", "id": self.identity})["board"], latest)

    def test_checkout_never_overwrites_an_existing_nonempty_directory(self):
        directory = self.directory / "existing"
        directory.mkdir()
        marker = directory / "keep.txt"
        marker.write_text("Keep this exact draft", encoding="utf-8")
        code, result = self.run_command("checkout", "--board", self.identity, "--node", "E05", "--out", str(directory))
        self.assertEqual(code, 1)
        self.assertIn("不会覆盖", result["error"])
        self.assertEqual(marker.read_text(encoding="utf-8"), "Keep this exact draft")
        self.assertEqual(list(directory.iterdir()), [marker])

    def test_global_pinned_constraints_are_readable_but_do_not_expand_the_writable_scope(self):
        organization = json.loads(self.storage["organization"])
        items = organization["current"]["items"]
        items[-1]["summary"] = "Global constraint: preserve the protocol"
        items[-1]["spec"] = {"kind": "constraint", "id": "RULE-PROTOCOL"}
        items.extend([
            {"id": "A03", "parentId": "E06", "title": "Pinned answer", "summary": "Short preview"},
            {"id": "E08", "parentId": None, "title": "Draft", "summary": "Unconfirmed", "draft": True},
            {"id": "E09", "parentId": "E08", "title": "Pinned draft child", "summary": "Do not promote"},
            {"id": "A10", "parentId": "E09", "title": "Draft answer", "summary": "Not a global rule"},
            {"id": "E11", "parentId": None, "title": "Deleted root", "summary": "Removed"},
            {"id": "E12", "parentId": "E11", "title": "Pinned deleted child", "summary": "Do not use"}])
        memory = json.loads(self.storage["memory"])
        memory["pinnedIds"] = ["E04", "E06", "A03", "E09", "A10", "E12"]
        memory["deletedIds"] = ["E11"]
        memory["notes"].extend([{"id": "A03", "answer": "Full globally pinned answer " * 100},
                                 {"id": "A10", "answer": "Full unconfirmed draft answer"}])
        board_store_request({"action": "save", "id": self.identity, "expectedRevision": 1,
                              "metadata": {"title": "Shared project", "repositoryPath": "C:/project"},
                              "storage": {**self.storage, "organization": json.dumps(organization), "memory": json.dumps(memory)}})
        directory = self.checkout_directory()
        context = json.loads((directory / "context.json").read_text(encoding="utf-8"))
        self.assertEqual({item["id"] for item in context["pinnedCards"]}, {"E04", "E06", "A03"})
        self.assertEqual(next(item for item in context["pinnedCards"] if item["id"] == "E06")["summary"],
                         "Global constraint: preserve the protocol")
        self.assertEqual({note["id"] for note in context["notes"]}, {"A02", "A03"})
        self.assertEqual(next(note for note in context["notes"] if note["id"] == "A03"), memory["notes"][1])
        self.write_workspace_proposal(directory, {"updates": [{"id": "E06", "summary": "Forbidden scope expansion"}]})
        self.server.calls = []
        code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1, result)
        self.assertFalse(result["committed"])
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))

    def test_workspace_preview_and_commit_preserve_unrelated_data_and_do_not_duplicate(self):
        directory = self.checkout_directory()
        self.write_workspace_proposal(directory)
        self.server.calls = []
        code, preview = self.run_command("submit", "--workspace", str(directory))
        self.assertEqual(code, 0, preview)
        self.assertFalse(preview["committed"])
        self.assertEqual(preview["rootId"], "E05")
        self.assertFalse((directory / "receipt.json").exists())
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))
        code, committed = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 0, committed)
        self.assertTrue(committed["verified"])
        self.assertEqual(committed["revision"], 2)
        record = json.loads((directory / "receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(record["status"], "verified")
        self.assertEqual(record["result"], committed)
        fresh = skill.Client(self.origin).call("load", id=self.identity)["board"]
        items = {node["id"]: node for node in json.loads(fresh["storage"]["organization"])["current"]["items"]}
        self.assertEqual(items[committed["assigned"]["test"]]["parentId"], committed["assigned"]["detail"])
        self.assertEqual(items["E06"]["summary"], "Keep this")
        for field in ("memory", "templateBackup", "guideBackup"):
            self.assertEqual(fresh["storage"][field], self.storage[field])
        code, repeated = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 0, repeated)
        self.assertTrue(repeated["alreadyCommitted"])
        self.assertEqual(sum(call["action"] == "save" for call in self.server.calls), 1)
        self.assertEqual(skill.Client(self.origin).call("load", id=self.identity)["board"], fresh)

    def test_workspace_rejects_empty_out_of_scope_and_changed_root_proposals(self):
        directory = self.checkout_directory()
        for proposal in ({"updates": [], "children": []},
                         {"updates": [{"id": "E06", "summary": "Wrong branch"}]},
                         {"rootId": "E04", "updates": [{"id": "E05", "summary": "Changed scope"}]},
                         {"board": "other", "updates": [{"id": "E05", "summary": "Changed metadata"}]}):
            with self.subTest(proposal=proposal):
                self.write_workspace_proposal(directory, proposal)
                code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
                self.assertEqual(code, 1, result)
                self.assertFalse(result["committed"])
        self.assertFalse((directory / "receipt.json").exists())
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))

    def test_workspace_rejects_modified_context_manifest_url_and_file_redirection(self):
        for index, changed in enumerate(("context", "manifest", "url", "file")):
            with self.subTest(changed=changed):
                directory = self.checkout_directory(f"changed-{index}")
                self.write_workspace_proposal(directory)
                manifest_file, context_file = directory / "manifest.json", directory / "context.json"
                if changed == "context":
                    value = json.loads(context_file.read_text(encoding="utf-8"))
                    value["subtree"][0]["summary"] = "Edited the source instead of the proposal"
                    context_file.write_text(json.dumps(value), encoding="utf-8")
                elif changed == "manifest":
                    value = json.loads(manifest_file.read_text(encoding="utf-8"))
                    value["revision"] += 1
                    manifest_file.write_text(json.dumps(value), encoding="utf-8")
                elif changed == "file":
                    context_file.unlink()
                    context_file.mkdir()
                arguments = ["submit", "--workspace", str(directory), "--commit"]
                if changed == "url":
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        code = skill.main(["--url", "http://127.0.0.1:1", *arguments])
                    result = json.loads(out.getvalue() or err.getvalue())
                else:
                    code, result = self.run_command(*arguments)
                self.assertEqual(code, 1, result)
                self.assertFalse((directory / "receipt.json").exists())
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))

    def test_workspace_stale_version_never_overwrites_another_users_change(self):
        directory = self.checkout_directory()
        self.write_workspace_proposal(directory)
        changed, _ = skill.propose(self.saved, {"rootId": "E04", "updates": [{"id": "E06", "summary": "New independent change"}]}, 1)
        winner = board_store_request({"action": "save", "id": self.identity, "expectedRevision": 1,
                                      "metadata": {"title": "Shared project", "repositoryPath": "C:/project"},
                                      "storage": changed["storage"]})["board"]
        self.server.calls = []
        code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1)
        self.assertIn("版本已改变", result["error"])
        self.assertFalse(any(call["action"] == "save" for call in self.server.calls))
        self.assertEqual(board_store_request({"action": "load", "id": self.identity})["board"], winner)

    def test_pending_receipt_reconciles_lost_acknowledgement_without_another_save(self):
        directory = self.checkout_directory()
        self.write_workspace_proposal(directory)
        self.server.calls, self.server.mode = [], "save-ack-lost"
        code, unknown = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1)
        self.assertEqual(unknown["committed"], "unknown")
        self.assertEqual(json.loads((directory / "receipt.json").read_text(encoding="utf-8"))["status"], "pending")
        self.server.mode = "normal"
        code, recovered = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 0, recovered)
        self.assertTrue(recovered["alreadyCommitted"])
        self.assertEqual(sum(call["action"] == "save" for call in self.server.calls), 1)
        self.assertEqual(json.loads((directory / "receipt.json").read_text(encoding="utf-8"))["status"], "verified")

    def test_pending_uncommitted_or_changed_proposal_stops_instead_of_retrying(self):
        directory = self.checkout_directory()
        self.write_workspace_proposal(directory)
        self.server.calls, self.server.mode = [], "save-unavailable"
        code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1)
        self.assertEqual(result["committed"], "unknown")
        self.server.mode = "normal"
        code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1)
        self.assertEqual(result["committed"], "unknown")
        self.write_workspace_proposal(directory, {"updates": [{"id": "E05", "summary": "Different proposal"}]})
        code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
        self.assertEqual(code, 1)
        self.assertIn("回执与本提案不一致", result["error"])
        self.assertEqual(sum(call["action"] == "save" for call in self.server.calls), 1)
        self.assertEqual(board_store_request({"action": "load", "id": self.identity})["board"], self.saved)

    def test_prior_submission_never_becomes_false_after_draft_context_or_service_changes(self):
        for index, changed in enumerate(("proposal", "context", "manifest", "receipt", "service", "deleted")):
            with self.subTest(changed=changed):
                # Restore this isolated fixture; each workspace simulates an
                # acknowledgement lost after exactly one successful HTTP save.
                if index:
                    self.identity = "board-" + str(index) * 32
                    board_store_request({"action": "save", "id": self.identity, "expectedRevision": 0,
                                          "metadata": {"title": "Shared project", "repositoryPath": "C:/project"}, "storage": self.storage})
                self.server.mode = "normal"
                directory = self.checkout_directory(f"pending-{index}")
                self.write_workspace_proposal(directory)
                self.server.calls, self.server.mode = [], "save-ack-lost"
                code, unknown = self.run_command("submit", "--workspace", str(directory), "--commit")
                self.assertEqual(code, 1, unknown)
                self.assertEqual(unknown["committed"], "unknown")
                self.server.mode = "normal"
                if changed == "proposal":
                    self.write_workspace_proposal(directory, {"updates": [{"id": "E05", "summary": "A different new question"}]})
                elif changed == "receipt":
                    receipt_path = directory / "receipt.json"
                    record = json.loads(receipt_path.read_text(encoding="utf-8"))
                    del record["result"]["newIds"]
                    receipt_path.write_text(json.dumps(record), encoding="utf-8")
                elif changed in {"context", "manifest"}:
                    (directory / f"{changed}.json").write_text("{broken", encoding="utf-8")
                elif changed == "service":
                    self.server.mode = "unsupported"
                else:
                    board_store_request({"action": "delete", "id": self.identity, "expectedRevision": 2})
                code, result = self.run_command("submit", "--workspace", str(directory), "--commit")
                self.assertEqual(code, 1, result)
                self.assertEqual(result["committed"], "unknown", "A prior committed result must not look safe to repeat")
                self.assertEqual(sum(call["action"] == "save" for call in self.server.calls), 1)


# Preserve the original handoff acceptance coverage as well as API probing.
service = skill
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


class OriginalHandoffHandler(BaseHTTPRequestHandler):
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


class OriginalHandoffServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), OriginalHandoffHandler)
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
        OriginalHandoffHandler.redirect = False
        self.client = service.Client(self.url)
        self.original = self.client.call("save", id=IDENTITY, expectedRevision=0,
                                         metadata={"title": "测试白板", "repositoryPath": "C:/example"}, storage=fixture())["board"]
        OriginalHandoffHandler.calls.clear()
        OriginalHandoffHandler.redirect = False

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
        self.assertNotIn("save", OriginalHandoffHandler.calls)
        self.assertEqual(self.client.call("load", id=IDENTITY)["board"]["storage"], self.original["storage"])

    def test_project_summary_rejects_wide_siblings_and_accepts_grouped_children(self):
        proposed = {"rootId": "E04", "structure": "project-summary",
                    "children": [{"ref": f"topic{index}", "parentId": "E18", "title": f"主题 {index}", "summary": "说明"}
                                 for index in range(4)]}
        status, error = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1",
                                 "--file", self.file(proposed), "--commit")
        self.assertNotEqual(status, 0)
        self.assertRegex(str(error), r"E18.*5 张直属下级")
        self.assertNotIn("save", OriginalHandoffHandler.calls)
        last = proposed["children"].pop()
        del last["parentId"]
        proposed["children"][0]["children"] = [last]
        status, result = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1",
                                  "--file", self.file(proposed), "--commit")
        self.assertEqual(status, 0, result)
        self.assertTrue(result["verified"])
        saved = self.client.call("load", id=IDENTITY)["board"]
        items = json.loads(saved["storage"]["organization"])["current"]["items"]
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id[result["assigned"]["topic3"]]["parentId"], result["assigned"]["topic0"])

    def test_commits_nested_tree_once_preserving_every_other_field(self):
        receipt = Path(self.tmp.name) / "receipt.json"
        status, result = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(self.proposal()), "--commit", "--receipt", str(receipt))
        self.assertEqual(status, 0, result)
        self.assertTrue(result["verified"])
        self.assertEqual(result["revision"], 2)
        self.assertEqual(OriginalHandoffHandler.calls.count("save"), 1)
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
        self.assertNotIn("save", OriginalHandoffHandler.calls)

    def test_stale_precondition_and_cas_race_never_retry(self):
        candidate, _ = service.propose(self.original, self.proposal(), 1)
        self.client.call("save", id=IDENTITY, expectedRevision=1, metadata={"title": "新版本"}, storage=candidate["storage"])
        OriginalHandoffHandler.calls.clear()
        with self.assertRaises(service.ServiceError):
            self.client.call("save", id=IDENTITY, expectedRevision=1, metadata={"title": "旧提案"}, storage=self.original["storage"])
        self.assertEqual(OriginalHandoffHandler.calls.count("save"), 1)
        OriginalHandoffHandler.calls.clear()
        status, _ = self.cli("apply", "--board", IDENTITY, "--expected-revision", "1", "--file", self.file(self.proposal()), "--commit")
        self.assertEqual(status, 1)
        self.assertNotIn("save", OriginalHandoffHandler.calls)

    def test_only_loopback_http_without_proxy_or_redirect(self):
        for url in ("https://127.0.0.1:8791", "http://example.com:8791", "http://127.0.0.1:0", "http://127.0.0.1:8791@other.test", "http://127.0.0.1:8791/path", "http://localhost:8791/?key=secret"):
            with self.subTest(url=url), self.assertRaises(service.ServiceError):
                service.Client(url)
        OriginalHandoffHandler.redirect = True
        with self.assertRaisesRegex(service.ServiceError, "重定向"):
            self.client.call("list")


if __name__ == "__main__":
    unittest.main()
