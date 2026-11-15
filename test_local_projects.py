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

    def test_project_detail_and_activity_have_the_same_identity(self):
        self.write_catalog(self.entry, {
            **self.entry, "name": "项目乙", "path": str(self.project.with_name("本机项目 乙")),
        })
        project_a, project_b = self.request(action="list")["projects"]
        id_a, id_b = project_a["id"], project_b["id"]
        self.assertEqual(self.request(action="get", id=id_a), {"project": project_a})
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
