"use strict";

// Persistence-boundary tests run with an in-memory Storage implementation.
// They never access a browser profile, a provider, or the real board database.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const transfer = require("./board_transfer.js");

const sourceId = `board-${"a".repeat(32)}`;
const catalogKey = "whiteboard.codex.boards.v1";
const boardKeys = (id) => ({
  memory: `whiteboard.codex.${id}.v1`,
  organization: `whiteboard.codex.${id}.organization.v1`,
});
const plain = (value) => JSON.parse(JSON.stringify(value));

function documentFixture() {
  const box = { x: 80, y: 150, width: 300, height: 150 };
  const payload = (parent, question) => ({ boardId: sourceId, question,
    anchor: { elementIds: [parent], wholeCardIds: [parent], box, quote: "选中的原文" }, scope: "explain" });
  return {
    title: "设计手册",
    sourceBoardId: sourceId,
    memory: {
      project: { goal: "看懂实现", constraints: ["保留接口"],
        decisions: [{ text: "先验证再改", sourceIds: ["E02", "A01"] }] },
      notes: [
        { id: "A01", kind: "branch", branchId: "A01", rect: box,
          payload: payload("E02", "这里怎么实现？"), sourceCardIds: ["E02"],
          answer: "由路由分派到处理器。", anchors: [box] },
        { id: "A02", kind: "note", branchId: "A01", rect: { ...box, x: 420 },
          payload: payload("A01", "失败时如何恢复？"), sourceCardIds: ["E02"],
          answer: "保留草稿并显示错误。", anchors: [box], delivery: "failed",
          deliveryMessage: "上次请求失败", retryPayload: payload("A01", "重试恢复说明") },
      ],
      pinnedIds: ["E01", "A01"], deletedIds: [],
    },
    organization: {
      current: null, rawCards: [
        { id: "E01", parentId: null, title: "总览", summary: "入口说明", category: "main" },
        { id: "E02", parentId: "E01", title: "接口", summary: "处理入口", category: "reference", folded: true },
        { id: "E03", parentId: "E01", title: "验证", summary: "验收方法", category: "reference" },
      ],
      rawPositions: { E01: { x: -40, y: 60, width: 320 }, E02: { x: 340, y: 60, width: 300 },
        E03: { x: 340, y: 260, width: 300 }, A01: { x: 720, y: 60, width: 300 }, A02: { x: 1080, y: 60, width: 300 } },
      rawLinks: { E02: ["E01"], E03: ["E01"], A01: ["E02"], A02: ["A01"] },
      rawCollapsedBranches: ["E02"], quickMode: "balanced", rawCompact: true,
      branchQuickModes: { E02: "horizontal" }, opinion: "章节按功能分组",
    },
  };
}

function harness({ fixedToken, boardId = sourceId } = {}) {
  const fixture = documentFixture();
  const data = new Map([
    [catalogKey, JSON.stringify([{ id: sourceId, title: fixture.title,
      repositoryPath: "C:\\private\\original-repository", projectId: "a".repeat(32) }])],
    [boardKeys(sourceId).memory, JSON.stringify(fixture.memory)],
    [boardKeys(sourceId).organization, JSON.stringify(fixture.organization)],
    [`whiteboard.codex.${sourceId}.template-backup.v1`, JSON.stringify(["private undo", "private plan"])],
    ["whiteboard.codex.connection.v1", JSON.stringify({ backend: "api", apiKey: "synthetic-private-key" })],
  ]);
  let writeNumber = 0;
  let failingWrite = 0;
  const storage = {
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) {
      writeNumber += 1;
      if (writeNumber === failingWrite) {
        const error = new Error("Synthetic storage quota exhaustion");
        error.name = "QuotaExceededError";
        throw error;
      }
      data.set(String(key), String(value));
    },
    removeItem(key) { data.delete(String(key)); },
    clear() { data.clear(); },
    key(index) { return [...data.keys()][index] ?? null; },
    get length() { return data.size; },
  };
  let randomToken = 0;
  const window = { localStorage: storage, location: { search: `?board=${boardId}`, hash: "" },
    navigator: { locks: { request: (_name, change) => Promise.resolve().then(change) } },
    dispatchEvent() {}, BoardTransfer: transfer };
  const context = vm.createContext({ window, localStorage: storage, URLSearchParams,
    crypto: { getRandomValues(bytes) { bytes.fill(fixedToken ?? ++randomToken); return bytes; } },
    Event: class Event { constructor(type) { this.type = type; } } });
  vm.runInContext(readFileSync(join(__dirname, "memory.js"), "utf8"), context, { filename: "memory.js" });
  vm.runInContext(readFileSync(join(__dirname, "organization.js"), "utf8"), context, { filename: "organization.js" });
  return { data, window, storage, memory: window.BoardMemory, organization: window.BoardOrganization,
    fixture, failWrite(number) { failingWrite = writeNumber + number; },
    snapshot() { return [...data].sort(([left], [right]) => left.localeCompare(right)); },
    reload(id) {
      window.location.search = `?board=${id}`;
      vm.runInContext(readFileSync(join(__dirname, "memory.js"), "utf8"), context, { filename: "memory.js" });
      vm.runInContext(readFileSync(join(__dirname, "organization.js"), "utf8"), context, { filename: "organization.js" });
      this.memory = window.BoardMemory;
      this.organization = window.BoardOrganization;
    },
  };
}

test("import creates a new board, rewrites discussion board IDs, and preserves source and node identities", async () => {
  const h = harness();
  const before = h.snapshot();
  const input = plain(h.fixture);
  const id = await h.memory.importBoard(input, "独立实验副本", "");
  assert.match(id, /^board-[0-9a-f]{32}$/);
  assert.notEqual(id, sourceId);
  assert.deepEqual(input, h.fixture, "forking must not mutate the caller's source document");
  for (const [key, value] of before.filter(([key]) => key !== catalogKey)) {
    assert.equal(h.storage.getItem(key), value, `source or private setting changed: ${key}`);
  }
  const catalog = JSON.parse(h.storage.getItem(catalogKey));
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], JSON.parse(before.find(([key]) => key === catalogKey)[1])[0]);
  const metadata = catalog.find((entry) => entry.id === id);
  assert.deepEqual(metadata, { id, title: "独立实验副本" });
  const saved = JSON.parse(h.storage.getItem(boardKeys(id).memory));
  assert.deepEqual(saved.notes.map((note) => note.id), ["A01", "A02"]);
  assert.equal(saved.notes[0].payload.boardId, id);
  assert.equal(saved.notes[1].payload.boardId, id);
  assert.equal(saved.notes[1].retryPayload.boardId, id);
  assert.deepEqual(saved.notes[1].payload.anchor.elementIds, ["A01"]);
  assert.deepEqual(saved.pinnedIds, ["E01", "A01"]);
  assert.deepEqual(saved.project, input.memory.project);
  assert.equal(saved.notes[1].branchId, "A01");
  const importedKeys = [...h.data.keys()].filter((key) => key.startsWith(`whiteboard.codex.${id}.`));
  assert.deepEqual(importedKeys.sort(), Object.values(boardKeys(id)).sort(), "only content and organization are copied");
  assert.equal(importedKeys.map((key) => h.storage.getItem(key)).join("\n").includes("synthetic-private-key"), false);
});

for (const [stage, write] of [["first document", 1], ["second document", 2], ["catalog publication", 3]]) {
  test(`storage exhaustion during ${stage} rolls back all new document fragments`, async () => {
    const h = harness();
    const before = h.snapshot();
    h.failWrite(write);
    await assert.rejects(h.memory.importBoard(h.fixture, "未完成副本"), /Synthetic storage quota/);
    assert.deepEqual(h.snapshot(), before, "catalog, source, private config and document keys must remain byte-identical");
  });
}

test("invalid name and invalid graph reject before publishing any board", async () => {
  const h = harness();
  const before = h.snapshot();
  await assert.rejects(h.memory.importBoard(h.fixture, " "), /白板名称/);
  const duplicate = plain(h.fixture);
  duplicate.organization.rawCards.push({ ...duplicate.organization.rawCards[0] });
  await assert.rejects(h.memory.importBoard(duplicate, "无效结构"));
  assert.deepEqual(h.snapshot(), before);
});

test("generated board ID collision never overwrites an existing board", async () => {
  const h = harness({ fixedToken: 0xaa });
  const before = h.snapshot();
  await assert.rejects(h.memory.importBoard(h.fixture, "编号冲突"), /编号已存在/);
  assert.deepEqual(h.snapshot(), before);
});

test("reloading a raw imported custom board retains seed IDs, links, folded state and actual positions", async () => {
  const h = harness();
  const id = await h.memory.importBoard(h.fixture, "从示例复制", "C:\\projects\\fork-workspace");
  h.reload(id);
  assert.equal(h.memory.activeBoard, id);
  assert.equal(h.memory.activeBoardInfo.custom, true);
  assert.equal(h.memory.activeBoardInfo.repositoryPath, "C:\\projects\\fork-workspace");
  assert.equal(Object.hasOwn(h.memory.activeBoardInfo, "projectId"), false);
  const org = plain(h.organization.load());
  assert.equal(org.current, null);
  assert.deepEqual(org.rawCards.map((item) => item.id), ["E01", "E02", "E03"]);
  assert.equal(org.rawCards.find((item) => item.id === "E02").folded, true);
  assert.deepEqual(org.rawLinks, h.fixture.organization.rawLinks);
  assert.deepEqual(org.rawPositions, h.fixture.organization.rawPositions);
  assert.deepEqual(org.rawCollapsedBranches, ["E02"]);
  assert.equal(org.quickMode, "balanced");
  assert.deepEqual(org.branchQuickModes, { E02: "horizontal" });
  assert.equal(org.undoAvailable, false);
  assert.equal(org.previous, null);
});

test("two imports create independent IDs and documents without borrowing project registration", async () => {
  const h = harness();
  const first = await h.memory.importBoard(h.fixture, "方案一");
  const second = await h.memory.importBoard(h.fixture, "方案二");
  assert.notEqual(first, second);
  assert.equal(JSON.parse(h.storage.getItem(catalogKey)).length, 3);
  const original = h.storage.getItem(boardKeys(sourceId).memory);
  const next = JSON.parse(h.storage.getItem(boardKeys(first).memory));
  next.project.goal = "只修改方案一";
  h.storage.setItem(boardKeys(first).memory, JSON.stringify(next));
  assert.equal(JSON.parse(h.storage.getItem(boardKeys(second).memory)).project.goal, "看懂实现");
  assert.equal(h.storage.getItem(boardKeys(sourceId).memory), original);
});

test("an invalid card cannot be accepted and silently disappear during reload", async () => {
  const h = harness();
  const before = h.snapshot();
  const rawAnswer = plain(h.fixture);
  rawAnswer.organization.rawCards.push({ id: "A09", parentId: "E01", title: "未持久化的回答", summary: "不能悄悄丢失", category: "reference" });
  await assert.rejects(h.memory.importBoard(rawAnswer, "不可呈现的原始卡片"));
  const phantomAnswer = plain(h.fixture);
  phantomAnswer.organization.current = { title: "包含空壳回答", items: [
    ...phantomAnswer.organization.rawCards,
    { id: "A09", parentId: "E01", title: "缺少回答记录", summary: "不能悄悄丢失", category: "reference" },
  ] };
  delete phantomAnswer.organization.rawCards;
  await assert.rejects(h.memory.importBoard(phantomAnswer, "不可呈现的回答节点"));
  assert.deepEqual(h.snapshot(), before);
});
