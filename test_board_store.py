from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

from board_store import BoardStoreError, STORAGE_FIELDS, board_store_request


class BoardStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name, "data", "boards.sqlite3")
        configure = patch.dict(os.environ, WHITEBOARD_BOARDS_FILE=str(self.path))
        configure.start()
        self.addCleanup(configure.stop)
        self.identity = "board-" + "1" * 32
        self.metadata = {"id": self.identity, "title": "项目白板", "repositoryPath": "C:/本机项目"}
        self.storage = {
            "memory": json.dumps({"project": {"goal": "理解工程"}, "notes": [{"id": "A01", "answer": "原有回答"}]}),
            "organization": json.dumps({"current": {"items": [{"id": "E13", "parentId": "E01"}]} }),
            "templateBackup": '[null, "{}"]',
            "guideBackup": '{"values":[null,"{}"],"guideId":"v1"}',
        }

    def request(self, action, **fields):
        return board_store_request({"action": action, **fields})

    def save(self, revision=0, **changes):
        return self.request("save", id=self.identity, expectedRevision=revision,
                            metadata=changes.get("metadata", self.metadata), storage=changes.get("storage", self.storage))["board"]

    def test_new_browser_reads_same_tree_and_backups_from_fresh_connection(self):
        self.assertEqual(self.request("list"), {"boards": [], "deleted": []})
        self.assertEqual(self.request("load", id=self.identity), {"board": None, "deleted": False, "revision": 0})
        saved = self.save()
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["storage"], self.storage)
        self.assertTrue(self.path.is_file())
        # Each request opens and closes its own connection. No browser-local
        # storage or prior Python object is needed to recover this document.
        loaded = self.request("load", id=self.identity)["board"]
        self.assertEqual(loaded, saved)
        listing, = self.request("list")["boards"]
        self.assertNotIn("storage", listing)
        self.assertEqual(listing, {key: value for key, value in saved.items() if key != "storage"})

    def test_update_atomically_replaces_metadata_and_entire_tree(self):
        original = self.save()
        changed = {**self.storage, "memory": '{"notes":[]}', "organization": '{"current":{"items":[]}}'}
        title = {**self.metadata, "title": "新标题"}
        saved = self.save(original["revision"], metadata=title, storage=changed)
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(self.request("load", id=self.identity)["board"], saved)
        self.assertEqual(saved["title"], "新标题")
        self.assertEqual(saved["storage"], changed)

    def test_old_browser_migration_and_stale_saves_cannot_overwrite(self):
        saved = self.save()
        for stale in (0, 10):
            with self.assertRaises(BoardStoreError) as error:
                self.save(stale, storage={"memory": "{}"})
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(error.exception.details["board"], saved)
        self.assertEqual(self.request("load", id=self.identity)["board"], saved)

    def test_concurrent_saves_allow_one_writer_without_partial_tree(self):
        self.save()

        def write(index):
            value = json.dumps({"writer": index})
            try:
                return self.save(1, storage={"memory": value, "organization": value})
            except BoardStoreError as error:
                return error.status

        with ThreadPoolExecutor(max_workers=4) as executor:
            outcomes = list(executor.map(write, range(4)))
        accepted = [value for value in outcomes if isinstance(value, dict)]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(outcomes.count(409), 3)
        saved = self.request("load", id=self.identity)["board"]
        self.assertEqual(saved, accepted[0])
        self.assertEqual(saved["storage"]["memory"], saved["storage"]["organization"])

    def test_deletion_tombstone_prevents_stale_browser_resurrection(self):
        saved = self.save()
        removed = self.request("delete", id=self.identity, expectedRevision=saved["revision"])
        self.assertEqual(removed, {"id": self.identity, "revision": 2, "deleted": True})
        self.assertEqual(self.request("load", id=self.identity), {"board": None, "revision": 2, "deleted": True})
        self.assertEqual(self.request("list"), {"boards": [], "deleted": [{"id": self.identity, "revision": 2}]})
        for revision in (0, 1, 2):
            with self.assertRaises(BoardStoreError) as error:
                self.save(revision)
            self.assertEqual(error.exception.status, 409)
            self.assertTrue(error.exception.details["deleted"])
        with closing(sqlite3.connect(self.path)) as connection:
            document, = connection.execute("SELECT storage FROM boards WHERE id=?", (self.identity,)).fetchone()
        self.assertEqual(json.loads(document), self.storage)

    def test_saving_other_project_does_not_invalidate_existing_revision(self):
        original = self.save()
        other = "board-" + "2" * 32
        self.request("save", id=other, expectedRevision=0,
                     metadata={"title": "另一个项目", "projectId": other.removeprefix("board-")}, storage={})
        updated = self.save(original["revision"])
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(len(self.request("list")["boards"]), 2)

    def test_invalid_identifiers_and_metadata_never_create_files(self):
        for identity in ("../../evil", "board-" + "A" * 32, "local-projects", "board-1234", "", None, 1):
            with self.subTest(identity=identity), self.assertRaises(BoardStoreError):
                self.request("load", id=identity)
        metadata = [None, {}, {"title": ""}, {"title": "\ud800"}, {"title": "x" * 81},
                    {"title": "ok", "apiKey": "secret"}, {**self.metadata, "id": "original"},
                    {**self.metadata, "repositoryPath": "x\nother"},
                    {**self.metadata, "projectId": "2" * 32}]
        for value in metadata:
            with self.subTest(metadata=value), self.assertRaises(BoardStoreError):
                self.save(metadata=value)
        self.assertFalse(self.path.exists())

    def test_rejects_unscoped_settings_and_malformed_documents_without_losing_saved_state(self):
        saved = self.save()
        for value in ({"apiKey": "secret"}, {"whiteboard.codex.api.v1": "{}"},
                      {"memory": {}}, {"memory": "{broken"}, {"memory": '"text"'},
                      {"memory": '{"value":NaN}'}, {"organization": "[]"}, {"guideBackup": "3"},
                      {"templateBackup": "\ud800"}, None):
            with self.subTest(storage=value), self.assertRaises(BoardStoreError) as error:
                self.save(1, storage=value)
            self.assertEqual(error.exception.status, 422)
        self.assertEqual(self.request("load", id=self.identity)["board"], saved)

    def test_optional_storage_fields_and_builtin_boards(self):
        saved = self.request("save", id="original", expectedRevision=0, metadata={"title": "原白板"}, storage={})["board"]
        self.assertEqual(saved["storage"], dict.fromkeys(STORAGE_FIELDS))
        self.assertEqual(self.request("load", id="original")["board"], saved)

    def test_failed_write_rolls_back_both_tree_and_catalog(self):
        saved = self.save()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("CREATE TRIGGER refuse_update BEFORE UPDATE ON boards BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
            connection.commit()
        with self.assertRaises(BoardStoreError) as error:
            self.save(1, metadata={"title": "不能写入"}, storage={"memory": "{}"})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.request("load", id=self.identity)["board"], saved)

    def test_oversize_document_and_bad_request_fields(self):
        with patch("board_store.MAX_STORE_BYTES", 8), self.assertRaises(BoardStoreError) as oversized:
            self.save()
        self.assertEqual(oversized.exception.status, 413)
        for body in (None, [], {"action": "evil"}, {"action": "list", "unexpected": True},
                     {"action": "save", "id": self.identity},
                     {"action": "delete", "id": self.identity, "expectedRevision": True}):
            with self.subTest(body=body), self.assertRaises(BoardStoreError):
                board_store_request(body)
        self.assertFalse(self.path.exists())

    def test_unwritable_or_corrupt_store_is_not_silently_replaced(self):
        self.path.parent.mkdir()
        broken = b"this is not a sqlite database"
        self.path.write_bytes(broken)
        with self.assertRaises(BoardStoreError) as error:
            self.request("list")
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.path.read_bytes(), broken)

    def test_revisions_are_monotonic_safe_integers_and_missing_delete_is_not_migration(self):
        for revision in (True, False, None, "0", 1.0, -1, 2 ** 53):
            with self.subTest(revision=revision), self.assertRaises(BoardStoreError) as error:
                self.save(revision)
            self.assertEqual(error.exception.status, 422)
        with self.assertRaises(BoardStoreError) as error:
            self.request("delete", id=self.identity, expectedRevision=0)
        self.assertEqual(error.exception.status, 404)
        self.assertEqual(self.request("load", id=self.identity)["revision"], 0)

    def test_invalid_persisted_json_reports_failure_without_defaulting_to_empty(self):
        self.save()
        for field, value in (("storage", "broken"), ("storage", "[]"), ("metadata", "null")):
            with self.subTest(field=field, value=value):
                with closing(sqlite3.connect(self.path)) as connection:
                    connection.execute(f"UPDATE boards SET {field}=?", (value,))
                    connection.commit()
                with self.assertRaises(BoardStoreError) as error:
                    self.request("load", id=self.identity)
                self.assertEqual(error.exception.status, 503)

    def test_history_keeps_complete_immutable_documents_with_pagination(self):
        first = self.save()
        second = self.save(1, metadata={**self.metadata, "title": "第二版"}, storage={"memory": '{"notes":[]} '})
        history = self.request("history", id=self.identity, limit=1)
        self.assertEqual([item["revision"] for item in history["versions"]], [2])
        self.assertEqual(history["nextBeforeRevision"], 2)
        self.assertNotIn("storage", history["versions"][0])
        older = self.request("history", id=self.identity, limit=1, beforeRevision=2)
        self.assertEqual([item["revision"] for item in older["versions"]], [1])
        self.assertIsNone(older["nextBeforeRevision"])
        self.assertEqual(self.request("load", id=self.identity, revision=1)["board"], first)
        self.assertEqual(self.request("load", id=self.identity, revision=2)["board"], second)
        self.assertEqual(self.request("load", id=self.identity)["board"], second)

    def test_fork_uses_selected_version_and_keeps_both_branches_independent(self):
        source_metadata = {**self.metadata, "projectId": self.identity.removeprefix("board-")}
        first = self.save(metadata=source_metadata)
        second = self.save(1, storage={"memory": '{"notes":[{"answer":"第二版"}]}'})
        fork = self.request("fork", id=self.identity, revision=1, title="实验分支")["board"]
        fork_id = fork["id"]
        self.assertNotEqual(fork_id, self.identity)
        self.assertEqual(fork["revision"], 1)
        self.assertEqual(fork["storage"]["memory"], first["storage"]["memory"])
        source_layout = json.loads(first["storage"]["organization"])
        fork_layout = json.loads(fork["storage"]["organization"])
        self.assertEqual(fork_layout["current"]["title"], "实验分支")
        self.assertEqual(fork_layout["current"]["items"], source_layout["current"]["items"])
        self.assertNotIn("title", source_layout["current"])
        self.assertEqual(fork["repositoryPath"], self.metadata["repositoryPath"])
        self.assertNotIn("projectId", fork)
        self.assertEqual(fork["forkedFrom"], {"boardId": self.identity, "revision": 1, "title": first["title"]})
        changed = self.request("save", id=fork_id, expectedRevision=1, metadata={"title": "分支继续修改"},
                               storage={"memory": '{"notes":[{"answer":"仅分支改动"}]}'})["board"]
        self.assertEqual(changed["forkedFrom"], fork["forkedFrom"])
        self.assertEqual(self.request("load", id=fork_id, revision=1)["board"], fork)
        self.assertEqual(self.request("load", id=self.identity)["board"], second)
        self.assertEqual(self.request("load", id=fork_id)["board"], changed)
        listed = {item["id"]: item for item in self.request("list")["boards"]}
        self.assertEqual(listed[fork_id]["forkedFrom"], fork["forkedFrom"])
        latest_fork = self.request("fork", id=self.identity)["board"]
        self.assertEqual(latest_fork["storage"]["memory"], second["storage"]["memory"])
        self.assertEqual(latest_fork["forkedFrom"]["revision"], 2)

    def test_restore_creates_a_new_revision_and_preserves_the_displaced_version(self):
        first = self.save()
        second = self.save(1, metadata={"title": "后来的标题"}, storage={"memory": '{"notes":[]}'})
        restored = self.request("restore", id=self.identity, revision=1, expectedRevision=2)["board"]
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(restored["storage"], first["storage"])
        self.assertEqual(restored["title"], first["title"])
        self.assertEqual(self.request("load", id=self.identity, revision=2)["board"], second)
        versions = self.request("history", id=self.identity)["versions"]
        self.assertEqual([item["revision"] for item in versions], [3, 2, 1])
        self.assertEqual(versions[0]["operation"], "restore")
        self.assertEqual(versions[0]["restoredFromRevision"], 1)
        with self.assertRaises(BoardStoreError) as error:
            self.request("restore", id=self.identity, revision=1, expectedRevision=2)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.request("load", id=self.identity)["board"], restored)
        self.assertEqual(len(self.request("history", id=self.identity)["versions"]), 3)

    def test_fork_rebinds_saved_and_retry_questions_including_undo_backups(self):
        document = {"notes": [{"id": "A01", "answer": f"引用来源 {self.identity} 不应被改写", "sourceCardIds": ["E13"],
                               "payload": {"boardId": self.identity, "question": "为什么？", "anchor": {"elementIds": ["E13"]}},
                               "retryPayload": {"boardId": "whiteboard-implementation", "question": "重试"}}]}
        raw = json.dumps(document)
        storage = {**self.storage, "memory": raw, "templateBackup": json.dumps([raw, "{}"]),
                   "guideBackup": json.dumps({"values": [raw, "{}"], "guideId": "guide"})}
        source = self.save(storage=storage)
        fork = self.request("fork", id=self.identity)["board"]
        memories = [fork["storage"]["memory"], json.loads(fork["storage"]["templateBackup"])[0],
                    json.loads(fork["storage"]["guideBackup"])["values"][0]]
        for memory in memories:
            note, = json.loads(memory)["notes"]
            self.assertEqual(note["payload"]["boardId"], fork["id"])
            self.assertEqual(note["retryPayload"]["boardId"], fork["id"])
            self.assertEqual(note["answer"], document["notes"][0]["answer"])
            self.assertEqual(note["sourceCardIds"], ["E13"])
        self.assertEqual(self.request("load", id=self.identity)["board"], source)

    def test_deleted_history_can_be_explicitly_restored_or_forked_but_never_reimported(self):
        first = self.save()
        self.request("delete", id=self.identity, expectedRevision=1)
        self.assertEqual(self.request("history", id=self.identity)["versions"][0]["operation"], "delete")
        self.assertEqual(self.request("load", id=self.identity, revision=1)["board"], first)
        fork = self.request("fork", id=self.identity, revision=1)["board"]
        self.assertEqual(fork["storage"]["memory"], first["storage"]["memory"])
        self.assertEqual(json.loads(fork["storage"]["organization"])["current"]["title"], fork["title"])
        self.assertTrue(self.request("load", id=self.identity)["deleted"])
        with self.assertRaises(BoardStoreError):
            self.save(0)
        restored = self.request("restore", id=self.identity, revision=1, expectedRevision=2)["board"]
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(restored["storage"], first["storage"])

    def test_upgrade_seeds_only_the_existing_current_revision_without_replacing_it(self):
        self.path.parent.mkdir()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("""CREATE TABLE boards (id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                metadata TEXT NOT NULL, storage TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)""")
            connection.execute("INSERT INTO boards VALUES (?,7,?,?,?,0)",
                               (self.identity, json.dumps(self.metadata), json.dumps(self.storage), "2026-11-18T00:00:00Z"))
            connection.commit()
        original = self.request("load", id=self.identity)["board"]
        self.assertEqual(original["revision"], 7)
        self.assertEqual(original["storage"], self.storage)
        self.assertEqual([item["revision"] for item in self.request("history", id=self.identity)["versions"]], [7])
        self.assertEqual(self.request("load", id=self.identity, revision=7)["board"], original)
        self.save(7, storage={})
        self.assertEqual(self.request("load", id=self.identity, revision=7)["board"], original)

    def test_history_insert_failure_rolls_back_current_and_metadata_changes(self):
        original = self.save()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("CREATE TRIGGER refuse_version BEFORE INSERT ON board_versions BEGIN SELECT RAISE(ABORT,'failure'); END")
            connection.commit()
        with self.assertRaises(BoardStoreError) as error:
            self.save(1, metadata={"title": "不应生效"}, storage={})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(self.request("load", id=self.identity)["board"], original)
        self.assertEqual(len(self.request("history", id=self.identity)["versions"]), 1)

    def test_invalid_version_and_lineage_fields_do_not_change_a_saved_board(self):
        original = self.save()
        requests = [
            {"action": "history", "id": self.identity, "limit": 0},
            {"action": "history", "id": self.identity, "limit": True},
            {"action": "history", "id": self.identity, "beforeRevision": -1},
            {"action": "load", "id": self.identity, "revision": 0},
            {"action": "fork", "id": self.identity, "revision": True},
            {"action": "fork", "id": self.identity, "title": ""},
            {"action": "fork", "id": self.identity, "title": "x", "forkedFrom": {}},
            {"action": "restore", "id": self.identity, "revision": 123, "expectedRevision": 1},
        ]
        for request in requests:
            with self.subTest(body=request), self.assertRaises(BoardStoreError):
                board_store_request(request)
        with self.assertRaises(BoardStoreError):
            self.save(1, metadata={**self.metadata, "forkedFrom": {"boardId": "original", "revision": 1}})
        self.assertEqual(self.request("load", id=self.identity)["board"], original)
        self.assertEqual(len(self.request("history", id=self.identity)["versions"]), 1)

    def test_cold_start_six_way_import_race_returns_one_save_and_five_conflicts(self):
        def write(_):
            try:
                return self.save()["revision"]
            except BoardStoreError as error:
                return error.status

        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(write, range(6)))
        self.assertEqual(results.count(1), 1)
        self.assertEqual(results.count(409), 5)
        self.assertEqual(len(self.request("history", id=self.identity)["versions"]), 1)


class BoardStoreHTTPTests(unittest.TestCase):
    def setUp(self):
        import server
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        configure = patch.dict(os.environ, WHITEBOARD_BOARDS_FILE=str(Path(directory.name, "boards.sqlite3")))
        configure.start()
        self.addCleanup(configure.stop)
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.WhiteboardHandler)
        self.host = f"127.0.0.1:{self.httpd.server_port}"
        allowed = patch.object(server, "ALLOWED_HOSTS", {self.host})
        allowed.start()
        self.addCleanup(allowed.stop)
        self.thread = Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def post(self, body, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        self.addCleanup(connection.close)
        contents = json.dumps(body).encode("utf-8")
        connection.request("POST", "/api/board-store", contents,
                           {"Content-Type": "application/json", "Origin": f"http://{self.host}", **headers})
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_http_endpoint_is_independent_of_active_model_and_protects_origin(self):
        import server
        with patch.object(server, "TURN_LOCK") as busy:
            status, response = self.post({"action": "list"})
            self.assertEqual((status, response), (200, {"boards": [], "deleted": []}))
            busy.acquire.assert_not_called()
        status, _ = self.post({"action": "list"}, Origin="http://unrelated.test")
        self.assertEqual(status, 403)
        status, _ = self.post({"action": "list"}, **{"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_http_save_load_and_conflict_response(self):
        identity = "board-" + "8" * 32
        body = {"action": "save", "id": identity, "expectedRevision": 0,
                "metadata": {"title": "共享测试"}, "storage": {"memory": '{"notes":[]}'}}
        status, saved = self.post(body)
        self.assertEqual(status, 200)
        status, loaded = self.post({"action": "load", "id": identity})
        self.assertEqual(status, 200)
        self.assertEqual(loaded["board"], saved["board"])
        status, stale = self.post(body)
        self.assertEqual(status, 409)
        self.assertEqual(stale["board"], saved["board"])

    def test_http_route_keeps_existing_body_and_header_limits(self):
        import server
        with patch.object(server, "MAX_STORE_REQUEST_BYTES", 8):
            status, _ = self.post({"action": "list"})
        self.assertEqual(status, 413)
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        self.addCleanup(connection.close)
        content = b'{"action":"list"}'
        connection.putrequest("POST", "/api/board-store")
        connection.putheader("Origin", f"http://{self.host}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(len(content)))
        connection.endheaders(content)
        response = connection.getresponse()
        self.assertEqual(response.status, 415)
        response.read()

    def test_sync_bootstrap_is_served_before_existing_browser_scripts(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.request("GET", "/board_sync.js")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("javascript", response.getheader("Content-Type"))
        self.assertIn(b"/api/board-store", response.read())


if __name__ == "__main__":
    unittest.main()
