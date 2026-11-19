/* Mindmap presentation acceptance in an ephemeral browser and mock HTTP service.
 * Run: node test_mindmap_browser.mjs
 * Uses the actual code manual and native question/split handlers. No real model,
 * user browser profile, source repository or production database is accessed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const boards = new Map();
const errors = [];
const unexpected = [];
const requests = [];
const fullAnswer = "合成问答：E27 的附件与事件流来自当前白板选区。" +
  "这是完整正文的验证段落，详情面板应该一直保留原来的回答，而不是被组织摘要截断。".repeat(75) + "完整回答末尾验收标记。";
const artifacts = await mkdtemp(join(tmpdir(), "whiteboard-mindmap-browser-"));
let heldPlan;
let releasePlan;
let server;
let browser;
let origin;
let page;

function pass(message) { console.log(`PASS ${message}`); }
function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function relay(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/api/status") {
    json(res, { busy: false, available: true, backends: [
      { id: "codex", available: true, installed: true, models: ["mindmap-fixture"] },
    ] });
    return;
  }
  if (url.pathname === "/api/local-projects") { json(res, { projects: [] }); return; }
  if (url.pathname === "/api/workbench-activity") { json(res, { activity: null }); return; }
  if (url.pathname === "/api/board-store") {
    const payload = await body(req);
    const current = boards.get(payload.id);
    if (payload.action === "list") {
      json(res, { boards: [...boards.values()].filter(board => !board.deleted).map(({ storage, ...metadata }) => metadata),
        deleted: [...boards.values()].filter(board => board.deleted).map(({ id, revision }) => ({ id, revision })) });
    } else if (payload.action === "load") {
      json(res, { board: current?.deleted ? null : current || null, deleted: Boolean(current?.deleted), revision: current?.revision || 0 });
    } else if (payload.expectedRevision !== (current?.revision || 0) || current?.deleted) {
      json(res, { text: "测试白板版本冲突。", board: current || null, deleted: Boolean(current?.deleted), revision: current?.revision || 0 }, 409);
    } else if (payload.action === "save") {
      const board = { ...payload.metadata, id: payload.id, revision: payload.expectedRevision + 1,
        updatedAt: new Date().toISOString(), storage: payload.storage };
      boards.set(payload.id, board);
      json(res, { board });
    } else json(res, { text: "本测试不执行删除或历史恢复。" }, 418);
    return;
  }
  if (url.pathname === "/api/codex") {
    const payload = await body(req);
    requests.push(payload);
    let event;
    if (payload.scope === "plan") {
      if (heldPlan) await heldPlan;
      event = { type: "answer", text: '{"action":"ask"}' };
    }
    else if (payload.scope === "explain") event = { type: "explanation", explanation: {
      summary: "合成解释：附件与连接状态沿 E27 对应的数据通路处理。",
      sections: [
        { title: "输入与边界", text: "当前节点是 E27，引用与正文应保持其身份。", parentIndex: null },
        { title: "验证连接", text: "先核对当前连接，再提交本次选区。", parentIndex: 0 },
      ],
    } };
    else event = { type: "answer", text: fullAnswer };
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    res.end([event, { type: "done" }].map(value => JSON.stringify(value)).join("\n") + "\n");
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    unexpected.push(`${req.method} ${url.pathname}`);
    json(res, { text: "本测试禁止其他工具或真实模型调用。" }, 418);
    return;
  }
  const target = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
  if (req.method !== "GET" || (target !== root && !target.startsWith(root + sep)) || !existsSync(target)) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(target));
}
async function ready(id = "E27") {
  await page.waitForFunction(cardId => Boolean(window.BoardMemory && window.BoardOrganization &&
    document.querySelector(`#board [data-element-id="${cardId}"]`)), id);
  await page.waitForFunction(() => !document.querySelector("#presentation-mindmap")?.disabled);
}
async function state() {
  return page.evaluate(() => ({
    organization: window.BoardOrganization.load(),
    memory: window.BoardMemory.load(),
  }));
}
async function cards() {
  return page.locator('#board [data-element-id]:not([hidden]), #threads [data-element-id]:not([hidden])').evaluateAll(elements =>
    elements.filter(element => !element.closest("[hidden]") && element.getClientRects().length).map(element => ({
      id: element.dataset.elementId,
      x: parseFloat(element.style.left), y: parseFloat(element.style.top),
      width: element.offsetWidth, height: element.offsetHeight,
    })));
}
function noOverlap(rectangles) {
  for (const [index, a] of rectangles.entries()) {
    assert.ok([a.x, a.y, a.width, a.height].every(Number.isFinite), `${a.id} has invalid coordinates`);
    for (const b of rectangles.slice(index + 1)) {
      assert.ok(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 ||
        a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1, `${a.id} overlaps ${b.id}`);
    }
  }
}
async function sourceUnchanged(before) {
  const after = await state();
  assert.deepEqual(after.organization.current.items, before.organization.current.items, "Presentation changed source card content or ownership");
  assert.deepEqual(after.organization.current.positions, before.organization.current.positions, "Presentation overwrote manual source positions");
  assert.deepEqual(after.organization.rawPositions, before.organization.rawPositions, "Presentation overwrote raw source positions");
  assert.deepEqual(after.memory.project, before.memory.project, "Presentation changed project memory");
  assert.deepEqual(after.memory.pinnedIds, before.memory.pinnedIds, "Presentation changed pins");
  assert.deepEqual(after.memory.notes, before.memory.notes, "Presentation changed source discussions");
}
async function selectCard(id) {
  // Enter is an existing accessible native card-selection path used by the
  // whiteboard's other acceptance tests, including at low overview zoom.
  await page.locator(`#board [data-element-id="${id}"]`).press("Enter");
  await page.waitForFunction(cardId => document.querySelector(`[data-element-id="${cardId}"]`)?.getAttribute("aria-pressed") === "true", id);
}
async function flush() { await page.evaluate(() => window.BoardSync?.flush()); }
async function clearSelection() {
  await page.locator("#select-mode").click();
  const point = await page.locator("#viewport").evaluate(viewport => {
    const box = viewport.getBoundingClientRect();
    for (let y = box.top + 7; y < box.bottom - 7; y += 28) {
      for (let x = box.left + 7; x < box.right - 7; x += 28) {
        const element = document.elementFromPoint(x, y);
        if (viewport.contains(element) && !element.closest("[data-element-id], #ask-popover, #expand-card, button, summary")) return { x, y };
      }
    }
    return null;
  });
  assert.ok(point, "A blank canvas point is required to clear selection");
  await page.mouse.click(point.x, point.y);
}
function descendantIds(items, rootId) {
  const ids = new Set([rootId]);
  for (const id of ids) for (const child of items.filter(item => item.parentId === id)) ids.add(child.id);
  return ids;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.02, `${message}: ${actual} != ${expected}`);
}
async function rootOutlineOverview() {
  const manualPage = page;
  const id = `board-${"c".repeat(32)}`;
  const box = { x: 0, y: 0, width: 240, height: 90 };
  const note = (identity, parent, title, outline) => ({
    id: identity, kind: "branch", rect: box, sourceCardIds: [], anchors: [box], answer: `${title}的完整说明`,
    payload: { boardId: id, mode: "ask", scope: "explain", question: title,
      anchor: { elementIds: [parent || "board"], box, quote: title } },
    ...(outline ? { outline: true, outlineCollapsed: true } : {}),
    ...(parent ? { sectionOf: parent } : {}),
  });
  const notes = [note("A01", null, "回答根总览", true), note("A02", "A01", "直接章节", true),
    note("A03", "A02", "更深细节", false)];
  const seed = {
    "whiteboard.codex.boards.v1": JSON.stringify([{ id, title: "回答根主干验收" }]),
    [`whiteboard.codex.${id}.v1`]: JSON.stringify({ project: { goal: "验证回答根主干" }, notes, pinnedIds: [], deletedIds: [] }),
    [`whiteboard.codex.${id}.organization.v1`]: JSON.stringify({ current: { title: "回答根主干验收",
      layout: { flow: "vertical", density: "compact" }, positions: {}, collapsedBranches: ["A01", "A02"],
      items: notes.map((entry, index) => ({ id: entry.id, parentId: index ? notes[index - 1].id : null,
        title: entry.payload.question, summary: entry.answer, category: index ? "reference" : "main",
        nativeFace: true, explicitParent: true })) }, rawPositions: {} }),
  };
  const isolated = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  isolated.setDefaultTimeout(12000);
  await isolated.addInitScript(entries => {
    if (sessionStorage.getItem("mindmap-outline-seed")) return;
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    sessionStorage.setItem("mindmap-outline-seed", "yes");
  }, seed);
  await isolated.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    unexpected.push(`outline external ${url.origin}`);
    return route.abort();
  });
  try {
    page = await isolated.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
    await page.goto(`${origin}/?board=${id}&view=canvas`, { waitUntil: "networkidle" });
    await ready("A01");
    await page.locator("#presentation-mindmap").click();
    await page.locator("#mindmap-overview").click();
    const visible = (await cards()).map(rect => rect.id);
    assert.deepEqual(new Set(visible), new Set(["A01", "A02"]), "Main-only must keep outline root open and its direct chapter visible");
    const root = (await state()).memory.notes.find(entry => entry.id === "A01");
    const chapter = (await state()).memory.notes.find(entry => entry.id === "A02");
    assert.equal(root.outlineCollapsed, false, "A root outline must not fold itself in main-only mode");
    assert.equal(chapter.outlineCollapsed, true, "The nested chapter should fold its detail");
    await selectCard("A01");
    assert.equal(await page.locator("#mindmap-split").isDisabled(), await page.locator("#expand-card-open").isDisabled(),
      "Inspector must reflect the original native expansion capability for an existing outline");
    await flush();
    await page.reload({ waitUntil: "networkidle" });
    await ready("A01");
    assert.deepEqual(new Set((await cards()).map(rect => rect.id)), new Set(["A01", "A02"]));
    pass("Main-only keeps an answer-outline root and its chapter visible through reload; inspector respects native split restrictions");
  } finally {
    await isolated.close();
    page = manualPage;
  }
}

try {
  server = createServer((req, res) => { void relay(req, res).catch(error => json(res, { text: error.message }, 500)); });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1900, height: 1200 }, serviceWorkers: "block" });
  context.setDefaultTimeout(12000);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "blob:" || url.origin === origin) return route.continue();
    unexpected.push(`external ${url.origin}`);
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  await page.goto(`${origin}/?board=repo-manual&view=canvas`, { waitUntil: "networkidle" });
  await ready();
  await flush();
  const baseline = await state();
  const allItems = baseline.organization.current.items;
  assert.ok(allItems.find(item => item.id === "E27"), "Real code manual must contain E27");
  await page.locator("#presentation-mindmap").click();
  await page.waitForFunction(() => document.querySelector("#presentation-mindmap").getAttribute("aria-pressed") === "true");
  await sourceUnchanged(baseline);
  const overview = await cards();
  noOverlap(overview);
  const rootId = baseline.organization.current.projectGuide?.rootId || allItems.find(item => !item.parentId).id;
  const rootRect = overview.find(item => item.id === rootId);
  assert.ok(rootRect, "Mindmap must show the actual project root");
  const children = new Set(allItems.filter(item => item.parentId === rootId).map(item => item.id));
  const chapters = overview.filter(item => children.has(item.id));
  assert.ok(chapters.some(item => item.x + item.width <= rootRect.x), "Mindmap must use left-hand space");
  assert.ok(chapters.some(item => item.x >= rootRect.x + rootRect.width), "Mindmap must use right-hand space");
  await page.screenshot({ path: join(artifacts, "mindmap-overview.png"), fullPage: true });
  pass("Same code-manual nodes form a collision-free two-sided overview without changing stored content or source positions");

  await page.locator("#mindmap-expand-all").click();
  const expanded = await cards();
  assert.ok(expanded.length > overview.length, "Expand-all should reveal deeper cards");
  noOverlap(expanded);
  const edges = await page.locator("#connections > .mindmap-connection").evaluateAll(paths => paths.map(path => ({
    parentId: path.dataset.parentId, childId: path.dataset.childId, d: path.getAttribute("d"),
    color: path.style.getPropertyValue("--map-color"),
    hitParent: path.nextElementSibling?.dataset.edgeParent, hitChild: path.nextElementSibling?.dataset.edgeChild,
  })));
  assert.ok(edges.length > 4, "The actual existing tree must keep its relation paths");
  const itemById = new Map(allItems.map(item => [item.id, item]));
  for (const edge of edges) {
    assert.equal(itemById.get(edge.childId)?.parentId, edge.parentId, "Curved path should preserve the original parent relation");
    assert.match(edge.d, /C/, "Reading paths should be smooth cubic curves");
    assert.ok(edge.color, "Reading paths should retain the actual branch color");
    assert.equal(edge.hitParent, edge.parentId, "Native edge-selection hit target should retain the real parent");
    assert.equal(edge.hitChild, edge.childId, "Native edge-selection hit target should retain the real child");
  }
  await selectCard("E27");
  const inspector = page.locator("#mindmap-inspector");
  await inspector.waitFor({ state: "visible" });
  const target = allItems.find(item => item.id === "E27");
  assert.ok((await inspector.innerText()).includes(target.title), "Inspector should show the selected card title");
  assert.ok((await inspector.innerText()).includes(target.summary), "Inspector should show the complete existing summary");
  assert.equal(await page.locator("#split-module").isDisabled(), false, "Native splitting remains enabled for E27");
  assert.equal(await page.locator("#split-module-tree").isDisabled(), false, "Native multilevel splitting remains enabled for E27");
  await page.locator("#fit").click();
  await page.screenshot({ path: join(artifacts, "mindmap-e27-detail.png"), fullPage: true });
  pass("Expanded E27 opens its complete existing detail and retains native split actions");

  await selectCard(rootId);
  const toggle = page.locator(`#board [data-element-id="${rootId}"] .branch-toggle`);
  await toggle.click();
  const collapsed = await cards();
  assert.ok(collapsed.length < expanded.length, "Collapsing a branch should hide its descendants");
  await toggle.click();
  assert.equal((await cards()).length, expanded.length, "Opening a branch should restore its visible descendants");
  await page.locator("#mindmap-overview").click();
  assert.ok((await cards()).length < expanded.length, "Overview should reduce visible detail");
  await page.locator("#mindmap-expand-all").click();
  noOverlap(await cards());
  await flush();
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  assert.equal(await page.locator("#presentation-mindmap").getAttribute("aria-pressed"), "true", "Presentation preference should survive reload");
  await page.locator("#presentation-cards").click();
  await sourceUnchanged(baseline);
  pass("Branch folding, main-only/full expansion, reload and switching back preserve source content and positions");

  await page.locator("#presentation-mindmap").click();
  await page.locator("#mindmap-expand-all").click();
  await selectCard("E27");
  await page.locator("#fit").click();
  const beforeDrag = new Map((await cards()).map(rect => [rect.id, rect]));
  await page.locator("#pan-mode").click();
  const targetBox = await page.locator('#board [data-element-id="E27"] .organized-title').boundingBox();
  const dragX = targetBox.x + targetBox.width / 2;
  const dragY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 70, dragY + 45, { steps: 8 });
  await page.mouse.up();
  const afterDrag = new Map((await cards()).map(rect => [rect.id, rect]));
  assert.notDeepEqual(afterDrag.get("E27"), beforeDrag.get("E27"), "Native dragging should move the reading node");
  await sourceUnchanged(baseline);
  const readingPositions = await page.evaluate(() => window.BoardMindmap.positions);
  assert.ok(readingPositions.E27, "Dragged position should be stored as a reading-only preference");
  await flush();
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  const restoredDrag = new Map((await cards()).map(rect => [rect.id, rect]));
  assert.deepEqual(restoredDrag.get("E27"), afterDrag.get("E27"), "Reading-node drag must survive refresh");
  await sourceUnchanged(baseline);
  await selectCard("E27");
  const beforeLocal = new Map((await cards()).map(rect => [rect.id, rect]));
  await page.locator("#quick-reorder").click();
  const afterLocal = new Map((await cards()).map(rect => [rect.id, rect]));
  const localScope = descendantIds(allItems, "E27");
  for (const [id, rect] of beforeLocal) {
    if (id === "E27" || !localScope.has(id)) assert.deepEqual(afterLocal.get(id), rect, `Local reading reorder moved fixed card ${id}`);
  }
  await sourceUnchanged(baseline);
  await page.locator("#undo-organization").click();
  assert.deepEqual(new Map((await cards()).map(rect => [rect.id, rect])), beforeLocal, "Undo should restore the exact local reading arrangement");
  await selectCard("E27");
  await page.locator("#quick-reorder").click();
  const explicitBefore = await page.evaluate(() => window.BoardMindmap.positions);
  const explicitChildren = [...localScope].filter(id => id !== "E27" && explicitBefore[id]);
  assert.ok(explicitChildren.length > 0, "Local reorder must create explicit descendant reading positions");
  await page.locator('#board [data-element-id="E27"] .branch-toggle').click();
  for (const id of explicitChildren) assert.equal((await cards()).some(rect => rect.id === id), false);
  await page.locator("#fit").click();
  await page.locator("#pan-mode").click();
  const foldedBox = await page.locator('#board [data-element-id="E27"] .organized-title').boundingBox();
  const foldedX = foldedBox.x + foldedBox.width / 2;
  const foldedY = foldedBox.y + foldedBox.height / 2;
  await page.mouse.move(foldedX, foldedY);
  await page.mouse.down();
  await page.mouse.move(foldedX + 55, foldedY - 35, { steps: 8 });
  await page.mouse.up();
  const explicitAfter = await page.evaluate(() => window.BoardMindmap.positions);
  const delta = { x: explicitAfter.E27.x - explicitBefore.E27.x, y: explicitAfter.E27.y - explicitBefore.E27.y };
  assert.ok(Math.hypot(delta.x, delta.y) > 20, "The collapsed parent should actually move");
  for (const id of explicitChildren) {
    near(explicitAfter[id].x, explicitBefore[id].x + delta.x, `${id} hidden x must move with E27`);
    near(explicitAfter[id].y, explicitBefore[id].y + delta.y, `${id} hidden y must move with E27`);
  }
  await sourceUnchanged(baseline);
  await flush();
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  assert.deepEqual(await page.evaluate(() => window.BoardMindmap.positions), explicitAfter, "Hidden descendant reading positions must survive refresh");
  await selectCard("E27");
  await page.locator('#board [data-element-id="E27"] .branch-toggle').click();
  const reopened = new Map((await cards()).map(rect => [rect.id, rect]));
  for (const id of explicitChildren) {
    assert.ok(reopened.has(id), `Reopening the moved parent should restore ${id}`);
    near(reopened.get(id).x, explicitAfter[id].x, `${id} should open at its translated x`);
    near(reopened.get(id).y, explicitAfter[id].y, `${id} should open at its translated y`);
    near(reopened.get(id).x - reopened.get("E27").x, explicitBefore[id].x - explicitBefore.E27.x,
      `${id} should keep its previous relative horizontal distance to E27`);
    near(reopened.get(id).y - reopened.get("E27").y, explicitBefore[id].y - explicitBefore.E27.y,
      `${id} should keep its previous relative vertical distance to E27`);
  }
  await sourceUnchanged(baseline);
  pass("After local reflow, dragging a folded parent translates every explicitly positioned hidden descendant by the same delta; reopening after refresh preserves their relative paths");
  await clearSelection();
  await page.locator("#quick-reorder").click();
  noOverlap(await cards());
  await sourceUnchanged(baseline);
  pass("Native reading-node drag survives refresh; local reorder and undo keep the root and every outside branch fixed, independently of card coordinates");

  await selectCard("E27");
  await page.locator("#mindmap-ask").click();
  await page.locator("#question").fill("请解释当前 E27 附件与事件流的实现边界。");
  heldPlan = new Promise(resolvePlan => { releasePlan = resolvePlan; });
  await page.locator("#submit-question").click();
  await page.waitForFunction(() => document.querySelector("#submit-question").disabled);
  await page.locator("#presentation-cards").evaluate(button => button.click());
  assert.equal(await page.locator("#presentation-mindmap").getAttribute("aria-pressed"), "true", "Planning should keep the in-flight selection presentation stable");
  releasePlan();
  heldPlan = null;
  await page.locator('#threads [data-anchor="E27"] .thread-answer').filter({ hasText: "合成问答" }).waitFor({ state: "attached" });
  await page.locator("#stop-ai").waitFor({ state: "hidden" });
  const asking = requests.filter(request => request.scope !== "plan");
  assert.equal(asking.length, 1);
  assert.deepEqual(asking[0].anchor.elementIds, ["E27"], "Native model request should target E27, not an invented reading-map copy");
  assert.equal(asking[0].boardId, "repo-manual");
  const delivered = await state();
  const note = delivered.memory.notes.find(item => item.payload?.question === "请解释当前 E27 附件与事件流的实现边界。");
  assert.ok(note, "Native response should be saved in this board");
  assert.deepEqual(note.payload.anchor.elementIds, ["E27"]);
  await page.locator("#mindmap-ask").click();
  await page.locator("#question").waitFor({ state: "visible" });
  await page.locator("#ask-close").click();
  await selectCard(note.id);
  assert.ok((await page.locator("#mindmap-inspector").innerText()).includes(fullAnswer),
    "The complete long native answer, including its final marker, should be readable without summary truncation");
  pass("A real native question handler sends the actual selected E27 identity and saves the mocked response under E27");
  await selectCard("E27");
  await page.locator("#mindmap-split").click();
  await page.locator("#expand-card-split").click();
  await page.waitForFunction(() => (window.BoardMemory.load().notes || []).some(note =>
    note.answer === "合成解释：附件与连接状态沿 E27 对应的数据通路处理。"));
  await page.locator("#stop-ai").waitFor({ state: "hidden" });
  const split = requests.find(request => request.scope === "explain");
  assert.deepEqual(split?.anchor.elementIds, ["E27"], "Native splitting should retain the selected E27 parent");
  const splitNotes = (await state()).memory.notes;
  const bridge = splitNotes.find(note => note.answer === "合成解释：附件与连接状态沿 E27 对应的数据通路处理。");
  assert.deepEqual(bridge.payload.anchor.elementIds, ["E27"]);
  const firstSection = splitNotes.find(note => note.sectionOf === bridge.id);
  assert.ok(firstSection, "A split explanation should have a real first child");
  const nestedSection = splitNotes.find(note => note.sectionOf === firstSection.id);
  assert.ok(nestedSection, "A split explanation should retain its second-level ownership");
  noOverlap(await cards());
  pass("Inspector split uses the native explanation request and saves both descendant levels under the original E27");
  await page.locator("#mindmap-overview").click();
  await page.locator("#fit").click();
  await rootOutlineOverview();
  assert.deepEqual(errors, [], "Unexpected JavaScript errors");
  assert.deepEqual(unexpected, [], "Unexpected external or provider calls");
  await page.screenshot({ path: join(artifacts, "mindmap-code-manual.png"), fullPage: true });
  console.log(`ARTIFACTS ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, "mindmap-failure.png"), fullPage: true }).catch(() => {});
  console.error(`ARTIFACTS ${artifacts}`);
  throw error;
} finally {
  releasePlan?.();
  await browser?.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
}
