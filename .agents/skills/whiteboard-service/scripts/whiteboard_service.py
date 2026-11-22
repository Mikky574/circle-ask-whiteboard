"""Read and narrowly update an existing shared whiteboard through its service.

Uses only Python's standard library. Never reads browser profiles, SQLite files,
connection settings or model credentials. Apply defaults to a read-only preview.
"""

import argparse
from collections import Counter
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_BYTES = 24 * 1024 * 1024
DEFAULT_URL = "http://127.0.0.1:8797"
BUNDLE_FORMAT = "circle-ask-whiteboard-workspace-v1"
RECEIPT_FORMAT = "circle-ask-whiteboard-submission-v1"
FIELDS = ("memory", "organization", "templateBackup", "guideBackup")
CATEGORIES = {"main", "done", "optimize", "reference", "archive"}
PROPOSAL_FIELDS = {"rootId", "updates", "children", "structure"}
PROJECT_SUMMARY_MAX_CHILDREN = 4
CARD_ID = re.compile(r"[EA][0-9]+\Z")
PATCH_FIELDS = {"title", "summary", "category", "sources", "repositoryFiles", "taskDetails", "spec", "experiment"}
SOURCE_FILES = {"index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "run_gate.js",
                "experiment_data.js", "research_board.js", "research_board.css",
                "project_finder.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py", "backends.py",
                "api_backend.py", "board_tools.py", "local_projects.py", "board_transfer.js", "board_store.py",
                "board_sync.js", "board_versions.js", "mindmap.js", "mindmap.css"}


class ServiceError(Exception):
    pass


class SubmissionUncertain(ServiceError):
    """A durable pending receipt prevents another write after an unknown result."""


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
            if error.code in {404, 405, 501}:
                raise ServiceError("目标服务不支持 /api/board-store 共享白板接口。请核对端口并升级服务；未退回 localStorage 或代理私有浏览器，不能报告已同步。") from error
            raise ServiceError(f"白板服务 HTTP {error.code}；未自动重试，请检查服务版本和请求。") from error
        except (URLError, TimeoutError, OSError) as error:
            raise ServiceError("无法确认白板服务结果。请先 read 检查服务端版本，避免重复提交。") from error
        except (ValueError, RecursionError) as error:
            raise ServiceError("白板服务没有返回有效 JSON。") from error

    def probe(self):
        """Require the shared document API before reading or committing a board."""
        listing = self.call("list")
        for field in ("boards", "deleted"):
            entries = listing.get(field)
            if not isinstance(entries, list) or any(
                not isinstance(entry, dict) or not isinstance(entry.get("id"), str)
                or not isinstance(entry.get("revision"), int) or isinstance(entry["revision"], bool)
                or entry["revision"] < 1 for entry in entries
            ):
                raise ServiceError("服务未返回共享白板目录，无法确认 /api/board-store 能力。未读取或写入浏览器缓存；请检查服务版本和端口。")
        return listing


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
        elif key == "experiment":
            result[key] = experiment_record(item)
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


def experiment_record(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ServiceError("实验资料需要 version: 1。")
    result = {"version": 1}
    for field in ("kind", "question", "metricSummary", "finding", "caveat"):
        if field in value:
            result[field] = text(value[field], 800, field).strip()
    comparison = value.get("comparison")
    if comparison is None:
        return result
    if (not isinstance(comparison, dict) or not isinstance(comparison.get("metrics"), list)
            or not 1 <= len(comparison["metrics"]) <= 6 or not isinstance(comparison.get("arms"), list)
            or not 2 <= len(comparison["arms"]) <= 12):
        raise ServiceError("实验对照需要 1–6 个指标和 2–12 个对照臂。")
    metrics = []
    for metric in comparison["metrics"]:
        if not isinstance(metric, dict) or metric.get("direction") not in ("higher", "lower"):
            raise ServiceError("实验指标方向无效。")
        metrics.append({"label": text(metric.get("label"), 100, "指标名称", empty=False).strip(),
                        "direction": metric["direction"]})
    arms = []
    for arm in comparison["arms"]:
        if (not isinstance(arm, dict) or not isinstance(arm.get("id"), str)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,60}", arm["id"])
                or not isinstance(arm.get("values"), list) or len(arm["values"]) != len(metrics)
                or any(number is not None and (type(number) not in (int, float) or not math.isfinite(number))
                       for number in arm["values"])):
            raise ServiceError("实验对照数值无效，缺失值请用 null。")
        arms.append({"id": arm["id"], "label": text(arm.get("label"), 100, "对照名称", empty=False).strip(),
                     "values": arm["values"][:]})
    identities = {arm["id"] for arm in arms}
    baseline, primary = comparison.get("baseline"), comparison.get("primary")
    if (not isinstance(baseline, str) or not isinstance(primary, str) or len(identities) != len(arms)
            or baseline not in identities or primary not in identities or baseline == primary):
        raise ServiceError("实验基线或主对照臂无效。")
    result["comparison"] = {"metrics": metrics, "arms": arms, "baseline": baseline, "primary": primary}
    for field in ("title", "cohort", "source", "finding", "caveat"):
        if field in comparison:
            result["comparison"][field] = text(comparison[field], 1200, field).strip()
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
    if not isinstance(proposal, dict) or set(proposal) - PROPOSAL_FIELDS:
        raise ServiceError("提案只支持 rootId、updates、children、structure。")
    layered_summary = "structure" in proposal
    if layered_summary and proposal["structure"] != "project-summary":
        raise ServiceError("structure 只支持 project-summary。")
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
    if layered_summary:
        counts = Counter(item.get("parentId") for item in by_id.values()
                         if item["id"] not in deleted and item.get("category") != "archive")
        affected_parents = dict.fromkeys(item["parentId"] for item, _, _ in additions)
        for parent in affected_parents:
            if counts[parent] > PROJECT_SUMMARY_MAX_CHILDREN:
                raise ServiceError(f"{parent}「{by_id[parent]['title']}」将有 {counts[parent]} 张直属下级。"
                                   "项目概括每个父卡最多 4 张，请按能力或问题把细节归入子章节后再预览。")
    result["storage"]["organization"] = json.dumps(organization, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    receipt = {"board": board["id"], "rootId": root, "previousRevision": expected_revision,
               "assigned": refs, "touchedIds": touched,
               "newIds": [item["id"] for item, _, _ in additions],
               "preview": [copy.deepcopy(by_id[identity]) for identity in touched]}
    return result, receipt


def digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def plain_path(path):
    # These checks prevent accidentally following a workspace file into another
    # directory. They are not a security boundary against a hostile local user.
    if path.is_symlink() or (path.exists() and getattr(path.lstat(), "st_file_attributes", 0) & 0x400):
        raise ServiceError("工作目录和工作文件不能是符号链接或目录联接，请使用独立的普通目录。")
    return path


def workspace_file(directory, name):
    path = plain_path(directory / name)
    if path.resolve().parent != directory:
        raise ServiceError("工作文件超出工作目录，未处理。")
    return path


def read_json(path):
    plain_path(path)
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ServiceError("工作文件不存在、不是普通文件或超过 24 MB。")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value, *, exclusive=False):
    plain_path(path)
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    if len(raw.encode("utf-8")) > MAX_BYTES:
        raise ServiceError("工作文件超过 24 MB，请缩小目标分支。")
    if exclusive:
        with path.open("x", encoding="utf-8") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        return
    # Replace the pending receipt atomically; a killed process leaves either a
    # recoverable pending record or a verified record, never truncated JSON.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".receipt-", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        except Exception:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def context_for(board, root, origin):
    _, memory, by_id = document(board)
    if not isinstance(root, str) or root not in by_id:
        raise ServiceError("未找到 checkout 根卡，请先 find 确认卡号。")
    deleted = set(memory.get("deletedIds", []))
    paths = {identity: [entry["id"] for entry in path_for(identity, by_id)] for identity in by_id}
    scope = [identity for identity in by_id if root in paths[identity] and not deleted.intersection(paths[identity])]
    if root not in scope:
        raise ServiceError("checkout 根卡已删除或处于已删除的分支下。")
    path = path_for(root, by_id)
    pins = [identity for identity in memory.get("pinnedIds", []) if identity in by_id
            and not deleted.intersection(paths[identity])
            and not any(by_id[ancestor].get("draft") is True for ancestor in paths[identity])]
    related = set(scope) | {entry["id"] for entry in path} | set(pins)
    return {"format": BUNDLE_FORMAT, "url": origin, "board": board["id"], "title": board["title"],
            "revision": board["revision"], "repositoryPath": board.get("repositoryPath", ""), "rootId": root,
            "path": path, "ancestors": [copy.deepcopy(by_id[entry["id"]]) for entry in path[:-1]],
            "subtree": [copy.deepcopy(by_id[identity]) for identity in scope],
            "notes": [copy.deepcopy(note) for note in memory.get("notes", [])
                      if isinstance(note, dict) and note.get("id") in related],
            "project": copy.deepcopy(memory.get("project", {})),
            "pinnedIds": pins,
            "pinnedCards": [{**copy.deepcopy(by_id[identity]), "path": path_for(identity, by_id)} for identity in pins],
            "overview": {"total": len(by_id), "nodes": [
                {key: item.get(key) for key in ("id", "parentId", "title", "category")}
                for item in list(by_id.values())[:128]]}}


def checkout(board, root, origin, directory):
    context = context_for(board, root, origin)
    manifest = {"format": BUNDLE_FORMAT, "url": origin, "board": board["id"], "rootId": root,
                "revision": board["revision"], "contextSha256": digest(context)}
    directory = plain_path(directory.absolute()).resolve()
    if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
        raise ServiceError("checkout 需要空目录或尚不存在的目录，不会覆盖现有文件。")
    directory.mkdir(parents=True, exist_ok=True)
    # Only proposal.json is edited. The other two files detect accidental scope
    # or version changes; the hash is deliberately not called a signature.
    write_json(workspace_file(directory, "context.json"), context, exclusive=True)
    write_json(workspace_file(directory, "proposal.json"), {"updates": [], "children": []}, exclusive=True)
    write_json(workspace_file(directory, "manifest.json"), manifest, exclusive=True)
    return {"workspace": str(directory), "board": board["id"], "rootId": root,
            "revision": board["revision"], "contextCards": len(context["subtree"]), "readOnly": True,
            "proposal": str(directory / "proposal.json"), "committed": False}


def read_workspace(path, explicit_url=None):
    directory = plain_path(path.absolute()).resolve()
    if not directory.is_dir():
        raise ServiceError("工作目录不存在。")
    manifest = read_json(workspace_file(directory, "manifest.json"))
    keys = {"format", "url", "board", "rootId", "revision", "contextSha256"}
    if (not isinstance(manifest, dict) or set(manifest) != keys or manifest.get("format") != BUNDLE_FORMAT
            or not isinstance(manifest.get("board"), str) or not manifest["board"]
            or not isinstance(manifest.get("url"), str)
            or not isinstance(manifest.get("rootId"), str) or not CARD_ID.fullmatch(manifest["rootId"])
            or not isinstance(manifest.get("revision"), int) or isinstance(manifest["revision"], bool) or manifest["revision"] < 1):
        raise ServiceError("manifest.json 元数据无效；请重新 checkout，不要手工改板号、根卡或版本。")
    client = Client(manifest["url"])
    if manifest["url"] != client.origin or (explicit_url and Client(explicit_url).origin != client.origin):
        raise ServiceError("提交服务地址与 checkout 不一致；请使用原服务，不能切换目标。")
    context = read_json(workspace_file(directory, "context.json"))
    if (not isinstance(context, dict) or digest(context) != manifest["contextSha256"] or
            any(context.get(key) != manifest[key] for key in ("format", "url", "board", "rootId", "revision"))):
        raise ServiceError("context.json 或 manifest.json 已改变；仅编辑 proposal.json，需更新上下文时重新 checkout。")
    proposal = read_json(workspace_file(directory, "proposal.json"))
    if not isinstance(proposal, dict) or set(proposal) - PROPOSAL_FIELDS:
        raise ServiceError("proposal.json 支持 updates、children、structure；不能设置服务、板号或版本。")
    if "rootId" in proposal and proposal["rootId"] != manifest["rootId"]:
        raise ServiceError("提案 rootId 与 checkout 根卡不一致，未提交。")
    proposal["rootId"] = manifest["rootId"]
    return directory, client, manifest, context, proposal


def candidate_hash(board):
    return digest({"metadata": {key: board[key] for key in ("id", "title", "repositoryPath", "projectId") if key in board},
                   "storage": board["storage"]})


def committed_result(client, receipt, revision):
    focus = receipt["newIds"][0] if receipt["newIds"] else receipt["rootId"]
    return {**receipt, "committed": True, "revision": revision, "verified": True,
            "focusId": focus, "url": f"{client.origin}/?board={receipt['board']}#{focus}"}


def reconcile_submission(client, manifest, proposal, path):
    record = read_json(path)
    if (not isinstance(record, dict) or record.get("format") != RECEIPT_FORMAT
            or record.get("manifestSha256") != digest(manifest) or record.get("proposalSha256") != digest(proposal)
            or record.get("status") not in {"pending", "verified"} or not isinstance(record.get("result"), dict)
            or not isinstance(record["result"].get("newIds"), list)
            or any(not isinstance(identity, str) or not CARD_ID.fullmatch(identity) for identity in record["result"]["newIds"])
            or record["result"].get("board") != manifest["board"] or record["result"].get("rootId") != manifest["rootId"]
            or record["result"].get("previousRevision") != manifest["revision"]):
        raise ServiceError("已有提交回执与本提案不一致；不会重新提交。保留原提案和回执，先查看版本历史确认原结果，不能直接重建相同新增。")
    revision = manifest["revision"] + 1
    try:
        snapshot = client.call("load", id=manifest["board"], revision=revision).get("board")
        if not snapshot or snapshot.get("revision") != revision or candidate_hash(snapshot) != record.get("candidateSha256"):
            raise ServiceError("服务端未找到与本次提案完全一致的版本。")
        result = committed_result(client, record["result"], revision)
        if record["status"] != "verified":
            write_json(path, {**record, "status": "verified", "result": result})
        return {**result, "alreadyCommitted": True}
    except (ServiceError, OSError) as error:
        raise SubmissionUncertain("已有待核对回执，未再次写入。请 read 或查看版本历史确认结果，勿删除回执后盲目重试。" + str(error)) from error


def _submit_workspace(path, explicit_url=None, commit=False):
    directory, client, manifest, context, proposal = read_workspace(path, explicit_url)
    listing = client.probe()
    if not any(entry["id"] == manifest["board"] for entry in listing["boards"]):
        raise ServiceError("原板号不在服务目录中，未新建同名板。")
    receipt_path = workspace_file(directory, "receipt.json")
    if receipt_path.exists():
        return reconcile_submission(client, manifest, proposal, receipt_path)
    board = client.call("load", id=manifest["board"]).get("board")
    if not board or board.get("revision") != manifest["revision"]:
        raise ServiceError("服务端版本已改变；请重新 checkout 后合并提案，不能自动换新版本覆盖。")
    if digest(context_for(board, manifest["rootId"], client.origin)) != manifest["contextSha256"]:
        raise ServiceError("服务端目标内容与 checkout 上下文不符，请检查服务和板号。")
    candidate, receipt = propose(board, proposal, manifest["revision"])
    if not commit:
        return {**receipt, "committed": False, "workspace": str(directory)}
    pending = {"format": RECEIPT_FORMAT, "manifestSha256": digest(manifest), "proposalSha256": digest(proposal),
               "candidateSha256": candidate_hash(candidate), "status": "pending", "result": receipt}
    write_json(receipt_path, pending, exclusive=True)
    try:
        fields = {key: board[key] for key in ("id", "title", "repositoryPath", "projectId") if key in board}
        saved = client.call("save", id=manifest["board"], expectedRevision=manifest["revision"],
                            metadata=fields, storage=candidate["storage"]).get("board")
        if not saved or saved.get("revision") != manifest["revision"] + 1 or candidate_hash(saved) != pending["candidateSha256"]:
            raise ServiceError("保存回执与提案不一致。")
        checked = client.call("load", id=manifest["board"]).get("board")
        if not checked or checked.get("revision") != saved["revision"] or candidate_hash(checked) != pending["candidateSha256"]:
            raise ServiceError("保存后当前版本已变化，需从版本历史核对本次结果。")
        result = committed_result(client, receipt, saved["revision"])
        write_json(receipt_path, {**pending, "status": "verified", "result": result})
        return result
    except (ServiceError, OSError) as error:
        raise SubmissionUncertain("本次结果待核对，pending 回执已保留。再次 submit 只读核对，不会再次追加。" + str(error)) from error


def submit_workspace(path, explicit_url=None, commit=False):
    # A previous write may have succeeded even if the draft, context or service
    # is now invalid. Never turn that uncertainty into an apparent safe retry.
    receipt_path = path / "receipt.json"
    had_receipt = os.path.lexists(receipt_path)
    try:
        return _submit_workspace(path, explicit_url, commit)
    except SubmissionUncertain:
        raise
    except (ServiceError, OSError, ValueError, TypeError, RecursionError) as error:
        if had_receipt or os.path.lexists(receipt_path):
            raise SubmissionUncertain("该工作目录已有提交记录，原结果仍需核对；不能认定未提交或重新追加相同内容。" + str(error)) from error
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help=f"本机服务根地址（默认 {DEFAULT_URL}；submit 使用 manifest 地址）")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
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
    checkout_parser = commands.add_parser("checkout", help="导出只读上下文与可编辑提案文件")
    checkout_parser.add_argument("--board", required=True)
    checkout_parser.add_argument("--node", required=True)
    checkout_parser.add_argument("--out", required=True, type=Path)
    submit = commands.add_parser("submit", help="按工作目录固定的范围与版本预览或提交")
    submit.add_argument("--workspace", required=True, type=Path)
    submit.add_argument("--commit", action="store_true")
    args = parser.parse_args(argv)
    write_started = False
    try:
        if args.command == "submit":
            output = submit_workspace(args.workspace, args.url, args.commit)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 0
        client = Client(args.url or DEFAULT_URL)
        listing = client.probe()
        if args.command == "probe":
            output = {"url": client.origin, "sharedBoards": True, "boardCount": len(listing["boards"]),
                      "readOnly": True}
        elif args.command == "list":
            output = listing
        else:
            if not any(entry["id"] == args.board for entry in listing["boards"]):
                raise ServiceError("目标板号不在该服务的共享目录中。请核对链接与项目；未新建同名白板，也未读取浏览器私有记录。")
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
            elif args.command == "checkout":
                output = checkout(board, args.node, client.origin, args.out)
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
                    write_started = True
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
        print(json.dumps({"error": str(error), "committed": "unknown" if write_started or isinstance(error, SubmissionUncertain) else False}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
