/* Real whiteboard UI with an ephemeral browser and an isolated fake relay.
 * node test_multicard_context_browser.mjs
 * MULTICARD_BASELINE=1 restores only the old scope predicate and must fail.
 * No provider calls, real browser profiles, project files or databases are used.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const boardId = `board-${"d".repeat(32)}`;
const prefix = `whiteboard.codex.${boardId}`;
const baseline = process.env.MULTICARD_BASELINE === "1";
const tailA = "EXPLICIT_DRAFT_A_AFTER_600";
const tailB = "EXPLICIT_DRAFT_B_AFTER_600";
const privateMarker = "UNSELECTED_PRIVATE_DRAFT_MUST_STAY_PRIVATE";
const privateChild = "PRIVATE_DRAFT_CHILD_CONTEXT";
const bodyA = "甲".repeat(650) + tailA;
const bodyB = "乙".repeat(650) + tailB;
const requests = [];
const heldQuestions = new Map();
const heldPlans = new Map();
const slowPlan = "意图并发验收-第一条 ZCode";
const slowUpload = "意图并发验收-含附件";
const nextPlan = "意图并发验收-第二条 ZCode";
const uploaded = { id: "e".repeat(32), name: "concurrent.txt", size: 10 };
let completeUpload;
const cancellations = [];
const browserErrors = [];
const unexpectedRequests = [];
const records = new Map();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
let browser;
let context;
let server;
let origin;
let baselineReplacements = 0;

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function pass(message) { console.log(`PASS ${message}`); }
async function relay(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/api/status") {
    json(res, { busy: false, maxConcurrentRequests: 4, maxExpansionSummaryLength: 240,
      backends: ["codex", "zcode"].map(id => ({ id, available: true, installed: true, models: ["context-fixture"] })) });
    return;
  }
  if (url.pathname === "/api/local-projects") { json(res, { projects: [] }); return; }
  if (url.pathname === "/api/workbench-activity") { json(res, { activity: null }); return; }
  if (url.pathname === "/api/board-store") {
    const payload = await body(req);
    const current = records.get(payload.id);
    if (payload.action === "list") {
      json(res, { boards: [...records.values()].filter(value => !value.deleted).map(({ storage, ...value }) => value),
        deleted: [...records.values()].filter(value => value.deleted).map(({ id, revision }) => ({ id, revision })) });
    } else if (payload.action === "load") {
      json(res, { board: current?.deleted ? null : current || null, deleted: Boolean(current?.deleted), revision: current?.revision || 0 });
    } else if (payload.expectedRevision !== (current?.revision || 0) || current?.deleted) {
      json(res, { text: "Synthetic revision conflict", board: current || null, revision: current?.revision || 0 }, 409);
    } else if (payload.action === "save") {
      const board = { ...payload.metadata, id: payload.id, revision: payload.expectedRevision + 1,
        updatedAt: new Date().toISOString(), storage: payload.storage };
      records.set(board.id, board);
      json(res, { board });
    } else json(res, { text: "Unsupported test store action" }, 400);
    return;
  }
  if (url.pathname === "/api/cancel" && req.method === "POST") {
    const { requestId } = await body(req);
    cancellations.push(requestId);
    json(res, { requestId, cancelled: true }, 202);
    return;
  }
  if (url.pathname === "/api/attachments" && req.method === "POST") {
    for await (const _ of req) { /* Drain the isolated upload fixture. */ }
    assert.equal(req.headers["x-attachment-name"], uploaded.name);
    completeUpload = () => json(res, uploaded);
    return;
  }
  if (url.pathname === "/api/codex" && req.method === "POST") {
    const payload = await body(req);
    requests.push(payload);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const stream = event => res.write(JSON.stringify({ ...event, requestId: payload.requestId, baseRevision: payload.baseRevision }) + "\n");
    const label = [slowPlan, nextPlan].find(question => payload.question.endsWith(JSON.stringify(question)));
    if (payload.scope === "plan" && label) {
      stream({ type: "status", text: "正在等待意图验收放行" });
      stream({ type: "output", text: `还未结束的模型输出 · ${label} <fixture-tag>` });
      stream({ type: "log", channel: "stderr", text: label === slowPlan ? "HTTP 429" : "HTTP 502" });
      heldPlans.set(label, { payload, stream, complete() {
        stream({ type: "answer", text: '{"action":"ask"}' });
        stream({ type: "done", changedFiles: [] });
        res.end();
      } });
    } else if (payload.question.startsWith("并发验收-")) {
      stream({ type: "status", text: "正在等待验收放行" });
      heldQuestions.set(payload.question, { payload, complete() {
        stream({ type: "answer", text: `答复 ${payload.question}` });
        stream({ type: "done", changedFiles: [] });
        res.end();
      } });
    } else {
      if (payload.scope === "expandCard") {
        stream({ type: "children", children: [
          { title: "短摘要卡片", summary: "行为与限制" },
          { title: "完整摘要卡片", summary: "详".repeat(134) + "。" },
        ] });
      } else {
        stream({ type: "answer", text: payload.scope === "plan" ? '{"action":"ask"}' : `MOCK_ANSWER_${requests.length}` });
      }
      stream({ type: "done", changedFiles: [] });
      res.end();
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    unexpectedRequests.push(`${req.method} ${url.pathname}`);
    json(res, { text: "External tools are forbidden in this test" }, 418);
    return;
  }
  const target = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
  if (req.method !== "GET" || (target !== root && !target.startsWith(root + sep)) || !existsSync(target)) {
    res.writeHead(404); res.end("not found"); return;
  }
  let content = await readFile(target);
  if (baseline && url.pathname === "/app.js") {
    const script = content.toString("utf8");
    const oldPredicate = /const inScope = \(id\) => explicitIds\.has\(id\) \|\| !drafts\.has\(id\) \|\| drafts\.get\(id\) === draftRoot;/;
    assert.match(script, oldPredicate, "Baseline must replace precisely the fixed explicit-selection predicate");
    content = Buffer.from(script.replace(oldPredicate,
      "const inScope = (id) => !drafts.has(id) || drafts.get(id) === draftRoot;"));
    baselineReplacements += 1;
  }
  res.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(content);
}

function seed() {
  return {
    "whiteboard.codex.boards.v1": JSON.stringify([{ id: boardId, title: "手工多卡联合研究验收" }]),
    [`${prefix}.v1`]: JSON.stringify({
      project: { goal: "允许人手写需求并明确选择上下文。", constraints: ["未选中的独立草稿保持隔离"], decisions: [] },
      notes: [], pinnedIds: ["E80"], deletedIds: [], pendingRepair: "",
    }),
    [`${prefix}.organization.v1`]: JSON.stringify({ current: {
      title: "手工多卡联合研究验收", summary: "正式模块和独立草稿并存。", layout: { flow: "horizontal", density: "compact" },
      items: [
        { id: "E04", parentId: null, category: "main", title: "现有实现模块", summary: "FORMAL_MODULE_CONTEXT", folded: false },
        { id: "E80", parentId: null, category: "reference", title: "未选择的私密草稿", summary: privateMarker,
          draft: true, folded: false, spec: { kind: "constraint", id: "RULE-E80" } },
        { id: "E81", parentId: "E80", category: "reference", title: "该草稿自己的下级", summary: privateChild, folded: false },
      ],
      positions: { E04: { x: 50, y: 80, width: 300 }, E80: { x: 420, y: 80, width: 300 }, E81: { x: 790, y: 80, width: 300 } },
      collapsedBranches: [],
    }, previous: null, undoAvailable: false, rawPositions: {}, opinion: "", rawCompact: false }),
    "whiteboard.codex.connection.v1": JSON.stringify({ backend: "codex", models: { codex: "context-fixture", zcode: "", api: "" } }),
  };
}
async function ready(page) {
  await page.waitForFunction(() => Boolean(window.BoardMemory && window.BoardOrganization));
  await page.waitForFunction(() => !document.querySelector("#board-manage").disabled &&
    document.querySelector("#connection-label").textContent.includes("Codex"));
}
async function readItems(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)).current.items, `${prefix}.organization.v1`);
}
async function createManualCard(page, title, summary) {
  const before = requests.length;
  await page.locator("#new-card").click();
  await page.locator("#workbench-card-title").fill(title);
  await page.locator("#workbench-card-body").fill(summary);
  await page.locator("#save-workbench-card").click();
  await page.waitForFunction(({ key, title }) => JSON.parse(localStorage.getItem(key))?.current.items.some(item => item.title === title),
    { key: `${prefix}.organization.v1`, title });
  const item = (await readItems(page)).find(entry => entry.title === title);
  assert.equal(item.summary, summary);
  assert.equal(item.parentId, null);
  assert.equal(item.draft, true);
  assert.equal(requests.length, before, "Manual creation does not ask a model");
  return item.id;
}
async function selectCards(page, ids) {
  await page.locator("#select-mode").click();
  for (const [index, id] of ids.entries()) {
    const card = page.locator(`#board [data-element-id="${id}"]`);
    await card.focus();
    await page.keyboard.press(index ? "Shift+Enter" : "Enter");
  }
  const selected = await page.locator('#board [data-element-id][aria-pressed="true"]').evaluateAll(elements => elements.map(element => element.dataset.elementId));
  assert.deepEqual(selected.sort(), [...ids].sort(), "Native Enter/Shift+Enter selects the intended whole cards");
}
async function ask(page, ids, question) {
  await selectCards(page, ids);
  await page.locator("#ask-open").click();
  await page.locator("#question").fill(question);
  const start = requests.length;
  await page.locator("#submit-question").click();
  await page.waitForFunction(() => document.querySelector("#board-manage").disabled === false &&
    [...document.querySelectorAll(".thread-answer")].some(element => element.textContent.startsWith("MOCK_ANSWER_")));
  const deadline = Date.now() + 12000;
  while (requests.length < start + 2 && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 30));
  assert.equal(requests.length, start + 2, "One classification request and one final question request are sent");
  await page.waitForFunction(() => document.querySelector("#board-manage").disabled === false);
  const turns = requests.slice(start);
  assert.equal(turns[0].scope, "plan");
  assert.equal(turns[1].scope, undefined);
  assert.equal(turns[1].question, question);
  for (const turn of turns) assert.deepEqual(turn.anchor.elementIds, ids);
  return turns;
}
function assertSelection(turns, ids, markers, forbidden = [privateMarker, privateChild]) {
  for (const turn of turns) {
    assert.deepEqual(turn.project.selectedCards?.map(card => card.id).sort(), [...ids].sort(),
      `Every explicitly selected card must reach the ${turn.scope === "plan" ? "classification" : "final question"} context`);
    for (const [id, marker] of markers) {
      const selected = turn.project.selectedCards.find(card => card.id === id);
      assert.ok(selected.summary.includes(marker), `Full card context must retain ${marker} beyond the shared 600-character quote`);
    }
    const contextText = JSON.stringify(turn.project);
    for (const marker of forbidden) assert.ok(!contextText.includes(marker), `Unselected draft must stay out of the request: ${marker}`);
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
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: "block" });
  context.setDefaultTimeout(12000);
  await context.addInitScript(entries => {
    if (sessionStorage.getItem("multicard-seeded")) return;
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    sessionStorage.setItem("multicard-seeded", "yes");
  }, seed());
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "blob:") return route.continue();
    unexpectedRequests.push(`external ${url.origin}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  await page.goto(`${origin}/?board=${boardId}`, { waitUntil: "networkidle" });
  await ready(page);
  const idA = await createManualCard(page, "手写需求 A", bodyA);
  const idB = await createManualCard(page, "手写约束 B", bodyB);
  pass("Two independent draft cards are created by the real UI without model calls");

  const combined = await ask(page, [idA, idB], "请联合分析我手写的需求和约束，给出实现方案。");
  assertSelection(combined, [idA, idB], [[idA, tailA], [idB, tailB]]);
  for (const turn of combined) {
    assert.ok(!turn.anchor.quote.includes(tailA) && !turn.anchor.quote.includes(tailB));
    assert.equal(turn.project.draftBranch, undefined, "Distinct drafts are not falsely relabeled as one branch");
  }
  pass("Both independent drafts retain their full summaries in classification and final requests; a third private draft is excluded");

  const mixed = await ask(page, ["E04", idA], "结合现有实现与我写的新需求比较该怎么修改。");
  assertSelection(mixed, ["E04", idA], [["E04", "FORMAL_MODULE_CONTEXT"], [idA, tailA]], [tailB, privateMarker, privateChild]);
  pass("Formal-plus-draft selection includes both explicit cards without importing unselected drafts");

  const formal = await ask(page, ["E04"], "仅解释当前正式实现，不处理独立草稿。");
  assertSelection(formal, ["E04"], [["E04", "FORMAL_MODULE_CONTEXT"]], [tailA, tailB, privateMarker, privateChild]);
  pass("A normal formal-card question still excludes all unselected drafts and private pinned constraints");

  const singleDraft = await ask(page, ["E80"], "现在只研究我明确选中的独立分支。");
  assertSelection(singleDraft, ["E80"], [["E80", privateMarker]], [tailA, tailB]);
  for (const turn of singleDraft) {
    assert.equal(turn.project.draftBranch?.rootId, "E80");
    // The final request can also include its newly saved pending answer card.
    assert.deepEqual(turn.project.draftBranch.nodes.map(node => node.id).filter(id => id.startsWith("E")).sort(), ["E80", "E81"]);
    assert.ok(JSON.stringify(turn.project.draftBranch).includes(privateChild));
  }
  pass("A single selected draft still supplies its own branch and descendants");

  async function startQuestion(card, text) {
    await selectCards(page, [card]);
    await page.locator("#ask-open").click();
    await page.locator("#question").fill(text);
    await page.locator("#submit-question").click();
    const task = page.locator("#running-questions li[data-question-run]").filter({ hasText: text });
    await task.waitFor({ state: "visible" });
    return task.getAttribute("data-question-run");
  }
  async function switchBackend(id) {
    const settings = page.locator(".connection-settings");
    if (!(await settings.getAttribute("open"))) await settings.locator("summary").click();
    await page.locator("#backend-select").selectOption(id);
    await settings.locator("summary").click();
  }
  const labelA = "并发验收-第一条 Codex";
  const labelB = "并发验收-第二条 ZCode";
  const labelC = "并发验收-第三条 Codex";
  const noteA = await startQuestion("E04", labelA);
  await switchBackend("zcode");
  const noteB = await startQuestion(idB, labelB);
  await switchBackend("codex");
  const noteC = await startQuestion(idA, labelC);
  await page.waitForFunction(() => document.querySelectorAll("#running-questions li").length === 3);
  const runA = heldQuestions.get(labelA);
  const runB = heldQuestions.get(labelB);
  const runC = heldQuestions.get(labelC);
  assert.deepEqual([runA, runB, runC].map(run => run.payload.backend), ["codex", "zcode", "codex"]);
  assert.equal(new Set([runA, runB, runC].map(run => run.payload.requestId)).size, 3);
  const note = id => page.locator(`[data-element-id="${id}"]`);
  await selectCards(page, ["E04"]);
  await page.locator("#ask-open").click();
  await page.locator("#question").fill("正在写的新问题");
  await page.getByRole("button", { name: `停止问答 ${noteB}` }).click();
  await page.waitForFunction(id => document.querySelector(`[data-element-id="${id}"]`).getAttribute("aria-busy") === "false", noteB);
  assert.deepEqual(cancellations, [runB.payload.requestId]);
  assert.match(await note(noteB).locator(".thread-status").textContent(), /停止/);
  runB.complete();
  runC.complete();
  await note(noteC).locator(".thread-answer").getByText(`答复 ${labelC}`).waitFor();
  assert.equal(await note(noteA).getAttribute("aria-busy"), "true");
  runA.complete();
  await note(noteA).locator(".thread-answer").getByText(`答复 ${labelA}`).waitFor();
  await page.locator("#running-questions").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#question").inputValue(), "正在写的新问题");
  await page.evaluate(() => window.BoardSync.flush());
  await page.reload({ waitUntil: "networkidle" });
  await ready(page);
  for (const [id, anchor, question] of [[noteA, "E04", labelA], [noteC, idA, labelC]]) {
    assert.equal(await note(id).getAttribute("data-anchor"), anchor);
    assert.equal(await note(id).locator(".thread-answer").textContent(), `答复 ${question}`);
  }
  assert.equal(await note(noteB).locator(".thread-answer").textContent(), "");
  assert.match(await note(noteB).locator(".thread-status").textContent(), /停止/);
  pass("Three overlapping CLI questions finish independently, cancellation targets one, and responses retain their anchors on reload");

  await switchBackend("zcode");
  const task = text => page.locator("#running-questions li").filter({ hasText: text });
  async function sendOn(card, text, file) {
    await selectCards(page, [card]);
    await page.locator("#ask-open").click();
    await page.locator("#question").fill(text);
    if (file) await page.locator("#attachment-input").setInputFiles(file);
    await page.locator("#submit-question").click();
  }
  async function waitForRelay(predicate) {
    const deadline = Date.now() + 12000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 25));
    assert.ok(predicate(), "The expected request must reach the isolated relay");
  }
  await sendOn("E04", slowPlan);
  await waitForRelay(() => heldPlans.has(slowPlan));
  await task(slowPlan).getByText(/判断意图/).waitFor();
  await sendOn(idA, slowUpload, { name: uploaded.name, mimeType: "text/plain", buffer: Buffer.from("attachment") });
  await waitForRelay(() => completeUpload);
  await task(slowUpload).getByText(/上传附件/).waitFor();
  await sendOn(idB, nextPlan);
  await waitForRelay(() => heldPlans.has(nextPlan));
  assert.deepEqual(heldPlans.get(slowPlan).payload.anchor.elementIds, ["E04"]);
  assert.deepEqual(heldPlans.get(nextPlan).payload.anchor.elementIds, [idB]);
  assert.equal(heldPlans.get(nextPlan).payload.attachments, undefined);
  const executionPicker = page.locator("#execution-request");
  const cliPreview = page.locator("#execution-output-text");
  const cliLog = page.locator("#execution-log");
  await cliPreview.getByText(new RegExp(nextPlan)).waitFor();
  assert.equal(await cliPreview.locator("fixture-tag").count(), 0, "The stream is displayed as text");
  assert.match(await cliLog.innerText(), /\[stderr\] HTTP 502/);
  await executionPicker.selectOption(heldPlans.get(slowPlan).payload.requestId);
  assert.match(await cliPreview.innerText(), new RegExp(slowPlan));
  assert.match(await cliLog.innerText(), /\[stderr\] HTTP 429/);
  heldPlans.get(nextPlan).stream({ type: "output", text: "并行请求的新流式文字" });
  assert.doesNotMatch(await cliPreview.innerText(), /并行请求/);
  await executionPicker.selectOption(heldPlans.get(nextPlan).payload.requestId);
  await cliPreview.getByText("并行请求的新流式文字").waitFor();
  completeUpload();
  await waitForRelay(() => requests.some(({ question }) => question === slowUpload));
  const withFile = requests.find(({ question }) => question === slowUpload);
  assert.equal(withFile.backend, "zcode");
  assert.deepEqual(withFile.anchor.elementIds, [idA]);
  assert.deepEqual(withFile.attachments, [uploaded]);
  assert.equal(await executionPicker.inputValue(), heldPlans.get(nextPlan).payload.requestId);
  assert.equal(await cliPreview.innerText(), "并行请求的新流式文字", "A new request must not replace a manually selected log");

  await selectCards(page, ["E04"]);
  await page.locator("#ask-open").click();
  await page.locator("#question").fill("手头正在写的 ZCode 问题");
  await task(slowPlan).getByRole("button", { name: /停止问答/ }).click();
  await task(slowPlan).getByRole("button", { name: "恢复草稿" }).waitFor();
  heldPlans.get(slowPlan).complete();
  heldPlans.get(nextPlan).complete();
  await waitForRelay(() => requests.some(({ question }) => question === nextPlan));
  await page.locator("#running-questions li[data-question-run]").waitFor({ state: "hidden" });
  assert.equal(cancellations.at(-1), heldPlans.get(slowPlan).payload.requestId);
  assert.equal(requests.some(({ question }) => question === slowPlan), false);
  const answered = requests.find(({ question }) => question === nextPlan);
  assert.equal(answered.backend, "zcode");
  assert.deepEqual(answered.anchor.elementIds, [idB]);
  assert.equal(await page.locator("#question").inputValue(), "手头正在写的 ZCode 问题");
  await page.locator("#question").fill("");
  await task(slowPlan).getByRole("button", { name: "恢复草稿" }).click();
  assert.equal(await page.locator("#question").inputValue(), slowPlan);
  await page.locator("#ask-close").click();
  await executionPicker.selectOption(heldPlans.get(slowPlan).payload.requestId);
  assert.match(await page.locator("#execution-trace-status").innerText(), /已停止/);
  assert.match(await cliPreview.innerText(), new RegExp(slowPlan));
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(Object.entries(localStorage))), /HTTP 429|并行请求的新流式文字/);
  pass("ZCode planners stream independently, retain their output on cancellation, and never store the execution log on the board");
  await executionPicker.selectOption("");

  await selectCards(page, ["E04"]);
  await page.locator("#expand-card-open").click();
  await page.locator("#expand-card-submit").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".organized-title")].some(element => element.textContent === "完整摘要卡片"));
  const expansion = (await readItems(page)).find(item => item.title === "完整摘要卡片");
  assert.equal(expansion.summary, "详".repeat(134) + "。");
  assert.equal(expansion.parentId, "E04");
  pass("A 135-character ZCode expansion summary is saved intact under its source card");
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(unexpectedRequests, []);
  if (baseline) assert.ok(baselineReplacements > 0);
  pass("No browser exceptions, real provider requests, or external file changes");
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
}
