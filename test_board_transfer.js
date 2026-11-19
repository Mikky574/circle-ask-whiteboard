"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const transfer = require("./board_transfer.js");

function fixture(raw = false) {
  const rect = { x: 120, y: -90, width: 300, height: 180 };
  const source = { title: "项目说明 · 试验分支", sourceBoardId: "repo-manual",
    memory: { project: { goal: "掌握仓库", constraints: ["先测试"], decisions: [{ text: "保留接口", sourceIds: ["E01"] }] },
      notes: [{ id: "A01", kind: "branch", branchId: null, archived: false, rect,
        payload: { boardId: "repo-manual", question: "为什么这样做？", anchor: { elementIds: ["E02"], box: rect, quote: "实现",
          wholeCardIds: ["E02"], noteContexts: [{ elementId: "E02", originalQuestion: "原问题", sourceCardIds: ["E01", "E999"] }] } },
        sourceCardIds: ["E02"], answer: "完整回答".repeat(200), anchors: [rect], outline: true, outlineCollapsed: true,
        originalAnswer: "原始长文", delivery: "failed", retryPayload: { boardId: "repo-manual", question: "重试",
          anchor: { elementIds: ["E02"], box: rect, quote: "" } } },
        { id: "A02", kind: "note", branchId: "A01", rect: { ...rect, y: 200 },
          payload: { boardId: "repo-manual", question: "再解释", anchor: { elementIds: ["A01"], box: rect, quote: "回答" } },
          sourceCardIds: ["E02"], answer: "下一层", anchors: [rect], sectionOf: "A01" }],
      pinnedIds: ["E01", "A01"], deletedIds: ["E90"], pendingRepair: "should not resume" },
    organization: { current: { title: "仓库详解", summary: "内容", layout: { flow: "horizontal", density: "compact" },
      items: [{ id: "E01", parentId: null, title: "总览", summary: "根节点", category: "main", attachments: [{ id: "a".repeat(32), name: "需求.md", size: 5 }] },
        { id: "E02", parentId: "E01", title: "实现", summary: "正文".repeat(400), category: "reference", folded: true,
          taskDetails: { task: "实现", dependencies: ["接口定义"], acceptance: ["有回归测试"] },
          spec: { kind: "requirement", id: "REQ-01" }, repositoryFiles: ["src/main.js"], sources: ["app.js"],
          codePreview: { path: "src/main.js", text: "main()" } },
        { id: "A01", parentId: "E02", title: "回答", summary: "卡片表述", category: "reference", nativeFace: true },
        { id: "A02", parentId: "A01", title: "下级", summary: "子回答", category: "reference", localContent: true }],
      positions: { E01: { x: -500, y: -40, width: 350 }, E02: { x: 0, y: -20 }, A01: { x: 340, y: 20 } },
      projectGuide: { rootId: "E01", x: -500, y: -40 }, collapsedBranches: ["A01"], branchLayouts: ["E02"] },
      previous: { shouldNotExport: true }, quickUndo: { shouldNotExport: true }, undoAvailable: true,
      rawLinkUndo: { shouldNotExport: true }, templateBackup: "shouldNotExport", opinion: "更细",
      rawPositions: { E01: { x: -10, y: 30 } }, rawCompact: true, quickMode: "adaptive", branchQuickModes: { E02: "balanced" } } };
  if (raw) {
    source.organization.rawCards = source.organization.current.items.filter(entry => entry.id.startsWith("E"));
    source.organization.current = null;
    source.organization.rawLinks = { E02: ["E01"], A01: ["E02"], A02: ["A01", "E01"] };
    source.organization.rawCollapsedBranches = ["E02"];
  }
  return source;
}
const roundtrip = source => transfer.parse(JSON.stringify(transfer.create(source)));
function invalid(change, match) {
  const source = fixture();
  change(source);
  assert.throws(() => transfer.create(source), match);
}

test("round trip preserves full hierarchy, long content, notes, task/spec/code, pins and layout", () => {
  const source = fixture();
  const result = roundtrip(source);
  assert.equal(result.title, source.title);
  assert.equal(result.sourceBoardId, "repo-manual");
  assert.deepEqual(result.organization.current, source.organization.current);
  assert.equal(result.memory.notes[0].answer, source.memory.notes[0].answer);
  assert.deepEqual(result.memory.pinnedIds, ["E01", "A01"]);
  assert.equal(result.memory.notes[1].sectionOf, "A01");
  assert.deepEqual(result.memory.notes[0].retryPayload, source.memory.notes[0].retryPayload);
  assert.deepEqual(result.memory.notes[0].payload.anchor.noteContexts[0].sourceCardIds, ["E01"]);
  assert.deepEqual(result.stats, { cards: 2, notes: 2, attachments: 1 });
  assert.deepEqual(result.organization.branchQuickModes, { E02: "balanced" });
});

test("raw-mode preserves original seed IDs, multiple manual parents and collapsed branches", () => {
  const source = fixture(true);
  const result = roundtrip(source);
  assert.equal(result.organization.current, null);
  assert.equal(result.organization.rawCards[0].id, "E01");
  assert.deepEqual(result.organization.rawLinks, source.organization.rawLinks);
  assert.deepEqual(result.organization.rawCollapsedBranches, ["E02"]);
  assert.equal(result.memory.notes[1].branchId, "A01");
});

test("only allowlisted document fields survive; no connection, project binding or undo state leaks", () => {
  const source = fixture();
  Object.assign(source, { apiKey: "TOP-KEY", repositoryPath: "PRIVATE-PATH", projectId: "PRIVATE-ID", connection: { key: "CONNECTION-KEY" } });
  Object.assign(source.memory, { apiKey: "MEMORY-KEY", connection: { apiKey: "MEMORY-CONNECTION-KEY" } });
  Object.assign(source.organization.current.items[0], { apiKey: "CARD-KEY", privateModel: "SECRET-MODEL" });
  Object.assign(source.memory.notes[0].payload, { apiKey: "PAYLOAD-KEY", apiBase: "SECRET-URL", model: "SECRET-MODEL" });
  Object.assign(source.memory.notes[0].payload.anchor, { connection: "ANCHOR-KEY" });
  source.organization.current.items[0].attachments[0].path = "PRIVATE-ATTACHMENT-PATH";
  const serialized = JSON.stringify(transfer.create(source));
  for (const forbidden of ["TOP-KEY", "PRIVATE-PATH", "PRIVATE-ID", "CONNECTION-KEY", "MEMORY-KEY", "CARD-KEY", "PAYLOAD-KEY",
    "SECRET-URL", "SECRET-MODEL", "ANCHOR-KEY", "PRIVATE-ATTACHMENT-PATH", "shouldNotExport", "should not resume"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  const result = transfer.parse(serialized);
  assert.equal(result.organization.previous, null);
  assert.equal(result.organization.quickUndo, null);
  assert.equal(result.organization.undoAvailable, false);
  assert.equal(result.memory.pendingRepair, "");
  assert.deepEqual(result.organization.current.items[0].attachments, [{ id: "a".repeat(32), name: "需求.md", size: 5 }]);
});

test("completed and interrupted historical questions keep references to deleted cards", () => {
  const source = fixture();
  source.memory.notes[0].payload.anchor.elementIds = ["E90"];
  source.memory.notes[0].payload.anchor.wholeCardIds = ["E90"];
  source.memory.notes[0].sourceCardIds = ["E90"];
  source.memory.notes[0].delivery = "pending";
  const result = roundtrip(source);
  assert.deepEqual(result.memory.notes[0].payload.anchor.elementIds, ["E90"]);
  assert.equal(result.memory.notes[0].delivery, "interrupted");
});

test("empty independent boards and UTF-8 BOM files are supported", () => {
  const content = transfer.create({ title: "空白板", memory: { project: {}, notes: [] }, organization: { current: null } });
  const result = transfer.parse(`\uFEFF${JSON.stringify(content)}`);
  assert.deepEqual(result.stats, { cards: 0, notes: 0, attachments: 0 });
  assert.equal(result.organization.current, null);
});

test("rejects unknown formats, versions and malformed JSON with actionable Chinese errors", () => {
  assert.throws(() => transfer.parse("hello"), /无法读取 JSON/);
  assert.throws(() => transfer.parse("null"), /白板文件应为对象/);
  const value = transfer.create(fixture());
  assert.throws(() => transfer.parse(JSON.stringify({ ...value, format: "other" })), /请选择圈问白板/);
  assert.throws(() => transfer.parse(JSON.stringify({ ...value, version: 2 })), /不支持这个文件版本/);
});

test("rejects duplicate entities, missing parents and hierarchy cycles without changing input", () => {
  invalid(source => source.organization.current.items.push({ ...source.organization.current.items[0] }), /重复卡片编号/);
  invalid(source => source.memory.notes.push({ ...source.memory.notes[0] }), /重复卡片编号/);
  invalid(source => { source.organization.current.items[0].parentId = "E999"; }, /不存在的卡片 E999/);
  invalid(source => { source.organization.current.items[0].parentId = "A02"; }, /存在循环/);
  const raw = fixture(true);
  raw.organization.rawLinks.E01 = ["A02"];
  const before = JSON.stringify(raw);
  assert.throws(() => transfer.create(raw), /存在循环/);
  assert.equal(JSON.stringify(raw), before);
});

test("rejects invalid numeric geometry, attachment descriptors and dangling selection references", () => {
  invalid(source => { source.organization.current.positions.E01.x = Infinity; }, /坐标无效/);
  invalid(source => { source.memory.notes[0].rect.height = -2; }, /坐标或尺寸无效/);
  invalid(source => { source.organization.current.items[0].attachments[0].id = "../../escape"; }, /附件编号/);
  invalid(source => { source.organization.current.items[0].attachments[0].size = 10 * 1024 * 1024 + 1; }, /附件编号或大小/);
  invalid(source => { source.memory.notes[0].payload.anchor.elementIds = ["E999"]; }, /不存在的卡片 E999/);
});

test("24 MiB limit counts UTF-8 bytes rather than just JavaScript characters", () => {
  assert.throws(() => transfer.parse("你".repeat(Math.floor(transfer.MAX_BYTES / 3) + 1)), /不能超过 24 MiB/);
  const source = fixture();
  const original = source.memory.notes[0];
  source.memory.notes.push(...Array.from({ length: 550 }, (_, index) => ({ ...original, id: `A${index + 100}`, answer: "你".repeat(16000) })));
  assert.throws(() => transfer.create(source), /不能超过 24 MiB/);
});

test("canonical storage text and list limits reject inputs that would be truncated or dropped on reload", () => {
  const bad = [
    source => { source.organization.current.items[0].title = "标".repeat(101); },
    source => { source.organization.current.items[0].summary = "文".repeat(801); },
    source => { source.organization.current.items[1].taskDetails.task = "任".repeat(501); },
    source => { source.organization.current.items[1].taskDetails.dependencies = Array(6).fill("依赖"); },
    source => { source.organization.current.items[1].taskDetails.acceptance = []; },
    source => { source.organization.current.items[1].taskDetails.acceptance = ["验".repeat(181)]; },
    source => { source.organization.current.items[1].spec.id = "invalid-spec"; },
    source => { source.organization.current.items[1].codePreview.text = "x".repeat(1401); },
    source => { source.organization.current.items[1].repositoryFiles = Array.from({ length: 13 }, (_, i) => `src/${i}.js`); },
    source => { source.organization.current.items[1].repositoryFiles = ["../outside.js"]; },
    source => { source.memory.notes[0].payload.question = "问".repeat(1001); },
    source => { source.memory.notes[0].answer = "答".repeat(16001); },
    source => { source.memory.notes[0].payload.anchor.quote = "摘".repeat(601); },
    source => { source.memory.notes[0].payload.anchor.elementIds = Array.from({ length: 25 }, (_, i) => `E${100 + i}`); },
    source => { source.memory.notes[0].payload.anchor.formulaFragments = [{ elementId: "E02", quote: "f", source: "f".repeat(1001) }]; },
    source => { source.memory.project.goal = "目".repeat(801); },
    source => { source.memory.project.constraints = Array(25).fill("约束"); },
    source => { source.memory.project.constraints = ["约".repeat(301)]; },
    source => { source.memory.project.decisions[0].text = "决".repeat(701); },
  ];
  for (const change of bad) invalid(change, /白板文件无效/);
});

test("canonical boundary content, codepoint-sized titles and full 16000-unit answers survive", () => {
  const source = fixture();
  source.organization.current.items[0].title = "🌿".repeat(100);
  source.organization.current.items[0].summary = "🌿".repeat(800);
  source.organization.current.items[1].taskDetails.task = "🌿".repeat(500);
  source.memory.notes[0].answer = "答".repeat(16000);
  source.memory.notes[0].payload.question = "问".repeat(1000);
  const result = roundtrip(source);
  assert.equal(result.organization.current.items[0].title, source.organization.current.items[0].title);
  assert.equal(result.organization.current.items[0].summary, source.organization.current.items[0].summary);
  assert.equal(result.memory.notes[0].answer.length, 16000);
  assert.equal(result.memory.notes[0].payload.question.length, 1000);
  assert.equal(result.stats.cards + result.stats.notes, 4);
});
