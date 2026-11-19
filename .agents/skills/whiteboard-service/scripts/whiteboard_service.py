"""Read and narrowly update an existing shared whiteboard through its service.

Uses only Python's standard library. Never reads browser profiles, SQLite files,
connection settings or model credentials. Apply defaults to a read-only preview.
"""

import argparse
import copy
import json
import math
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_BYTES = 24 * 1024 * 1024
FIELDS = ("memory", "organization", "templateBackup", "guideBackup")
CATEGORIES = {"main", "done", "optimize", "reference", "archive"}
CARD_ID = re.compile(r"[EA][0-9]+\Z")
PATCH_FIELDS = {"title", "summary", "category", "sources", "repositoryFiles", "taskDetails", "spec"}
SOURCE_FILES = {"index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "run_gate.js",
                "project_finder.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py", "backends.py",
                "api_backend.py", "board_tools.py", "local_projects.py", "board_transfer.js", "board_store.py",
                "board_sync.js", "board_versions.js"}


class ServiceError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ServiceError("服务返回了重定向，未向其他地址发送白板内容。")


class Client:
    def __init__(self, url):
        try:
            parsed = urlsplit(url)
            port = parsed.port if parsed.port is not None else 80
        except ValueError as error:
            raise ServiceError("白板服务地址无效。") from error
        if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"}
                or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment or not 1 <= port <= 65535):
            raise ServiceError("只接受本机 http://127.0.0.1:端口 或 http://localhost:端口 服务根地址。")
        self.origin = f"http://{parsed.hostname}:{port}"
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def call(self, action, **fields):
        body = json.dumps({"action": action, **fields}, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(body) > MAX_BYTES:
            raise ServiceError("本次请求超过 24 MB，请减少白板正文或备份大小。")
        request = Request(self.origin + "/api/board-store", data=body,
                          headers={"Content-Type": "application/json", "Origin": self.origin,
                                   "Accept": "application/json"}, method="POST")
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read(MAX_BYTES + 65537)
            if len(raw) > MAX_BYTES + 65536:
                raise ServiceError("服务响应过大，未处理。")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ServiceError("服务没有返回 JSON 对象。")
            return result
        except HTTPError as error:
            if error.code == 409:
                raise ServiceError("白板版本冲突：本次未重试。请重新读取目标分支并合并提案，再使用新的 expected-revision。") from error
            raise ServiceError(f"白板服务 HTTP {error.code}；未自动重试，请检查服务版本和请求。") from error
        except (URLError, TimeoutError, OSError) as error:
            raise ServiceError("无法确认白板服务结果。请先 read 检查服务端版本，避免重复提交。") from error
        except (ValueError, RecursionError) as error:
            raise ServiceError("白板服务没有返回有效 JSON。") from error


def document(board):
    if not isinstance(board, dict) or not isinstance(board.get("storage"), dict):
        raise ServiceError("这张白板不存在或已删除。")
    try:
        organization = json.loads(board["storage"].get("organization") or "{}")
        memory = json.loads(board["storage"].get("memory") or "{}")
    except (TypeError, ValueError) as error:
        raise ServiceError("白板内容不能解析，请保留原版本并检查。") from error
    if not isinstance(organization, dict) or not isinstance(memory, dict):
        raise ServiceError("白板内容结构无效。")
    current = organization.get("current")
    if not isinstance(current, dict) or not isinstance(current.get("items"), list):
        raise ServiceError("当前工具只处理已整理的 current.items 白板；请先在白板中完成初始化，不能用模板覆盖原板。")
    items = current["items"]
    by_id = {}
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not CARD_ID.fullmatch(item["id"]) or item["id"] in by_id):
            raise ServiceError("现有白板存在无效或重复节点编号，请先修复，未写入。")
        by_id[item["id"]] = item
    validate_graph(by_id)
    note_ids = {note.get("id") for note in memory.get("notes", []) if isinstance(note, dict)}
    if any(identity.startswith("A") and identity not in note_ids for identity in by_id):
        raise ServiceError("现有讨论卡缺少原始回答记录，请先修复，未写入。")
    return organization, memory, by_id


def validate_graph(by_id):
    for item in by_id.values():
        parent = item.get("parentId")
        if parent is not None and (not isinstance(parent, str) or parent not in by_id):
            raise ServiceError(f"节点 {item['id']} 引用了不存在的父节点。")
        visited = set()
        identity = item["id"]
        while identity is not None:
            if identity in visited:
                raise ServiceError("父子关系存在环，未写入。")
            visited.add(identity)
            identity = by_id[identity].get("parentId")


def path_for(identity, by_id):
    path = []
    while identity is not None:
        item = by_id[identity]
        path.append({"id": identity, "title": item.get("title", "")})
        identity = item.get("parentId")
    return list(reversed(path))


def text(value, limit, label, *, empty=True):
    if (not isinstance(value, str) or len(value) > limit or (not empty and not value.strip())
            or any(0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ServiceError(f"{label}必须是{'非空' if not empty else ''}文本，最多 {limit} 字。")
    return value


def string_list(value, limit, width, label):
    if not isinstance(value, list) or len(value) > limit:
        raise ServiceError(f"{label}必须是数组，最多 {limit} 项。")
    return list(dict.fromkeys(text(item, width, label, empty=False) for item in value))


def patch_fields(value):
    result = {}
    for key in PATCH_FIELDS & value.keys():
        item = value[key]
        if key in {"title", "summary"}:
            result[key] = text(item, 100 if key == "title" else 800, key, empty=key != "title")
        elif key == "category":
            if not isinstance(item, str) or item not in CATEGORIES:
                raise ServiceError("category 只能是 main/done/optimize/reference/archive。")
            result[key] = item
        elif key in {"sources", "repositoryFiles"}:
            result[key] = string_list(item, 12, 300, key)
            if key == "sources" and any(path not in SOURCE_FILES for path in result[key]):
                raise ServiceError("sources 包含白板不支持的标签；其他源码或文档路径请使用 repositoryFiles。")
            if key == "repositoryFiles" and any(not re.fullmatch(r"[\w .()\[\]@+/\-]+", path)
                    or any(part in {"", ".", ".."} for part in path.split("/")) for path in result[key]):
                raise ServiceError("repositoryFiles 必须是仓库相对路径，不能含盘符、反斜杠或上跳目录。")
        elif key == "taskDetails":
            if not isinstance(item, dict) or set(item) != {"task", "dependencies", "acceptance"}:
                raise ServiceError("taskDetails 需要 task、dependencies、acceptance。")
            acceptance = string_list(item["acceptance"], 5, 180, "acceptance")
            if not acceptance:
                raise ServiceError("验收标准至少需要一项。")
            result[key] = {"task": text(item["task"], 500, "task", empty=False),
                           "dependencies": string_list(item["dependencies"], 5, 180, "dependencies"),
                           "acceptance": acceptance}
        elif key == "spec":
            if (not isinstance(item, dict) or set(item) - {"kind", "id", "status", "runner"}
                    or not isinstance(item.get("kind"), str) or item.get("kind") not in {"requirement", "constraint", "case"}
                    or not isinstance(item.get("id"), str) or not re.fullmatch(r"[A-Z][A-Z0-9-]{2,47}", item["id"])):
                raise ServiceError("spec 需要有效 kind 与需求/用例编号。")
            result[key] = {"kind": item["kind"], "id": item["id"]}
            if item["kind"] == "case":
                status = item.get("status", "pending")
                if not isinstance(status, str) or status not in {"pending", "mock-pass", "offline-pass"}:
                    raise ServiceError("用例状态只能是 pending/mock-pass/offline-pass，不能把未验证标成通过。")
                result[key]["status"] = status
                if "runner" in item:
                    result[key]["runner"] = text(item["runner"], 220, "runner")
    return result


def reserved_ids(value, found=None):
    found = set() if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            reserved_ids(key, found)
            reserved_ids(item, found)
    elif isinstance(value, list):
        for item in value:
            reserved_ids(item, found)
    elif isinstance(value, str):
        if CARD_ID.fullmatch(value):
            found.add(value)
        elif value.lstrip().startswith(("{", "[")):
            try:
                reserved_ids(json.loads(value), found)
            except (ValueError, RecursionError):
                pass
    return found


def propose(board, proposal, expected_revision):
    if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
        raise ServiceError("expected-revision 必须是刚读取的正整数版本号。")
    if board.get("revision") != expected_revision:
        raise ServiceError("白板版本已改变，请重新读取目标分支后合并提案；未写入。")
    if not isinstance(proposal, dict) or set(proposal) - {"rootId", "updates", "children"}:
        raise ServiceError("提案只支持 rootId、updates、children。")
    result = copy.deepcopy(board)
    organization, memory, by_id = document(result)
    root = proposal.get("rootId")
    if not isinstance(root, str) or root not in by_id or root in memory.get("deletedIds", []):
        raise ServiceError("rootId 必须是当前白板中实际存在的模块。")
    deleted = set(memory.get("deletedIds", []))
    scope = {identity for identity in by_id if root in [entry["id"] for entry in path_for(identity, by_id)]
             and not deleted.intersection(entry["id"] for entry in path_for(identity, by_id))}
    for key in ("updates", "children"):
        if not isinstance(proposal.get(key, []), list):
            raise ServiceError(f"{key} 必须是数组。")
    touched = []
    for update in proposal.get("updates", []):
        if not isinstance(update, dict) or set(update) - (PATCH_FIELDS | {"id"}):
            raise ServiceError("更新中有不支持的字段；当前不支持删除、重挂接或整体替换。")
        identity = update.get("id")
        if not isinstance(identity, str) or identity not in scope or identity in touched:
            raise ServiceError("更新节点必须实际存在于 rootId 分支下，且每个节点只能更新一次。")
        fields = patch_fields(update)
        if not fields:
            raise ServiceError("更新至少提供一项正文属性。")
        if fields.get("category") == "archive" and identity in memory.get("pinnedIds", []):
            raise ServiceError("固定重点不能归档；请先在白板中确认并取消固定。")
        by_id[identity].update(fields)
        if identity.startswith("A") and {"title", "summary"} & fields.keys():
            if not any(isinstance(note, dict) and note.get("id") == identity for note in memory.get("notes", [])):
                raise ServiceError("该讨论卡缺少原始回答记录，不能安全更新。")
            by_id[identity]["localContent"] = True
        touched.append(identity)
        if len(touched) > 256:
            raise ServiceError("单次最多修改或新增 256 张卡，请分批更新。")
    used = reserved_ids(board.get("storage", {}))
    next_number = max((int(identity[1:]) for identity in used), default=0) + 1
    refs = {}
    additions = []

    def add(nodes, parent=None, depth=0):
        nonlocal next_number
        if depth > 16:
            raise ServiceError("新增分支层数超过 16，请分批更新。")
        for node in nodes:
            if (not isinstance(node, dict) or set(node) - (PATCH_FIELDS | {"ref", "parentId", "children", "position", "collapsed"})
                    or "title" not in node or "summary" not in node):
                raise ServiceError("新增节点需要 title、summary；不接受手工编号或删除指令。")
            ref = node.get("ref")
            if ref is not None and (not isinstance(ref, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", ref) or ref in refs):
                raise ServiceError("ref 必须是唯一的短英文标识。")
            identity = f"E{next_number:02d}"
            next_number += 1
            if len(identity) > 9:
                raise ServiceError("可用模块编号超出模型接口支持范围，请检查历史编号。")
            if ref:
                refs[ref] = identity
            supplied_parent = node.get("parentId", parent)
            if not isinstance(supplied_parent, str):
                raise ServiceError("新增卡需要有效 parentId；嵌套 children 自动继承父节点。")
            if parent is not None and supplied_parent != parent:
                raise ServiceError("嵌套 children 不能另外指定不同的父节点。")
            item = {"id": identity, "parentId": supplied_parent, "category": "reference", **patch_fields(node)}
            if "collapsed" in node and not isinstance(node["collapsed"], bool):
                raise ServiceError("collapsed 必须是布尔值。")
            additions.append((item, node.get("position"), node.get("collapsed", False)))
            if len(additions) + len(touched) > 256:
                raise ServiceError("单次最多修改或新增 256 张卡，请分批更新。")
            nested = node.get("children", [])
            if not isinstance(nested, list):
                raise ServiceError("children 必须是数组。")
            add(nested, identity, depth + 1)

    add(proposal.get("children", []))
    for item, position, collapsed in additions:
        parent = item.get("parentId")
        if isinstance(parent, str) and parent.startswith("@"):
            parent = refs.get(parent[1:])
        item["parentId"] = parent
        if parent not in scope and parent not in {entry[0]["id"] for entry in additions}:
            raise ServiceError("新增节点必须挂在 rootId 分支内已有节点，或本提案新增的 ref 下。")
        by_id[item["id"]] = item
        organization["current"]["items"].append(item)
        if collapsed:
            collapsed_branches = organization["current"].setdefault("collapsedBranches", [])
            if item["id"] not in collapsed_branches:
                collapsed_branches.append(item["id"])
        if position is not None:
            if not isinstance(position, dict) or set(position) - {"x", "y", "width"} or not {"x", "y"} <= position.keys():
                raise ServiceError("position 需要 x、y，可以附带 width。")
            if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value)
                   or abs(value) > 1e6 for value in position.values()):
                raise ServiceError("position 坐标必须是有限数值，范围在 ±1000000 内。")
            if "width" in position and not 240 <= position["width"] <= 1200:
                raise ServiceError("新增卡片宽度必须在 240 到 1200 之间。")
            organization["current"].setdefault("positions", {})[item["id"]] = copy.deepcopy(position)
        touched.append(item["id"])
    if not touched:
        raise ServiceError("提案为空，没有需要更新的卡片。")
    validate_graph(by_id)
    for item, _, _ in additions:
        if root not in [entry["id"] for entry in path_for(item["id"], by_id)]:
            raise ServiceError("新增分支未连回 rootId，不能生成孤立节点。")
    result["storage"]["organization"] = json.dumps(organization, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    receipt = {"board": board["id"], "rootId": root, "previousRevision": expected_revision,
               "assigned": refs, "touchedIds": touched,
               "newIds": [item["id"] for item, _, _ in additions],
               "preview": [copy.deepcopy(by_id[identity]) for identity in touched]}
    return result, receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8791")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    read = commands.add_parser("read")
    read.add_argument("--board", required=True)
    read.add_argument("--node")
    find = commands.add_parser("find")
    find.add_argument("--board", required=True)
    find.add_argument("--query", required=True)
    apply = commands.add_parser("apply")
    apply.add_argument("--board", required=True)
    apply.add_argument("--expected-revision", required=True, type=int)
    apply.add_argument("--file", required=True, type=Path)
    apply.add_argument("--commit", action="store_true")
    apply.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        client = Client(args.url)
        if args.command == "list":
            output = client.call("list")
        else:
            board = client.call("load", id=args.board).get("board")
            organization, memory, by_id = document(board)
            base = {"board": board["id"], "title": board["title"], "revision": board["revision"],
                    "repositoryPath": board.get("repositoryPath", "")}
            if args.command == "read":
                if args.node:
                    if args.node not in by_id:
                        raise ServiceError("未找到该节点，请先 find 确认卡号。")
                    output = {**base, "node": by_id[args.node], "path": path_for(args.node, by_id),
                              "children": [item for item in by_id.values() if item.get("parentId") == args.node]}
                else:
                    output = {**base, "items": list(by_id.values()), "project": memory.get("project", {}),
                              "pinnedIds": memory.get("pinnedIds", [])}
            elif args.command == "find":
                query = args.query.strip().casefold()
                if not query:
                    raise ServiceError("搜索词不能为空。")
                matches = [item for item in by_id.values() if query in json.dumps(item, ensure_ascii=False).casefold()]
                output = {**base, "matches": [{**item, "path": path_for(item["id"], by_id)} for item in matches[:100]],
                          "total": len(matches)}
            else:
                if args.file.stat().st_size > MAX_BYTES:
                    raise ServiceError("提案文件超过 24 MB。")
                proposal = json.loads(args.file.read_text(encoding="utf-8-sig"))
                candidate, receipt = propose(board, proposal, args.expected_revision)
                output = {**receipt, "committed": False}
                if args.commit:
                    fields = {key: board[key] for key in ("id", "title", "repositoryPath", "projectId") if key in board}
                    saved = client.call("save", id=args.board, expectedRevision=args.expected_revision,
                                        metadata=fields, storage=candidate["storage"]).get("board")
                    if not saved or not isinstance(saved.get("revision"), int):
                        raise ServiceError("服务没有返回保存回执，请先 read 核实，勿重复提交。")
                    checked = client.call("load", id=args.board).get("board")
                    if not checked or checked.get("revision") != saved["revision"] or checked.get("storage") != candidate["storage"]:
                        raise ServiceError("保存后服务端内容又有变化，尚未确认本轮读回。请 read 并检查版本历史，勿重复提交。")
                    focus = receipt["newIds"][0] if receipt["newIds"] else receipt["rootId"]
                    output = {**receipt, "committed": True, "revision": saved["revision"], "verified": True,
                              "focusId": focus, "url": f"{client.origin}/?board={args.board}#{focus}"}
                if args.receipt:
                    args.receipt.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (ServiceError, OSError, ValueError, TypeError, RecursionError) as error:
        print(json.dumps({"error": str(error), "committed": "unknown" if getattr(args, "commit", False) else False}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
