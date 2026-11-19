/* Whiteboard transfer acceptance in an ephemeral browser and mock HTTP service.
 * Run: node test_board_transfer_browser.mjs
 * No real provider, user browser profile, project files or database is accessed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const sourceId = `board-${"a".repeat(32)}`;
const sourceTitle = "导入导出浏览器验收";
const secret = "TRANSFER-TEST-ONLY-NOT-A-REAL-KEY";
const hiddenPath = "C:\\fixture-private-repository";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const stores = new Map();
const pageErrors = [];
const unexpectedRequests = [];
let nextSession = 0;
let browser;
let server;
let origin;

function pass(message) { console.log(`PASS ${message}`); }
function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function relay(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/api/status") {
    json(res, { busy: false, backends: [{ id: "codex", available: true, installed: true, models: ["transfer-fixture"] }] });
    return;
  }
  if (url.pathname === "/api/local-projects") { json(res, { projects: [] }); return; }
  if (url.pathname === "/api/workbench-activity") { json(res, { activity: null }); return; }
  if (url.pathname === "/api/repository") {
    const payload = await requestBody(req);
    json(res, { repositoryPath: payload.repositoryPath });
    return;
  }
  // Optional shared-board bootstrap is isolated too. The transfer tests do not
  // require board_sync.js or a live SQLite service to exist.
  if (url.pathname === "/api/board-store") {
    const key = req.headers.cookie?.match(/(?:^|;\s*)transfer-session=([^;]+)/)?.[1] || "default";
    if (!stores.has(key)) stores.set(key, new Map());
    const records = stores.get(key);
    const payload = await requestBody(req);
    const current = records.get(payload.id);
    if (payload.action === "list") {
      json(res, { boards: [...records.values()].filter(board => !board.deleted).map(({ storage, ...metadata }) => metadata),
        deleted: [...records.values()].filter(board => board.deleted).map(({ id, revision }) => ({ id, revision })) });
    } else if (payload.action === "load") {
      json(res, { board: current?.deleted ? null : current || null, deleted: Boolean(current?.deleted), revision: current?.revision || 0 });
    } else if (payload.expectedRevision !== (current?.revision || 0) || current?.deleted) {
      json(res, { text: "测试白板版本冲突。", board: current || null, deleted: Boolean(current?.deleted), revision: current?.revision || 0 }, 409);
    } else if (payload.action === "save") {
      const board = { ...payload.metadata, id: payload.id, revision: payload.expectedRevision + 1,
        updatedAt: new Date().toISOString(), storage: payload.storage };
      records.set(payload.id, board);
      json(res, { board });
    } else if (payload.action === "delete") {
      const board = { id: payload.id, revision: payload.expectedRevision + 1, deleted: true };
      records.set(payload.id, board);
      json(res, board);
    } else json(res, { text: "无效的测试操作。" }, 400);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    unexpectedRequests.push(`${req.method} ${url.pathname}`);
    json(res, { text: "本测试禁止模型或其他工具调用。" }, 418);
    return;
  }
  const target = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
  if (req.method !== "GET" || (target !== root && !target.startsWith(root + sep)) || !existsSync(target)) {
    res.writeHead(404); res.end("not found"); return;
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(content);
  } catch { res.writeHead(404); res.end("not found"); }
}

const rect = (x, y, width = 300, height = 160) => ({ x, y, width, height });
function fixture() {
  const note = (id, parent, question, answer, x, y) => ({ id, kind: "note", branchId: null, archived: false,
    rect: rect(x, y), sourceCardIds: ["E04"], anchors: [rect(80, 100)],
    payload: { boardId: sourceId, question, mode: "ask", scope: "explain", anchor: {
      elementIds: [parent], wholeCardIds: [parent], box: rect(80, 100), quote: `引用 ${parent}`,
      ...(parent === "A01" ? { noteContexts: [{ elementId: "A01", originalQuestion: "怎样理解父模块？", sourceCardIds: ["E04"] }] } : {}),
    } }, answer });
  const memory = { project: { goal: "交付可以继续编辑的独立白板副本。", constraints: ["保留父子关系", "原白板不受影响"],
    decisions: [{ text: "导入时使用全新的白板编号。", sourceIds: ["E04", "A01"] }] },
    notes: [note("A01", "E04", "怎样理解父模块？", "第一层解释保留在原父卡下。", 700, 100),
      note("A02", "A01", "继续解释验收条件", "第二层追问仍属于第一层解释。", 1080, 100)],
    pinnedIds: ["E04", "A01"], deletedIds: [], pendingRepair: "" };
  const items = [
    { id: "E04", parentId: null, category: "main", title: "需求总览", summary: "从需求到实现再到验收。", folded: false },
    { id: "E05", parentId: "E04", category: "reference", title: "输入与校验", summary: "只处理本次指定的文档。", folded: true,
      repositoryFiles: ["src/import.js"], spec: { kind: "requirement", id: "REQ-TRANSFER-01" } },
    { id: "E06", parentId: "E05", category: "reference", title: "验收细节", summary: "错误输入不得覆盖旧白板。", folded: false,
      taskDetails: { task: "覆盖正常和错误的文件输入。", dependencies: ["完成格式解析"], acceptance: ["原始白板不变", "新副本可以刷新"] } },
    { id: "A01", parentId: "E04", category: "reference", title: memory.notes[0].payload.question,
      summary: memory.notes[0].answer, nativeFace: true, explicitParent: true },
    { id: "A02", parentId: "A01", category: "reference", title: memory.notes[1].payload.question,
      summary: memory.notes[1].answer, nativeFace: true, explicitParent: true },
  ];
  const organization = { current: { title: sourceTitle, summary: "已知的两层层级与手工关系。", items,
    layout: { flow: "horizontal", density: "compact" }, collapsedBranches: ["E05"],
    positions: { E04: { x: 80, y: 100, width: 320 }, E05: { x: 450, y: 100, width: 300 },
      E06: { x: 820, y: 320, width: 300 }, A01: { x: 700, y: 100, width: 300 }, A02: { x: 1080, y: 100, width: 300 } } },
    previous: null, undoAvailable: false, opinion: "保持局部说明在对应父节点下。", rawPositions: {},
    rawLinks: { E06: ["E05", "E04"] }, rawCompact: false, quickMode: "horizontal", branchQuickModes: { E05: "compact" },
    quickUndo: null };
  return { memory, organization };
}
function storageKeys(id) {
  const prefix = id === "original" ? "whiteboard.codex" : `whiteboard.codex.${id}`;
  return { memory: `${prefix}.v1`, organization: `${prefix}.organization.v1` };
}
async function openContext(seed) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: "block", acceptDownloads: true });
  context.setDefaultTimeout(12000);
  await context.addCookies([{ name: "transfer-session", value: String(++nextSession), url: origin }]);
  if (seed) await context.addInitScript(entries => {
    if (sessionStorage.getItem("transfer-seeded")) return;
    Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value));
    sessionStorage.setItem("transfer-seeded", "yes");
  }, seed);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "blob:" || url.origin === origin) return route.continue();
    unexpectedRequests.push(`external ${url.origin}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  return { context, page };
}
async function ready(page) {
  await page.waitForFunction(() => Boolean(window.BoardMemory && window.BoardOrganization && window.BoardTransfer));
  await page.waitForFunction(() => !document.querySelector("#board-manage").disabled);
}
async function action(page, id) {
  await page.locator("#board-manage").click();
  await page.locator(id).click();
}
async function downloadDocument(page) {
  const downloadPromise = page.waitForEvent("download");
  await action(page, "#board-export");
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.whiteboard\.json$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function parsed(page, contents) { return page.evaluate(text => window.BoardTransfer.parse(text), contents); }
async function selectFile(page, contents, name = "fixture.whiteboard.json") {
  await page.locator("#board-import-file").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(contents) });
}
async function finishImport(page, name) {
  await page.locator("#board-import-name").fill(name);
  const oldId = await page.evaluate(() => window.BoardMemory.activeBoard);
  await Promise.all([
    page.waitForURL(url => /^board-[0-9a-f]{32}$/.test(url.searchParams.get("board") || "") && url.searchParams.get("board") !== oldId),
    page.locator("#board-import-submit").click(),
  ]);
  await ready(page);
  const id = await page.evaluate(() => window.BoardMemory.activeBoard);
  assert.notEqual(id, oldId);
  assert.equal(await page.evaluate(() => window.BoardMemory.activeBoardInfo.title), name);
  return id;
}
async function readBoard(page, id) {
  return page.evaluate(keys => ({ memory: JSON.parse(localStorage.getItem(keys.memory)),
    organization: JSON.parse(localStorage.getItem(keys.organization)) }), storageKeys(id));
}
async function readCatalog(page) {
  return page.evaluate(() => localStorage.getItem(window.BoardMemory.catalogKey));
}
function assertFixturePreserved(state, id) {
  assert.equal(state.memory.project.goal, fixture().memory.project.goal);
  assert.deepEqual(state.memory.project.constraints, fixture().memory.project.constraints);
  assert.deepEqual(state.memory.project.decisions, fixture().memory.project.decisions);
  assert.deepEqual(state.memory.pinnedIds, ["E04", "A01"]);
  assert.equal(state.memory.notes.length, 2);
  for (const note of state.memory.notes) assert.equal(note.payload.boardId, id, "Imported question payload belongs to new board");
  assert.deepEqual(state.memory.notes.find(note => note.id === "A02").payload.anchor.elementIds, ["A01"]);
  assert.equal(state.memory.notes.find(note => note.id === "A02").answer, fixture().memory.notes[1].answer);
  const items = new Map(state.organization.current.items.map(item => [item.id, item]));
  assert.equal(items.size, 5);
  assert.equal(items.get("E05").parentId, "E04");
  assert.equal(items.get("E06").parentId, "E05");
  assert.equal(items.get("A01").parentId, "E04");
  assert.equal(items.get("A02").parentId, "A01");
  assert.deepEqual(items.get("E06").taskDetails, fixture().organization.current.items[2].taskDetails);
  assert.deepEqual(items.get("E05").repositoryFiles, ["src/import.js"]);
  assert.ok(state.organization.current.collapsedBranches.includes("E05"));
  assert.equal(items.get("E05").folded, true);
  assert.deepEqual(state.organization.rawLinks.E06, ["E05", "E04"]);
  assert.equal(state.organization.quickMode, "horizontal");
  assert.equal(state.organization.branchQuickModes.E05, "compact");
  assert.ok(Object.values(state.organization.current.positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
}

try {
  server = createServer((req, res) => { void relay(req, res).catch(error => json(res, { text: error.message }, 500)); });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  // Built-in content lives in HTML until materialized; importing its export
  // as a custom board must preserve it, rather than yielding an empty board.
  const builtIn = await openContext({ "whiteboard.codex.connection.v1": JSON.stringify({ backend: "codex", models: {}, apiKey: secret }) });
  try {
    const { page } = builtIn;
    await page.goto(`${origin}/?board=original`, { waitUntil: "networkidle" });
    await ready(page);
    const nativeIds = await page.locator("#board [data-element-id]").evaluateAll(elements => elements.map(element => element.dataset.elementId));
    assert.ok(nativeIds.length >= 3);
    const nativeTitles = await page.locator("#board [data-element-id] .element-title").allTextContents();
    const contents = await downloadDocument(page);
    assert.ok(!contents.includes(secret));
    const document = await parsed(page, contents);
    const materialized = document.organization.current?.items || document.organization.rawCards;
    assert.ok(materialized.length >= nativeIds.length);
    for (const id of nativeIds) assert.ok(materialized.some(item => item.id === id));
    await action(page, "#board-import");
    await selectFile(page, contents);
    await page.waitForFunction(() => !document.querySelector("#board-import-submit").disabled);
    await finishImport(page, "内置白板的独立副本");
    for (const title of nativeTitles) assert.ok((await page.locator("#board").textContent()).includes(title.trim()));
    await page.reload({ waitUntil: "networkidle" });
    await ready(page);
    assert.ok(await page.locator("#board [data-element-id]").count() >= nativeIds.length);
    pass("Built-in cards are materialized through export, import and reload; connection credentials are excluded");
  } finally { await builtIn.context.close(); }

  const { memory, organization } = fixture();
  const keys = storageKeys(sourceId);
  const session = await openContext({
    "whiteboard.codex.boards.v1": JSON.stringify([{ id: sourceId, title: sourceTitle, repositoryPath: hiddenPath }]),
    [keys.memory]: JSON.stringify(memory), [keys.organization]: JSON.stringify(organization),
    "whiteboard.codex.connection.v1": JSON.stringify({ backend: "codex", models: { codex: "transfer-fixture" }, apiKey: secret }),
  });
  try {
    const { page } = session;
    await page.goto(`${origin}/?board=${sourceId}`, { waitUntil: "networkidle" });
    await ready(page);
    const source = await readBoard(page, sourceId);
    const contents = await downloadDocument(page);
    assert.ok(!contents.includes(secret));
    assert.ok(!contents.includes(hiddenPath), "Machine-local project binding is not transferred");
    const exported = await parsed(page, contents);
    assert.equal(exported.title, sourceTitle);
    assert.equal(exported.organization.current.items.length, 5);

    await action(page, "#board-import");
    await selectFile(page, contents);
    await page.waitForFunction(() => !document.querySelector("#board-import-submit").disabled);
    assert.equal(await page.locator("#board-import-repository-path").inputValue(), "");
    if (process.env.TRANSFER_SCREENSHOT) {
      const screenshot = resolve(process.env.TRANSFER_SCREENSHOT);
      await page.screenshot({ path: screenshot });
      console.log(`SCREENSHOT ${screenshot}`);
    }
    const importedId = await finishImport(page, "可编辑导入副本");
    assert.notEqual(importedId, sourceId);
    assertFixturePreserved(await readBoard(page, importedId), importedId);
    assert.deepEqual(await readBoard(page, sourceId), source, "Import leaves original board snapshot untouched");
    const importedPositions = (await readBoard(page, importedId)).organization.current.positions;
    for (const [id, point] of Object.entries(exported.organization.current.positions)) {
      assert.equal(importedPositions[id].x, point.x, `${id} keeps exported horizontal position`);
      assert.equal(importedPositions[id].y, point.y, `${id} keeps exported vertical position`);
    }
    await page.reload({ waitUntil: "networkidle" });
    await ready(page);
    const restored = await readBoard(page, importedId);
    assertFixturePreserved(restored, importedId);
    assert.deepEqual(restored.organization.current.positions, importedPositions);
    assert.equal(await page.locator('#board [data-element-id="E06"]').isVisible(), false);
    assert.equal(await page.locator('#board [data-element-id="E05"] .branch-toggle').getAttribute("aria-expanded"), "false");
    pass("Import creates a new board and preserves two-level discussions, tasks, manual links, pins, folding and saved positions after reload");

    await action(page, "#board-fork");
    await page.locator("#board-import-dialog").waitFor();
    assert.match(await page.locator("#board-import-name").inputValue(), /副本$/);
    assert.equal(await page.locator("#board-import-file").isVisible(), false);
    const copiedId = await finishImport(page, "本地分叉验证");
    assert.notEqual(copiedId, importedId);
    assertFixturePreserved(await readBoard(page, copiedId), copiedId);
    assert.deepEqual(await readBoard(page, sourceId), source);
    pass("Copy/fork uses the same validated document flow with a separate board identity");

    const quota = await page.evaluate(async text => {
      const beforeCatalog = localStorage.getItem(window.BoardMemory.catalogKey);
      const beforeKeys = Object.keys(localStorage).sort();
      const original = Storage.prototype.setItem;
      let rejected = false;
      Storage.prototype.setItem = function(key, value) {
        if (/^whiteboard\.codex\.board-[0-9a-f]{32}\.organization\.v1$/.test(key) && !beforeKeys.includes(key)) {
          throw new DOMException("Synthetic transfer quota failure", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
      try { await window.BoardMemory.importBoard(window.BoardTransfer.parse(text), "不得产生半张白板", ""); }
      catch { rejected = true; }
      finally { Storage.prototype.setItem = original; }
      return { rejected, catalogUnchanged: localStorage.getItem(window.BoardMemory.catalogKey) === beforeCatalog,
        keysUnchanged: JSON.stringify(Object.keys(localStorage).sort()) === JSON.stringify(beforeKeys) };
    }, contents);
    assert.deepEqual(quota, { rejected: true, catalogUnchanged: true, keysUnchanged: true });
    pass("Storage failure rolls back a partially written import before publishing its catalog entry");

    const beforeErrors = await readCatalog(page);
    const beforeId = await page.evaluate(() => window.BoardMemory.activeBoard);
    for (const [name, text] of [["bad.json", "{bad"], ["future.json", JSON.stringify({ format: "circle-ask-whiteboard", version: 999 })],
      ["large.json", " ".repeat(24 * 1024 * 1024 + 1)]]) {
      await action(page, "#board-import");
      await selectFile(page, text, name);
      await page.locator("#board-import-error").waitFor({ state: "visible" });
      assert.ok((await page.locator("#board-import-error").textContent()).trim());
      assert.equal(await page.locator("#board-import-submit").isDisabled(), true);
      assert.equal(await readCatalog(page), beforeErrors);
      assert.equal(await page.evaluate(() => window.BoardMemory.activeBoard), beforeId);
      await page.locator("#board-import-cancel").click();
    }
    pass("Malformed, future-version and oversized files show errors without changing active board or catalog");

    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator("#home-import-board").click();
    await page.locator("#board-import-dialog").waitFor();
    await selectFile(page, contents);
    await page.waitForFunction(() => !document.querySelector("#board-import-submit").disabled);
    const homeId = await finishImport(page, "首页导入的副本");
    assertFixturePreserved(await readBoard(page, homeId), homeId);
    pass("Homepage import opens the imported board without requiring an existing active canvas");
  } finally { await session.context.close(); }

  assert.deepEqual(pageErrors, [], "No browser JavaScript errors");
  assert.deepEqual(unexpectedRequests, [], "No model, provider or external service calls");
  pass("All transfer paths finish without browser exceptions or provider requests");
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
}
