import io
import json
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import server
import zcode_backend
from zcode_workspace import call_tool
from test_capability_intro import capability


def cli_request(**fields):
    body = json.dumps({"backend": "codex", "mode": "ask", "question": "Describe the bound project", **fields}).encode()
    return server.backend_request_from_body(body, server.parse_request(body))


def query_workspace(command, arguments, calls):
    messages = "\n".join(
        json.dumps({"id": index, "method": method, "params": params})
        for index, (method, params) in enumerate(calls, 1)
    ) + "\n"
    completed = subprocess.run([command, *arguments], input=messages, capture_output=True, encoding="utf-8",
                               timeout=10, check=True)
    return [json.loads(line)["result"] for line in completed.stdout.splitlines()]


class RepositoryBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.repository = root / "本地 项目"
        self.repository.mkdir()
        (self.repository / "src").mkdir()
        (self.repository / "src" / "main.py").write_text("入口 = '独立项目'\n", encoding="utf-8")
        (self.repository / ".env").write_text("sensitive fixture", encoding="utf-8")
        (root / "outside.py").write_text("out of scope", encoding="utf-8")
        self.workspace = root / "workspace"
        self.workspace.mkdir()
        (self.workspace / "attachments").mkdir()
        (self.workspace / "attachments" / "attachment-1.txt").write_text("staged attachment", encoding="utf-8")

    def test_normalizes_only_cli_paths_and_rejects_edits(self):
        for backend in ("codex", "zcode"):
            request = cli_request(backend=backend, repositoryPath=str(self.repository))
            self.assertEqual(request.repository_path, self.repository)
            self.assertNotIn("repositoryPath", request.context)
            with self.assertRaisesRegex(ValueError, "只读分析"):
                cli_request(backend=backend, repositoryPath=str(self.repository), mode="edit")
        for value in ("relative/path", str(self.repository / "absent"), str(self.repository / ".env"), [], None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                cli_request(repositoryPath=value)
        self.assertIsNone(cli_request().repository_path)
        self.assertIsNone(cli_request(repositoryPath="").repository_path)
        with patch.object(server, "resolve_repository_path", side_effect=AssertionError("API must not resolve a path")):
            self.assertIsNone(cli_request(backend="api", repositoryPath=str(self.repository)).repository_path)

    def test_validation_endpoint(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), server.WhiteboardHandler) as httpd:
            address = f"127.0.0.1:{httpd.server_port}"
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(server, "ALLOWED_HOSTS", {address}):
                    for directory, status in ((str(self.repository), 200), ("relative", 400), (None, 400), ("", 200)):
                        with self.subTest(directory=directory):
                            connection = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                            try:
                                connection.request("POST", "/api/repository", json.dumps({"repositoryPath": directory}),
                                                   {"Origin": f"http://{address}", "Content-Type": "application/json"})
                                response = connection.getresponse()
                                result = json.loads(response.read())
                                self.assertEqual(response.status, status)
                                if status == 200:
                                    self.assertEqual(result, {"repositoryPath": directory})
                            finally:
                                connection.close()
            finally:
                httpd.shutdown()
                thread.join(timeout=5)

    def verify_scoped_tools(self, command, args):
        results = query_workspace(command, args, [
            ("tools/list", {}),
            ("tools/call", {"name": "list_files", "arguments": {}}),
            ("tools/call", {"name": "list_files", "arguments": {"path": "repository/src"}}),
            ("tools/call", {"name": "read_file", "arguments": {"path": "repository/src/main.py"}}),
            ("tools/call", {"name": "read_file", "arguments": {"path": "attachments/attachment-1.txt"}}),
            ("tools/call", {"name": "read_file", "arguments": {"path": "repository/.env"}}),
            ("tools/call", {"name": "read_file", "arguments": {"path": "repository/../outside.py"}}),
            ("tools/call", {"name": "replace_text", "arguments": {"path": "repository/src/main.py"}}),
        ])
        self.assertEqual([tool["name"] for tool in results[0]["tools"]], ["list_files", "read_file"])
        listing = json.loads(results[1]["content"][0]["text"])
        self.assertEqual(listing["files"], ["repository/src/main.py", "attachments/attachment-1.txt"])
        self.assertIn("repository/src", listing["directories"])
        self.assertIn("repository/src/main.py", json.loads(results[2]["content"][0]["text"])["files"])
        self.assertIn("独立项目", json.loads(results[3]["content"][0]["text"])["text"])
        self.assertEqual(json.loads(results[4]["content"][0]["text"])["text"], "staged attachment")
        self.assertTrue(all(result["isError"] for result in results[5:]))

    def test_codex_command_can_read_repository_with_attachments(self):
        command = server.codex_command("codex", "ask", workspace=self.workspace, repository=self.repository)
        args = next(value.partition("=")[2] for value in command if value.startswith("mcp_servers.whiteboard.args="))
        self.assertIn("read-only", command)
        self.assertEqual(command[command.index("--disable") + 1], "shell_tool")
        self.verify_scoped_tools(sys.executable, json.loads(args))

    def test_zcode_configures_the_same_scoped_repository_tools(self):
        requests = {}

        class FakeConnection:
            def __init__(self, process, tools):
                requests["allowed"] = tools

            def request(self, method, params):
                if method == "session/create":
                    requests[method] = params
                    return {"session": {"sessionId": "test-session"},
                            "settings": {"model": {"current": {"modelId": "fixture"}}}}

            def begin_request(self, method, params):
                return 1

        events = queue.SimpleQueue()
        with patch.object(zcode_backend, "ZCodeConnection", FakeConnection), \
             patch.object(zcode_backend, "read_turn", return_value="fixture"):
            zcode_backend.run_zcode(SimpleNamespace(stdin=io.BytesIO()), "read", "", "ask", self.workspace,
                                   events, repository=self.repository)
        settings = requests["session/create"]
        self.assertEqual(settings["workspace"]["workspacePath"], str(self.workspace))
        self.assertEqual(requests["allowed"], zcode_backend.READ_TOOLS)
        tool = settings["mcpServers"][0]
        self.verify_scoped_tools(tool["command"], tool["args"])

    def test_custom_turn_uses_scratch_and_bound_prompt(self):
        for backend in ("codex", "zcode"):
            with self.subTest(backend=backend):
                captured = []
                handler = object.__new__(server.WhiteboardHandler)
                request = cli_request(backend=backend, repositoryPath=str(self.repository))

                def read_turn(*args, **kwargs):
                    workspace = args[6]
                    self.assertNotEqual(workspace, self.repository)
                    self.assertEqual(list(workspace.iterdir()), [])
                    self.assertEqual(kwargs["request"].repository_path, self.repository)
                    captured.append(workspace)

                handler.run_agent = read_turn
                handler.run_turn(request=request)
                self.assertEqual(len(captured), 1)
                self.assertFalse(captured[0].exists())
        prompt = server.build_prompt("ask", "Inspect the project", {}, repository_scope=True)
        self.assertIn("repository/", prompt)
        self.assertNotIn("E01 maps", prompt)
        self.assertNotIn(str(self.repository), prompt)

    def test_bound_organization_uses_repository_evidence_in_card_text(self):
        context = {"scope": "organize", "board": {"nodes": [{"id": "E01"}], "newIds": ["E02"]}}
        plan = {
            "title": "Repository", "summary": "Current source",
            "layout": {"flow": "horizontal", "density": "normal"},
            "items": [
                {"id": "E01", "category": "main", "parentId": None, "title": "Project",
                 "summary": "Project overview", "sources": []},
                {"id": "E02", "category": "reference", "parentId": "E01", "title": "Entry point",
                 "summary": "See src/main.py for the entry point", "sources": []},
            ],
        }
        kind, fields = server.structured_candidate(json.dumps(plan), context, repository_scope=True)
        self.assertEqual(kind, "map")
        self.assertEqual(fields["map"]["items"], plan["items"])
        with self.assertRaisesRegex(ValueError, "缺少源码依据"):
            server.structured_candidate(json.dumps(plan), context)
        plan["items"][1]["sources"] = ["app.js"]
        with self.assertRaisesRegex(ValueError, "源码依据请写在 repositoryFiles"):
            server.structured_candidate(json.dumps(plan), context, repository_scope=True)

    def repository_init_request(self, **fields):
        return cli_request(**{
            "scope": "organize",
            "boardIntent": "repository_init",
            "board": {"nodes": [], "newIds": [f"E{number:02}" for number in range(4, 12)]},
            **fields,
        })

    def test_initialization_is_a_read_only_cli_action_for_empty_boards(self):
        for backend in ("codex", "zcode"):
            request = self.repository_init_request(backend=backend, repositoryPath=str(self.repository))
            self.assertEqual(request.repository_path, self.repository)
            self.assertEqual(request.context["board"]["nodes"], [])
            self.assertEqual(request.context["boardIntent"], "repository_init")
        self.assertEqual(self.repository_init_request().repository_path, server.ROOT)

        for fields in (
            {"backend": "api"},
            {"mode": "edit"},
            {"scope": "plan"},
            {"attachments": [{"id": "fixture"}]},
            {"board": {"nodes": [{"id": "E01"}], "newIds": ["E04"]}},
            {"board": {"nodes": [], "newIds": ["E04"]}},
            {"boardIntent": "main"},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.repository_init_request(**fields)

    def test_initialization_enforces_a_hierarchy_and_local_source_evidence(self):
        request = self.repository_init_request(repositoryPath=str(self.repository))
        plan = {
            "title": "Project",
            "summary": "From the public entry point to behavior and verification",
            "layout": {"flow": "horizontal", "density": "compact"},
            "items": [
                {"id": f"E{number:02}", "parentId": parent, "category": "main" if parent is None else "reference",
                 "title": title, "summary": f"Evidence: {citation}", "sources": [], "capability": capability()}
                for number, parent, title, citation in (
                    (4, None, "Project overview", "`src/main.py`"),
                    (5, "E04", "Entry point", "`src/main.py#start`"),
                    (6, "E04", "Key behavior", "`repository/src/main.py`"),
                    (7, "E04", "Validation", "`src/main.py`"),
                    (8, "E05", "Entry point detail", "`src/main.py`"),
                )
            ],
        }

        def candidate():
            return server.structured_candidate(json.dumps(plan), request.context,
                                               repository_scope=True, repository=request.repository_path)

        expected = {**plan, "items": [{**item, "repositoryFiles": ["src/main.py"]} for item in plan["items"]]}
        self.assertEqual(candidate(), ("map", {"map": expected}))
        plan["items"][-1]["parentId"] = "E04"
        self.assertEqual(len(candidate()[1]["map"]["items"]), 5, "No artificial depth is required")
        plan["items"][-1]["parentId"] = "E05"
        for invalid in ("`src/missing.py`", "`../outside.py`", "`.env`", "src/main.py"):
            plan["items"][-1]["summary"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "缺少可读取"):
                candidate()
        prompt = server.build_prompt("ask", request.question, request.context, repository_scope=True)
        self.assertIn("First call list_files", prompt)
        self.assertIn("README, AGENTS.md", prompt)
        self.assertIn("tests or documented validation command", prompt)
        self.assertNotIn("E01 maps", prompt)

    def test_initialization_adds_actual_source_cards_outside_the_model_ids(self):
        test_file = self.repository / "src" / "test_main.py"
        test_file.write_text("def test_entry():\n    assert 61 > 60\n", encoding="utf-8")
        self.repository.joinpath("README.md").write_text("# Local project\n", encoding="utf-8")
        self.repository.joinpath("src", "main.py").write_text(
            "def main():\n    api_key = 'example-only-private-token'\n    return 61\n", encoding="utf-8")
        reserved = [f"E{number:02}" for number in range(4, 14)]
        request = self.repository_init_request(repositoryPath=str(self.repository),
                                               board={"nodes": [], "newIds": reserved})
        self.assertEqual(request.context["board"]["newIds"], reserved[:8])
        self.assertEqual(request.context["board"]["codeIds"], reserved[8:])
        prompt = server.build_prompt("ask", request.question, request.context, repository_scope=True)
        self.assertIn('"E11"', prompt)
        self.assertNotIn('"E12"', prompt)
        self.assertNotIn("codeIds", prompt)
        plan = {
            "title": "Project", "summary": "Architecture and verification",
            "layout": {"flow": "horizontal", "density": "compact"},
            "items": [
                {"id": identifier, "parentId": parent, "category": "main" if parent is None else "reference",
                 "title": identifier, "summary": f"Evidence: `{file}`", "sources": [], "capability": capability()}
                for identifier, parent, file in (
                    ("E04", None, "src/main.py"),
                    ("E05", "E04", "src/main.py#main"),
                    ("E06", "E04", "src/test_main.py"),
                    ("E07", "E04", "README.md"),
                    ("E08", "E05", "src/main.py"),
                )
            ],
        }

        def candidate():
            return server.structured_candidate(json.dumps(plan), request.context,
                                               repository_scope=True, repository=request.repository_path)[1]["map"]

        generated = candidate()["items"]
        self.assertEqual([item["id"] for item in generated[:5]], [item["id"] for item in plan["items"]])
        self.assertEqual([(item["id"], item["parentId"], item["codePreview"]["path"]) for item in generated[5:]], [
            ("E12", "E08", "src/main.py"),
        ])
        self.assertIn("    return 61", generated[5]["codePreview"]["text"])
        self.assertNotIn("example-only-private-token", generated[5]["codePreview"]["text"])
        self.assertFalse(any(item.get("codePreview", {}).get("path") == "src/test_main.py" for item in generated),
                         "Source previews must not attach directly to an outer capability")
        plan["items"][2]["summary"] = "Evidence: `README.md`"
        self.assertEqual([item["codePreview"]["path"] for item in candidate()["items"] if "codePreview" in item],
                         ["src/main.py"])
        plan["items"][-1]["id"] = "E12"
        with self.assertRaisesRegex(ValueError, "未知或重复"):
            candidate()

    def test_full_initialization_checks_each_capability_and_parent_width(self):
        reserved = [f"E{number:02}" for number in range(4, 27)]
        request = self.repository_init_request(repositoryPath=str(self.repository),
                                               board={"nodes": [], "newIds": reserved})
        self.assertEqual(request.context["board"]["newIds"], reserved[:21])
        self.assertEqual(request.context["board"]["codeIds"], reserved[21:])
        parents = [None, "E04", "E04", "E04", "E05", "E05", "E05",
                   "E06", "E06", "E06", "E07", "E07", "E07"]
        plan = {"title": "能力手册", "summary": "从能力逐级到验收", "layout": {"flow": "horizontal", "density": "compact"},
                "items": [{"id": identity, "parentId": parent, "category": "reference" if parent else "main",
                           "title": f"Topic {identity}", "summary": "Evidence: `src/main.py`", "sources": [],
                           "capability": capability()}
                          for identity, parent in zip(reserved, parents)]}

        def candidate():
            return server.structured_candidate(json.dumps(plan), request.context,
                                               repository_scope=True, repository=request.repository_path)[1]["map"]

        generated = candidate()["items"]
        self.assertEqual(len(generated), 14)
        self.assertEqual(generated[-1]["parentId"], "E08")
        self.assertEqual(generated[-1]["codePreview"]["path"], "src/main.py")
        plan["items"][-1]["parentId"] = "E08"
        self.assertEqual(candidate()["items"][12]["parentId"], "E08", "Evidence can be nested one level deeper")
        plan["items"][9]["parentId"] = "E05"
        plan["items"][-1]["parentId"] = "E05"
        with self.assertRaisesRegex(ValueError, "直属下级超过 4 张"):
            candidate()
        plan["items"][9]["parentId"] = "E06"
        plan["items"][-1]["parentId"] = "E08"
        plan["items"][-2]["parentId"] = "E08"
        self.assertTrue(candidate()["items"], "ID budget must not force two children on every capability")

    def test_repository_links_do_not_escape_scope(self):
        link = self.repository / "linked.py"
        try:
            link.symlink_to(self.repository.parent / "outside.py")
        except OSError:
            self.skipTest("File symlinks are unavailable")
        with self.assertRaisesRegex(ValueError, "unavailable or is a link"):
            call_tool(self.workspace, "ask", "read_file", {"path": "repository/linked.py"}, repository=self.repository)
        result = call_tool(self.workspace, "ask", "list_files", {}, repository=self.repository)
        self.assertNotIn("repository/linked.py", result["files"])


if __name__ == "__main__":
    unittest.main()
