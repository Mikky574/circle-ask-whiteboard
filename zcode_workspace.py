"""A stdio MCP server scoped to one staged whiteboard request."""

import json
import re
import sys
from pathlib import Path


EDITABLE = ("index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js")
READABLE = (
    *EDITABLE, "run_gate.js", "server.py", "attachments.py", "zcode_backend.py", "zcode_workspace.py",
    "backends.py", "api_backend.py", "board_tools.py",
)
ATTACHMENT = re.compile(r"attachments/attachment-[0-9]{1,2}\.[a-z0-9]{1,12}")
TEXT = {"type": "string"}


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


def file_path(root, name, write=False):
    if not isinstance(name, str) or (name not in (EDITABLE if write else READABLE)
                                     and (write or not ATTACHMENT.fullmatch(name))):
        raise ValueError("File is outside the allowed workspace scope.")
    path = root / name
    if path.resolve(strict=True) != path or not path.is_file():
        raise ValueError("File is unavailable.")
    return path


def call_tool(root, mode, name, args):
    if name == "list_files":
        attachments = [path.relative_to(root).as_posix() for path in (root / "attachments").glob("attachment-*")]
        return {"files": [name for name in (*READABLE, *sorted(attachments)) if (root / name).is_file()]}
    if name == "read_file":
        path = file_path(root, args.get("path"))
        offset, limit = args.get("offset", 0), args.get("limit", 16000)
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 20000:
            raise ValueError("Invalid text range.")
        try:
            contents = path.read_bytes().decode("utf-8-sig")
        except UnicodeError:
            raise ValueError("File is not UTF-8 text. Use the supplied native attachment if supported.") from None
        end = offset + limit
        return {"text": contents[offset:end], "nextOffset": end if end < len(contents) else None}
    if name != "replace_text" or mode != "edit":
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


def serve(root, mode):
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
            response["result"] = {"tools": TOOLS if mode == "edit" else TOOLS[:2]}
        elif method == "tools/call":
            try:
                params = message["params"]
                output = call_tool(root, mode, params["name"], params.get("arguments") or {})
                response["result"] = {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}]}
            except (ValueError, OSError, TypeError, KeyError, AttributeError) as error:
                text = str(error) if isinstance(error, ValueError) else "Unable to complete the file operation."
                response["result"] = {"isError": True, "content": [{"type": "text", "text": text}]}
        else:
            response["error"] = {"code": -32601, "message": "Unknown method"}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    serve(Path(sys.argv[1]).resolve(strict=True), sys.argv[2])
