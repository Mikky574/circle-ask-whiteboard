"""Bounded, user-visible coding agent activity built from observed tool events."""

from difflib import unified_diff
import hashlib
from itertools import islice
import json
import re
from pathlib import PurePosixPath

from zcode_workspace import ATTACHMENT, READABLE, REPOSITORY_PREFIX, repository_name_allowed

TRACE_LIMIT = 120
DETAIL_LIMIT = 1400
DETAIL_LINES = 14
TOOL_KINDS = {"list_files": "list", "read_file": "read", "replace_text": "edit"}
TOOL_LABELS = {"list": "列出项目文件", "read": "读取源码", "edit": "暂存源码修改",
               "command": "执行本地命令", "search": "搜索源码", "tool": "调用本机工具"}
SECRET_LINE = re.compile(
    r"password|passphrase|passwd|credential|secret|(?:api|access|private)[_-]?key|"
    r"(?:access|auth|refresh|session)[_-]?token|\btoken\s*[:=]|(?:bearer|basic)\s+[\w+/=-]+|"
    r"\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|"
    r"(?:AKIA|ASIA)[A-Z0-9]{16})\b|[\w+.-]+://[^\s/]+:[^\s/]+@",
    re.I,
)
SECRET_BLOCK = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", re.I)
TRACE_PATH = re.compile(r"[\w .()\[\]@+/-]+", re.UNICODE)
SOURCE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".h", ".hpp",
    ".html", ".java", ".js", ".jsx", ".kt", ".lua", ".mjs", ".php", ".py", ".rb",
    ".rs", ".scala", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
}


def safe_path(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 300:
        return None
    value = value.replace("\\", "/").removeprefix("./")
    if not TRACE_PATH.fullmatch(value) or SECRET_LINE.search(value):
        return None
    if not all(repository_name_allowed(part) for part in value.split("/")):
        return None
    return value


def bounded_detail(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    if SECRET_BLOCK.search(value):
        return "〔敏感内容已隐藏〕"
    lines = value.splitlines()[:DETAIL_LINES + 1]
    clipped = len(lines) > DETAIL_LINES or len(value) > DETAIL_LIMIT
    preview = "\n".join(
        "〔敏感内容已隐藏〕" if SECRET_LINE.search(line) else
        "".join(character for character in line if character == "\t" or character.isprintable())
        for line in lines[:DETAIL_LINES]
    )
    suffix = "\n…" if clipped else ""
    return preview[:DETAIL_LIMIT - len(suffix)].rstrip() + suffix


def diff_preview(previous, updated):
    """Show the first actual change with a small amount of surrounding code."""
    old = previous.decode("utf-8").splitlines()
    new = updated.decode("utf-8").splitlines()
    shared = next((index for index, (a, b) in enumerate(zip(old, new)) if a != b), min(len(old), len(new)))
    if len(old) == len(new) == shared:
        return None
    start = max(0, shared - 2)
    remaining = min(len(old), len(new)) - shared
    common_end = next((index for index in range(remaining) if old[-index - 1] != new[-index - 1]), remaining)
    trim = max(0, common_end - 2)
    old_end, new_end = len(old) - trim, len(new) - trim
    if max(old_end, new_end) - start > 600:
        return None
    diff = unified_diff(old[start:old_end], new[start:new_end], n=2, lineterm="")
    lines = list(islice(diff, 3, DETAIL_LINES + 3))
    if not lines:
        return None
    # Drop further hunk headers because line offsets in the clipped window are local.
    stop = next((index for index, line in enumerate(lines) if line.startswith("@@")), len(lines))
    return "\n".join([f"@@ 第 {start + 1} 行附近 @@", *lines[:stop]])


def trace_event(identifier, kind, state, *, path=None, text=None, detail=None, detail_kind="text"):
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 256:
        return None
    step = "step-" + hashlib.sha256(identifier.encode("utf-8", errors="replace")).hexdigest()[:24]
    event = {"step": step, "kind": kind, "state": state, "text": text or TOOL_LABELS[kind]}
    path = safe_path(path)
    if path:
        event["path"] = path
    if preview := bounded_detail(detail):
        event.update(detail=preview, detailKind=detail_kind)
    return event


def tool_output(value):
    if not isinstance(value, dict):
        return {}
    if any(field in value for field in ("text", "files", "updated")):
        return value
    content = value.get("content")
    if isinstance(content, list) and content:
        block = content[0]
        content = block.get("text") if isinstance(block, dict) and block.get("type") == "text" else None
    if isinstance(content, str) and len(content) <= 150_000:
        try:
            decoded = json.loads(content)
        except (ValueError, RecursionError):
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def mcp_trace(identifier, name, state, arguments, result):
    kind = TOOL_KINDS.get(name, "tool") if isinstance(name, str) else "tool"
    path = safe_path(arguments.get("path")) if kind in ("list", "read", "edit") and isinstance(arguments, dict) else None
    result = tool_output(result) if state == "done" and kind != "tool" else {}
    if path is None and kind in ("read", "edit"):
        path = safe_path(result.get("path") if kind == "read" else result.get("updated"))
    detail, detail_kind = None, "text"
    if kind == "read" and path and not ATTACHMENT.fullmatch(path):
        scope = path.startswith(REPOSITORY_PREFIX) or path in READABLE
        if scope and PurePosixPath(path).suffix.casefold() in SOURCE_SUFFIXES:
            detail, detail_kind = result.get("text"), "code"
    elif kind == "list" and isinstance(result.get("files"), list):
        detail = f"工具返回 {len(result['files'])} 个文件路径"
        if result.get("truncated") is True:
            detail += "（目录较大，结果已截断）"
    return trace_event(identifier, kind, state, path=path, detail=detail, detail_kind=detail_kind)


def codex_trace(event):
    phase = event.get("type")
    item = event.get("item")
    if phase not in ("item.started", "item.completed") or not isinstance(item, dict):
        return None
    state = "running" if phase == "item.started" else "done"
    item_type = item.get("type")
    identifier = item.get("id")
    if item_type == "mcp_tool_call":
        result = item.get("result")
        if (item.get("error") or item.get("status") == "failed" or
                isinstance(result, dict) and result.get("isError") is True):
            state = "error"
        name = item.get("tool")
        return mcp_trace(identifier, name if item.get("server") == "whiteboard" else None,
                         state, item.get("arguments"), result)
    if item_type == "command_execution":
        command = item.get("command")
        kind, path = "command", None
        if isinstance(command, str):
            if re.search(r"\b(?:rg|grep|select-string)\b", command, re.I):
                kind = "search"
            elif re.search(r"\b(?:get-content|cat|head|tail|sed\s+-n)\b", command, re.I):
                kind = "read"
            if kind in ("read", "search"):
                candidates = [name for name in READABLE if re.search(
                    rf"(?<![\w./\\\\:-]){re.escape(name)}(?![\w./\\\\:-])", command, re.I)]
                if len(candidates) == 1:
                    path = candidates[0]
        exit_code = item.get("exit_code")
        if item.get("status") == "failed" or state == "done" and type(exit_code) is int and exit_code != 0:
            state = "error"
        detail = f"退出码 {exit_code}" if state != "running" and type(exit_code) is int and abs(exit_code) < 1_000_000 else None
        return trace_event(identifier, kind, state, path=path, detail=detail)
    if item_type == "file_change":
        changes = item.get("changes")
        paths = [safe_path(change.get("path")) for change in changes if isinstance(change, dict)] if isinstance(changes, list) else []
        paths = [path for path in paths if path in READABLE]
        return trace_event(identifier, "edit", "error" if item.get("status") == "failed" else state,
                           path=paths[0] if len(paths) == 1 else None)
    if item_type == "web_search":
        return trace_event(identifier, "search", state, text="检索外部资料")
    return None


def zcode_trace(payload, pending):
    if not isinstance(payload, dict):
        return None
    phase = payload.get("kind")
    identifier = payload.get("toolCallId")
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 256:
        return None
    if phase == "scheduled":
        if len(pending) >= TRACE_LIMIT:
            return None
        name = payload.get("toolName")
        arguments = payload.get("input")
        name = name.removeprefix("mcp__whiteboard__") if isinstance(name, str) and name.startswith("mcp__whiteboard__") else None
        pending[identifier] = name, arguments
        return mcp_trace(identifier, name, "running", arguments, None)
    if phase not in ("result", "error") or identifier not in pending:
        return None
    name, arguments = pending.pop(identifier)
    result = payload.get("result")
    failed = phase == "error" or isinstance(result, dict) and (
        result.get("success") is False or result.get("isError") is True)
    return mcp_trace(identifier, name, "error" if failed else "done", arguments, result)
