"""Read-only GitNexus evidence for the whiteboard's local source snapshot."""

from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_SYMBOLS = 3000
MAX_CALLS = 10000
TIMEOUT_SECONDS = 180
SYMBOL_NAME = re.compile(r"(?:[^\W\d]|\$)[\w$]{0,159}")
SYMBOL_KINDS = ("Function", "Class", "Method", "Constructor")
SYMBOL_QUERY = (
    "MATCH (n) WHERE labels(n) IN ['Function', 'Class', 'Method', 'Constructor'] "
    "RETURN n.id AS id, n.name AS name, n.filePath AS file, n.startLine AS line, labels(n) AS kind "
    f"ORDER BY file, line, name LIMIT {MAX_SYMBOLS + 1}"
)
CALL_QUERY = (
    "MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' "
    f"RETURN DISTINCT a.id AS caller, b.id AS callee ORDER BY caller, callee LIMIT {MAX_CALLS + 1}"
)


class RepoIndexError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def cli_command():
    configured = os.environ.get("WHITEBOARD_GITNEXUS_CLI")
    if configured is None:
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        configured = ""
        if local_app_data:
            configured = str(Path(local_app_data) / "CircleAskWhiteboard" / "tools" / "gitnexus" / "1.6.12"
                             / "node_modules" / "gitnexus" / "dist" / "cli" / "index.js")
    path = Path(configured)
    if configured and path.is_absolute() and path.is_file():
        if path.suffix.lower() in {".js", ".mjs", ".cjs"}:
            node = shutil.which("node")
            if node:
                return [node, str(path)]
        elif path.suffix.lower() == ".exe" or (os.name != "nt" and os.access(path, os.X_OK)):
            return [str(path)]
    raise RepoIndexError(503, "GitNexus 不可用。请在白板服务中配置 WHITEBOARD_GITNEXUS_CLI。")


def isolated_env(directory):
    allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC"}
    env = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    home = directory / "home"
    scratch = directory / "tmp"
    home.mkdir()
    scratch.mkdir()
    env.update({name: str(home) for name in (
        "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
    )})
    env.update({name: str(scratch) for name in ("TEMP", "TMP", "TMPDIR")})
    env.update(GITNEXUS_HOME=str(directory / "gitnexus"), GITNEXUS_NO_UPDATE_NOTIFIER="1",
               GITNEXUS_LBUG_EXTENSION_INSTALL="never", GITNEXUS_SHARED_STORE="off",
               GITNEXUS_MEMORY="off", GITNEXUS_CONTENT_RETENTION="none", NO_COLOR="1")
    return env


def run_cli(command, args, cwd, env, deadline):
    description = {"--version": "检查版本", "analyze": "构建索引", "cypher": "读取代码关系"}[args[0]]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        with tempfile.TemporaryFile() as output:
            with subprocess.Popen([*command, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output,
                                  stderr=subprocess.DEVNULL, creationflags=flags) as process:
                while process.poll() is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        process.kill()
                        raise RepoIndexError(504, f"GitNexus {description}超时，请重试。")
                    if os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES:
                        process.kill()
                        raise RepoIndexError(502, f"GitNexus {description}输出超过限制。")
                    try:
                        process.wait(timeout=min(remaining, 0.05))
                    except subprocess.TimeoutExpired:
                        pass
                if process.returncode != 0:
                    raise RepoIndexError(502, f"GitNexus {description}失败，请检查本机安装。")
            output.seek(0)
            raw = output.read(MAX_OUTPUT_BYTES + 1)
            if len(raw) > MAX_OUTPUT_BYTES:
                raise RepoIndexError(502, f"GitNexus {description}输出超过限制。")
            return raw.decode("utf-8").strip()
    except (OSError, UnicodeError) as error:
        raise RepoIndexError(502, f"无法完成 GitNexus {description}。") from error


def read_rows(output, columns, limit):
    try:
        result = json.loads(output)
        if isinstance(result, dict):
            # The CLI renders tabular results as Markdown inside its JSON response.
            lines = result["markdown"].splitlines()

            def cells(line):
                if not line.startswith("|") or not line.endswith("|"):
                    raise ValueError
                return [value.strip() for value in line[1:-1].split("|")]

            if (len(lines) < 2 or cells(lines[0]) != list(columns)
                    or result["row_count"] != len(lines) - 2):
                raise ValueError
            result = [dict(zip(columns, cells(line), strict=True)) for line in lines[2:]]
        if not isinstance(result, list) or any(
                not isinstance(row, dict) or not all(column in row for column in columns) for row in result):
            raise ValueError
    except (AttributeError, KeyError, TypeError, ValueError, RecursionError) as error:
        raise RepoIndexError(502, "GitNexus 返回了无法读取的代码索引。") from error
    if len(result) > limit:
        raise RepoIndexError(502, "GitNexus 的代码索引超过当前白板的结果上限。")
    return result


class RepositoryIndex:
    def __init__(self, source_files, public_file):
        self.source_files = tuple(sorted(source_files))
        self.public_file = public_file
        self.lock = threading.Lock()
        self.cache_key = None
        self.cache = None

    def request(self, body):
        if not isinstance(body, dict):
            raise RepoIndexError(400, "请提交代码索引请求。")
        action = body.get("action")
        if action == "scan" and set(body) == {"action"}:
            symbol = None
            file = None
        elif action == "context" and set(body) <= {"action", "symbol", "file"}:
            symbol = body.get("symbol")
            file = body.get("file")
            if (not isinstance(symbol, str) or not SYMBOL_NAME.fullmatch(symbol)
                    or ("file" in body and file not in self.source_files)):
                raise RepoIndexError(400, "请输入有效的代码符号和源码文件名。")
        else:
            raise RepoIndexError(400, "未知的代码索引操作。")

        command = cli_command()
        if not self.lock.acquire(blocking=False):
            raise RepoIndexError(409, "GitNexus 正在扫描源码，请稍后重试。")
        try:
            snapshot, sources = self.read_sources()
            key = (snapshot, tuple(command))
            if key != self.cache_key:
                self.cache = self.build(command, sources)
                self.cache_key = key
            version, symbols, callers, callees = self.cache
            response = {"engine": "GitNexus", "version": version, "snapshot": snapshot,
                        "files": [{"path": name, "bytes": len(data)} for name, data in sources.items()]}
            if symbol is None:
                return {**response, "symbols": list(symbols.values())}
            matches = [uid for uid, record in symbols.items()
                       if record["name"] == symbol and (file is None or record["file"] == file)]
            if not matches:
                raise RepoIndexError(404, "当前索引中没有找到这个代码符号。")
            if len(matches) > 1:
                raise RepoIndexError(409, "当前索引中有多个同名符号，请指定源码文件。")
            uid = matches[0]
            record = symbols[uid]
            return {**response, "context": {"symbol": symbol, "file": record["file"],
                    "line": record["line"], "kind": record["kind"],
                    "callers": [symbols[other] for other in callers.get(uid, ())],
                    "callees": [symbols[other] for other in callees.get(uid, ())]}}
        finally:
            self.lock.release()

    def read_sources(self):
        sources = {}
        fingerprint = hashlib.sha256()
        total = 0
        for name in self.source_files:
            try:
                with self.public_file(name).open("rb") as source:
                    data = source.read(MAX_FILE_BYTES + 1)
            except OSError as error:
                raise RepoIndexError(500, "白板源码文件不可读。") from error
            total += len(data)
            if len(data) > MAX_FILE_BYTES or total > MAX_SNAPSHOT_BYTES:
                raise RepoIndexError(413, "白板源码快照超过扫描上限。")
            sources[name] = data
            fingerprint.update(name.encode("utf-8") + b"\0" + hashlib.sha256(data).digest())
        return fingerprint.hexdigest(), sources

    def build(self, command, sources):
        deadline = time.monotonic() + TIMEOUT_SECONDS
        try:
            with tempfile.TemporaryDirectory(prefix="whiteboard-index-") as directory:
                temporary = Path(directory).resolve()
                snapshot = temporary / "whiteboard-prototype"
                snapshot.mkdir()
                for name, data in sources.items():
                    (snapshot / name).write_bytes(data)
                env = isolated_env(temporary)
                version = run_cli(command, ("--version",), snapshot, env, deadline)
                if not re.fullmatch(r"\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?", version):
                    raise RepoIndexError(502, "无法确认本机 GitNexus 的版本。")
                analyze_args = ("analyze", str(snapshot), "--skip-git", "--index-only", "--skip-fts",
                                "--workers", "2", "--max-file-size", str(MAX_FILE_BYTES // 1024))
                run_cli(command, analyze_args, snapshot, env, deadline)
                symbol_rows = read_rows(run_cli(command, ("cypher", SYMBOL_QUERY), snapshot, env, deadline),
                                        ("id", "name", "file", "line", "kind"), MAX_SYMBOLS)
                call_rows = read_rows(run_cli(command, ("cypher", CALL_QUERY), snapshot, env, deadline),
                                      ("caller", "callee"), MAX_CALLS)
        except OSError as error:
            raise RepoIndexError(500, "无法准备或清理本机源码快照。") from error

        symbols = {}
        line_counts = {name: data.count(b"\n") + 1 for name, data in sources.items()}
        for row in symbol_rows:
            uid, name, file, line, kind = (row[key] for key in ("id", "name", "file", "line", "kind"))
            if not isinstance(file, str) or file not in sources:
                continue
            if isinstance(line, str) and re.fullmatch(r"[0-9]{1,8}", line):
                line = int(line)
            if (isinstance(uid, str) and 0 < len(uid) <= 512 and isinstance(name, str)
                    and SYMBOL_NAME.fullmatch(name) and type(line) is int and 0 <= line < line_counts[file]
                    and kind in SYMBOL_KINDS):
                symbols[uid] = {"name": name, "file": file, "line": line + 1, "kind": kind}
        if not symbols:
            raise RepoIndexError(502, "GitNexus 没有在白板源码中识别到代码符号。")

        callers, callees = defaultdict(set), defaultdict(set)
        for row in call_rows:
            caller, callee = row["caller"], row["callee"]
            if isinstance(caller, str) and isinstance(callee, str) and caller in symbols and callee in symbols:
                callers[callee].add(caller)
                callees[caller].add(callee)
        return version, symbols, {uid: sorted(others) for uid, others in callers.items()}, {
            uid: sorted(others) for uid, others in callees.items()
        }
