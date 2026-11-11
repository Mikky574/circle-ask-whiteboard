import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from repo_index import RepositoryIndex, RepoIndexError, isolated_env, run_cli


class RepositoryIndexTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.source = self.root / "app.js"
        self.source.write_text("function entry() {}\nfunction helper() {}\n", encoding="utf-8")
        (self.root / ".env").write_text("TEST_SECRET=protected", encoding="utf-8")
        self.cli = self.root / "cli.exe"
        self.cli.touch()
        config = patch.dict(os.environ, {"WHITEBOARD_GITNEXUS_CLI": str(self.cli), "TEST_SECRET": "protected"})
        config.start()
        self.addCleanup(config.stop)
        self.index = RepositoryIndex(("app.js",), lambda name: self.root / name)
        self.commands = []
        self.snapshot_path = None

    def run_cli(self, command, args, cwd, env, deadline):
        self.commands.append(args)
        self.snapshot_path = cwd
        self.assertNotEqual(cwd, self.root)
        self.assertEqual(sorted(path.name for path in cwd.iterdir()), ["app.js"])
        self.assertNotIn("TEST_SECRET", env)
        self.assertEqual(Path(env["GITNEXUS_HOME"]).parent, cwd.parent)
        self.assertEqual(env["GITNEXUS_NO_UPDATE_NOTIFIER"], "1")
        self.assertEqual(env["GITNEXUS_CONTENT_RETENTION"], "none")
        if args[0] == "--version":
            return "1.6.12"
        if args[0] == "analyze":
            self.assertIn("--skip-git", args)
            self.assertIn("--index-only", args)
            self.assertIn("--skip-fts", args)
            return ""
        self.assertEqual(args[0], "cypher")
        if "CodeRelation" in args[1]:
            return json.dumps({"markdown": "| caller | callee |\n| --- | --- |\n| one | two |\n| outside | one |",
                               "row_count": 2})
        return json.dumps([
            {"id": "one", "name": "entry", "file": "app.js", "line": 0, "kind": "Function", "content": "ignored"},
            {"id": "two", "name": "helper", "file": "app.js", "line": 1, "kind": "Function"},
            {"id": "outside", "name": "secret", "file": "../private.js", "line": 1, "kind": "Function"},
        ])

    def test_scan_and_context_reuse_read_only_snapshot(self):
        with patch("repo_index.run_cli", side_effect=self.run_cli):
            scan = self.index.request({"action": "scan"})
            self.assertEqual(scan["engine"], "GitNexus")
            self.assertEqual(scan["version"], "1.6.12")
            self.assertEqual(scan["files"], [{"path": "app.js", "bytes": self.source.stat().st_size}])
            self.assertEqual(len(scan["snapshot"]), 64)
            self.assertEqual(scan["symbols"], [
                {"name": "entry", "file": "app.js", "line": 1, "kind": "Function"},
                {"name": "helper", "file": "app.js", "line": 2, "kind": "Function"},
            ])
            self.assertFalse(self.snapshot_path.exists())
            self.assertEqual(len(self.commands), 4)
            context = self.index.request({"action": "context", "symbol": "entry"})
            self.assertEqual(context["snapshot"], scan["snapshot"])
            self.assertEqual(context["context"]["callers"], [])
            self.assertEqual(context["context"]["callees"], scan["symbols"][1:])
            self.assertEqual(len(self.commands), 4)
            self.source.write_text("// changed\n" + self.source.read_text(encoding="utf-8"), encoding="utf-8")
            refreshed = self.index.request({"action": "scan"})
            self.assertNotEqual(refreshed["snapshot"], scan["snapshot"])
            self.assertEqual(len(self.commands), 8)

    def test_query_rejects_paths_and_returns_unknown_symbol(self):
        with patch("repo_index.run_cli", side_effect=self.run_cli):
            for body in ({"action": "scan", "path": "../"}, {"action": "context", "symbol": "--help"},
                         {"action": "context", "symbol": "entry", "file": "../app.js"}):
                with self.assertRaises(RepoIndexError) as caught:
                    self.index.request(body)
                self.assertEqual(caught.exception.status, 400)
            self.assertEqual(self.commands, [])
            with self.assertRaises(RepoIndexError) as caught:
                self.index.request({"action": "context", "symbol": "missing"})
            self.assertEqual(caught.exception.status, 404)

    def test_missing_install_is_not_reported_as_a_scan(self):
        with patch.dict(os.environ, {"WHITEBOARD_GITNEXUS_CLI": ""}):
            with self.assertRaises(RepoIndexError) as caught:
                self.index.request({"action": "scan"})
        self.assertEqual(caught.exception.status, 503)

    def test_failed_queries_leave_no_cached_success(self):
        with patch("repo_index.run_cli", side_effect=["1.6.12", "", '{"error":"private CLI output"}']):
            with self.assertRaises(RepoIndexError) as caught:
                self.index.request({"action": "scan"})
        self.assertEqual(caught.exception.status, 502)
        self.assertNotIn("private CLI output", str(caught.exception))
        self.assertIsNone(self.index.cache)

    def test_cli_timeout_and_output_limit(self):
        env = isolated_env(self.root)
        with self.assertRaises(RepoIndexError) as caught:
            run_cli([sys.executable, "-c", "import time; time.sleep(5)"], ("--version",), self.root,
                    env, time.monotonic() + 0.1)
        self.assertEqual(caught.exception.status, 504)
        with patch("repo_index.MAX_OUTPUT_BYTES", 16):
            with self.assertRaises(RepoIndexError) as caught:
                run_cli([sys.executable, "-c", "print('x' * 17)"], ("--version",), self.root,
                        env, time.monotonic() + 5)
        self.assertEqual(caught.exception.status, 502)


if __name__ == "__main__":
    unittest.main()
