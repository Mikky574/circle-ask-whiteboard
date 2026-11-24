"""Function summaries must stand alone; code evidence belongs in separate fields."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import server


def capability():
    return {"version": 1, "audience": "需要复核结果的人", "input": "待识别图片",
            "outcome": "得到识别结果或明确的不确定提示", "boundary": "不替用户确认物种",
            "verification": "用已知图片和低置信样例核对可见结果；尚未运行"}


def overview_fixture(items):
    root = next(item["id"] for item in items if item["parentId"] is None)
    direct = [item for item in items if item["parentId"] == root]
    return {"version": 1, "rootId": root, "title": "从使用到验收", "zones": [
        {"id": "goal", "title": "用途", "role": "entry", "size": "medium", "lane": 0,
         "nodes": [{"id": "root", "cardId": root, "label": "查看项目", "note": ""}]},
        {"id": "outcome", "title": "可观察结果", "role": "capability", "size": "large", "lane": 1,
         "nodes": [{"id": f"step-{i}", "cardId": item["id"], "label": item["title"], "note": ""}
                   for i, item in enumerate(direct)]},
    ], "links": []}


class CapabilityIntroTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repository = Path(self.temp.name)
        (self.repository / "predict.py").write_text("def predict(image):\n    return None\n", encoding="utf-8")
        self.board = {"nodes": [], "newIds": [f"E{i:02}" for i in range(4, 25)]}
        self.plan = {"title": "识别项目", "summary": "从图片到可复核结果",
                     "layout": {"flow": "horizontal", "density": "compact"}, "items": [
            {"id": "E04", "parentId": None, "category": "main", "title": "从图片得到可复核结果",
             "summary": "将图片转成候选与复核提示。", "sources": [],
             "repositoryFiles": ["predict.py"], "capability": capability()},
            {"id": "E05", "parentId": "E04", "category": "reference", "title": "不确定时保留待复核结果",
             "summary": "无法可靠判断时，保留图片并提示复核。", "sources": [],
             "repositoryFiles": ["predict.py#predict"], "capability": capability()},
        ]}
        self.plan["projectStructure"] = overview_fixture(self.plan["items"])

    def generate(self, plan=None):
        return server.structured_candidate(json.dumps(plan or self.plan),
            {"scope": "organize", "boardIntent": "repository_init", "board": self.board},
            repository_scope=True, repository=self.repository)[1]["map"]

    def test_small_function_map_does_not_need_filler_or_code_in_prose(self):
        result = self.generate()
        self.assertEqual(len(result["items"]), 2, "Available IDs are a budget, not a quota")
        self.assertEqual(result["items"][1]["summary"], self.plan["items"][1]["summary"])
        self.assertEqual(result["items"][1]["repositoryFiles"], ["predict.py"])
        self.assertEqual(result["items"][0]["capability"], capability())
        self.assertEqual(result["projectStructure"], self.plan["projectStructure"])

    def test_both_cli_schemas_require_the_same_diagram(self):
        for zcode in (False, True):
            schema_path = server.write_map_schema(self.board, repository_scope=True, zcode=zcode, repository_intro=True)
            try:
                schema = json.loads(schema_path.read_text(encoding="utf-8"))
            finally:
                schema_path.unlink()
            self.assertIn("projectStructure", schema["required"])
            self.assertEqual(schema["properties"]["projectStructure"]["required"],
                             ["version", "rootId", "title", "zones", "links"])
        prompt = server.build_prompt("ask", "初始化", {"boardIntent": "repository_init", "board": self.board},
                                     repository_scope=True)
        self.assertIn(server.GUIDE_PATH.read_text(encoding="utf-8"), prompt)

    def test_diagram_requires_outer_cards_and_evidenced_links(self):
        link = {"from": "root", "to": "step-0", "label": "打开可复核结果", "kind": "main", "evidence": "E05"}
        self.plan["projectStructure"]["links"] = [link]
        self.assertEqual(self.generate()["projectStructure"]["links"], [link])
        for mutate in (
            lambda plan: plan.pop("projectStructure"),
            lambda plan: plan["projectStructure"].update(rootId="E05"),
            lambda plan: plan["projectStructure"]["zones"].pop(),
            lambda plan: plan["projectStructure"]["zones"][1]["nodes"][0].update(cardId="E04"),
            lambda plan: plan["projectStructure"]["links"][0].update(evidence="E08"),
            lambda plan: plan["projectStructure"]["links"][0].update(to="E05"),
        ):
            with self.subTest(mutate=mutate), self.assertRaisesRegex(ValueError, "模块图无效"):
                plan = copy.deepcopy(self.plan)
                mutate(plan)
                self.generate(plan)

    def test_outer_cards_require_a_user_outcome_and_separate_valid_evidence(self):
        for mutate in (
            lambda plan: plan["items"][1].pop("capability"),
            lambda plan: plan["items"][1]["capability"].update(outcome=" "),
            lambda plan: plan["items"][1].update(repositoryFiles=["../outside.py"]),
            lambda plan: plan["items"][1].update(repositoryFiles=["missing.py"]),
        ):
            with self.subTest(mutate=mutate):
                plan = copy.deepcopy(self.plan)
                mutate(plan)
                with self.assertRaises(ValueError):
                    self.generate(plan)

    def test_no_automatic_source_card_on_overview_or_capability(self):
        self.board["codeIds"] = ["E30", "E31"]
        self.assertFalse(any("codePreview" in item for item in self.generate()["items"]))

    def test_reading_hierarchy_can_reach_five_and_six_levels(self):
        for number, title in enumerate(("遇到低置信结果", "交给人工复核", "核对复核输出", "定位输出的实现"), 6):
            self.plan["items"].append({"id": f"E{number:02}", "parentId": f"E{number - 1:02}",
                "category": "reference", "title": title, "summary": "检查这一层的行为和依据。",
                "repositoryFiles": ["predict.py"], "capability": None, "sources": []})
        self.assertEqual(self.generate()["items"][-1]["parentId"], "E08")
        self.plan["items"].append({**self.plan["items"][-1], "id": "E10", "parentId": "E09"})
        with self.assertRaisesRegex(ValueError, "超出工程介绍的 6 级范围"):
            self.generate()

    def test_existing_board_reorganization_can_return_function_records_and_checks_evidence(self):
        context = {"scope": "organize", "board": {"nodes": [{"id": "E04"}, {"id": "E05"}], "newIds": []}}
        self.plan.pop("projectStructure")
        result = server.structured_candidate(json.dumps(self.plan), context, repository_scope=True,
                                             repository=self.repository)[1]["map"]
        self.assertEqual(result["items"][1]["capability"], capability())
        self.assertEqual(result["items"][1]["repositoryFiles"], ["predict.py"])
        self.plan["items"][1]["repositoryFiles"] = ["missing.py"]
        with self.assertRaisesRegex(ValueError, "missing.py"):
            server.structured_candidate(json.dumps(self.plan), context, repository_scope=True, repository=self.repository)

    def test_capability_expansion_checks_scope_and_retains_the_user_outcome(self):
        target = {"id": "E04", "parentId": None, "title": "Project", "summary": "Root", "pinned": False}
        neighbor = {**target, "id": "E06", "title": "Export the result"}
        expansion = {"targetId": "E04", "path": [target], "children": [], "pinned": [],
                     "strategy": "capabilities", "related": [neighbor]}
        server.validate_card_expansion_context(expansion, {"elementIds": ["E04"]})
        item = {"title": "Get a reviewable prediction", "summary": "Keep a candidate or ask for review.",
                "capability": capability()}
        self.assertEqual(server.validate_card_expansion({"children": [item]}, expansion), [item])
        self.assertEqual(server.validate_card_expansion({"children": []}, expansion), [])
        with self.assertRaisesRegex(ValueError, "重复标题"):
            server.validate_card_expansion({"children": [{**item, "title": neighbor["title"]}]}, expansion)
        with self.assertRaises(ValueError):
            server.validate_card_expansion({"children": [{"title": item["title"], "summary": item["summary"]}]}, expansion)
        with self.assertRaises(ValueError):
            server.validate_card_expansion_context({**expansion, "strategy": "rewrite_board"}, {"elementIds": ["E04"]})


if __name__ == "__main__":
    unittest.main()
