"""Persist project boards independently of a browser profile or service port.

Only the four document fields below are accepted. Connection settings and API
credentials remain browser-local. SQLite commits the document and catalog
metadata together; the revision check also works between service processes.
"""

from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from uuid import uuid4


MAX_STORE_BYTES = 24 * 1024 * 1024
MAX_STORE_REQUEST_BYTES = MAX_STORE_BYTES + 32 * 1024
MAX_BOARDS = 2048
STORAGE_FIELDS = ("memory", "organization", "templateBackup", "guideBackup")
BUILT_IN_IDS = frozenset(("original", "project-design", "repo-manual", "repo-atlas", "project-workbench"))


class BoardStoreError(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.status = status
        self.details = details


def store_path():
    configured = os.environ.get("WHITEBOARD_BOARDS_FILE")
    return (Path(configured).expanduser() if configured else
            Path.home() / ".circle-ask-whiteboard" / "boards.sqlite3")


def board_id(value):
    if not isinstance(value, str) or (value not in BUILT_IN_IDS and not re.fullmatch(r"board-[0-9a-f]{32}", value)):
        raise BoardStoreError(422, "白板编号无效。")
    return value


def revision_number(value):
    if type(value) is not int or not 0 <= value < 2 ** 53:
        raise BoardStoreError(422, "白板版本号无效，请刷新后重试。")
    return value


def clean_text(value, limit, *, empty=False):
    if (not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()) or
            any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise BoardStoreError(422, "白板名称或项目目录无效，请检查长度和内容。")
    return value.strip()


def clean_metadata(value, identity):
    if (not isinstance(value, dict) or not {"title"} <= value.keys() or
            value.keys() - {"id", "title", "repositoryPath", "projectId"}):
        raise BoardStoreError(422, "请提供白板名称和有效的项目资料。")
    if "id" in value and value["id"] != identity:
        raise BoardStoreError(422, "白板编号与项目资料不一致。")
    result = {"id": identity, "title": clean_text(value["title"], 80)}
    path = clean_text(value.get("repositoryPath", ""), 1024, empty=True)
    if path:
        result["repositoryPath"] = path
    if "projectId" in value:
        project = value["projectId"]
        if not isinstance(project, str) or not re.fullmatch(r"[0-9a-f]{32}", project) or identity != f"board-{project}":
            raise BoardStoreError(422, "白板与本机项目编号不一致。")
        result["projectId"] = project
    return result


def clean_storage(value):
    if not isinstance(value, dict) or value.keys() - set(STORAGE_FIELDS):
        raise BoardStoreError(422, "白板存储只能包含内容、布局和撤销备份。")
    result = {}
    size = 0
    for key in STORAGE_FIELDS:
        item = value.get(key)
        if item is not None:
            if not isinstance(item, str):
                raise BoardStoreError(422, "白板内容必须是 JSON 文本或空值。")
            try:
                size += len(item.encode("utf-8"))
                if size > MAX_STORE_BYTES:
                    raise BoardStoreError(413, "单张白板内容和备份总计不能超过 24 MB。")
                decoded = json.loads(item, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            except (UnicodeError, ValueError, RecursionError) as error:
                raise BoardStoreError(422, "白板内容或备份不是有效的 JSON，请保留本地副本。") from error
            expected = (dict, list) if key in ("templateBackup", "guideBackup") else (dict,)
            if not isinstance(decoded, expected):
                raise BoardStoreError(422, "白板内容或备份的结构无效，请保留本地副本。")
        result[key] = item
    return result


def _initialize(connection):
    if connection.execute("PRAGMA user_version").fetchone()[0] >= 1:
        return
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("""CREATE TABLE IF NOT EXISTS boards (
            id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
            metadata TEXT NOT NULL, storage TEXT NOT NULL,
            updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
            forked_from TEXT
        )""")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(boards)")}
        if "forked_from" not in columns:
            connection.execute("ALTER TABLE boards ADD COLUMN forked_from TEXT")
        connection.execute("""CREATE TABLE IF NOT EXISTS board_versions (
            board_id TEXT NOT NULL, revision INTEGER NOT NULL,
            metadata TEXT NOT NULL, storage TEXT NOT NULL,
            updated_at TEXT NOT NULL, operation TEXT NOT NULL,
            restored_from_revision INTEGER,
            PRIMARY KEY(board_id, revision)
        )""")
        # An upgraded database has no earlier snapshots. Preserve its current
        # revision instead of inventing history or replacing the live document.
        connection.execute("""INSERT OR IGNORE INTO board_versions
            (board_id, revision, metadata, storage, updated_at, operation)
            SELECT id, revision, metadata, storage, updated_at,
                CASE WHEN deleted=1 THEN 'delete' ELSE 'save' END FROM boards""")
        connection.execute("PRAGMA user_version=1")
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise


def _connect():
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 10
    while True:
        connection = sqlite3.connect(path, timeout=10, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=10000")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            _initialize(connection)
            return connection
        except Exception as error:
            connection.close()
            # Concurrent first requests can race the journal-mode/schema
            # transition before SQLite's usual busy timeout takes effect.
            if isinstance(error, sqlite3.OperationalError) and "locked" in str(error).lower() and time.monotonic() < deadline:
                time.sleep(0.025)
                continue
            raise


def _board(row, *, contents=True):
    if row is None or row["deleted"]:
        return None
    try:
        metadata = clean_metadata(json.loads(row["metadata"]), board_id(row["id"]))
        value = {**metadata, "revision": revision_number(row["revision"]), "updatedAt": row["updated_at"]}
        if contents:
            value["storage"] = clean_storage(json.loads(row["storage"]))
        if row["forked_from"] is not None:
            source = json.loads(row["forked_from"])
            if not isinstance(source, dict) or source.keys() != {"boardId", "revision", "title"}:
                raise ValueError("Invalid fork lineage")
            value["forkedFrom"] = {"boardId": board_id(source["boardId"]),
                                   "revision": positive_revision(source["revision"]),
                                   "title": clean_text(source["title"], 80)}
        return value
    except (BoardStoreError, ValueError, TypeError, RecursionError) as error:
        raise BoardStoreError(503, "服务端白板记录格式异常，已保留原记录，请先检查或恢复备份。") from error


def _conflict(row):
    raise BoardStoreError(409, "这张白板已在其他浏览器更新或删除。本页草稿已保留，请刷新后再操作。",
                          board=_board(row), deleted=bool(row and row["deleted"]),
                          revision=row["revision"] if row else 0)


def _validate_body(body):
    if not isinstance(body, dict) or body.get("action") not in ("list", "load", "save", "delete", "history", "restore", "fork"):
        raise BoardStoreError(400, "无效的白板存储操作。")
    action = body["action"]
    fields = {"action"}
    if action != "list":
        fields.add("id")
    if action in ("save", "delete", "restore"):
        fields.add("expectedRevision")
    if action == "save":
        fields.update(("metadata", "storage"))
    if action == "restore":
        fields.add("revision")
    optional = {"revision"} if action == "load" else {"revision", "title"} if action == "fork" else {
        "limit", "beforeRevision"} if action == "history" else set()
    if not fields <= body.keys() or body.keys() - fields - optional:
        raise BoardStoreError(400, "白板存储操作的字段不完整或不受支持。")
    identity = board_id(body["id"]) if action != "list" else None
    expected = revision_number(body["expectedRevision"]) if action in ("save", "delete", "restore") else None
    metadata = clean_metadata(body["metadata"], identity) if action == "save" else None
    storage = clean_storage(body["storage"]) if action == "save" else None
    for key in ("revision", "beforeRevision"):
        if key in body:
            positive_revision(body[key])
    if "limit" in body and (type(body["limit"]) is not int or not 1 <= body["limit"] <= 100):
        raise BoardStoreError(422, "版本列表每次可读取 1 到 100 项。")
    if "title" in body:
        clean_text(body["title"], 80)
    return action, identity, expected, metadata, storage


def positive_revision(value):
    number = revision_number(value)
    if number < 1:
        raise BoardStoreError(422, "请选择已经保存的白板版本。")
    return number


def _snapshot(connection, identity, revision):
    row = connection.execute("""SELECT v.board_id AS id, v.revision, v.metadata, v.storage,
        v.updated_at, 0 AS deleted, b.forked_from
        FROM board_versions v JOIN boards b ON b.id=v.board_id
        WHERE v.board_id=? AND v.revision=?""", (identity, revision)).fetchone()
    if row is None:
        raise BoardStoreError(404, "这个白板版本不存在，请刷新版本列表后重试。")
    return row


def _version(connection, identity, operation, restored_from=None):
    connection.execute("""INSERT INTO board_versions
        (board_id, revision, metadata, storage, updated_at, operation, restored_from_revision)
        SELECT id, revision, metadata, storage, updated_at, ?, ? FROM boards WHERE id=?""",
                       (operation, restored_from, identity))


def _capacity(connection):
    if connection.execute("SELECT COUNT(*) FROM boards WHERE deleted=0").fetchone()[0] >= MAX_BOARDS:
        raise BoardStoreError(413, "服务端白板数量已达到上限，请先整理现有项目。")


def _fork_storage(storage, target, title):
    """Rebind document identity, never citations, card IDs or answer prose."""
    def memory_document(raw):
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            # A legacy undo pair can contain an unreadable old document. Keep
            # its bytes without blocking a fork of the valid current board.
            return raw
        changed = False
        notes = value.get("notes", []) if isinstance(value, dict) else []
        for note in notes if isinstance(notes, list) else []:
            if not isinstance(note, dict):
                continue
            for key in ("payload", "retryPayload"):
                payload = note.get(key)
                if isinstance(payload, dict):
                    payload["boardId"] = target
                    changed = True
        return json.dumps(value, ensure_ascii=False) if changed else raw

    result = {**storage, "memory": memory_document(storage["memory"])}
    if storage["organization"] is not None:
        organization = json.loads(storage["organization"])
        if isinstance(organization.get("current"), dict):
            organization["current"]["title"] = title
            result["organization"] = json.dumps(organization, ensure_ascii=False)
    for key in ("templateBackup", "guideBackup"):
        raw = storage[key]
        if raw is None:
            continue
        value = json.loads(raw)
        pair = value if isinstance(value, list) else value.get("values") if isinstance(value, dict) else None
        if isinstance(pair, list) and len(pair) == 2 and isinstance(pair[0], str):
            replacement = memory_document(pair[0])
            if replacement != pair[0]:
                pair[0] = replacement
                result[key] = json.dumps(value, ensure_ascii=False)
    return result


def board_store_request(body):
    action, identity, expected, metadata, storage = _validate_body(body)
    try:
        with closing(_connect()) as connection:
            if action == "list":
                rows = connection.execute("SELECT id, revision, metadata, updated_at, deleted, forked_from FROM boards ORDER BY updated_at, id").fetchall()
                return {"boards": [_board(row, contents=False) for row in rows if not row["deleted"]],
                        "deleted": [{"id": row["id"], "revision": row["revision"]} for row in rows if row["deleted"]]}
            if action == "load":
                if "revision" in body:
                    row = _snapshot(connection, identity, body["revision"])
                    return {"board": _board(row), "deleted": False, "revision": row["revision"]}
                row = connection.execute("SELECT * FROM boards WHERE id=?", (identity,)).fetchone()
                return {"board": _board(row), "deleted": bool(row and row["deleted"]),
                        "revision": row["revision"] if row else 0}
            if action == "history":
                if connection.execute("SELECT id FROM boards WHERE id=?", (identity,)).fetchone() is None:
                    raise BoardStoreError(404, "这张白板还没有保存到服务端。")
                limit = body.get("limit", 30)
                before = body.get("beforeRevision", 2 ** 53)
                rows = connection.execute("""SELECT revision, metadata, updated_at, operation, restored_from_revision
                    FROM board_versions WHERE board_id=? AND revision<? ORDER BY revision DESC LIMIT ?""",
                                          (identity, before, limit + 1)).fetchall()
                versions = []
                for row in rows[:limit]:
                    item = {"revision": row["revision"], "title": json.loads(row["metadata"])["title"],
                            "updatedAt": row["updated_at"], "operation": row["operation"]}
                    if row["restored_from_revision"] is not None:
                        item["restoredFromRevision"] = row["restored_from_revision"]
                    versions.append(item)
                return {"id": identity, "versions": versions,
                        "nextBeforeRevision": versions[-1]["revision"] if len(rows) > limit else None}
            # BEGIN IMMEDIATE makes comparing the revision and committing the
            # whole card tree atomic even when two localhost services share it.
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT * FROM boards WHERE id=?", (identity,)).fetchone()
                if action == "fork":
                    source = _snapshot(connection, identity, body["revision"]) if "revision" in body else row
                    if source is None or source["deleted"]:
                        raise BoardStoreError(404, "请先保存源白板，或选择已有版本后再创建分支。")
                    source_board = _board(source)
                    _capacity(connection)
                    target = f"board-{uuid4().hex}"
                    title = clean_text(body["title"], 80) if "title" in body else f"{source_board['title'][:75]} · 分支"
                    fork_metadata = {"id": target, "title": title}
                    if source_board.get("repositoryPath"):
                        fork_metadata["repositoryPath"] = source_board["repositoryPath"]
                    lineage = {"boardId": identity, "revision": source["revision"], "title": source_board["title"]}
                    fork_storage = _fork_storage(source_board["storage"], target, title)
                    updated = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                    connection.execute("""INSERT INTO boards
                        (id, revision, metadata, storage, updated_at, forked_from) VALUES (?, 1, ?, ?, ?, ?)""",
                                       (target, json.dumps(fork_metadata, ensure_ascii=False), json.dumps(fork_storage, ensure_ascii=False), updated,
                                        json.dumps(lineage, ensure_ascii=False)))
                    _version(connection, target, "fork")
                    result = {"board": _board(connection.execute("SELECT * FROM boards WHERE id=?", (target,)).fetchone())}
                    connection.execute("COMMIT")
                    return result
                if (row is not None and row["deleted"] and action != "restore") or expected != (row["revision"] if row else 0):
                    _conflict(row)
                if expected >= 2 ** 53 - 1:
                    raise BoardStoreError(422, "白板版本号已达到上限，请创建新的分支。")
                next_revision = expected + 1
                updated = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                if action == "delete":
                    if row is None:
                        raise BoardStoreError(404, "这张白板还没有保存到服务端。")
                    # Retain the last document privately for recovery, but never
                    # let a stale browser migration resurrect a deleted board.
                    connection.execute("UPDATE boards SET revision=?, updated_at=?, deleted=1 WHERE id=?",
                                       (next_revision, updated, identity))
                    _version(connection, identity, "delete")
                    result = {"id": identity, "revision": next_revision, "deleted": True}
                elif action == "restore":
                    if row is None:
                        raise BoardStoreError(404, "这张白板还没有保存到服务端。")
                    source = _snapshot(connection, identity, body["revision"])
                    _board(source)
                    if row["deleted"]:
                        _capacity(connection)
                    connection.execute("""UPDATE boards SET revision=?, metadata=?, storage=?, updated_at=?, deleted=0
                        WHERE id=?""", (next_revision, source["metadata"], source["storage"], updated, identity))
                    _version(connection, identity, "restore", body["revision"])
                    result = {"board": _board(connection.execute("SELECT * FROM boards WHERE id=?", (identity,)).fetchone())}
                else:
                    if row is None:
                        _capacity(connection)
                    connection.execute("""INSERT INTO boards(id, revision, metadata, storage, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, metadata=excluded.metadata,
                            storage=excluded.storage, updated_at=excluded.updated_at""",
                                       (identity, next_revision, json.dumps(metadata, ensure_ascii=False),
                                        json.dumps(storage, ensure_ascii=False), updated))
                    _version(connection, identity, "save")
                    result = {"board": _board(connection.execute("SELECT * FROM boards WHERE id=?", (identity,)).fetchone())}
                connection.execute("COMMIT")
                return result
            except Exception:
                connection.execute("ROLLBACK")
                raise
    except BoardStoreError:
        raise
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, RecursionError) as error:
        raise BoardStoreError(503, "服务端白板存储暂不可用。本页本地内容已保留，请稍后重试。") from error
