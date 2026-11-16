"""Read and update the workstation's project catalog."""

import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from threading import Lock
from uuid import NAMESPACE_URL, uuid5


MAX_CATALOG_BYTES = 1024 * 1024
CATALOG_WRITE_LOCK = Lock()


class ProjectCatalogError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def catalog_path():
    configured = os.environ.get("WHITEBOARD_PROJECTS_FILE")
    return Path(configured) if configured else Path.home() / ".circle-ask-whiteboard" / "projects.local.json"


def project_text(value, limit, *, allow_empty=False, field=None):
    if (not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip())
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        message = f"{field}无效，请检查内容和长度。" if field else "本机项目清单包含无效字段。"
        raise ProjectCatalogError(422, message)
    return value.strip()


def project_aliases(entry):
    aliases = entry.get("aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 24:
        raise ProjectCatalogError(422, "项目别名请填写为名称或用途短语的数组，最多 24 项。")
    return list(dict.fromkeys(project_text(alias, 80) for alias in aliases))


def read_catalog_entries(path):
    try:
        with path.open("rb") as catalog:
            contents = catalog.read(MAX_CATALOG_BYTES + 1)
    except FileNotFoundError:
        return []
    except OSError as error:
        raise ProjectCatalogError(500, "无法读取本机项目清单。") from error

    if len(contents) > MAX_CATALOG_BYTES:
        raise ProjectCatalogError(422, "本机项目清单过大。")
    try:
        entries = json.loads(contents.decode("utf-8-sig"))
    except (ValueError, RecursionError) as error:
        raise ProjectCatalogError(422, "本机项目清单不是有效的 JSON。") from error
    if not isinstance(entries, list):
        raise ProjectCatalogError(422, "本机项目清单必须是项目数组。")
    return entries


def normalized_directory(path):
    return os.path.normcase(os.path.normpath(path))


def project_key(path):
    return uuid5(NAMESPACE_URL, "circle-ask-whiteboard:" + normalized_directory(path)).hex


def catalog_projects(entries):
    projects = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ProjectCatalogError(422, "本机项目清单包含无效项目。")
        directory = Path(project_text(entry.get("path"), 1024))
        if not directory.is_absolute() or directory.drive.startswith("\\\\"):
            raise ProjectCatalogError(422, "项目清单请使用本机目录的绝对路径。")
        key = project_key(directory)
        projects.setdefault(key, {
            "id": key,
            "name": project_text(entry.get("name"), 80),
            "description": project_text(entry.get("description"), 400, allow_empty=True),
            "category": project_text(entry.get("category"), 40),
            "path": str(directory),
            "aliases": project_aliases(entry),
            "childCount": 0,
        })
    directory_ids = {
        Path(normalized_directory(project["path"])): project_id
        for project_id, project in projects.items()
    }
    for directory, project_id in directory_ids.items():
        parent_id = next((directory_ids[parent] for parent in directory.parents if parent in directory_ids), None)
        projects[project_id]["parentId"] = parent_id
        if parent_id is not None:
            projects[parent_id]["childCount"] += 1
    return projects


def load_catalog():
    return catalog_projects(read_catalog_entries(catalog_path()))


def write_catalog_entries(path, entries):
    contents = (json.dumps(entries, ensure_ascii=False, indent=2) + "\n").encode("utf-8", errors="backslashreplace")
    if len(contents) > MAX_CATALOG_BYTES:
        raise ProjectCatalogError(422, "本机项目清单过大。")
    staged = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=path.parent, prefix=".project-catalog-", suffix=".tmp", delete=False) as stream:
            staged = Path(stream.name)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        staged.replace(path)
    except OSError as error:
        raise ProjectCatalogError(500, "无法保存本机项目清单。") from error
    finally:
        if staged is not None:
            try:
                staged.unlink(missing_ok=True)
            except OSError:
                pass


def register_project(body, resolve_directory):
    if body.keys() - {"description"} != {"action", "name", "path"}:
        raise ProjectCatalogError(400, "请提供项目名称和本机目录。")
    name = project_text(body["name"], 80, field="项目名称")
    description = body.get("description", "")
    if isinstance(description, str):
        description = description.replace("\r\n", "\n").replace("\r", "\n").replace("\n", " ")
    description = project_text(description, 400, allow_empty=True, field="项目简介")
    original_path = project_text(body["path"], 1024, field="项目目录")
    try:
        directory = resolve_directory(original_path)
    except ValueError as error:
        raise ProjectCatalogError(422, str(error)) from error
    key = project_key(directory)
    with CATALOG_WRITE_LOCK:
        try:
            path = catalog_path().resolve()
        except (OSError, RuntimeError) as error:
            raise ProjectCatalogError(500, "无法定位本机项目清单。") from error
        entries = read_catalog_entries(path)
        projects = catalog_projects(entries)
        existing = projects.get(project_key(original_path)) or projects.get(key)
        if existing is not None:
            return existing
        entries.append({"name": name, "description": description, "category": "本机项目", "path": str(directory)})
        project = catalog_projects(entries)[key]
        write_catalog_entries(path, entries)
        return project


def project_catalog_request(body, resolve_directory):
    if body == {"action": "list"}:
        return {"projects": list(load_catalog().values())}
    if isinstance(body, dict) and body.get("action") == "register":
        return {"project": register_project(body, resolve_directory)}
    if (not isinstance(body, dict) or body.keys() != {"action", "id"} or body["action"] not in ("open", "get")
            or not isinstance(body["id"], str)):
        raise ProjectCatalogError(400, "无效的项目操作。")
    projects = load_catalog()
    project = projects.get(body["id"])
    if project is None:
        raise ProjectCatalogError(404, "项目已不在本机清单中，请刷新后重试。")
    if body["action"] == "get":
        ancestors = []
        parent_id = project["parentId"]
        while parent_id is not None:
            parent = projects[parent_id]
            ancestors.append(parent)
            parent_id = parent["parentId"]
        return {
            "project": project,
            "ancestors": list(reversed(ancestors)),
            "children": [entry for entry in projects.values() if entry["parentId"] == project["id"]],
        }
    if os.name != "nt":
        raise ProjectCatalogError(501, "在资源管理器打开目录需要 Windows。")

    try:
        directory = resolve_directory(project["path"])
    except ValueError as error:
        raise ProjectCatalogError(404, str(error)) from error
    try:
        os.startfile(str(directory), "explore")
    except OSError as error:
        raise ProjectCatalogError(500, "无法在资源管理器中打开该目录。") from error
    return {"opened": True}


def project_activity_request(body):
    project_id = body.get("projectId") if isinstance(body, dict) and body.keys() == {"projectId"} else None
    if not isinstance(project_id, str) or not re.fullmatch(r"[0-9a-f]{32}", project_id):
        raise ProjectCatalogError(400, "请提供本机项目编号。")
    folder = catalog_path().parent
    paths = (folder / "workbench-activity" / f"{project_id}.json", folder / "workbench-activity.local.json")
    for path in paths:
        try:
            with path.open("rb") as activity_file:
                raw = activity_file.read(512 * 1024 + 1)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise ProjectCatalogError(500, "无法读取本机项目动作。") from error
        if len(raw) > 512 * 1024:
            raise ProjectCatalogError(422, "本机项目动作文件过大。")
        try:
            activity = json.loads(raw.decode("utf-8-sig"))
        except (ValueError, RecursionError) as error:
            raise ProjectCatalogError(422, "本机项目动作文件格式有误。") from error
        if isinstance(activity, dict) and activity.get("projectId") == project_id:
            return {"activity": activity}
    return {"activity": None}
