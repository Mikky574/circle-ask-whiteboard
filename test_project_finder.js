const assert = require("node:assert/strict");
const { test } = require("node:test");
const { findProjects } = require("./project_finder.js");

const catalog = [
  { name: "港口影像分析", path: "D:\\影像\\dock", description: "港区视频目标检测", category: "检测",
    aliases: ["码头录像", "查船", "货船"] },
  { name: "杆件计数", path: "D:\\影像\\counter", description: "自动点数端面", category: "计数",
    aliases: ["数竹签", "几根竹签"] },
  { name: "CNN_IC", path: "D:\\模型\\CNN_IC", description: "统一多头", category: "模型" },
  { name: "CNN_IC_Aves", path: "D:\\模型\\CNN_IC_Aves", description: "鸟类分类机器人", category: "模型" },
  { name: "截图文字识别", path: "D:\\工具\\OCR", description: "屏幕 OCR 样例", category: "工具" },
];

test("uses a project purpose stated in a natural question", () => {
  assert.equal(findProjects(catalog, "我想找那个在码头录像里查船的")[0], catalog[0]);
  assert.equal(findProjects(catalog, "哪个项目能数出照片里有几根竹签？")[0], catalog[1]);
});

test("ranks exact identifiers and local paths", () => {
  assert.deepEqual(findProjects(catalog, "查一下 ＣＮＮ＿ＩＣ"), [catalog[2]]);
  assert.equal(findProjects(catalog, "打开 d:/工具/ocr")[0], catalog[4]);
});

test("generic phrases and incidental single characters do not yield projects", () => {
  for (const question of ["", "我想找那个文件夹", "天气怎么样", "有做月球采矿机的吗"]) {
    assert.deepEqual(findProjects(catalog, question), [], question);
  }
});
