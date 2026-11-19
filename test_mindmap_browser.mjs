/* Mindmap presentation acceptance in an ephemeral browser and mock HTTP service.
 * Run: node test_mindmap_browser.mjs
 * Uses the actual code manual and native question/split handlers. No real model,
 * user browser profile, source repository or production database is accessed.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const boards = new Map();
const boardCases = new Map([["main", boards]]);
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
    const caseId = req.headers.cookie?.match(/(?:^|;\s*)mindmap-case=([^;]+)/)?.[1] || "main";
    if (!boardCases.has(caseId)) boardCases.set(caseId, new Map());
    const records = boardCases.get(caseId);
    const payload = await body(req);
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
    else if (payload.scope === "expandCard") event = { type: "children", children: [
      { title: "阅读选区的输入边界", summary: "保留用户输入的延伸方向，新增卡片归属 E27。" },
      { title: "阅读选区的验收反馈", summary: "选中原文、完整上下文和新下级应能对应起来。" },
    ] };
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

async function dragSelectDetail(quote, detail = page.locator("#mindmap-inspector .mindmap-detail-body")) {
  await detail.evaluate(element => {
    element.scrollIntoView({ block: "start", inline: "nearest" });
    const scroller = element.closest(".context-body");
    const actions = document.querySelector("#mindmap-inspector .mindmap-detail-actions");
    if (scroller && actions) scroller.scrollTop -= actions.getBoundingClientRect().height + 24;
  });
  const endpoints = await detail.evaluate((element, text) => {
    const start = element.textContent.indexOf(text);
    if (start < 0) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let first;
    let last;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!first && start < offset + node.length) first = { node, offset: start - offset };
      const end = start + text.length - 1;
      if (end >= offset && end < offset + node.length) last = { node, offset: end - offset };
      offset += node.length;
    }
    if (!first || !last) return null;
    const glyph = ({ node, offset: index }) => {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    };
    return { first: glyph(first), last: glyph(last) };
  }, quote);
  assert.ok(endpoints, "The selected sentence must exist in the actual rendered detail");
  // DOM ranges only measure glyphs. Native mouse events perform the selection.
  await page.mouse.move(endpoints.first.left + 0.5, endpoints.first.y);
  await page.mouse.down();
  await page.mouse.move(endpoints.last.right - 0.5, endpoints.last.y, { steps: 12 });
  await page.mouse.up();
  try { await page.waitForFunction(text => window.getSelection()?.toString() === text, quote); }
  catch (error) {
    error.message += `\nExpected native selection ${JSON.stringify(quote)}, got ${JSON.stringify(await page.evaluate(() => window.getSelection()?.toString()))}.`;
    throw error;
  }
  await page.locator("#mindmap-ask-selection").waitFor({ state: "visible" });
  assert.equal(await page.locator("#mindmap-ask-selection").isEnabled(), true);
  assert.equal(await page.locator(".mindmap-selection-quote").textContent(), quote);
}

async function sendDetailQuestion(text) {
  const before = requests.length;
  await page.locator("#question").fill(text);
  await page.locator("#submit-question").click();
  await page.waitForFunction(({ question, answer }) => window.BoardMemory.load().notes.some(note =>
    note.payload?.question === question && note.answer === answer), { question: text, answer: fullAnswer });
  await page.locator("#stop-ai").waitFor({ state: "hidden" });
  const sent = requests.slice(before);
  const request = sent.find(entry => entry.scope !== "plan");
  assert.ok(request, "The native handler must execute the question after planning");
  const note = (await state()).memory.notes.find(entry => entry.payload?.question === text);
  return { sent, request, note };
}

async function inspectorTextQuestions(allItems) {
  await page.locator("#mindmap-expand-all").click();
  await selectCard("E27");
  const owner = allItems.find(item => item.id === "E27");
  const quote = owner.summary.slice(0, owner.summary.indexOf("。") + 1);
  assert.ok(quote.length > 10 && quote.length < owner.summary.length);
  await page.locator("#mindmap-ask").click();
  const draft = "这是尚未发送的提问草稿，重新选择原文时应继续保留。";
  await page.locator("#question").fill(draft);
  await page.locator("#ask-close").click();
  await dragSelectDetail(quote);
  await dragSelectDetail(quote);
  await page.locator("#mindmap-ask-selection").click();
  assert.equal(await page.locator("#question").inputValue(), draft,
    "Reselecting text while its quote panel is visible must preserve the existing question draft");
  const first = await sendDetailQuestion("只解释导图详情中选中的这句话，并结合其所在模块。");
  assert.equal(first.sent.length, 2, "A detail question should use native planning and execution");
  const byId = new Map(allItems.map(item => [item.id, item]));
  const path = [];
  for (let item = owner; item; item = byId.get(item.parentId)) path.unshift(item.id);
  for (const request of first.sent) {
    assert.equal(request.boardId, "repo-manual");
    assert.deepEqual(request.anchor.elementIds, ["E27"]);
    assert.equal(request.anchor.quote, quote, "The submitted quote must exactly match the native text selection");
    assert.equal(request.anchor.wholeCardIds, undefined, "A partial quote must retain partial-selection semantics");
    const context = request.project.selectedCards.find(item => item.id === "E27");
    assert.equal(context.summary, owner.summary, "Both plan and answer need the complete owner, not only the selected sentence");
    assert.deepEqual(context.path.map(item => item.id), path);
    assert.equal(context.parent.id, owner.parentId);
    assert.deepEqual(new Set(context.sources), new Set(owner.sources));
    assert.ok(request.anchor.sourceFiles.includes("attachments.py"));
  }
  assert.deepEqual(first.note.payload.anchor.elementIds, ["E27"]);
  assert.equal(first.note.payload.anchor.quote, quote);
  assert.ok(first.note.sourceCardIds.includes("E27"));
  assert.equal(await page.locator(`#threads [data-element-id="${first.note.id}"]`).getAttribute("data-anchor"), "E27");
  pass("Dragging a sentence in the reading detail sends the exact quote plus its full owner, ancestors and files, and saves the answer under that owner");

  await selectCard(first.note.id);
  const answerQuote = fullAnswer.slice(0, fullAnswer.indexOf("。") + 1);
  await dragSelectDetail(answerQuote);
  await page.locator("#mindmap-ask-selection").click();
  const follow = await sendDetailQuestion("继续解释这条导图回答里选中的一句话。");
  assert.deepEqual(follow.request.anchor.elementIds, [first.note.id]);
  assert.equal(follow.request.anchor.quote, answerQuote);
  assert.equal(follow.request.anchor.wholeCardIds, undefined);
  assert.ok(follow.request.anchor.noteContexts.some(context => context.elementId === first.note.id &&
    context.originalQuestion === first.note.payload.question && context.sourceCardIds.includes("E27")));
  assert.ok(follow.request.branch.recent.some(entry => entry.question === first.note.payload.question));
  assert.deepEqual(follow.note.payload.anchor.elementIds, [first.note.id]);
  pass("A sentence in a generated answer remains selectable and its follow-up preserves the answer identity, original question and E27 discussion history");

  await selectCard("E27");
  await dragSelectDetail(quote);
  await selectCard("E07");
  const staleAction = page.locator("#mindmap-ask-selection");
  assert.ok(await staleAction.isHidden() || await staleAction.isDisabled(), "Changing nodes must invalidate the previous quote action");
  const preview = page.locator(".mindmap-selection-quote");
  assert.ok(await preview.isHidden() || !(await preview.textContent()).includes(quote), "Changing nodes must clear the previous quote preview");
  await selectCard("E27");
  await dragSelectDetail(quote);
  await page.locator("#mindmap-ask").click();
  const whole = await sendDetailQuestion("请解释 E27 整张模块卡的完整职责。");
  assert.deepEqual(whole.request.anchor.elementIds, ["E27"]);
  assert.deepEqual(whole.request.anchor.wholeCardIds, ["E27"], "The whole-card action must explicitly replace any active partial quote");
  assert.ok(whole.request.anchor.quote.includes(owner.summary));
  assert.notEqual(whole.request.anchor.quote, quote);
  pass("Changing the selected node clears its old quote, and the whole-card question action restores full-card semantics even after text selection");

  await selectCard("E27");
  const beforeExtend = requests.length;
  await page.locator("#mindmap-extend").click();
  await page.locator("#expand-card-form").waitFor({ state: "visible" });
  assert.equal(requests.length, beforeExtend, "Opening the extension input must not start a model request");
  const direction = "沿选区和事件流的验收方向继续往下延伸。";
  await page.locator("#expand-card-focus").fill(direction);
  await page.locator("#expand-card-submit").click();
  await page.waitForFunction(() => window.BoardOrganization.load().current.items.some(item => item.title === "阅读选区的输入边界"));
  await page.locator("#stop-ai").waitFor({ state: "hidden" });
  const expansion = requests.slice(beforeExtend).find(request => request.scope === "expandCard");
  assert.ok(expansion, "The reading extension action should reuse native child expansion");
  assert.deepEqual(expansion.anchor.elementIds, ["E27"]);
  assert.equal(expansion.question, direction);
  const additions = (await state()).organization.current.items.filter(item =>
    ["阅读选区的输入边界", "阅读选区的验收反馈"].includes(item.title));
  assert.equal(additions.length, 2);
  assert.ok(additions.every(item => item.parentId === "E27"));
  await flush();
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  const restored = await state();
  assert.ok(restored.memory.notes.some(note => note.id === first.note.id && note.payload.anchor.quote === quote));
  assert.ok(restored.memory.notes.some(note => note.id === follow.note.id && note.payload.anchor.elementIds[0] === first.note.id));
  assert.ok(additions.every(child => restored.organization.current.items.some(item => item.id === child.id && item.parentId === "E27")));
  pass("The downward-extension entry waits for a direction, creates real children through the native handler, and keeps selected-text discussions and child ownership after reload");

  const editedText = "手动修订后的阅读说明采用当前保存的模块内容。历史模型回答保留作追溯依据。";
  await flush();
  // Existing reorganized replies can have current local content alongside the
  // older saved answer. Load that supported document shape through the relay.
  const reorganized = structuredClone(restored.organization);
  const editedItem = reorganized.current.items.find(item => item.id === first.note.id);
  assert.ok(editedItem, "The saved reply must be a real organized item before replacing its current wording");
  Object.assign(editedItem, { title: "手动修订的阅读说明", summary: editedText, localContent: true });
  const remote = boards.get("repo-manual");
  boards.set("repo-manual", { ...remote, revision: remote.revision + 1, updatedAt: new Date().toISOString(),
    storage: { ...remote.storage, organization: JSON.stringify(reorganized) } });
  await page.reload({ waitUntil: "networkidle" });
  await ready();
  await selectCard(first.note.id);
  const edited = await state();
  assert.equal(edited.organization.current.items.find(item => item.id === first.note.id).localContent, true);
  assert.equal(edited.memory.notes.find(note => note.id === first.note.id).answer, fullAnswer);
  const editedQuote = editedText.slice(0, editedText.indexOf("。") + 1);
  await dragSelectDetail(editedQuote);
  await page.locator("#mindmap-ask-selection").click();
  const editedQuestion = await sendDetailQuestion("解释我手动修订后的阅读说明这一句。");
  for (const request of editedQuestion.sent) {
    assert.deepEqual(request.anchor.elementIds, [first.note.id]);
    assert.equal(request.anchor.quote, editedQuote);
    assert.equal(request.project.selectedCards.find(item => item.id === first.note.id).summary, editedText,
      "Manual localContent must take precedence over the older saved model answer in both planning and answering");
  }
  pass("Quoted questions on a manually edited answer send its current localContent while preserving the original saved answer for traceability");
}

async function hiddenChildTextQuestion(allItems) {
  await page.locator("#mindmap-expand-all").click();
  await selectCard("E07");
  await page.locator('#board [data-element-id="E07"] .branch-toggle').click();
  assert.equal((await cards()).some(rect => rect.id === "E27"), false);
  const inspector = page.locator("#mindmap-inspector");
  const chapter = inspector.locator(':scope > .mindmap-child-details > details[data-card-id="E27"]');
  await chapter.waitFor({ state: "visible" });
  if (!await chapter.evaluate(element => element.open)) await chapter.locator(":scope > summary").click();
  const child = chapter.locator(':scope > .mindmap-child-content > .mindmap-nested-details > details[data-card-id="E28"]');
  if (!await child.evaluate(element => element.open)) await child.locator(":scope > summary").click();
  const owner = allItems.find(item => item.id === "E28");
  assert.ok((await child.locator(":scope > .mindmap-child-content").innerText()).includes(owner.summary));
  const beforeReading = await state();
  await page.locator("#mindmap-ask").click();
  const scroll = await page.locator(".context-body").evaluate(element => {
    element.scrollTop = Math.min(140, element.scrollHeight - element.clientHeight);
    window.__mindmapSelectedChild = document.querySelector('#mindmap-inspector details[data-card-id="E28"]');
    return element.scrollTop;
  });
  assert.ok(scroll > 0, "The expanded reader should have a real scroll position to preserve");
  await page.locator("#question").fill("编辑提问草稿时保留当前阅读进度。");
  assert.equal(await page.locator(".context-body").evaluate(element => element.scrollTop), scroll);
  assert.equal(await child.evaluate(element => element === window.__mindmapSelectedChild && element.open), true);
  assert.deepEqual(await state(), beforeReading, "Reading hidden descendants and typing a draft must not change the saved tree or discussions");
  await page.locator("#question").fill("");
  await page.locator("#ask-close").click();
  const quote = owner.summary.slice(0, owner.summary.indexOf("。") + 1);
  await dragSelectDetail(quote, child.locator(":scope > .mindmap-child-content"));
  await page.locator("#mindmap-ask-selection").click();
  await page.waitForFunction(() => document.querySelector('[data-element-id="E28"]')?.getAttribute("aria-pressed") === "true");
  assert.equal((await cards()).some(rect => rect.id === "E28"), true);
  assert.equal(await inspector.locator(":scope > .mindmap-detail-title").innerText(), owner.title);
  const result = await sendDetailQuestion("解释在 E07 阅读器内直接选中的 E28 这句话。");
  assert.deepEqual(result.request.anchor.elementIds, ["E28"], "A hidden child's discussion must attach to the child, never to the reader's old E07 root");
  assert.equal(result.request.anchor.quote, quote);
  assert.equal(result.request.anchor.wholeCardIds, undefined);
  const context = result.request.project.selectedCards.find(item => item.id === "E28");
  assert.equal(context.summary, owner.summary);
  assert.equal(context.parent.id, "E27");
  assert.ok(context.path.some(item => item.id === "E07"));
  assert.deepEqual(result.note.payload.anchor.elementIds, ["E28"]);
  pass("The reader preserves hidden descendants and reading state; directly quoting nested E28 text reveals and targets its true owner without first using View node");
}

async function cameraAt(id) {
  // A transform, fit, or page-scroll change can all move the click target. Read
  // rendered screen coordinates rather than comparing only stored node poses.
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  return page.evaluate(cardId => {
    const node = document.querySelector(`#board [data-element-id="${cardId}"]`);
    const box = node.getBoundingClientRect();
    const button = node.querySelector(".branch-toggle").getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector("#board")).transform);
    const frame = document.querySelector("#viewport").getBoundingClientRect();
    return { node: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      button: { x: button.x + button.width / 2, y: button.y + button.height / 2 },
      scale: matrix.a, offsetX: matrix.e, offsetY: matrix.f,
      scrollX, scrollY, viewport: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      selected: [...document.querySelectorAll('#board [data-element-id][aria-pressed="true"]')].map(element => element.dataset.elementId) };
  }, id);
}

async function branchCameraStability() {
  const previous = page;
  const observations = [];
  const failures = [];
  for (const dimensions of [{ width: 1900, height: 1200 }, { width: 900, height: 950 }]) {
    for (const presentation of ["mindmap", "cards"]) {
      const isolated = await browser.newContext({ viewport: dimensions, serviceWorkers: "block" });
      isolated.setDefaultTimeout(12000);
      await isolated.addCookies([{ name: "mindmap-case", value: `camera-${dimensions.width}-${presentation}`, url: origin }]);
      await isolated.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        unexpected.push(`camera external ${url.origin}`);
        return route.abort();
      });
      try {
        page = await isolated.newPage();
        page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
        await page.goto(`${origin}/?board=repo-manual&view=canvas`, { waitUntil: "networkidle" });
        await ready();
        await page.locator("#presentation-mindmap").click();
        await page.locator("#mindmap-expand-all").click();
        if (presentation === "cards") await page.locator("#presentation-cards").click();
        for (const id of presentation === "mindmap" ? ["E27", "E04", "E07"] : ["E07"]) {
          for (const selected of [false, true]) {
            if (selected) await selectCard(id);
            else await clearSelection();
            await page.locator("#fit").click();
            const toggle = page.locator(`#board [data-element-id="${id}"] .branch-toggle`);
            for (const phase of ["collapse", "expand"]) {
              const before = await cameraAt(id);
              await toggle.click();
              const after = await cameraAt(id);
              const nodeDelta = Math.hypot(after.node.x - before.node.x, after.node.y - before.node.y);
              const buttonDelta = Math.hypot(after.button.x - before.button.x, after.button.y - before.button.y);
              const scaleDelta = Math.abs(after.scale - before.scale);
              const label = `${dimensions.width}px ${presentation} ${id} ${selected ? "selected" : "unselected"} ${phase}`;
              observations.push({ label, nodeDelta: +nodeDelta.toFixed(3), buttonDelta: +buttonDelta.toFixed(3),
                scaleBefore: +before.scale.toFixed(5), scaleAfter: +after.scale.toFixed(5),
                scrollBefore: before.scrollY, scrollAfter: after.scrollY });
              try {
                assert.ok(scaleDelta < 1e-8, `${label}: branch toggle changed zoom (${before.scale} -> ${after.scale})`);
                assert.ok(nodeDelta < 2, `${label}: clicked node moved ${nodeDelta.toFixed(2)} screen pixels`);
                if (presentation === "mindmap") assert.ok(buttonDelta < 2,
                  `${label}: clicked +/- target moved ${buttonDelta.toFixed(2)} screen pixels`);
                assert.equal(after.scrollY, before.scrollY, `${label}: branch toggle scrolled the document`);
                assert.deepEqual(after.selected, before.selected, `${label}: branch toggle replaced current selection`);
              } catch (error) { failures.push(error.message); }
            }
          }
        }
        await flush();
      } finally { await isolated.close(); }
    }
  }
  page = previous;
  await writeFile(join(artifacts, "branch-camera-observations.json"), JSON.stringify({ observations, failures }, null, 2));
  if (process.env.MINDMAP_OBSERVE_JUMPS === "1") {
    console.log(`BRANCH_CAMERA_OBSERVATIONS ${JSON.stringify(observations)}`);
    console.log(`BRANCH_CAMERA_FAILURES ${JSON.stringify(failures)}`);
  } else {
    assert.deepEqual(failures, [], "Branch toggles must preserve camera and clicked screen anchor");
    pass("Desktop and narrow-screen branch toggles keep zoom, clicked node, +/- target and selection stable across 32 clicks");
  }
}

async function readHiddenManualDescendants(items, baseline) {
  await selectCard("E07");
  await page.locator('#board [data-element-id="E07"] .branch-toggle').click();
  assert.equal((await cards()).some(rect => rect.id === "E27"), false, "The child should really be hidden on the canvas");
  const inspector = page.locator("#mindmap-inspector");
  const chapter = inspector.locator(':scope > .mindmap-child-details > details[data-card-id="E27"]');
  await chapter.waitFor({ state: "visible" });
  if (!await chapter.evaluate(element => element.open)) await chapter.locator(":scope > summary").click();
  const expected = items.find(item => item.id === "E27");
  assert.ok((await chapter.locator(":scope > .mindmap-child-content").innerText()).includes(expected.summary),
    "A collapsed canvas child should expose its complete existing content in the inspector");
  const nested = chapter.locator(':scope > .mindmap-child-content > .mindmap-nested-details > details[data-card-id="E28"]');
  if (!await nested.evaluate(element => element.open)) await nested.locator(":scope > summary").click();
  assert.ok((await nested.locator(":scope > .mindmap-child-content").innerText()).includes(items.find(item => item.id === "E28").summary),
    "The inspector should let the reader go two real levels down without unfolding the canvas");
  await nested.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "mindmap-reader-descendants.png"), fullPage: true });
  const beforeReading = await state();
  await page.locator("#mindmap-ask").click();
  const scroll = await page.locator(".context-body").evaluate(element => {
    element.scrollTop = Math.min(140, element.scrollHeight - element.clientHeight);
    window.__mindmapReaderTest = document.querySelector('#mindmap-inspector details[data-card-id="E27"]');
    return element.scrollTop;
  });
  assert.ok(scroll > 0, "The expanded reader should have a real scroll position to preserve");
  await page.locator("#question").fill("仅编辑提问草稿，不应重置右侧阅读位置。");
  assert.equal(await page.locator(".context-body").evaluate(element => element.scrollTop), scroll,
    "Routine question-input rendering should preserve reader scroll position");
  assert.equal(await chapter.evaluate(element => element === window.__mindmapReaderTest), true,
    "Unchanged reader content should retain its actual DOM, not rebuild disclosures");
  assert.equal(await nested.evaluate(element => element.open), true);
  assert.deepEqual((await state()).organization, beforeReading.organization, "Reading children must not modify tree content, ownership or folds");
  assert.deepEqual((await state()).memory, beforeReading.memory, "Reading children must not modify discussion records");
  await page.locator("#question").fill("");
  await page.locator("#ask-close").click();
  await nested.locator('.mindmap-child-navigate[data-navigate-id="E28"]').click();
  await page.waitForFunction(() => document.querySelector('[data-element-id="E28"]')?.getAttribute("aria-pressed") === "true");
  assert.equal((await cards()).some(rect => rect.id === "E28"), true, "View-node should reveal the originally hidden real child");
  assert.equal(await inspector.locator(":scope > .mindmap-detail-title").innerText(), items.find(item => item.id === "E28").title);
  await sourceUnchanged(baseline);
  await page.locator("#mindmap-expand-all").click();
  await selectCard("E27");
  pass("The inspector reads hidden E07 → E27 → E28 descendants, preserves reader scroll/disclosures during typing, and locates the actual hidden child without changing content or ownership");
}

async function readerDataFixture() {
  const previous = page;
  const isolated = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  isolated.setDefaultTimeout(12000);
  const previousAnswer = "历史原始回答，和当前说明明确区分。".repeat(120) + "历史回答末尾。";
  const savedAnswer = "当前已保存的完整回答。".repeat(100) + "当前完整回答末尾。";
  const method = "先校验输入，再按顺序解码事件，并把不完整分片留到下一轮。";
  const condition = "给定多字节 UTF-8 横跨两个分片，解码结果应与完整输入相同。";
  try {
    await isolated.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/reader-fixture.html") return route.fulfill({ contentType: "text/html", body:
        '<!doctype html><html><head><meta charset="utf-8"></head><body><button id="presentation-cards">卡片</button><button id="presentation-mindmap">导图</button>' +
        '<main id="board"><article data-element-id="A10"><div class="organized-face"><div class="organized-body">' +
        '<p>当前整理后的简短说明。</p><p>需求：保持事件顺序。</p></div></div></article>' +
        '<article data-element-id="E58" hidden><div class="organized-face"><div class="organized-body"><p>子卡记录真实跨片解码策略。</p></div></div></article>' +
        '<article data-element-id="E59" hidden><div class="organized-face"><div class="organized-body"><p>孙卡记录半个汉字的分片验收。</p></div></div></article></main>' +
        '<aside class="context-body" style="height:400px;overflow:auto"><section id="mindmap-inspector"></section></aside>' +
        '<script src="/mindmap.js"></script></body></html>' });
      if (url.origin === origin) return route.continue();
      unexpected.push(`reader external ${url.origin}`);
      return route.abort();
    });
    page = await isolated.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/reader-fixture.html`, { waitUntil: "networkidle" });
    await page.evaluate(values => {
      const items = [{ id: "A10", parentId: null, title: "整理后的说明", summary: "当前整理后的简短说明。", nativeFace: false,
        taskDetails: { task: "为短摘要补齐真实任务细节。", dependencies: ["已登记的解码任务依赖。"], acceptance: ["应展示已登记的任务验收条件。"] } },
        { id: "E58", parentId: "A10", title: "跨分片解码", summary: "子卡记录真实跨片解码策略。",
          taskDetails: { task: "把解码器接入顺序事件处理。", dependencies: ["先完成二进制分片读取。"],
            acceptance: ["断开连接后保留已确认的事件。"] } },
        { id: "E59", parentId: "E58", title: "分片验收", summary: "孙卡记录半个汉字的分片验收。" }];
      window.__readerFixture = { busy: false, version: 0, items,
        elements: new Map([...document.querySelectorAll("[data-element-id]")].map(element => [element.dataset.elementId, element])),
        getDetails: id => id === "A10" ? { answer: values.savedAnswer, originalAnswer: values.previousAnswer,
          requirement: { need: "需求：保持事件顺序。", method: "按事件累积结果。", methodDetails: [{ title: "跨片处理", description: values.method }],
            validation: [{ id: "TC-READER-01", title: "跨片汉字", condition: values.condition }] },
          sources: ["server.py"], attachments: [{ id: "reader_fixture_doc", name: "解码验收说明.md" }],
          codePreview: { path: "server.py", text: "decoder.decode(chunk, { stream: true })" } } : {} };
      const fixture = window.__readerFixture;
      window.BoardMindmap.init({ isBusy: () => fixture.busy, canAsk: () => true, canSplit: () => true,
        getDetails: id => fixture.getDetails(id), onNavigate: () => {} });
      window.BoardMindmap.setActive(true);
      window.BoardMindmap.inspect(["A10"], fixture.items, fixture.elements);
    }, { previousAnswer, savedAnswer, method, condition });
    const inspector = page.locator("#mindmap-inspector");
    const text = await inspector.innerText();
    assert.match(text, /当前整理后的简短说明/);
    assert.ok(text.includes("已登记的解码任务依赖。") && text.includes("应展示已登记的任务验收条件。"),
      "An existing short body and summary must not hide real task dependencies and acceptance");
    assert.ok(text.includes(method), "Existing method details supplied by the real callback shape should be visible");
    assert.ok(text.includes(condition), "Existing acceptance conditions should be visible");
    assert.equal(text.split("需求：保持事件顺序。").length - 1, 1, "The original need should not be duplicated from callback data");
    assert.equal(await inspector.locator('a[href="/api/attachments/reader_fixture_doc"]').innerText(), "解码验收说明.md");
    assert.match(text, /decoder\.decode\(chunk/);
    assert.ok(text.includes(savedAnswer), "A short organized summary must not hide the actual long saved answer");
    const historical = inspector.locator(".mindmap-original-answer");
    await historical.locator(":scope > summary").click();
    assert.ok((await historical.innerText()).includes(previousAnswer), "Historical raw answer should be complete and separately labelled");
    const firstChild = inspector.locator('.mindmap-child-details > details[data-card-id="E58"]');
    if (!await firstChild.evaluate(element => element.open)) await firstChild.locator(":scope > summary").click();
    await firstChild.locator(":scope > .mindmap-child-content").waitFor({ state: "visible" });
    const task = await firstChild.locator(":scope > .mindmap-child-content").innerText();
    assert.match(task, /把解码器接入顺序事件处理/);
    assert.match(task, /先完成二进制分片读取/);
    assert.match(task, /断开连接后保留已确认的事件/);
    const grandchild = firstChild.locator('details[data-card-id="E59"]');
    await grandchild.locator(":scope > summary").click();
    await grandchild.locator(":scope > .mindmap-child-content").waitFor({ state: "visible" });
    assert.match(await grandchild.locator(":scope > .mindmap-child-content").innerText(), /孙卡记录半个汉字的分片验收/);
    const preserved = await page.evaluate(() => {
      const fixture = window.__readerFixture;
      const scroll = document.querySelector(".context-body");
      scroll.scrollTop = 160;
      const disclosure = document.querySelector('#mindmap-inspector details[data-card-id="E59"]');
      fixture.busy = true;
      window.BoardMindmap.inspect(["A10"], fixture.items, fixture.elements);
      return { same: disclosure === document.querySelector('#mindmap-inspector details[data-card-id="E59"]'),
        open: disclosure.open, scroll: scroll.scrollTop, askDisabled: document.querySelector("#mindmap-ask").disabled,
        splitDisabled: document.querySelector("#mindmap-split").disabled };
    });
    assert.deepEqual(preserved, { same: true, open: true, scroll: 160, askDisabled: true, splitDisabled: true },
      "Busy updates should only change action availability, preserving actual reader DOM and scroll");
    pass("Reader details preserve current summaries, full saved and historical answers, real methods, acceptance, code and attachments; nested hidden content and reader state survive routine updates");
  } finally {
    await isolated.close();
    page = previous;
  }
}

async function workbenchDisplayEntry() {
  const previous = page;
  for (const viewport of [{ width: 1900, height: 1200 }, { width: 900, height: 950 }]) {
    const isolated = await browser.newContext({ viewport, serviceWorkers: "block" });
    isolated.setDefaultTimeout(12000);
    await isolated.addCookies([{ name: "mindmap-case", value: `workbench-${viewport.width}`, url: origin }]);
    await isolated.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push(`workbench external ${route.request().url()}`);
      return route.abort();
    });
    try {
      page = await isolated.newPage();
      page.on("pageerror", error => errors.push(error.message));
      page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
      await page.goto(`${origin}/?board=project-workbench&view=canvas`, { waitUntil: "networkidle" });
      await ready("E04");
      assert.equal(await page.evaluate(() => window.BoardMemory.activeBoard), "project-workbench");
      const source = await state();
      const display = page.locator(".canvas-display-bar");
      assert.equal(await display.isVisible(), true, "The requested workbench URL must expose display mode directly");
      assert.match(await display.innerText(), /显示方式/);
      const mode = page.locator("#presentation-mindmap");
      const box = await mode.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y < viewport.height,
        `${viewport.width}px display switch must be within the initial visible screen`);
      await mode.click();
      assert.equal(await mode.getAttribute("aria-pressed"), "true");
      await sourceUnchanged(source);
      await selectCard("E07");
      assert.equal(await page.locator("#mindmap-inspector").isVisible(), true);
      const modePaint = await mode.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const panel = document.querySelector(".canvas-panel");
        const frame = document.querySelector("#viewport");
        return { hit: Boolean(hit && (hit === button || button.contains(hit))),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          panelScroll: panel.scrollTop, viewportScroll: frame.scrollTop, documentScroll: scrollY,
          covering: hit?.outerHTML.slice(0, 200) };
      });
      await writeFile(join(artifacts, `project-workbench-display-${viewport.width}.json`), JSON.stringify(modePaint, null, 2));
      assert.equal(modePaint.hit, true, "Display switch must remain visibly clickable after selecting a node");
      assert.ok(await page.locator("#mindmap-inspector .mindmap-child-details .mindmap-child-detail").count() > 0,
        "The selected workbench chapter should expose actual existing child explanations");
      await page.screenshot({ path: join(artifacts, `project-workbench-mindmap-${viewport.width}.png`), fullPage: true });
      await flush();
    } finally { await isolated.close(); }
  }
  page = previous;
  pass("The exact project-workbench canvas URL exposes the labelled display switch and working original-node reader at desktop and narrow widths");
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

async function mindmapCardLifecycle() {
  const previousPage = page;
  const id = `board-${"d".repeat(32)}`;
  const prefix = `whiteboard.codex.${id}`;
  const items = [
    { id: "E04", parentId: null, title: "卡片管理验收", category: "main" },
    { id: "E40", parentId: "E04", title: "父节点", category: "reference" },
    { id: "E41", parentId: "E40", title: "子节点", category: "reference" },
    { id: "E55", parentId: null, title: "保留的独立节点", category: "reference" },
  ].map(item => ({ ...item, summary: `${item.title}的正文` }));
  const positions = { E04: { x: 400, y: 70, width: 400 }, E40: { x: 150, y: 320, width: 360 },
    E41: { x: 180, y: 470, width: 335 }, E55: { x: 620, y: 310, width: 348 } };
  const isolated = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const requestCount = requests.length;
  await isolated.addCookies([{ name: "mindmap-case", value: "card-lifecycle", url: origin }]);
  await isolated.addInitScript(({ id, prefix, items, positions }) => {
    if (sessionStorage.getItem("lifecycle-seeded")) return;
    localStorage.setItem("whiteboard.codex.boards.v1", JSON.stringify([{ id, title: "卡片管理验收" }]));
    localStorage.setItem(`${prefix}.organization.v1`, JSON.stringify({ current: {
      title: "卡片管理验收", items, positions, collapsedBranches: [], layout: { flow: "vertical", density: "compact" },
    } }));
    sessionStorage.setItem("lifecycle-seeded", "yes");
  }, { id, prefix, items, positions });
  try {
    page = await isolated.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?board=${id}&view=canvas`, { waitUntil: "networkidle" });
    await ready("E04");
    await page.locator("#presentation-mindmap").click();
    const card = identity => page.locator(`#board [data-element-id="${identity}"]`);
    const openAndSave = async title => {
      await page.locator("#workbench-card-title").fill(title);
      await page.locator("#workbench-card-body").fill(`${title}的完整正文`);
      await page.locator("#save-workbench-card").click();
      const created = (await state()).organization.current.items.find(item => item.title === title);
      assert.ok(created, "New card should be saved in the real board document");
      assert.equal(created.parentId, null);
      assert.equal(await card(created.id).getAttribute("aria-pressed"), "true");
      assert.ok((await page.locator("#mindmap-inspector").innerText()).includes(created.summary));
      return created.id;
    };
    await selectCard("E04");
    await page.locator("#new-card").click();
    const toolbarId = await openAndSave("用工具栏新建卡片");
    assert.deepEqual((await state()).organization.current.positions, positions,
      "Creating in mindmap must not persist title-node coordinates or widths in the card layout");

    await clearSelection();
    const point = await page.locator("#viewport").evaluate(viewport => {
      const bounds = viewport.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(document.getElementById("board")).transform);
      const cards = [...viewport.querySelectorAll("[data-map-level]:not([hidden])")].map(card => card.getBoundingClientRect());
      for (let y = bounds.top + 24; y < bounds.bottom - 100; y += 35) {
        for (let x = bounds.left + 24; x < bounds.right - 240 * matrix.a - 32; x += 42) {
          if (cards.some(box => x - 18 < box.right && x + 240 * matrix.a + 18 > box.left &&
              y - 18 < box.bottom && y + 100 * matrix.a + 18 > box.top)) continue;
          if (document.elementFromPoint(x, y)?.closest("[data-element-id], button, #ask-popover, #expand-card")) continue;
          return { x, y, sceneX: (x - bounds.left - matrix.e) / matrix.a, sceneY: (y - bounds.top - matrix.f) / matrix.a };
        }
      }
      return null;
    });
    assert.ok(point, "A clear placement point is required");
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.locator("#canvas-menu-new").click();
    const placedId = await openAndSave("在空白处新建卡片");
    const assertPoint = async () => {
      const placed = (await cards()).find(rect => rect.id === placedId);
      assert.ok(placed && Math.abs(placed.x - point.sceneX) < 2 && Math.abs(placed.y - point.sceneY) < 2,
        `Right-click placement should stay at the chosen mindmap point, got ${JSON.stringify(placed)}`);
    };
    await assertPoint();
    await flush();
    await page.reload({ waitUntil: "networkidle" });
    await ready("E04");
    await assertPoint();

    await card(placedId).press("Shift+F10");
    await page.locator("#canvas-menu-delete").click();
    await card(placedId).waitFor({ state: "detached" });
    assert.equal(await card(toolbarId).isVisible(), true);
    assert.deepEqual((await state()).organization.current.positions, positions, "Deleting a leaf must preserve the card layout");
    await page.locator("#undo-delete").click();
    await assertPoint();
    await selectCard(toolbarId);
    await card(toolbarId).press("Delete");
    await card(toolbarId).waitFor({ state: "detached" });
    await page.locator("#undo-delete").click();
    await card(toolbarId).waitFor();

    await selectCard("E40");
    await card("E41").press("Shift+Enter");
    await page.locator("#delete-selection").click();
    const after = await state();
    assert.deepEqual(after.memory.deletedIds, ["E40", "E41"]);
    assert.deepEqual(after.organization.current.positions, { E04: positions.E04, E55: positions.E55 });
    assert.equal(after.memory.pendingRepair, "");
    await page.locator("#presentation-cards").click();
    await flush();
    await page.reload({ waitUntil: "networkidle" });
    await ready("E04");
    assert.equal(await card("E40").count(), 0);
    assert.equal(await card("E41").count(), 0);
    assert.equal(await card("E55").isVisible(), true);
    assert.deepEqual((await state()).organization.current.positions, { E04: positions.E04, E55: positions.E55 });
    assert.equal(requests.length, requestCount, "Creating, deleting a leaf or a complete selection, and undoing require no model calls");
    pass("Mindmap creation, free-point placement, deletion and undo share the board document without changing its card coordinates");
  } finally {
    await isolated.close();
    page = previousPage;
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
  await mindmapCardLifecycle();
  await branchCameraStability();
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
  await readHiddenManualDescendants(allItems, baseline);

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
  await page.locator("#running-questions").getByText(/判断意图/).waitFor();
  await page.locator("#presentation-cards").click();
  assert.equal(await page.locator("#presentation-cards").getAttribute("aria-pressed"), "true", "A held planner should allow switching the active presentation");
  await page.locator("#presentation-mindmap").click();
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
  await inspectorTextQuestions(allItems);
  await hiddenChildTextQuestion(allItems);
  await rootOutlineOverview();
  await readerDataFixture();
  await workbenchDisplayEntry();
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
