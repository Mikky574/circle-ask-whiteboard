"""Load the workstation's project catalog and open registered directories."""

import json
import os
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5


MAX_CATALOG_BYTES = 1024 * 1024


class ProjectCatalogError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def catalog_path():
    configured = os.environ.get("WHITEBOARD_PROJECTS_FILE")
    return Path(configured) if configured else Path.home() / ".circle-ask-whiteboard" / "projects.local.json"


def project_text(value, limit):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ProjectCatalogError(422, "本机项目清单包含无效字段。")
    return value.strip()


def project_aliases(entry):
    aliases = entry.get("aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 24:
        raise ProjectCatalogError(422, "项目别名请填写为名称或用途短语的数组，最多 24 项。")
    return list(dict.fromkeys(project_text(alias, 80) for alias in aliases))


def load_catalog():
    try:
        with catalog_path().open("rb") as catalog:
            contents = catalog.read(MAX_CATALOG_BYTES + 1)
    except FileNotFoundError:
        return {}
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

    projects = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ProjectCatalogError(422, "本机项目清单包含无效项目。")
        directory = Path(project_text(entry.get("path"), 1024))
        if not directory.is_absolute() or directory.drive.startswith("\\\\"):
            raise ProjectCatalogError(422, "项目清单请使用本机目录的绝对路径。")
        key = uuid5(NAMESPACE_URL, "circle-ask-whiteboard:" + os.path.normcase(os.path.normpath(directory))).hex
        projects.setdefault(key, {
            "id": key,
            "name": project_text(entry.get("name"), 80),
            "description": project_text(entry.get("description"), 400),
            "category": project_text(entry.get("category"), 40),
            "path": str(directory),
            "aliases": project_aliases(entry),
        })
    return projects


def project_catalog_request(body, resolve_directory):
    if body == {"action": "list"}:
        return {"projects": list(load_catalog().values())}
    if (not isinstance(body, dict) or body.keys() != {"action", "id"} or body["action"] != "open"
            or not isinstance(body["id"], str)):
        raise ProjectCatalogError(400, "无效的项目操作。")
    project = load_catalog().get(body["id"])
    if project is None:
        raise ProjectCatalogError(404, "项目已不在本机清单中，请刷新后重试。")
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
