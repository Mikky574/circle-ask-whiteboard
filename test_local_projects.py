import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_projects import ProjectCatalogError, project_catalog_request
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
