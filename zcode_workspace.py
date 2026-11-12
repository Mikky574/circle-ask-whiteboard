"""A stdio MCP server scoped to one staged whiteboard request."""

import json
import os
import re
import stat
import sys
from collections import deque
from itertools import islice
from pathlib import Path


EDITABLE = ("index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js")
READABLE = (
    *EDITABLE, "run_gate.js", "server.py", "attachments.py", "zcode_backend.py", "zcode_workspace.py",
    "backends.py", "api_backend.py", "board_tools.py",
)
ATTACHMENT = re.compile(r"attachments/attachment-[0-9]{1,2}\.[a-z0-9]{1,12}")
TEXT = {"type": "string"}
REPOSITORY_PREFIX = "repository/"
MAX_REPOSITORY_ENTRIES = 320
MAX_REPOSITORY_SCAN = 4000
MAX_REPOSITORY_FILE_BYTES = 2 * 1024 * 1024
SKIP_REPOSITORY_NAMES = {
    ".git", ".hg", ".svn", ".ssh", ".aws", ".docker", ".gnupg", ".venv", ".tox", ".next",
    "node_modules", "__pycache__", ".cache", ".npmrc", ".pypirc", ".netrc",
    ".git-credentials", "credentials", "credentials.json", "credentials.yaml", "credentials.yml",
    "secrets.json", "secrets.yaml", "secrets.yml", "id_rsa", "id_ed25519",
}
SENSITIVE_FILE_SUFFIXES = {".env", ".key", ".pem", ".p12", ".pfx", ".kdbx"}


def tool(name, description, properties, required):
    read_only = name != "replace_text"
    return {"name": name, "description": description,
            "annotations": {"readOnlyHint": read_only, "destructiveHint": not read_only, "openWorldHint": False},
            "inputSchema": {"type": "object", "properties": properties, "required": required,
                            "additionalProperties": False}}


TOOLS = [
    tool("list_files", "List readable source files and staged attachments.", {}, []),
    tool("read_file", "Read a UTF-8 text range from a path returned by list_files. Use nextOffset to continue.",
         {"path": TEXT, "offset": {"type": "integer", "minimum": 0},
          "limit": {"type": "integer", "minimum": 1, "maximum": 20000}}, ["path"]),
    tool("replace_text", "Replace one unique exact text match in an editable front-end source file.",
         {"path": TEXT, "before": TEXT, "after": TEXT}, ["path", "before", "after"]),
]
REPOSITORY_LIST_TOOL = tool(
    "list_files",
    "List a bounded sample of files in the bound repository and staged attachments. "
    "Supply one of the listed repository directories to narrow the search.",
    {"path": TEXT}, [],
)


def file_path(root, name, write=False):
    if not isinstance(name, str) or (name not in (EDITABLE if write else READABLE)
                                     and (write or not ATTACHMENT.fullmatch(name))):
        raise ValueError("File is outside the allowed workspace scope.")
    path = root / name
    if path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("File is unavailable.")
    return path


def repository_name_allowed(name):
    folded = name.casefold()
    return (bool(name) and folded not in (".", "..", ".env")
            and not any(character in "\\:" or ord(character) < 32 or 0xD800 <= ord(character) <= 0xDFFF for character in name)
            and folded not in SKIP_REPOSITORY_NAMES and not folded.startswith(".env.")
            and Path(folded).suffix not in SENSITIVE_FILE_SUFFIXES)


def repository_path(repository, name):
    path = repository
    if name not in (None, "", REPOSITORY_PREFIX.rstrip("/"), REPOSITORY_PREFIX):
        if not isinstance(name, str) or not name.startswith(REPOSITORY_PREFIX) or len(name) > 1024:
            raise ValueError("Use a path relative to repository/.")
        parts = name[len(REPOSITORY_PREFIX):].split("/")
        if not all(repository_name_allowed(part) for part in parts):
            raise ValueError("File is outside the allowed repository scope.")
        path = repository.joinpath(*parts)
    try:
        if path.resolve(strict=True) == path:
            return path
    except (OSError, RuntimeError):
        pass
    raise ValueError("Repository path is unavailable or is a link.")


def repository_listing(repository, name):
    directory = repository_path(repository, name)
    if not directory.is_dir():
        raise ValueError("Choose a repository directory.")
    pending = deque([directory])
    files, directories = [], []
    scanned = 0
    truncated = False
    while pending and scanned < MAX_REPOSITORY_SCAN and len(files) + len(directories) < MAX_REPOSITORY_ENTRIES:
        parent = pending.popleft()
        try:
            if parent.resolve(strict=True) != parent:
                continue
            with os.scandir(parent) as entries:
                remaining = MAX_REPOSITORY_SCAN - scanned
                batch = list(islice(entries, remaining + 1))
                truncated |= len(batch) > remaining
            scanned += min(len(batch), remaining)
        except (OSError, RuntimeError):
            continue
        for entry in sorted(batch[:remaining], key=lambda item: item.name.casefold()):
            if len(files) + len(directories) >= MAX_REPOSITORY_ENTRIES:
                truncated = True
                break
            if not repository_name_allowed(entry.name):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                continue
            path = parent / entry.name
            relative = REPOSITORY_PREFIX + path.relative_to(repository).as_posix()
            if len(relative) > 1024:
                continue
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
                directories.append(relative)
            elif stat.S_ISREG(info.st_mode) and info.st_size <= MAX_REPOSITORY_FILE_BYTES:
                files.append(relative)
    return {"files": files, "directories": directories, "truncated": bool(pending) or truncated}


def call_tool(root, mode, name, args, *, repository=None):
    if name == "list_files":
        attachments = [path.relative_to(root).as_posix() for path in (root / "attachments").glob("attachment-*")]
        if repository is not None:
            listing = repository_listing(repository, args.get("path"))
            listing["files"] += [name for name in sorted(attachments) if (root / name).is_file()]
            return listing
        return {"files": [name for name in (*READABLE, *sorted(attachments)) if (root / name).is_file()]}
    if name == "read_file":
        name_or_path = args.get("path")
        repository_read = repository is not None and isinstance(name_or_path, str) and name_or_path.startswith(REPOSITORY_PREFIX)
        if repository is not None and not repository_read and (
                not isinstance(name_or_path, str) or not ATTACHMENT.fullmatch(name_or_path)):
            raise ValueError("Use a listed repository file or staged attachment.")
        path = repository_path(repository, name_or_path) if repository_read else file_path(root, name_or_path)
        offset, limit = args.get("offset", 0), args.get("limit", 16000)
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 20000:
            raise ValueError("Invalid text range.")
        try:
            if repository_read:
                if not path.is_file():
                    raise ValueError("Choose a repository file.")
                with path.open("rb") as stream:
                    contents = stream.read(MAX_REPOSITORY_FILE_BYTES + 1)
                if len(contents) > MAX_REPOSITORY_FILE_BYTES:
                    raise ValueError("Repository file is too large.")
                if b"\x00" in contents:
                    raise ValueError("Repository file is not UTF-8 text.")
                contents = contents.decode("utf-8-sig")
            else:
                contents = path.read_bytes().decode("utf-8-sig")
        except UnicodeError:
            raise ValueError("File is not UTF-8 text. Use the supplied native attachment if supported.") from None
        end = offset + limit
        return {"text": contents[offset:end], "nextOffset": end if end < len(contents) else None}
    if name != "replace_text" or mode != "edit" or repository is not None:
        raise ValueError("Tool is unavailable for this request.")
    path = file_path(root, args.get("path"), write=True)
    before, after = args.get("before"), args.get("after")
    if not isinstance(before, str) or not before or not isinstance(after, str):
        raise ValueError("Provide nonempty before text and the replacement text.")
    contents = path.read_bytes().decode("utf-8")
    if before not in contents and "\r\n" in contents and "\r" not in before:
        before = before.replace("\n", "\r\n")
        after = after.replace("\r\n", "\n").replace("\n", "\r\n")
    if contents.count(before) != 1:
        raise ValueError("Expected one exact match. Read the file and use a more specific selection.")
    updated = contents.replace(before, after, 1).encode("utf-8")
    if len(updated) > 2 * 1024 * 1024:
        raise ValueError("Updated source file is too large.")
    path.write_bytes(updated)
    return {"updated": args["path"]}


def serve(root, mode, *, repository=None):
    tools = TOOLS if mode == "edit" else TOOLS[:2]
    if repository is not None:
        tools = [REPOSITORY_LIST_TOOL, TOOLS[1]]
    for raw in sys.stdin.buffer:
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(message, dict) or "id" not in message:
            continue
        response = {"jsonrpc": "2.0", "id": message["id"]}
        method = message.get("method")
        if method == "initialize":
            response["result"] = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                                  "serverInfo": {"name": "whiteboard", "version": "1.0"}}
        elif method == "ping":
            response["result"] = {}
        elif method == "tools/list":
            response["result"] = {"tools": tools}
        elif method == "tools/call":
            try:
                params = message["params"]
                output = call_tool(root, mode, params["name"], params.get("arguments") or {}, repository=repository)
                response["result"] = {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}]}
            except (ValueError, OSError, TypeError, KeyError, AttributeError) as error:
                text = str(error) if isinstance(error, ValueError) else "Unable to complete the file operation."
                response["result"] = {"isError": True, "content": [{"type": "text", "text": text}]}
        else:
            response["error"] = {"code": -32601, "message": "Unknown method"}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    repository = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    serve(Path(sys.argv[1]).resolve(strict=True), sys.argv[2], repository=repository)
