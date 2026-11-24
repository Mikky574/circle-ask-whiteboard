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
const opinionRequests = [];
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
    const extendModule = payload.scope === "expandCard" && payload.project?.expansion?.targetId === "E41";
    (payload.branchIntent === "revise" || extendModule ? opinionRequests : requests).push(payload);
    let event;
    if (payload.scope === "plan") {
      if (heldPlan) await heldPlan;
      event = { type: "answer", text: '{"action":"ask"}' };
    }
    else if (payload.boardIntent === "repository_init") {
      const [root, feature] = payload.board.newIds;
      event = { type: "map", map: {
        title: "初始化示例", summary: "初始化白板并打开资料。", layout: { flow: "horizontal", density: "compact" },
        items: [
          { id: root, parentId: null, category: "main", title: "初始化示例", summary: "项目入口。" },
          { id: feature, parentId: root, category: "reference", title: "阅读工程说明", summary: "从功能图开始。" },
        ],
        projectStructure: { version: 1, rootId: root, title: "工程说明结构图", zones: [
          { id: "entry", title: "项目", nodes: [{ id: "root", cardId: root }, { id: "feature", cardId: feature }] },
        ] },
      } };
    }
    else if (payload.branchIntent === "revise") {
      const items = payload.question === "测试越界" ? [{ id: "E50", title: "不该改", summary: null }]
        : payload.board.nodes.map(node => ({
          id: node.id, title: node.id === payload.branchRootId ? "来自意见的标题" : null,
          summary: node.id === payload.branchRootId ? null : "来自意见的下级正文。",
        }));
      event = { type: "branch", branch: { items }, requestId: payload.requestId, baseRevision: payload.baseRevision };
    }
    else if (extendModule) event = { type: "children", requestId: payload.requestId, baseRevision: payload.baseRevision, children: [
      { title: "异常输入的验收", summary: "加入一次空输入检查并核对返回的提示。" },
      { title: "记录边界用例", summary: "收集需要补充验证的输入。" },
    ] };
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
  const file = await readFile(target);
  const readingCase = req.headers.cookie?.includes("mindmap-case=structure-workspace-");
  // Keep the archived renderer's characterization cases off the production presentation route.
  res.end(target === resolve(root, "index.html") && !readingCase
    ? file.toString("utf8").replace(" data-reading-only", "") : file);
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
      cards: Object.fromEntries([...document.querySelectorAll('#board [data-element-id]:not([hidden])')].map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [element.dataset.elementId, { x, y, width, height }];
      })),
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
              const common = Object.keys(before.cards).filter(card => after.cards[card]);
              const peerDelta = Math.max(0, ...common.map(card => Math.hypot(
                after.cards[card].x - before.cards[card].x, after.cards[card].y - before.cards[card].y)));
              const label = `${dimensions.width}px ${presentation} ${id} ${selected ? "selected" : "unselected"} ${phase}`;
              observations.push({ label, nodeDelta: +nodeDelta.toFixed(3), buttonDelta: +buttonDelta.toFixed(3), peerDelta: +peerDelta.toFixed(3),
                scaleBefore: +before.scale.toFixed(5), scaleAfter: +after.scale.toFixed(5),
                scrollBefore: before.scrollY, scrollAfter: after.scrollY });
              try {
                assert.ok(scaleDelta < 1e-8, `${label}: branch toggle changed zoom (${before.scale} -> ${after.scale})`);
                assert.ok(nodeDelta < 2, `${label}: clicked node moved ${nodeDelta.toFixed(2)} screen pixels`);
                assert.ok(peerDelta < 2, `${label}: an already-visible card moved ${peerDelta.toFixed(2)} screen pixels`);
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

async function structureWorkspaceEditing() {
  const previous = page;
  const boardId = `board-${"b".repeat(32)}`;
  const items = [
    { id: "E04", parentId: null, title: "同一个项目", category: "main" },
    { id: "E40", parentId: "E04", title: "使用入口", category: "reference" },
    { id: "E41", parentId: "E40", title: "原卡工作", category: "reference", flowSteps: ["E42", "E44"] },
    { id: "E42", parentId: "E41", title: "原分支中的证据", category: "reference" },
    { id: "E43", parentId: "E42", title: "第五级验收", category: "reference" },
    { id: "E44", parentId: "E41", title: "局部流程终点", category: "reference" },
    { id: "E50", parentId: "E04", title: "同区另一张卡", category: "reference", experiment: {
      version: 1, question: "同一批样本的结果如何？",
      comparison: {
        metrics: [
          { label: "准确率", direction: "higher" },
          { label: "召回率", direction: "higher" },
          { label: "绝对误差", direction: "lower" },
        ],
        arms: [
          { id: "base", label: "原方案", values: [0.6, 0.5, 0.4] },
          { id: "main", label: "主方案", values: [0.75, 0.65, 0.3] },
          { id: "extra", label: "次方案", values: [0.7, 0.6, 0.35] },
        ],
        baseline: "base", primary: "main", caveat: "只用于本批样本。",
      },
    } },
  ].map(item => ({ ...item, summary: item.title + "。" }));
  const positions = { E04: { x: 80, y: 90, width: 300 } };
  const links = [{ from: "start", to: "continue", label: "继续", evidence: "E42" },
    { from: "continue", to: "output", label: "提交结果" }];
  const current = { title: "同一个项目", items, positions, collapsedBranches: ["E40"],
    layout: { flow: "horizontal", density: "compact" }, projectStructure: {
      version: 1, rootId: "E04", zones: [
        { id: "entry", title: "入口", nodes: [{ id: "start", cardId: "E40" }] },
        { id: "work", title: "处理", nodes: [{ id: "continue", cardId: "E41" }, { id: "output", cardId: "E50" }] },
      ], links,
    } };
  for (const width of [1480, 500]) {
    const isolated = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 760, serviceWorkers: "block",
      reducedMotion: "reduce" });
    isolated.setDefaultTimeout(12000);
    const caseName = `structure-workspace-${width}`;
    await isolated.addCookies([{ name: "mindmap-case", value: caseName, url: origin }]);
    const records = new Map([[boardId, { id: boardId, title: current.title, revision: 1,
      updatedAt: new Date().toISOString(), storage: { organization: JSON.stringify({ current }) } }]]);
    boardCases.set(caseName, records);
    try {
      page = await isolated.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/?board=${boardId}&view=canvas`);
      const overview = page.locator('.research-module-board[data-module-root="E04"] .research-structure');
      const graph = page.locator(".research-module-board.is-active .research-structure");
      const entry = overview.locator('.research-snode[data-node="continue"]');
      const branch = entry.locator("..");
      const node = id => graph.locator(`.research-snode[data-card-id="${id}"]`).first();
      const menu = page.getByRole("menu");
      const drawer = page.locator("#project-card-drawer");
      await entry.waitFor();
      assert.equal(new URL(page.url()).searchParams.get("panel"), "structure", "The project opens on its structure whiteboard");
      assert.equal(await page.locator("#project-surface-canvas").count(), 0);
      assert.equal(await page.locator(".research-edge[data-from]").count(), 2);
      const frame = graph.locator(".research-structure-scroll");
      const geometry = () => frame.evaluate(frame => {
        const { x, y, width, height } = frame.getBoundingClientRect();
        return { x, y, width, height, left: frame.scrollLeft, top: frame.scrollTop, page: scrollY };
      });
      const camera = graph.getByRole("group", { name: "画布缩放" });
      const scale = camera.locator("button").filter({ hasText: /%/ });
      assert.equal(await scale.textContent(), "100%");
      if (width > 760) {
        const start = await geometry();
        await page.mouse.move(start.x + 12, start.y + 12);
        await page.mouse.down();
        await page.mouse.move(start.x + 66, start.y + 46, { steps: 5 });
        await page.mouse.up();
        const panned = await geometry();
        assert.ok(panned.left < start.left - 40 && panned.top < start.top - 25, "Dragging empty space pans both axes");
        assert.equal(panned.page, start.page, "Panning moves only the graph");
        await scale.click();
      }
      const initialWidth = (await entry.boundingBox()).width;
      await camera.getByRole("button", { name: "放大画布" }).click();
      assert.equal(await scale.textContent(), "120%");
      assert.ok((await entry.boundingBox()).width > initialWidth * 1.15, "Zoom scales the contents");
      assert.equal(await graph.locator(".research-edge[data-from]").count(), 2);
      await camera.getByRole("button", { name: "适应" }).click();
      if (width <= 760) assert.ok(parseFloat(await scale.textContent()) < 100, "The narrow graph can zoom out to fit");
      await scale.click();
      await entry.scrollIntoViewIfNeeded();
      const beforeSelection = await geometry();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await entry.click();
      const inspector = graph.locator(".research-structure-detail");
      await inspector.getByRole("heading", { name: "原卡工作", exact: true }).waitFor();
      assert.equal(await inspector.getByText("原卡工作。", { exact: true }).isVisible(), true);
      assert.equal(new URL(page.url()).searchParams.get("focusCard"), "E41");
      assert.deepEqual(await geometry(), beforeSelection, "Inspecting a card keeps the graph anchored");
      if (width > 760) {
        assert.ok((await inspector.boundingBox()).x >= beforeSelection.x + beforeSelection.width - 1);
      } else {
        await page.keyboard.press("Escape");
        await inspector.waitFor({ state: "hidden" });
        assert.equal(await entry.evaluate(element => document.activeElement === element), true);
        assert.deepEqual(await geometry(), beforeSelection, "Closing the sheet keeps the graph anchored");
      }
      const experiment = node("E50");
      await experiment.scrollIntoViewIfNeeded();
      const beforeExperiment = await geometry();
      await experiment.click();
      const metrics = inspector.locator(".research-key-metric");
      await metrics.first().waitFor();
      assert.equal(await metrics.count(), 2, "The experiment preview shows the first two metrics");
      const fullTable = inspector.locator(".research-table-wrap table");
      const tableDisclosure = fullTable.locator("xpath=ancestor::details[1]").locator("summary");
      const longText = inspector.getByText("同区另一张卡。", { exact: true });
      const descriptionDisclosure = longText.locator("xpath=ancestor::details[1]").locator("summary");
      assert.equal(await fullTable.isVisible(), false);
      assert.equal(await longText.isVisible(), false);
      await tableDisclosure.click();
      await fullTable.waitFor();
      await descriptionDisclosure.click();
      await longText.waitFor();
      const method = inspector.getByRole("combobox", { name: "对照方法" });
      await method.focus();
      await method.selectOption("extra");
      assert.equal(await method.evaluate(element => element === document.activeElement), true);
      assert.equal(await metrics.first().locator("strong").textContent(), "0.700");
      assert.equal(await fullTable.isVisible(), true, "Changing the comparison keeps the full table open");
      assert.equal(await longText.isVisible(), true, "Changing the comparison keeps the description open");
      assert.deepEqual(await geometry(), beforeExperiment, "Reading experimental evidence keeps the graph anchored");
      if (width <= 760) {
        await page.keyboard.press("Escape");
        await inspector.waitFor({ state: "hidden" });
      }
      await overview.evaluate(element => { element.dataset.retainedForTest = "original"; });
      await camera.getByRole("button", { name: "放大画布" }).click();
      const opening = branch.locator(".research-snode-drill");
      await opening.scrollIntoViewIfNeeded();
      const oldLayout = await geometry();
      const oldDetail = await inspector.textContent();
      await opening.click();
      await node("E42").waitFor();
      assert.equal(await page.locator(".research-module-board").count(), 2);
      assert.equal(await overview.getAttribute("data-retained-for-test"), "original");
      assert.equal(await overview.locator(".research-structure-detail").textContent(), oldDetail);
      assert.equal(await overview.getByRole("button", { name: "120%", exact: true }).count(), 1);
      const savedCamera = await overview.locator(".research-structure-scroll").evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      assert.deepEqual(savedCamera, { x: oldLayout.left, y: oldLayout.top });
      assert.equal(new URL(page.url()).searchParams.get("trail"), "E04.E41");
      assert.equal(await page.evaluate(() => document.activeElement?.matches(".research-module-board.is-active h2")), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight));
      const connector = page.locator('.research-module-board[data-module-root="E41"] .research-module-bridge');
      await connector.getByRole("button", { name: "↑ 同一个项目" }).click();
      assert.equal(await graph.getAttribute("data-diagram-root"), "E04");
      assert.equal(await page.locator(".research-module-board").count(), 2);
      assert.equal(await opening.textContent(), "跳到模块图 ↓");
      await opening.click();
      assert.equal(await page.locator(".research-module-board").count(), 2, "Reopening reuses the mounted child");
      await page.goBack();
      assert.equal(await graph.getAttribute("data-diagram-root"), "E04");
      assert.equal(await page.locator(".research-module-board").count(), 1);
      await page.goForward();
      assert.equal(await page.locator(".research-module-board").count(), 2);
      assert.equal(await graph.getAttribute("data-diagram-root"), "E41");
      await camera.getByRole("button", { name: "放大画布" }).click();
      const another = overview.locator('.research-snode[data-card-id="E40"]').locator("..").locator(".research-snode-drill");
      await another.click();
      assert.equal(new URL(page.url()).searchParams.get("trail"), "E04.E40");
      assert.equal(await page.locator('.research-module-board[data-module-root="E41"]').count(), 0);
      await opening.click();
      assert.equal(new URL(page.url()).searchParams.get("trail"), "E04.E41");
      assert.equal(await scale.textContent(), "120%", "A reopened alternative restores its camera");
      await scale.click();
      assert.equal(await graph.locator(".research-subtree").count(), 0);
      assert.equal(await graph.locator(".research-edge").count(), 1, "An explicit flow supplies one relation in the module");
      assert.equal(await graph.locator(".research-structure-lines").isVisible(), true, "The graph itself is available on narrow screens");
      if (width > 760) {
        await frame.hover();
        const scrollBefore = await frame.evaluate(el => ({ inner: el.scrollTop, outer: scrollY }));
        await page.mouse.wheel(0, -160);
        await page.waitForFunction(outer => scrollY < outer, scrollBefore.outer);
        assert.equal(await frame.evaluate(el => el.scrollTop), scrollBefore.inner, "Vertical wheel scrolls the page in a stack");
      }
      assert.equal(await page.locator("#viewport").isVisible(), false);
      await flush();
      assert.equal(records.get(boardId).revision, 1, "Drilling into a module does not write");
      await graph.getByRole("button", { name: "编辑模块图" }).click();
      const editGraph = page.locator("#project-diagram-drawer");
      const json = editGraph.locator("textarea");
      const scoped = JSON.parse(await json.inputValue());
      scoped.links[0].label = "结对复核";
      scoped.links[0].evidence = "E42";
      await json.fill(JSON.stringify({ ...scoped, rootId: "E50" }));
      await editGraph.getByRole("button", { name: "保存模块图" }).click();
      await editGraph.getByText("根卡编号应与当前模块一致。").waitFor();
      await json.fill(JSON.stringify(scoped));
      await editGraph.getByRole("button", { name: "保存模块图" }).click();
      await editGraph.waitFor({ state: "hidden" });
      await graph.locator(".research-edge-label").getByText("结对复核").click();
      await graph.locator(".research-structure-detail").getByText("证据卡片", { exact: true }).waitFor();
      assert.equal((await state()).organization.current.moduleDiagrams[0].rootId, "E41");
      await page.locator("#project-surface-structure").click();
      const toggle = branch.locator(".research-snode-expand").first();
      await entry.scrollIntoViewIfNeeded();
      await toggle.scrollIntoViewIfNeeded();
      const start = await entry.boundingBox();
      const route = page.url();
      const heading = await inspector.locator("h3").first().textContent();
      await toggle.click();
      const inline = graph.locator('.research-inline-module[data-diagram-root="E41"]');
      await inline.locator('.research-snode[data-card-id="E42"]').waitFor();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(page.url(), route, "Inline expansion stays on the same diagram");
      assert.equal(await inspector.locator("h3").first().textContent(), heading, "Expanding preserves the inspector");
      const anchored = await entry.boundingBox();
      assert.ok(Math.abs(anchored.x - start.x) < 2 && Math.abs(anchored.y - start.y) < 2, "Expansion anchors the parent");
      assert.equal(await inline.locator(".research-edge[data-from]").count(), 1, "Inline modules render their saved relations");
      assert.match(await inline.locator(".research-edge-label").textContent(), /结对复核/);
      const nested = inline.locator('.research-snode[data-card-id="E42"]').locator("..").locator(".research-snode-expand").first();
      await nested.click();
      const second = inline.locator('.research-inline-module[data-diagram-root="E42"]');
      await second.locator('.research-snode[data-card-id="E43"]').waitFor();
      assert.equal(await second.locator(".research-edge").count(), 0, "Containment is rendered as a frame");
      await toggle.click();
      await inline.waitFor({ state: "detached" });
      await toggle.click();
      await second.locator('.research-snode[data-card-id="E43"]').waitFor();
      await toggle.click();
      await inline.waitFor({ state: "detached" });
      await branch.locator(".research-snode-drill").click();
      await page.reload();
      await graph.locator(".research-edge-label").getByText("结对复核").waitFor();
      await node("E42").locator("..").locator(".research-snode-drill").click();
      await node("E43").waitFor();
      assert.equal(await graph.getAttribute("data-diagram-root"), "E42");
      assert.equal(await graph.locator(".research-edge").count(), 0, "Parentage does not create a workflow relation");
      await node("E43").press("Shift+F10");
      await menu.getByRole("menuitem", { name: "编辑原卡" }).click();
      assert.equal(await drawer.isVisible(), true);
      await page.locator("#workbench-card-body").fill("在结构白板上改好的第五级正文。");
      await drawer.getByRole("button", { name: "保存卡片" }).click();
      assert.equal(await node("E43").evaluate(node => node === document.activeElement), true);
      if (width <= 760) await node("E43").press("Enter");
      await inspector.getByText("在结构白板上改好的第五级正文。", { exact: true }).waitFor();
      if (width <= 760) await page.keyboard.press("Escape");
      await page.locator("#project-surface-structure").click();
      await entry.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "编辑原卡" }).click();
      await page.locator("#workbench-card-appearance summary").click();
      await page.locator("#workbench-card-diagram-title").fill("图上名称");
      await drawer.getByRole("button", { name: "保存卡片" }).click();
      await entry.getByText("图上名称", { exact: true }).waitFor();
      async function addBelow(parent, title) {
        await parent.click({ button: "right" });
        await menu.getByRole("menuitem", { name: "手动新建子卡" }).click();
        await page.locator("#workbench-card-title").fill(title);
        await drawer.getByRole("button", { name: "保存卡片" }).click();
        const saved = (await state()).organization.current.items.find(item => item.title === title);
        assert.ok(saved);
        await node(saved.id).waitFor();
        return saved;
      }
      await branch.locator(".research-snode-drill").click();
      await node("E42").locator("..").locator(".research-snode-drill").click();
      const child = await addBelow(node("E43"), "直接新建的子卡");
      assert.equal(child.parentId, "E43");
      const grandchild = await addBelow(node(child.id), "在新卡下继续新建");
      assert.equal(grandchild.parentId, child.id);
      assert.notEqual(child.id, grandchild.id);
      await page.locator("#project-surface-structure").click();
      await entry.waitFor();
      const opinion = page.locator("#project-opinion-drawer");
      const instruction = opinion.getByRole("textbox", { name: "你希望改成什么样？" });
      const generate = opinion.getByRole("button", { name: "生成修改预览" });
      await entry.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "提意见让 AI 改" }).click();
      await opinion.waitFor();
      assert.equal(await opinion.getByLabel("仅当前卡").isChecked(), true);
      const beforeOpinion = (await state()).organization.current;
      await instruction.fill("测试越界");
      await generate.click();
      await opinion.getByText("AI 建议超出本次卡片范围。").waitFor();
      assert.deepEqual(opinionRequests.at(-1).board.nodes.map(node => node.id), ["E41"]);
      assert.equal(await opinion.getByRole("button", { name: "应用勾选的修改" }).isVisible(), false);
      await instruction.fill("把当前卡的名称说得更直白，补全下级说明。");
      await opinion.getByLabel("当前卡及下级").check();
      await generate.click();
      const preview = opinion.getByRole("region", { name: "修改预览" });
      await preview.getByText("来自意见的标题", { exact: true }).waitFor();
      assert.deepEqual(new Set(opinionRequests.at(-1).board.nodes.map(node => node.id)),
        new Set(["E41", "E42", "E43", "E44", child.id, grandchild.id]));
      assert.deepEqual((await state()).organization.current, beforeOpinion, "Preview never writes to the board");
      for (const input of await preview.getByRole("checkbox").all()) {
        if (!(await input.getAttribute("value") === "E41")) await input.uncheck();
      }
      await opinion.getByRole("button", { name: "应用勾选的修改" }).click();
      await opinion.waitFor({ state: "hidden" });
      const afterOpinion = (await state()).organization.current;
      assert.deepEqual(afterOpinion.items, beforeOpinion.items.map(item =>
        item.id === "E41" ? { ...item, title: "来自意见的标题" } : item));
      assert.deepEqual(afterOpinion.projectStructure, beforeOpinion.projectStructure);
      assert.deepEqual(afterOpinion.moduleDiagrams, beforeOpinion.moduleDiagrams);
      await entry.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "AI 向下延伸" }).click();
      await opinion.waitFor();
      assert.equal(await opinion.getByLabel("新增下级").isChecked(), true);
      await instruction.fill("在这里加一个子卡，说明异常输入如何验收。");
      await opinion.getByRole("button", { name: "生成下级卡预览" }).click();
      await preview.getByText("加入一次空输入检查并核对返回的提示。").waitFor();
      const extension = opinionRequests.at(-1);
      assert.deepEqual(extension.anchor.elementIds, ["E41"]);
      assert.deepEqual(extension.project.expansion.path.map(item => item.id), ["E04", "E40", "E41"]);
      assert.deepEqual((await state()).organization.current, afterOpinion, "A new card preview never writes to the board");
      const choices = preview.getByRole("checkbox");
      assert.equal(await choices.count(), 2);
      await choices.nth(1).uncheck();
      await opinion.getByRole("button", { name: "加入勾选的下级卡" }).click();
      await opinion.waitFor({ state: "hidden" });
      const afterExtension = (await state()).organization.current;
      const additions = afterExtension.items.filter(item => !afterOpinion.items.some(previous => previous.id === item.id));
      assert.equal(additions.length, 1);
      const [addition] = additions;
      assert.equal(addition.title, "异常输入的验收");
      assert.equal(addition.parentId, "E41");
      assert.equal(addition.opinionChild, true);
      assert.deepEqual(afterExtension.moduleDiagrams, afterOpinion.moduleDiagrams);
      assert.equal(await graph.getAttribute("data-diagram-root"), "E41");
      assert.equal(new URL(page.url()).searchParams.get("focusCard"), addition.id);
      await graph.locator(".research-zone").filter({ hasText: "AI 补充" }).getByText(addition.title, { exact: true }).waitFor();
      assert.equal(await node(addition.id).evaluate(element => document.activeElement === element), true);
      await page.reload();
      await node(addition.id).waitFor();
      const viewport = await frame.boundingBox();
      const visibleNewCard = await node(addition.id).boundingBox();
      assert.ok(visibleNewCard.x >= viewport.x && visibleNewCard.x + visibleNewCard.width <= viewport.x + viewport.width);
      await page.locator("#project-surface-structure").click();
      if (width > 760) {
        const handle = branch.locator(".research-snode-handle");
        await handle.scrollIntoViewIfNeeded();
        const grip = await handle.boundingBox();
        const other = await page.locator('.research-snode[data-node="output"]').boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(other.x + other.width / 2, other.y + other.height * 0.8, { steps: 8 });
        await page.mouse.up();
      } else {
        await branch.locator(".research-snode-tools .research-snode-more").tap();
        await menu.getByRole("menuitem", { name: "在分区内下移" }).tap();
      }
      await page.waitForFunction(() => window.BoardOrganization.load()?.current?.projectStructure?.zones[1]?.nodes[0].id === "output");
      await flush();
      await page.reload();
      await entry.waitFor();
      const saved = (await state()).organization.current;
      assert.deepEqual(saved.projectStructure.zones[1].nodes.map(node => node.id), ["output", "continue"]);
      assert.deepEqual(saved.projectStructure.links.map(({ from, to, label, evidence }) => ({ from, to, label, ...(evidence ? { evidence } : {}) })), links);
      assert.deepEqual(saved.positions, positions);
      assert.deepEqual(saved.collapsedBranches, ["E40"]);
      assert.equal(new URL(page.url()).searchParams.get("panel"), "structure");
      await page.goto(`${origin}/?board=${boardId}&view=canvas&presentation=cards&root=E41#E42`);
      await graph.locator('.research-snode[data-card-id="E42"][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator("#viewport").isVisible(), false);
      assert.equal(new URL(page.url()).searchParams.get("presentation"), "research");
      await page.goto(`${origin}/?board=${boardId}&view=canvas&presentation=mindmap&root=E42&focusCard=E43`);
      await graph.locator('.research-snode[data-card-id="E43"][aria-pressed="true"]').waitFor();
      assert.equal(await page.getByRole("button", { name: "导图阅读" }).count(), 0);
      assert.equal(await page.getByRole("tab", { name: "关系导图" }).count(), 0);
      await page.locator("#reading-search #card-search-toggle").click();
      await page.locator("#card-search-input").fill("来自意见的标题");
      await page.locator("#card-search-results").getByRole("button", { name: /来自意见的标题/ }).click();
      await inspector.getByRole("heading", { name: "来自意见的标题", exact: true }).waitFor();
      if (width > 760) {
        const newBoard = `board-${"d".repeat(32)}`;
        records.set(newBoard, { id: newBoard, title: "空白阅读验收", revision: 1,
          updatedAt: new Date().toISOString(), storage: {} });
        await page.goto(`${origin}/?board=${newBoard}`);
        await page.locator("#reading-start").getByRole("button", { name: "初始化工程介绍" }).waitFor();
        await page.getByRole("button", { name: "写第一张卡片" }).click();
        await drawer.locator("#workbench-card-title").fill("阅读区的第一张卡");
        await drawer.locator("#workbench-card-body").fill("从阅读区填写一张初始卡并提问。");
        await drawer.getByRole("button", { name: "保存卡片" }).click();
        const starter = graph.locator(".research-snode").filter({ hasText: "阅读区的第一张卡" });
        const cardId = await starter.getAttribute("data-card-id");
        await starter.click();
        await inspector.getByRole("button", { name: "问这张卡" }).click();
        const ask = page.locator("#reading-question");
        await ask.getByRole("textbox", { name: "你的问题" }).fill("这张卡要交付什么？");
        const requestCount = requests.length;
        await ask.getByRole("button", { name: "发送" }).click();
        await page.waitForFunction(() => BoardMemory.load().notes.some(note => note.payload.question === "这张卡要交付什么？"));
        const newQuestion = requests.slice(requestCount).find(item => item.scope !== "plan");
        assert.deepEqual(newQuestion.anchor.elementIds, [cardId]);
        await page.getByRole("button", { name: "查看回答" }).click();
        await inspector.getByText("完整回答末尾验收标记。", { exact: false }).waitFor();
        requests.splice(requestCount);
        assert.equal(await page.locator("#viewport").isVisible(), false);
        const initBoard = `board-${"e".repeat(32)}`;
        records.set(initBoard, { id: initBoard, title: "阅读区初始化验收", revision: 1,
          updatedAt: new Date().toISOString(), storage: {} });
        await page.goto(`${origin}/?board=${initBoard}`);
        await page.locator("#reading-start #initialize-repository").click();
        await graph.getByRole("heading", { name: "工程说明结构图" }).waitFor();
        assert.equal(await page.locator("#viewport").isVisible(), false);
        requests.splice(requestCount);
      }
    } finally { await isolated.close(); }
  }
  page = previous;
  pass("The overview and scoped module diagrams share graph navigation, evidence, card edits, opinions and persistent layout on desktop and touch");
}

try {
  server = createServer((req, res) => { void relay(req, res).catch(error => json(res, { text: error.message }, 500)); });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  await structureWorkspaceEditing();
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
