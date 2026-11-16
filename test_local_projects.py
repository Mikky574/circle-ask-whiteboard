from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_projects import ProjectCatalogError, project_activity_request, project_catalog_request
from server import resolve_repository_path


class LocalProjectTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.project = Path(directory.name, "本机项目 甲")
        self.project.mkdir()
        self.manifest = Path(directory.name, "projects.local.json")
        configure = patch.dict(os.environ, WHITEBOARD_PROJECTS_FILE=str(self.manifest))
        configure.start()
        self.addCleanup(configure.stop)
        self.entry = {
            "name": "项目甲", "description": "有中文与空格的测试目录。", "category": "示例", "path": str(self.project),
        }

    def request(self, **body):
        return project_catalog_request(body, resolve_repository_path)

    def write_catalog(self, *entries):
        self.manifest.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")

    def test_lists_unique_folders_with_stable_ids(self):
        self.assertEqual(self.request(action="list"), {"projects": []})
        self.write_catalog(self.entry, self.entry)
        original, = self.request(action="list")["projects"]
        self.write_catalog({**self.entry, "name": "新名称"})
        updated, = self.request(action="list")["projects"]
        self.assertEqual(updated["id"], original["id"])
        self.assertEqual(updated["name"], "新名称")
        self.assertEqual(Path(updated["path"]), self.project)

    def test_lists_optional_search_aliases(self):
        self.write_catalog({**self.entry, "aliases": [" 图像识别 ", "图像识别", "训练"]})
        project, = self.request(action="list")["projects"]
        self.assertEqual(project["aliases"], ["图像识别", "训练"])
        self.write_catalog({**self.entry, "aliases": "图像识别"})
        with self.assertRaises(ProjectCatalogError) as malformed:
            self.request(action="list")
        self.assertEqual(malformed.exception.status, 422)

    def test_exposes_configured_board_url_and_preserves_it_when_reopening(self):
        urls = (
            "http://127.0.0.1:8797/?board=board-20261116000000000000000000000008",
            "https://localhost:8797?board=repo-manual",
            "http://[::1]:65535/?board=original",
        )
        for url in urls:
            with self.subTest(url=url):
                self.write_catalog({**self.entry, "boardUrl": url})
                source = self.manifest.read_bytes()
                project, = self.request(action="list")["projects"]
                self.assertEqual(project["boardUrl"], url)
                self.assertEqual(self.request(action="get", id=project["id"])["project"], project)
                reopened = self.request(action="register", name="新名称", path=str(self.project))["project"]
                self.assertEqual(reopened, project)
                self.assertEqual(self.manifest.read_bytes(), source)

        with self.assertRaises(ProjectCatalogError) as untrusted:
            self.request(action="register", name="项目", path=str(self.project), boardUrl=urls[0])
        self.assertEqual(untrusted.exception.status, 400)

    def test_rejects_malformed_or_nonlocal_board_urls(self):
        for url in (
            None, "", "javascript:alert(1)", "//localhost:8797/?board=original",
            "http://example.org:8797/?board=original", "http://localhost.example.org:8797/?board=original",
            "http://localhost/?board=original", "http://localhost:0/?board=original",
            "http://localhost:65536/?board=original", "http://localhost:abc/?board=original",
            "http://user@localhost:8797/?board=original", "http://localhost:8797/?board=original#",
            "http://localhost:8797/admin?board=original", "http://localhost:8797/?board=original&extra=1",
            "http://localhost:8797/?board=original&board=project-design", "http://localhost:8797/?board=board-abcd",
            "http://localhost:8797/?board=unknown",
        ):
            with self.subTest(url=url):
                self.write_catalog({**self.entry, "boardUrl": url})
                with self.assertRaises(ProjectCatalogError) as malformed:
                    self.request(action="list")
                self.assertEqual(malformed.exception.status, 422)

    def test_registers_and_reopens_without_overwriting_a_project(self):
        registered = self.request(action="register", name="  我的项目  ", path=str(self.project))["project"]
        self.assertEqual(registered["name"], "我的项目")
        self.assertEqual(registered["description"], "")
        self.assertEqual(self.request(action="list")["projects"], [registered])

        manifest = self.manifest.read_bytes()
        reopened = self.request(action="register", name="其他名称", path=str(self.project), description="其他简介")
        self.assertEqual(reopened["project"], registered)
        self.assertEqual(self.manifest.read_bytes(), manifest)
        self.assertEqual(self.request(action="get", id=registered["id"])["project"], registered)

    def test_registers_child_and_preserves_existing_catalog_fields(self):
        parent = {**self.entry, "aliases": ["旧名称"], "extra": {"owner": "本机用户"}}
        self.manifest.write_text(json.dumps([parent], ensure_ascii=False), encoding="utf-8-sig")
        old_project, = self.request(action="list")["projects"]
        child_path = self.project / "子项目"
        child_path.mkdir()
        child = self.request(action="register", name="子项目", path=str(child_path), description="子项目\n简介")["project"]
        self.assertEqual(child["parentId"], old_project["id"])
        self.assertEqual(child["description"], "子项目 简介")
        updated, = self.request(action="get", id=child["id"])["ancestors"]
        self.assertEqual(updated["childCount"], 1)
        self.assertEqual(json.loads(self.manifest.read_text(encoding="utf-8-sig"))[0], parent)

    def test_invalid_registration_and_catalog_preserve_existing_data(self):
        for path in ("relative", str(self.project / "missing")):
            with self.subTest(path=path), self.assertRaises(ProjectCatalogError) as invalid:
                self.request(action="register", name="项目", path=path)
            self.assertEqual(invalid.exception.status, 422)
            self.assertFalse(self.manifest.exists())

        for data in (b"\xff\xfe", b"{broken", b"{}", b"[{}]"):
            with self.subTest(catalog=data):
                self.manifest.write_bytes(data)
                with self.assertRaises(ProjectCatalogError) as invalid:
                    self.request(action="register", name="项目", path=str(self.project))
                self.assertEqual(invalid.exception.status, 422)
                self.assertEqual(self.manifest.read_bytes(), data)

    def test_concurrent_registrations_keep_each_project_once(self):
        second = self.project.with_name("本机项目 乙")
        second.mkdir()

        def register(directory):
            return self.request(action="register", name=directory.name, path=str(directory))["project"]["id"]

        with ThreadPoolExecutor(max_workers=3) as executor:
            first_id, second_id, repeated_id = executor.map(register, (self.project, second, self.project))
        self.assertEqual(first_id, repeated_id)
        self.assertNotEqual(first_id, second_id)
        self.assertEqual({project["id"] for project in self.request(action="list")["projects"]}, {first_id, second_id})

    def test_failed_catalog_replacement_keeps_the_original_file(self):
        self.write_catalog(self.entry)
        second = self.project.with_name("本机项目 乙")
        second.mkdir()
        current_bytes = self.manifest.read_bytes()
        current_files = set(self.manifest.parent.iterdir())
        with patch.object(Path, "replace", side_effect=PermissionError), self.assertRaises(ProjectCatalogError) as error:
            self.request(action="register", name="项目乙", path=str(second))
        self.assertEqual(error.exception.status, 500)
        self.assertEqual(self.manifest.read_bytes(), current_bytes)
        self.assertEqual(set(self.manifest.parent.iterdir()), current_files)

    def test_project_tree_uses_the_nearest_registered_ancestor(self):
        parent_path = self.project / "未登记目录" / "父项目"
        leaf_path = parent_path / "子项目"
        neighbor_path = self.project.with_name(f"{self.project.name}备份")
        self.write_catalog(
            {**self.entry, "name": "子项目", "path": str(leaf_path)},
            {**self.entry, "name": "同名前缀", "path": str(neighbor_path)},
            self.entry,
            {**self.entry, "name": "父项目", "path": str(parent_path)},
        )
        leaf, neighbor, root, parent = self.request(action="list")["projects"]
        self.assertIsNone(root["parentId"])
        self.assertIsNone(neighbor["parentId"])
        self.assertEqual((root["childCount"], parent["childCount"], leaf["childCount"]), (1, 1, 0))
        self.assertEqual(parent["parentId"], root["id"])
        self.assertEqual(leaf["parentId"], parent["id"])
        self.assertEqual(self.request(action="get", id=root["id"])["children"], [parent])
        self.assertEqual(self.request(action="get", id=parent["id"])["children"], [leaf])
        self.assertEqual(self.request(action="get", id=leaf["id"])["ancestors"], [root, parent])

    def test_project_detail_and_activity_have_the_same_identity(self):
        self.write_catalog(self.entry, {
            **self.entry, "name": "项目乙", "path": str(self.project.with_name("本机项目 乙")),
        })
        project_a, project_b = self.request(action="list")["projects"]
        id_a, id_b = project_a["id"], project_b["id"]
        self.assertEqual(self.request(action="get", id=id_a), {"project": project_a, "ancestors": [], "children": []})
        with self.assertRaises(ProjectCatalogError) as unknown:
            self.request(action="get", id="0" * 32)
        self.assertEqual(unknown.exception.status, 404)

        snapshot_a = {"projectId": id_a, "events": [{"id": "a"}]}
        legacy = self.manifest.with_name("workbench-activity.local.json")
        legacy.write_text(json.dumps(snapshot_a), encoding="utf-8")
        self.assertEqual(project_activity_request({"projectId": id_a}), {"activity": snapshot_a})
        self.assertEqual(project_activity_request({"projectId": id_b}), {"activity": None})

        folder = self.manifest.with_name("workbench-activity")
        folder.mkdir()
        file_b = folder / f"{id_b}.json"
        file_b.write_text(json.dumps(snapshot_a), encoding="utf-8")
        self.assertEqual(project_activity_request({"projectId": id_b}), {"activity": None})
        snapshot_b = {"projectId": id_b, "events": [{"id": "b"}]}
        file_b.write_text(json.dumps(snapshot_b), encoding="utf-8")
        self.assertEqual(project_activity_request({"projectId": id_b}), {"activity": snapshot_b})
        self.assertEqual(project_activity_request({"projectId": id_a}), {"activity": snapshot_a})

        with self.assertRaises(ProjectCatalogError) as invalid:
            project_activity_request({"projectId": "../projects.local"})
        self.assertEqual(invalid.exception.status, 400)

    @unittest.skipUnless(os.name == "nt", "Explorer integration is Windows-specific")
    def test_only_registered_existing_directories_are_launched(self):
        self.write_catalog(self.entry)
        project, = self.request(action="list")["projects"]
        with patch("os.startfile") as open_folder:
            with self.assertRaises(ProjectCatalogError) as unregistered:
                self.request(action="open", id=str(self.project.parent))
            self.assertEqual(unregistered.exception.status, 404)
            with self.assertRaises(ProjectCatalogError) as arbitrary_path:
                self.request(action="open", id=project["id"], path=str(self.project.parent))
            self.assertEqual(arbitrary_path.exception.status, 400)
            open_folder.assert_not_called()

            self.assertEqual(self.request(action="open", id=project["id"]), {"opened": True})
            open_folder.assert_called_once_with(str(self.project.resolve()), "explore")

            self.project.rmdir()
            with self.assertRaises(ProjectCatalogError) as missing:
                self.request(action="open", id=project["id"])
            self.assertEqual(missing.exception.status, 404)
            self.assertEqual(open_folder.call_count, 1)


if __name__ == "__main__":
    unittest.main()
