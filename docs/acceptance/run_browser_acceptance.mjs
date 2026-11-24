/*
 * Isolated L3 browser acceptance.  This is deliberately a self-contained
 * fake relay: it neither imports server.py nor has any provider/CLI route.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const FIXTURE = JSON.parse(await readFile(join(HERE, "browser_fixture.json"), "utf8"));
const TEST_KEY = FIXTURE.syntheticApiKey;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const startedAt = new Date().toISOString();
const command = "node docs/acceptance/run_browser_acceptance.mjs";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const results = [];
const telemetry = { requests: [], cancelRequests: [], lateAttempts: [] };
const cleanup = { browserClosed: false, contextsClosed: 0, serverClosed: false, temporaryProfile: "Playwright ephemeral profile (removed by browser.close)" };
let server;
let port;
let browser;
let executionTraceFixture;
const boardStores = new Map();
let nextBrowserSession = 0;

function redact(value) {
  return String(value ?? "").replaceAll(TEST_KEY, "[TEST-ONLY-REDACTED]");
}
function safeError(error) {
  return redact(error?.stack || error?.message || error);
}
function record(id, outcome, detail = "", extra = {}) {
  results.push({ id, outcome, mode: "ISOLATED_BROWSER_FAKE_ADAPTER", detail: redact(detail), ...extra });
}
function stream(res, event) { res.write(`${JSON.stringify(event)}\n`); }
function candidate() { return structuredClone(FIXTURE.map); }
const firstTask = { title: "实现任务验收入口", task: "给项目任务添加可检查的验收入口。",
  dependencies: ["确认任务字段"], acceptance: ["提交时显示未达标条目", "刷新后可继续验收"] };
const nextTask = { title: "验证验收输入", task: "覆盖空值和超长输入。",
  dependencies: [], acceptance: ["无效输入不会更新验收结果"] };
const parentProject = { id: "a".repeat(32), name: "接口平台", path: "C:\\fixture\\接口平台",
  description: "负责接口文档和版本管理。", category: "开发", aliases: [], parentId: null, childCount: 1 };
const childProject = { id: "b".repeat(32), name: "导入工具", path: "C:\\fixture\\接口平台\\导入工具",
  description: "将文本清单导入接口平台。", category: "开发", aliases: [], parentId: parentProject.id, childCount: 0 };
const registeredProjectId = "c".repeat(32);
const localProjects = [parentProject, childProject];
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function staticPath(urlPath) {
  const target = normalize(resolve(ROOT, `.${urlPath === "/" ? "/index.html" : urlPath}`));
  if (!target.startsWith(ROOT + "\\") && target !== ROOT) return null;
  return target;
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function jsonResponse(res, result, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(result));
}

async function relay(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname === "/api/board-store" && req.method === "POST") {
    // Each acceptance case has a separate document store; tabs within that
    // case share it. Production persistence is tested against SQLite by
    // test_shared_boards_browser.mjs, independently of this fake relay.
    const session = req.headers.cookie?.match(/(?:^|;\s*)whiteboard-test-session=([^;]+)/)?.[1] || "default";
    if (!boardStores.has(session)) boardStores.set(session, new Map());
    const records = boardStores.get(session);
    const payload = await body(req);
    const current = records.get(payload.id);
    if (payload.action === "list") {
      jsonResponse(res, {
        boards: [...records.values()].filter(board => !board.deleted).map(({ storage, ...metadata }) => metadata),
        deleted: [...records.values()].filter(board => board.deleted).map(({ id, revision }) => ({ id, revision })),
      });
    } else if (payload.action === "load") {
      jsonResponse(res, { board: current?.deleted ? null : current || null,
        deleted: Boolean(current?.deleted), revision: current?.revision || 0 });
    } else if (["save", "delete"].includes(payload.action)) {
      if (current?.deleted || payload.expectedRevision !== (current?.revision || 0)) {
        jsonResponse(res, { text: "白板已在另一页面更新或删除，请先保留草稿再刷新。",
          board: current?.deleted ? null : current || null, deleted: Boolean(current?.deleted),
          revision: current?.revision || 0 }, 409);
      } else if (payload.action === "delete") {
        const removed = { id: payload.id, revision: payload.expectedRevision + 1, deleted: true };
        records.set(payload.id, removed);
        jsonResponse(res, removed);
      } else {
        const board = { ...payload.metadata, id: payload.id, revision: payload.expectedRevision + 1,
          updatedAt: new Date().toISOString(), storage: payload.storage };
        records.set(payload.id, board);
        jsonResponse(res, { board });
      }
    } else jsonResponse(res, { text: "无效的存储测试操作。" }, 400);
    return;
  }
  if (url.pathname === "/api/status") {
    jsonResponse(res, { backends: FIXTURE.backends, maxRepositoryInitCards: 23 });
    return;
  }
  if (url.pathname === "/api/local-projects" && req.method === "POST") {
    const payload = await body(req);
    if (payload.action === "list") {
      jsonResponse(res, { projects: localProjects });
    } else if (payload.action === "get") {
      const project = localProjects.find(({ id }) => id === payload.id);
      if (!project) {
        jsonResponse(res, { text: "项目已不在本机清单中。" }, 404);
      } else {
        const ancestors = project.parentId ? [parentProject] : [];
        const children = localProjects.filter(({ parentId }) => parentId === project.id);
        jsonResponse(res, { project, ancestors, children });
      }
    } else if (payload.action === "register" && payload.path.startsWith("C:\\fixture\\")) {
      const project = { id: registeredProjectId, name: payload.name, path: payload.path, description: payload.description,
        category: "本机项目", aliases: [], parentId: null, childCount: 0 };
      localProjects.push(project);
      jsonResponse(res, { project });
    } else {
      jsonResponse(res, { text: "项目目录不可读。" }, 422);
    }
    return;
  }
  if (url.pathname === "/api/repository" && req.method === "POST") {
    const { repositoryPath } = await body(req);
    jsonResponse(res, { repositoryPath });
    return;
  }
  if (url.pathname === "/api/workbench-activity" && req.method === "POST") {
    jsonResponse(res, { activity: null });
    return;
  }
  if (url.pathname === "/api/cancel" && req.method === "POST") {
    const payload = await body(req);
    telemetry.cancelRequests.push({ requestId: String(payload.requestId || "") });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (url.pathname === "/api/codex" && req.method === "POST") {
    const payload = await body(req);
    telemetry.requests.push({ backend: payload.backend, requestId: payload.requestId, scope: payload.scope, hasApiKey: Boolean(payload.api?.apiKey), apiKeyValueRetained: false });
    const referer = new URL(req.headers.referer || "/", `http://${req.headers.host}`);
    const flavor = referer.searchParams.get("flow") || "normal";
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive" });
    stream(res, { type: "status", text: "fixture stream started" });
    if (flavor === "execution-trace" && executionTraceFixture) {
      await executionTraceFixture(payload, res);
      return;
    }
    if (flavor.startsWith("decompose") && payload.scope === "plan") {
      stream(res, { type: "answer", text: JSON.stringify({ action: "decompose" }) });
      stream(res, { type: "done" });
      res.end();
      return;
    }
    if (flavor.startsWith("decompose") && payload.scope === "decompose") {
      if (flavor === "decompose-stale") await delay(350);
      stream(res, { type: "children", children: [payload.decomposition.targetId === "E02" ? firstTask : nextTask] });
      if (flavor !== "decompose-incomplete") stream(res, { type: "done" });
      res.end();
      return;
    }
    if (flavor === "normal") {
      await delay(40);
      stream(res, { type: "map", map: candidate() });
      stream(res, { type: "done" });
      res.end();
      return;
    }
    await delay(350);
    telemetry.lateAttempts.push({ requestId: payload.requestId, flavor, events: ["map", "done"] });
    // The client is expected to have invalidated this run.  We still attempt
    // delivery as a fake adapter would; a closed browser stream is harmless.
    if (!res.destroyed && !res.writableEnded) {
      stream(res, { type: "map", map: candidate() });
      stream(res, { type: "done" });
      res.end();
    }
    return;
  }
  const path = staticPath(url.pathname);
  if (!path || !existsSync(path)) { res.writeHead(404); res.end("not found"); return; }
  try {
    const content = await readFile(path);
    res.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  } catch { res.writeHead(500); res.end("fixture static read failed"); }
}

async function openPage(flow = "normal", board = "original") {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 980 } });
  await context.addCookies([{ name: "whiteboard-test-session", value: String(++nextBrowserSession),
    url: `http://127.0.0.1:${port}/` }]);
  context.setDefaultTimeout(8_000);
  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (error) => jsErrors.push(safeError(error)));
  page.on("console", (message) => { if (message.type() === "error") jsErrors.push(redact(message.text())); });
  page.on("requestfailed", (request) => {
    // Intentional AbortError after Stop is accepted by the specific stop case.
    if (!request.url().includes("/api/codex")) jsErrors.push(`request failed: ${request.url()} ${request.failure()?.errorText || ""}`);
  });
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set("flow", flow);
  if (board) url.searchParams.set("board", board);
  await page.goto(url.href, { waitUntil: "networkidle" });
  if (board) {
    await page.waitForFunction(() => document.querySelector("#connection-label")?.textContent?.includes("已安装"));
  } else {
    await page.locator("#local-projects").waitFor();
  }
  return { context, page, jsErrors };
}
async function closeSession(session) {
  await session.context.close();
  cleanup.contextsClosed += 1;
}
async function chooseApi(page) {
  await page.locator(".connection-settings > summary").click();
  await page.locator("#backend-select").selectOption("api");
  await page.locator("#model-input").fill("api-fixture-a");
  await page.locator("#api-key").fill(TEST_KEY);
  assert.equal(await page.locator("#api-fields").evaluate((element) => element.hidden), false, "API fields did not become visible");
  await page.locator(".connection-settings > summary").click();
}
async function submitOrganization(page) {
  await page.locator("#organize-board").click();
  await page.locator("#confirm-organize-board").click();
}
async function organize(page) {
  await submitOrganization(page);
  await page.locator("#stop-ai").waitFor({ state: "visible" });
}
async function waitOrganizationSettled(page, expected = /(?:已重排白板|整理完成)/) {
  await page.waitForFunction((source) => new RegExp(source).test(document.querySelector("#organization-status")?.textContent || ""), expected.source);
  await page.locator("#stop-ai").waitFor({ state: "hidden" });
}
function assertNoJsErrors(errors, allowAbort = false) {
  const unexpected = errors.filter((entry) => !(allowAbort && /AbortError|aborted/i.test(entry)));
  assert.deepEqual(unexpected, [], `unexpected browser JS errors: ${unexpected.join(" | ")}`);
}
async function openDetails(page, ...ids) {
  for (const id of ids) {
    const details = page.locator(`#${id}`);
    if (!(await details.evaluate((element) => element.open))) {
      await details.locator(":scope > summary").click();
    }
  }
}
async function screenshot(id, page) {
  const folder = join(HERE, "screenshots");
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${id}.png`);
  await page.screenshot({ path, fullPage: true });
  return `screenshots/${basename(path)}`;
}

async function testCapabilities() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    await page.locator(".connection-settings > summary").click();
    for (const backend of ["codex", "zcode", "api"]) {
      await page.locator("#backend-select").selectOption(backend);
      await page.locator("#model-input").fill(`${backend}-manual-model`);
      const options = await page.locator("#model-options option").evaluateAll((nodes) => nodes.map((node) => node.value));
      assert.ok(options.some((value) => value.startsWith(`${backend}-fixture`)), `${backend} fixture models absent`);
      const apiHidden = await page.locator("#api-fields").evaluate((element) => element.hidden);
      assert.equal(apiHidden, backend !== "api", `${backend} API configuration visibility mismatch`);
    }
    assertNoJsErrors(jsErrors);
    record("U01", "PASS", "Three synthetic backends selectable with their fake capability/model constraints.");
  } catch (error) { record("U01", "FAIL", safeError(error)); await screenshot("U01-failure", session.page); }
  finally { await closeSession(session); }
}

async function testKeyEphemeral() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    await chooseApi(page); await organize(page);
    await waitOrganizationSettled(page);
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    assert.equal(JSON.stringify(stored).includes(TEST_KEY), false, "test-only key persisted to localStorage");
    assert.equal(await page.locator("#api-key").inputValue(), TEST_KEY, "key was not present in temporary DOM during the current page");
    const visibleText = await page.locator("body").innerText();
    assert.equal(visibleText.includes(TEST_KEY), false, "test-only key displayed in page text");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#connection-label")?.textContent?.includes("可用"));
    assert.equal(await page.locator("#api-key").inputValue(), "", "API key survived refresh");
    assertNoJsErrors(jsErrors);
    record("U02", "PASS", "Synthetic key stayed only in live input, never localStorage, and cleared on refresh.");
  } catch (error) { record("U02", "FAIL", safeError(error)); await screenshot("U02-failure", session.page); }
  finally { await closeSession(session); }
}

async function testStopLateEvents() {
  const session = await openPage("late-stop");
  try {
    const { page, jsErrors } = session;
    await chooseApi(page); await organize(page);
    await page.locator("#stop-ai").click();
    await page.waitForTimeout(520);
    assert.equal(await page.locator("#undo-organization").isVisible(), false, "late map/done applied after Stop");
    assert.ok(telemetry.cancelRequests.length > 0, "same-origin fake cancel route was not called");
    assert.ok(telemetry.lateAttempts.some((entry) => entry.flavor === "late-stop"), "fake adapter did not attempt late map/done");
    assertNoJsErrors(jsErrors, true);
    record("U05-A", "PASS", "Stop invalidated the run before fake adapter's delayed map/done attempt.");
  } catch (error) { record("U05-A", "FAIL", safeError(error)); await screenshot("U05-A-failure", session.page); }
  finally { await closeSession(session); }
}

async function testSamePageStale() {
  const session = await openPage("late-same-page");
  try {
    const { page, jsErrors } = session;
    await chooseApi(page); await organize(page);
    await page.evaluate(() => localStorage.setItem("whiteboard.codex.v1", JSON.stringify({ fixtureMutation: "same-page" })));
    await page.waitForFunction(() => document.querySelector("#organization-status")?.textContent?.includes("结果未应用"));
    assert.equal(await page.locator("#undo-organization").isVisible(), false, "stale same-page result committed");
    assertNoJsErrors(jsErrors);
    record("U04-A", "PASS", "Same-page isolated localStorage change rejected delayed result.");
  } catch (error) { record("U04-A", "FAIL", safeError(error)); await screenshot("U04-A-failure", session.page); }
  finally { await closeSession(session); }
}

async function testCrossPageStale() {
  const session = await openPage("late-cross-page");
  let peer;
  try {
    const { context, page, jsErrors } = session;
    peer = await context.newPage();
    await peer.goto(`http://127.0.0.1:${port}/?board=original`, { waitUntil: "networkidle" });
    // Establish the peer before starting the delayed stream: otherwise its
    // navigation itself can consume the whole test delay and fake a race.
    await chooseApi(page); await organize(page);
    await peer.evaluate(() => localStorage.setItem("whiteboard.codex.v1", JSON.stringify({ fixtureMutation: "cross-page" })));
    await page.waitForFunction(() => document.querySelector("#organization-status")?.textContent?.includes("结果未应用"));
    assert.equal(await page.locator("#undo-organization").isVisible(), false, "stale cross-page result committed");
    assertNoJsErrors(jsErrors);
    record("U04-B", "PASS", "Second isolated tab localStorage change rejected delayed result in first tab.");
  } catch (error) {
    const shot = await screenshot("U04-B-failure", session.page);
    record("U04-B", "FAIL", safeError(error), { screenshot: shot });
  }
  finally { if (peer) await peer.close(); await closeSession(session); }
}

async function testUndo() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    await chooseApi(page);
    const button = page.locator("#organize-board");
    const dialog = page.locator("#organize-board-dialog");
    const opinion = page.locator("#organize-board-opinion");
    const confirm = page.locator("#confirm-organize-board");
    const savedOpinion = "此前保存的整理意见。";
    const newOpinion = "把实现细节放在对应模块下，保留图钉。";
    const requests = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/codex") {
        requests.push(request.postDataJSON());
      }
    });
    await openDetails(page, "organization-options");
    await page.locator("#organization-opinion").fill(savedOpinion);
    await button.click();
    await dialog.waitFor();
    assert.equal(await opinion.inputValue(), savedOpinion, "Existing board opinion did not appear in the dialog");
    assert.match(await page.locator("#organize-board-scope").innerText(), /3\s*张/);
    await opinion.fill(newOpinion);
    await page.locator("#cancel-organize-board").click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(requests.length, 0, "Opening and cancelling the dialog must not start a model request");
    assert.equal(await page.locator("#undo-organization").isVisible(), false);

    await button.click();
    assert.equal(await opinion.inputValue(), newOpinion, "Cancelled draft was not available after reopening");
    await confirm.click();
    await waitOrganizationSettled(page);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].scope, "organize");
    assert.ok(requests[0].question.endsWith(newOpinion), "The confirmed opinion did not reach the organizer");
    assert.ok(!requests[0].question.includes(savedOpinion), "The old opinion replaced the confirmed draft");
    assert.equal(await page.locator("#undo-organization").isVisible(), true, "successful organization exposed no undo");
    await page.locator("#undo-organization").click();
    await page.waitForFunction(() => document.querySelector("#organization-status")?.textContent?.includes("已撤销整理"));
    assert.equal(await page.locator("#undo-organization").isVisible(), false, "undo action did not restore pre-organization state");
    const shot = await screenshot("U03-success-undo", page);

    await button.click();
    await opinion.fill("");
    await confirm.click();
    await waitOrganizationSettled(page);
    assert.equal(requests.length, 2, "A blank opinion should still allow organization");
    assert.ok(!requests[1].question.includes(newOpinion) && !requests[1].question.includes(savedOpinion),
      "Clearing the opinion should not send an older draft");
    assertNoJsErrors(jsErrors);
    record("U03", "PASS", "The whole-board dialog shows the scope, restores the saved opinion and keeps a cancelled draft. Only confirmation sends an opinion or an explicit blank. The result can be undone.", { screenshot: shot });
  } catch (error) { record("U03", "FAIL", safeError(error)); await screenshot("U03-failure", session.page); }
  finally { await closeSession(session); }
}

async function testBranchCollapse() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const plan = candidate();
    plan.items[2].parentId = "E02";
    plan.items.push({ id: "E04", category: "reference", parentId: null, title: "Independent branch", summary: "Unrelated node" });
    plan.collapsedBranches = ["E02"];
    const storageKey = "whiteboard.codex.organization.v1";
    await page.evaluate(([key, current]) => localStorage.setItem(key, JSON.stringify({ current })), [storageKey, plan]);
    await page.reload();

    const card = (id) => page.locator(`[data-element-id="${id}"]`);
    const root = card("E01").locator(".branch-toggle");
    const child = card("E02").locator(".branch-toggle");
    await root.waitFor();
    assert.equal(await child.getAttribute("aria-expanded"), "false");
    assert.equal(await card("E03").isVisible(), false);
    await root.press("Enter");
    assert.equal(await root.textContent(), "展开下级 2");
    assert.equal(await card("E02").isVisible(), false);
    assert.equal(await card("E04").isVisible(), true);

    await page.reload();
    await root.waitFor();
    assert.equal(await root.getAttribute("aria-expanded"), "false");
    await root.click();
    assert.equal(await child.isVisible(), true);
    assert.equal(await card("E03").isVisible(), false);
    await child.click();
    assert.equal(await card("E03").isVisible(), true);
    await card("E02").locator(".module-fold").click();
    assert.equal(await card("E02").locator(".organized-body").isVisible(), false);
    assert.equal(await card("E03").isVisible(), true);
    const storedItems = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).current.items, storageKey);
    assert.deepEqual(storedItems.map(({ id, parentId }) => [id, parentId]), plan.items.map(({ id, parentId }) => [id, parentId]));
    assertNoJsErrors(jsErrors);
    record("U06", "PASS", "Nested branches persist across refresh and reopen one level at a time; content folding and relationships stay independent.");
  } catch (error) { record("U06", "FAIL", safeError(error)); await screenshot("U06-failure", session.page); }
  finally { await closeSession(session); }
}

async function testProjectTemplate() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const keys = ["whiteboard.codex.v1", "whiteboard.codex.organization.v1"];
    const before = [JSON.stringify({ project: { goal: "Existing project", decisions: [{ text: "Keep this decision", sourceIds: ["E01"] }] } }),
      JSON.stringify({ current: candidate() })];
    await page.evaluate(([keys, values]) => keys.forEach((key, index) => localStorage.setItem(key, values[index])), [keys, before]);
    // Load the injected fixture into this page before exercising replacement.
    // A hash navigation alone retains the previous, now stale in-memory board.
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${page.url()}#project-template`);
    const backup = page.locator("#restore-project-template");
    await page.locator("#install-project-template").click();
    await backup.waitFor();
    const visible = () => page.locator("#board [data-element-id]:visible").count();
    assert.equal(await visible(), 5);
    assert.equal(await page.locator('[data-element-id="E01"]').isVisible(), false);
    const stored = await page.evaluate((keys) => keys.map((key) => JSON.parse(localStorage.getItem(key))), keys);
    assert.equal(stored[1].current.items.length, 13);
    assert.deepEqual(stored[0].project.decisions, [{ text: "Keep this decision", sourceIds: [] }]);
    const screenshotPath = await screenshot("U07-project-template", page);
    await page.locator('[data-element-id="E05"] .branch-toggle').click();
    assert.equal(await visible(), 7);
    await backup.click();
    await page.locator('[data-element-id="E01"]').waitFor();
    const restored = await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), keys);
    assert.deepEqual(restored, before);
    assertNoJsErrors(jsErrors);
    record("U07", "PASS", "Template shows five overview cards and eight hidden details, with reversible local replacement and exact restoration.", { screenshot: screenshotPath });
  } catch (error) { record("U07", "FAIL", safeError(error)); await screenshot("U07-failure", session.page); }
  finally { await closeSession(session); }
}

const organizationKey = "whiteboard.codex.organization.v1";

async function seedDecomposition(page) {
  const plan = candidate();
  plan.layout.flow = "vertical";
  plan.positions.E03 = { x: 750, y: 275 };
  plan.items.push({ id: "E04", category: "reference", parentId: "E02", title: "Existing task", summary: "Keep this sibling." });
  plan.collapsedBranches = ["E02"];
  await page.evaluate(([key, current]) => localStorage.setItem(key, JSON.stringify({ current })), [organizationKey, plan]);
  await page.reload();
  await chooseApi(page);
  return plan;
}

async function sendDecomposition(page, id) {
  const card = page.locator(`[data-element-id="${id}"]`);
  await card.press("Enter");
  await page.locator("#ask-open").click();
  await page.locator("#question").fill("根据当前项目把这个模块拆出任务、依赖和验收标准。");
  const request = page.waitForRequest((entry) => entry.method() === "POST" && entry.url().endsWith("/api/codex") &&
    entry.postDataJSON().scope === "decompose", { timeout: 3_500 });
  const [submitted] = await Promise.all([request, page.locator("#submit-question").click()]);
  return submitted.postDataJSON();
}

function readOrganization(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)).current, organizationKey);
}

async function testDecomposition() {
  const session = await openPage("decompose");
  try {
    const { page, jsErrors } = session;
    const plan = await seedDecomposition(page);
    const request = await sendDecomposition(page, "E02");
    assert.equal(request.mode, "ask");
    assert.equal(request.board, undefined, "decomposition should not send a whole-board payload");
    assert.equal(request.decomposition.targetId, "E02");
    assert.deepEqual(request.decomposition.path.map(({ id }) => id), ["E01", "E02"]);
    assert.deepEqual(request.decomposition.existingChildren.map(({ id }) => id), ["E04"]);
    assert.ok(Number.isInteger(request.decomposition.limit) && request.decomposition.limit >= 1 && request.decomposition.limit <= 6);
    await page.getByText(firstTask.title, { exact: true }).waitFor();
    const current = await readOrganization(page);
    const task = current.items.find(({ title }) => title === firstTask.title);
    assert.equal(task.parentId, "E02");
    const { title: _, ...details } = firstTask;
    assert.deepEqual(task.taskDetails, details);
    assert.deepEqual(current.layout, plan.layout);
    assert.deepEqual(current.positions.E03, plan.positions.E03);
    assert.deepEqual(current.items.slice(0, plan.items.length), plan.items);
    const taskCard = page.locator(`[data-element-id="${task.id}"]`);
    assert.ok((await taskCard.innerText()).includes(firstTask.acceptance[0]));
    assert.ok((await taskCard.innerText()).includes(firstTask.dependencies[0]));

    const deeperRequest = await sendDecomposition(page, task.id);
    assert.equal(deeperRequest.decomposition.targetId, task.id);
    assert.deepEqual(deeperRequest.decomposition.path.map(({ id }) => id), ["E01", "E02", task.id]);
    await page.getByText(nextTask.title, { exact: true }).waitFor();
    const nested = (await readOrganization(page)).items.find(({ title }) => title === nextTask.title);
    assert.equal(nested.parentId, task.id);
    const nestedCard = page.locator(`[data-element-id="${nested.id}"]`);
    const toggle = page.locator('[data-element-id="E02"] .branch-toggle');
    await toggle.click();
    await nestedCard.waitFor({ state: "hidden" });
    await page.reload();
    await toggle.waitFor();
    assert.equal(await nestedCard.isVisible(), false);
    assert.equal(await page.locator('[data-element-id="E03"]').isVisible(), true);
    await toggle.click();
    await nestedCard.waitFor();
    await page.locator("#undo-organization").click();
    await nestedCard.waitFor({ state: "detached" });
    assert.equal((await readOrganization(page)).items.find(({ id }) => id === task.id).parentId, "E02");
    assertNoJsErrors(jsErrors);
    record("U08", "PASS", "The single Send path adds structured task cards directly under a selected module or task, with persistent branch folding.");
  } catch (error) { record("U08", "FAIL", safeError(error)); await screenshot("U08-failure", session.page); }
  finally { await closeSession(session); }
}

async function testUncommittedDecomposition(id, flow) {
  const session = await openPage(flow);
  try {
    const { page, jsErrors } = session;
    await seedDecomposition(page);
    const before = await readOrganization(page);
    await sendDecomposition(page, "E02");
    if (flow === "decompose-stale") {
      await page.evaluate(() => localStorage.setItem("whiteboard.codex.v1", JSON.stringify({ fixtureMutation: "stale decomposition" })));
    }
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    assert.equal(await page.getByText(firstTask.title, { exact: true }).count(), 0);
    assert.deepEqual(await readOrganization(page), before);
    assertNoJsErrors(jsErrors);
    const reason = flow === "decompose-stale" ? "A stale board revision" : "A stream missing its terminal event";
    record(id, "PASS", `${reason} prevented any child commit.`);
  } catch (error) { record(id, "FAIL", safeError(error)); await screenshot(`${id}-failure`, session.page); }
  finally { await closeSession(session); }
}

async function testRawBoardDecomposition() {
  const session = await openPage("decompose-raw");
  try {
    const { page, jsErrors } = session;
    await page.evaluate(() => {
      const rect = { x: 370, y: 500, width: 240, height: 120 };
      const note = { id: "A01", kind: "note", rect, sourceCardIds: ["E02"], anchors: [rect],
        payload: { question: "Existing comment", anchor: { elementIds: ["E02"], box: rect } },
        answer: "Existing comment content." };
      localStorage.setItem("whiteboard.codex.v1", JSON.stringify({ notes: [note] }));
    });
    await page.reload();
    await chooseApi(page);
    const originalFormula = page.locator('[data-element-id="E02"] code');
    const originalNote = page.getByText("Existing comment content.", { exact: true });
    const request = await sendDecomposition(page, "E02");
    assert.deepEqual(request.decomposition.existingChildren.map(({ id }) => id), ["A01"]);
    const task = page.getByText(firstTask.title, { exact: true });
    await task.waitFor();
    assert.equal(await originalFormula.isVisible(), true);
    assert.equal(await originalNote.isVisible(), true);
    await page.locator("#undo-organization").click();
    await task.waitFor({ state: "detached" });
    assert.equal(await originalFormula.isVisible(), true);
    assert.equal(await originalNote.isVisible(), true);
    assertNoJsErrors(jsErrors);
    record("U10", "PASS", "A raw board can add task nodes without replacing its existing card faces or comment, and undo restores the raw view.");
  } catch (error) { record("U10", "FAIL", safeError(error)); await screenshot("U10-failure", session.page); }
  finally { await closeSession(session); }
}

async function testPublishedGuide() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const guide = JSON.parse(await page.locator("#published-project-guide-data").textContent());
    const rootTitle = guide.items.find((item) => item.parentId === null).title;
    const orgKey = "whiteboard.codex.organization.v1";
    const memoryKey = "whiteboard.codex.v1";
    const original = candidate();
    const noteStorage = JSON.stringify({ project: { goal: "Keep existing project memory" } });
    await page.evaluate(([orgKey, memoryKey, current, memory]) => {
      localStorage.setItem(orgKey, JSON.stringify({ current }));
      localStorage.setItem(memoryKey, memory);
    }, [orgKey, memoryKey, original, noteStorage]);
    const url = new URL(page.url());
    url.searchParams.set("project-guide", guide.id);
    const root = page.getByText(rootTitle, { exact: true });
    await page.goto(url.href);
    await root.waitFor();
    const readPlan = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), orgKey);
    const imported = await readPlan();
    assert.equal(imported.appliedGuideId, guide.id);
    assert.equal(imported.current.items.length, original.items.length + guide.items.length);
    assert.deepEqual(imported.current.items.slice(0, original.items.length), imported.previous.items);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), memoryKey), noteStorage);
    await page.goto(url.href);
    await root.waitFor();
    assert.equal((await readPlan()).current.items.length, imported.current.items.length);
    await page.locator("#undo-organization").click();
    await root.waitFor({ state: "detached" });
    await page.goto(url.href);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("project-guide"));
    assert.equal(await root.count(), 0);
    assert.deepEqual((await readPlan()).current.items, imported.previous.items);
    assertNoJsErrors(jsErrors);
    record("U11", "PASS", "Explicit one-shot guide import adds a tree without replacing existing items or memory, and undo cannot be replayed accidentally.");
  } catch (error) { record("U11", "FAIL", safeError(error)); await screenshot("U11-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRebuiltProjectGuide() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    await page.setViewportSize({ width: 1440, height: 900 });
    const structure = JSON.parse(await page.locator("#project-structure-data").textContent({ timeout: 4000 }));
    const keys = ["whiteboard.codex.v1", "whiteboard.codex.organization.v1"];
    const rect = { x: 370, y: 500, width: 240, height: 120 };
    const oldNote = { id: "A01", kind: "note", rect, sourceCardIds: ["E02"], anchors: [rect],
      payload: { question: "Old comment", anchor: { elementIds: ["E02"], box: rect } }, answer: "Old comment text." };
    const oldGoal = "Keep the project goal";
    const before = [JSON.stringify({ project: { goal: oldGoal }, notes: [oldNote] }), JSON.stringify({ current: candidate() })];
    const readStorage = () => page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), keys);
    await page.evaluate(([keys, values]) => keys.forEach((key, index) => localStorage.setItem(key, values[index])), [keys, before]);
    const link = new URL(page.url());
    link.searchParams.set("rebuild-project", structure.id);
    await page.goto(link.href, { waitUntil: "networkidle" });
    await page.locator("#restore-project-guide").waitFor({ state: "attached", timeout: 4000 });
    const [memory, stored] = (await readStorage()).map(JSON.parse);
    const current = stored.current;
    const treeShape = ({ id, title, parentId }) => [id, title, parentId];
    assert.deepEqual(current.items.map(treeShape), structure.items.map(treeShape));
    assert.equal(memory.project.goal, oldGoal);
    assert.deepEqual(memory.notes, []);
    const rootId = current.projectGuide.rootId;
    const modules = current.items.filter(({ parentId }) => parentId === rootId);
    assert.equal(modules.length, 3);
    const [product, system, delivery] = [/产品/u, /系统/u, /交付/u].map((label) => modules.find(({ title }) => label.test(title)));
    assert.ok(product && system && delivery, "the overview must expose separate product, system and delivery sections");

    const visible = page.locator("#board [data-element-id]:visible");
    const boxes = () => visible.evaluateAll((cards) => cards.map((card) => {
      const { left, right, top, bottom } = card.getBoundingClientRect();
      return { id: card.dataset.elementId, left, right, top, bottom };
    }));
    const checkVisible = async (expected) => {
      const cards = await boxes();
      assert.equal(cards.length, expected);
      const viewport = await page.locator("#viewport").boundingBox();
      for (const [index, a] of cards.entries()) {
        assert.ok(a.left >= viewport.x - 2 && a.right <= viewport.x + viewport.width + 2 &&
          a.top >= viewport.y - 2 && a.bottom <= viewport.y + viewport.height + 2, `${a.id} is outside the fitted viewport`);
        for (const b of cards.slice(index + 1)) {
          assert.ok(a.right <= b.left + 2 || b.right <= a.left + 2 || a.bottom <= b.top + 2 || b.bottom <= a.top + 2,
            `${a.id} overlaps ${b.id}`);
        }
      }
      return new Map(cards.map((card) => [card.id, card]));
    };
    const overview = await checkVisible(4);
    const root = overview.get(rootId);
    const lanes = modules.map(({ id }) => overview.get(id)).sort((a, b) => a.left - b.left);
    assert.ok(lanes.every(({ top }) => top > root.bottom && Math.abs(top - lanes[0].top) <= 2), "modules must align below the root");
    assert.ok(lanes.every((lane, i) => !i || lane.left > lanes[i - 1].right), "modules must use separate horizontal lanes");
    assert.ok(Math.abs(root.left + root.right - lanes[0].left - lanes.at(-1).right) <= 8, "root must be centered over modules");
    const shot = await screenshot("U12-project-structure-overview", page);

    const byId = new Map(current.items.map((item) => [item.id, item]));
    const ancestors = (item) => {
      const path = [];
      for (let id = item.parentId; id; id = byId.get(id).parentId) path.unshift(id);
      return path;
    };
    const milestones = current.items.filter(({ parentId, title }) => parentId === delivery.id &&
      /^(?:里程碑\s*)?M\d+\s*[｜|]/u.test(title));
    assert.ok(milestones.length >= 2, "delivery must include separate milestone nodes");
    const task = current.items.find((item) => milestones.some(({ id }) => item.parentId === id) &&
      ancestors(item).length >= 3 && item.taskDetails?.dependencies?.length && item.taskDetails.acceptance?.length);
    assert.ok(task, "a depth-3 milestone task must specify both a dependency and acceptance criteria");
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const show = async (item) => {
      for (const id of ancestors(item)) {
        const toggle = card(id).locator('.branch-toggle[aria-expanded="false"]');
        if (await toggle.count()) await toggle.click();
      }
      await card(item.id).waitFor();
    };
    for (const milestone of milestones) {
      await show(milestone);
      assert.equal(await card(milestone.id).locator(".organized-title").textContent(), milestone.title);
    }
    await show(task);
    const taskModule = ancestors(task)[1];
    const [taskBox, lane] = await Promise.all([card(task.id).boundingBox(), card(taskModule).boundingBox()]);
    assert.ok(taskBox.y > lane.y + lane.height && taskBox.x + taskBox.width / 2 > lane.x &&
      taskBox.x + taskBox.width / 2 < lane.x + lane.width, "expanded task must stay below its own section");
    const foldedTask = card(task.id).locator('.module-fold[aria-expanded="false"]');
    if (await foldedTask.count()) await foldedTask.click();
    const taskBody = card(task.id).locator(".task-details");
    for (const text of ["依赖", "验收标准", task.taskDetails.dependencies[0], task.taskDetails.acceptance[0]]) {
      assert.equal(await taskBody.getByText(text, { exact: true }).isVisible(), true);
    }
    await card(taskModule).locator(".branch-toggle").click();
    assert.equal(await card(task.id).isVisible(), false);
    await show(task);

    await openDetails(page, "sidebar-tools", "project-template");
    await page.locator("#restore-project-guide").click();
    await page.locator('[data-element-id="E01"]').waitFor();
    assert.deepEqual(await readStorage(), before);
    assertNoJsErrors(jsErrors);
    record("U12", "PASS", "Project rebuild preserves the full product, system and delivery hierarchy, reveals milestones and task dependencies/acceptance in their own lanes, and restores the exact old board.", { screenshot: shot });
  } catch (error) { record("U12", "FAIL", safeError(error)); await screenshot("U12-failure", session.page); }
  finally { await closeSession(session); }
}

async function testBoardSwitcher() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const switcher = page.locator("#board-switcher");
    await switcher.waitFor({ timeout: 4000 });
    assert.equal(await switcher.inputValue(), "original");
    const structure = JSON.parse(await page.locator("#project-structure-data").textContent());
    const root = structure.items.find(({ parentId }) => parentId === null);
    const section = structure.items.find(({ parentId }) => parentId === root.id);
    const child = structure.items.find(({ parentId }) => parentId === section.id);
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const originalKeys = ["whiteboard.codex.v1", "whiteboard.codex.organization.v1"];
    const readOriginal = () => page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), originalKeys);
    const goal = page.locator("#project-goal");
    const opinion = page.locator("#organization-opinion");
    const originalGoal = "Existing whiteboard goal stays here.";
    const originalOpinion = "Existing whiteboard layout notes.";
    const projectGoal = "Project-design board goal stays here.";
    const projectOpinion = "Project-design board layout notes.";
    const originalComment = "Existing whiteboard comment stays here.";
    await page.evaluate(([key, answer]) => {
      const rect = { x: 370, y: 500, width: 240, height: 120 };
      localStorage.setItem(key, JSON.stringify({ notes: [{ id: "A01", kind: "note", rect, sourceCardIds: ["E02"], anchors: [rect],
        payload: { question: "Old comment", anchor: { elementIds: ["E02"], box: rect } }, answer }] }));
    }, [originalKeys[0], originalComment]);
    await page.reload();
    await card("A01").getByText(originalComment, { exact: true }).waitFor();
    await openDetails(page, "sidebar-tools", "project-memory");
    await goal.fill(originalGoal);
    await openDetails(page, "organization-options");
    await opinion.fill(originalOpinion);
    const before = await readOriginal();

    const select = (board) => Promise.all([
      page.waitForURL((url) => url.searchParams.get("board") === board, { timeout: 4000 }),
      switcher.selectOption(board),
    ]);
    await select("project-design");
    await card(root.id).locator(".organized-title").waitFor();
    assert.equal(await switcher.inputValue(), "project-design");
    assert.equal(await card(root.id).locator(".organized-title").textContent(), root.title);
    assert.equal(await page.locator("#board [data-element-id]:visible").count(), 4);
    assert.deepEqual((await page.locator("#board .organized-title").allTextContents()).sort(), structure.items.map(({ title }) => title).sort());
    assert.equal(await card("A01").count(), 0);
    assert.deepEqual(await readOriginal(), before);
    await openDetails(page, "sidebar-tools", "project-memory");
    await goal.fill(projectGoal);
    await openDetails(page, "organization-options");
    await opinion.fill(projectOpinion);
    await card(section.id).locator('.branch-toggle[aria-expanded="false"]').click();
    await card(child.id).waitFor();
    assert.deepEqual(await readOriginal(), before);

    await select("original");
    await card("E01").waitFor();
    await card("A01").getByText(originalComment, { exact: true }).waitFor();
    assert.equal(await goal.inputValue(), originalGoal);
    assert.equal(await opinion.inputValue(), originalOpinion);
    assert.equal(await card(root.id).count(), 0);
    assert.deepEqual(await readOriginal(), before);

    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/?board=project-design", { waitUntil: "networkidle" });
    await card(child.id).waitFor();
    assert.equal(await switcher.inputValue(), "project-design");
    assert.equal(await goal.inputValue(), projectGoal);
    assert.equal(await opinion.inputValue(), projectOpinion);
    assert.deepEqual(await readOriginal(), before);
    assertNoJsErrors(jsErrors);
    const shot = await screenshot("U13-project-board-switcher", page);
    record("U13", "PASS", "The visible switcher and direct link select an independent project board, with edits and branch state saved separately from the original.", { screenshot: shot });
  } catch (error) { record("U13", "FAIL", safeError(error)); await screenshot("U13-failure", session.page); }
  finally { await closeSession(session); }
}

async function testBoardLifecycle() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const switcher = page.locator("#board-switcher");
    const goal = page.locator("#project-goal");
    const opinion = page.locator("#organization-opinion");
    const createDialog = page.locator("#board-create-dialog");
    const deleteDialog = page.locator("#board-delete-dialog");
    const optionIds = () => switcher.locator("option").evaluateAll((options) => options.map((option) => option.value));
    const readBoardStorage = (id) => page.evaluate((id) => {
      const prefix = id === "original" ? "whiteboard.codex" : "whiteboard.codex." + id;
      return ["v1", "organization.v1", "template-backup.v1", "project-guide-backup.v1"]
        .map((suffix) => localStorage.getItem(prefix + "." + suffix));
    }, id);
    const switchBoard = async (id) => {
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("board") === id),
        switcher.selectOption(id),
      ]);
      assert.equal(await switcher.inputValue(), id);
    };
    const openAction = async (action) => {
      await page.locator("#board-manage").click();
      await page.locator("#board-actions").waitFor();
      await page.locator(action).click();
    };
    const removeCurrent = async (id, name) => {
      await openAction("#board-delete");
      await deleteDialog.waitFor();
      assert.equal((await page.locator("#board-delete-name").textContent()).trim(), name);
      await page.locator("#board-delete-confirm").click();
      await page.locator("#local-projects").waitFor();
      assert.equal(await page.evaluate((deleted) => BoardMemory.listBoards().some(({ id }) => id === deleted), id), false);
      assert.deepEqual(await readBoardStorage(id), [null, null, null, null]);
    };

    const presets = ["original", "project-design", "repo-manual", "repo-atlas", "project-workbench"];
    assert.deepEqual((await optionIds()).sort(), presets.toSorted());
    await page.evaluate(() => {
      const rect = { x: 370, y: 500, width: 240, height: 120 };
      localStorage.setItem("whiteboard.codex.v1", JSON.stringify({
        notes: [{ id: "A01", kind: "note", rect, sourceCardIds: ["E02"], anchors: [rect],
          payload: { question: "原始白板的批注", anchor: { elementIds: ["E02"], box: rect } },
          answer: "原始白板的批注应独立保留。" }],
      }));
    });
    await page.reload();
    await openDetails(page, "sidebar-tools", "project-memory");
    await goal.fill("原始白板的目标只存在于原始白板。");
    await openDetails(page, "organization-options");
    await opinion.fill("保留原始白板的排布意见。");
    const original = await readBoardStorage("original");
    await switchBoard("project-design");
    const projectName = (await switcher.locator("option:checked").textContent()).trim();
    const projectGoal = "项目定义白板的局部目标。";
    await openDetails(page, "sidebar-tools", "project-memory");
    await goal.fill(projectGoal);
    await openDetails(page, "organization-options");
    await opinion.fill("保留项目定义白板的排布意见。");
    const project = await readBoardStorage("project-design");

    await openAction("#board-create");
    await createDialog.waitFor();
    await page.locator("#board-name").fill("取消的新白板");
    await page.locator("#board-create-cancel").click();
    await createDialog.waitFor({ state: "hidden" });
    assert.equal(await switcher.inputValue(), "project-design");
    assert.deepEqual((await optionIds()).sort(), presets.toSorted());

    const name = "接口设计草稿";
    await openAction("#board-create");
    assert.equal(await page.locator("#board-name").inputValue(), "");
    await page.locator("#board-name").fill(name);
    await Promise.all([
      page.waitForURL((url) => /^board-[a-f0-9]+$/.test(url.searchParams.get("board") || "")),
      page.locator("#board-create-submit").click(),
    ]);
    const customId = new URL(page.url()).searchParams.get("board");
    assert.equal(await switcher.inputValue(), customId);
    assert.equal((await switcher.locator("option:checked").textContent()).trim(), name);
    assert.equal((await page.locator("#canvas-title").textContent()).trim(), name);
    assert.equal(await page.locator("#board [data-element-id]:visible").count(), 0, "Custom boards must start blank");
    assert.equal(await goal.inputValue(), "");
    assert.equal(await page.locator("#project-constraints").inputValue(), "");
    assert.deepEqual(await readBoardStorage("original"), original);
    assert.deepEqual(await readBoardStorage("project-design"), project);

    const customGoal = "只讨论这个白板的接口设计。";
    const cardName = "接口兼容约束";
    await openDetails(page, "sidebar-tools", "project-memory");
    await goal.fill(customGoal);
    await page.locator("#new-card").click();
    await page.locator("#workbench-card-title").fill(cardName);
    await page.locator("#workbench-card-body").fill("保留旧接口的字段名。");
    await page.locator("#save-workbench-card").click();
    const card = page.locator("#board").getByText(cardName, { exact: true });
    await card.waitFor();
    const custom = await readBoardStorage(customId);

    await switchBoard("project-design");
    assert.equal(await goal.inputValue(), projectGoal);
    assert.equal(await card.count(), 0);
    assert.deepEqual(await readBoardStorage("project-design"), project);
    assert.deepEqual(await readBoardStorage(customId), custom);
    await switchBoard(customId);
    await page.reload();
    await card.waitFor();
    assert.equal(await switcher.inputValue(), customId);
    assert.equal(await goal.inputValue(), customGoal);
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.locator("#local-projects").waitFor();
    await page.locator(`#home-board-list a[href*="board=${customId}"]`).click();
    await card.waitFor();
    assert.equal(await switcher.inputValue(), customId, "Saved independent boards must reopen from the homepage");

    await openAction("#board-delete");
    await deleteDialog.waitFor();
    assert.equal((await page.locator("#board-delete-name").textContent()).trim(), name);
    await page.locator("#board-delete-cancel").click();
    await deleteDialog.waitFor({ state: "hidden" });
    assert.equal(await switcher.inputValue(), customId);
    await card.waitFor();
    assert.deepEqual(await readBoardStorage(customId), custom);

    const peer = await session.context.newPage();
    await peer.goto(origin + "/?board=" + customId, { waitUntil: "networkidle" });
    await peer.locator("#board").getByText(cardName, { exact: true }).waitFor();
    await openDetails(peer, "sidebar-tools", "project-memory");
    await removeCurrent(customId, name);
    await peer.locator("#storage-conflict").waitFor();
    assert.equal(await peer.locator('#board-switcher option[value="' + customId + '"]').count(), 0,
      "Another tab must refresh its board catalog when a board is deleted");
    await peer.locator("#project-goal").fill("在旧标签页编辑时，已删除的白板不能复活。");
    assert.deepEqual(await readBoardStorage(customId), [null, null, null, null]);
    peer.once("dialog", (dialog) => { void dialog.accept(); });
    await Promise.all([
      peer.waitForURL((url) => url.searchParams.get("board") === "project-design"),
      peer.locator("#board-switcher").selectOption("project-design"),
    ]);
    assert.equal(await peer.locator("#project-goal").inputValue(), projectGoal);
    await peer.close();
    assert.equal(await card.count(), 0);
    assert.deepEqual(await readBoardStorage("original"), original);
    assert.deepEqual(await readBoardStorage("project-design"), project);
    await page.goto(origin + "/?board=" + customId, { waitUntil: "networkidle" });
    await page.locator("#local-projects").waitFor();
    assert.equal(await page.locator("#home-board-list").getByText(name, { exact: true }).count(), 0);
    assert.deepEqual(await readBoardStorage(customId), [null, null, null, null]);

    await page.goto(origin + "/?board=project-design", { waitUntil: "networkidle" });
    await removeCurrent("project-design", projectName);
    await page.goto(origin + "/?board=project-design", { waitUntil: "networkidle" });
    await page.locator("#local-projects").waitFor();
    assert.ok(!(await page.evaluate(() => BoardMemory.listBoards().some(({ id }) => id === "project-design"))),
      "A deleted preset must not reappear when its URL is reopened");
    assert.deepEqual(await readBoardStorage("project-design"), [null, null, null, null]);
    assert.deepEqual(await readBoardStorage("original"), original);
    assertNoJsErrors(jsErrors);
    record("U50", "PASS", "Create, switch, reload, cancel, and delete share one board control. New boards start blank, other boards keep their data, and deleted custom boards and presets cannot reopen or be resurrected from a stale tab.");
  } catch (error) { record("U50", "FAIL", safeError(error)); await screenshot("U50-failure", session.page); }
  finally { await closeSession(session); }
}

async function testLastBoardLifecycle() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const switcher = page.locator("#board-switcher");
    const home = page.locator("#local-projects");
    const ids = await switcher.locator("option").evaluateAll((options) => options.map((option) => option.value));
    assert.equal(ids.length, 5);
    for (const [index, id] of ids.entries()) {
      assert.equal(await switcher.inputValue(), id);
      await page.locator("#board-manage").click();
      await page.locator("#board-actions").waitFor();
      await page.locator("#board-delete").click();
      await page.locator("#board-delete-dialog").waitFor();
      await page.locator("#board-delete-confirm").click();
      await home.waitFor();
      const next = ids[index + 1];
      if (next) {
        await openDetails(page, "home-examples");
        await page.locator(`#home-example-list a[href*="board=${next}"]`).click();
        await page.waitForURL((url) => url.searchParams.get("board") === next);
        assert.equal(await switcher.inputValue(), next);
      }
    }
    await page.reload();
    await home.waitFor();
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/?board=original", { waitUntil: "networkidle" });
    await home.waitFor();
    assert.equal(await page.locator("#board [data-element-id]:visible").count(), 0);

    await page.locator("#home-create-board").click();
    await page.locator("#board-create-dialog").waitFor();
    await page.locator("#board-name").fill("重新开始");
    await Promise.all([
      page.waitForURL((url) => /^board-[a-f0-9]+$/.test(url.searchParams.get("board") || "")),
      page.locator("#board-create-submit").click(),
    ]);
    assert.equal(await switcher.locator("option").count(), 1);
    assert.equal((await switcher.locator("option:checked").textContent()).trim(), "重新开始");
    assert.equal(await page.locator("#board [data-element-id]:visible").count(), 0);
    assert.equal(await home.isVisible(), false);
    assertNoJsErrors(jsErrors);
    record("U51", "PASS", "Removing all boards returns home, where a stale board link cannot restore a removed board and a new blank board can be created.");
  } catch (error) { record("U51", "FAIL", safeError(error)); await screenshot("U51-failure", session.page); }
  finally { await closeSession(session); }
}

async function testBoardRepositoryBinding() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const firstInput = "C:\\fixture\\项目 甲\\";
    const firstPath = "C:\\fixture\\项目 甲";
    const secondPath = "D:\\fixture\\project-b";
    const replacementPath = "E:\\fixture\\project-c";
    const requests = [];
    const validations = [];
    const switcher = page.locator("#board-switcher");
    const repositoryDialog = page.locator("#board-repository-dialog");
    const repositoryInput = page.locator("#board-repository-path");
    const projectError = "测试路径必须是存在的本地绝对目录。";

    await page.route("**/api/repository", async (route) => {
      const request = route.request();
      assert.equal(request.method(), "POST");
      const { repositoryPath } = request.postDataJSON();
      validations.push(repositoryPath);
      if (repositoryPath === "relative-directory") {
        await route.fulfill({ status: 400, json: { type: "error", text: projectError } });
      } else {
        assert.ok([firstInput, secondPath, replacementPath].includes(repositoryPath));
        await route.fulfill({ json: { repositoryPath: repositoryPath === firstInput ? firstPath : repositoryPath } });
      }
    });
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const text = request.scope === "plan" ? '{"action":"ask"}' : `项目目录验收回答 ${requests.length}`;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text }, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    const openAction = async (id) => {
      await page.locator("#board-manage").click();
      await page.locator(`#${id}`).click();
    };
    const create = async (name, repositoryPath) => {
      const previous = await switcher.inputValue();
      await openAction("board-create");
      await page.locator("#board-name").fill(name);
      await page.locator("#board-create-repository-path").fill(repositoryPath);
      await Promise.all([
        page.waitForURL((url) => {
          const id = url.searchParams.get("board");
          return id !== previous && /^board-[a-f0-9]+$/.test(id || "");
        }),
        page.locator("#board-create-submit").click(),
      ]);
      await page.getByRole("heading", { name, exact: true }).waitFor();
      return switcher.inputValue();
    };
    const switchBoard = async (id) => {
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("board") === id),
        switcher.selectOption(id),
      ]);
      assert.equal(await switcher.inputValue(), id);
    };
    const inspectPath = async (expected) => {
      await openAction("board-repository");
      await repositoryDialog.waitFor();
      assert.equal(await repositoryInput.inputValue(), expected);
    };
    const cancelEdit = async () => {
      await page.locator("#board-repository-cancel").click();
      await repositoryDialog.waitFor({ state: "hidden" });
    };
    const savePath = async (value) => {
      await repositoryInput.fill(value);
      await page.locator("#board-repository-submit").click();
      await repositoryDialog.waitFor({ state: "hidden" });
    };
    const addCard = async (title) => {
      await page.locator("#new-card").click();
      await page.locator("#workbench-card-title").fill(title);
      await page.locator("#workbench-card-body").fill("分析项目模块之间的调用关系。");
      await page.locator("#save-workbench-card").click();
      const card = page.locator("#board [data-element-id]").filter({ has: page.getByText(title, { exact: true }) });
      await card.waitFor();
      return card.getAttribute("data-element-id");
    };
    const chooseBackend = async (backend) => {
      await page.locator(".connection-settings > summary").click();
      await page.locator("#backend-select").selectOption(backend);
      await page.locator(".connection-settings > summary").click();
    };
    const ask = async (cardId, backend, repositoryPath) => {
      const before = requests.length;
      await page.locator(`#board [data-element-id="${cardId}"]`).press("Enter");
      await page.locator("#ask-open").click();
      assert.equal(await page.locator("#source-edit-consent").isVisible(), backend !== "api" && !repositoryPath);
      await page.locator("#question").fill(`请分析项目目录和模块关系 ${before}`);
      await page.locator("#submit-question").click();
      await page.getByText(`项目目录验收回答 ${before + 2}`, { exact: true }).waitFor();
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
      const turns = requests.slice(before);
      assert.equal(turns.length, 2);
      assert.equal(turns[0].scope, "plan");
      for (const turn of turns) {
        assert.equal(turn.backend, backend);
        assert.equal(turn.mode, "ask");
        if (repositoryPath) assert.equal(turn.repositoryPath, repositoryPath);
        else assert.equal(Object.hasOwn(turn, "repositoryPath"), false);
        if (backend === "api") assert.ok(!JSON.stringify(turn).includes(JSON.stringify(replacementPath)));
      }
    };

    const initialBoard = await switcher.inputValue();
    await openAction("board-create");
    await page.locator("#board-name").fill("目录无效的白板");
    await page.locator("#board-create-repository-path").fill("relative-directory");
    await page.locator("#board-create-submit").click();
    await page.locator("#board-create-error").waitFor();
    assert.equal(await page.locator("#board-create-error").textContent(), projectError);
    await page.locator("#board-create-cancel").click();
    assert.equal(await switcher.inputValue(), initialBoard);
    assert.equal(await switcher.getByRole("option", { name: "目录无效的白板" }).count(), 0);

    const firstBoard = await create("项目甲", firstInput);
    const firstCard = await addCard("项目甲模块");
    await inspectPath(firstPath);
    await cancelEdit();
    await ask(firstCard, "codex", firstPath);

    const secondBoard = await create("项目乙", secondPath);
    const secondCard = await addCard("项目乙模块");
    await page.reload({ waitUntil: "networkidle" });
    await inspectPath(secondPath);
    await cancelEdit();
    await chooseBackend("zcode");
    await ask(secondCard, "zcode", secondPath);

    await switchBoard(firstBoard);
    await inspectPath(firstPath);
    await repositoryInput.fill("relative-directory");
    await page.locator("#board-repository-submit").click();
    await page.locator("#board-repository-error").waitFor();
    assert.equal(await page.locator("#board-repository-error").textContent(), projectError);
    await cancelEdit();
    await inspectPath(firstPath);
    await savePath(replacementPath);
    await chooseBackend("codex");
    await ask(firstCard, "codex", replacementPath);
    await chooseApi(page);
    await ask(firstCard, "api");

    await switchBoard(secondBoard);
    await inspectPath(secondPath);
    await savePath("");
    await page.reload({ waitUntil: "networkidle" });
    await inspectPath("");
    await cancelEdit();
    await chooseBackend("codex");
    await ask(secondCard, "codex");
    await switchBoard(firstBoard);
    await inspectPath(replacementPath);
    await cancelEdit();
    await switchBoard("original");
    await inspectPath("");
    await cancelEdit();
    assert.deepEqual(validations, ["relative-directory", firstInput, secondPath, "relative-directory", replacementPath]);
    const isValidationError = (entry) => /Failed to load resource:.*400/.test(entry);
    assert.ok(jsErrors.filter(isValidationError).length <= 2);
    assertNoJsErrors(jsErrors.filter((entry) => !isValidationError(entry)));
    record("U55", "PASS", "A board-specific project directory is validated on create and edit, survives reload and switching, scopes Codex/ZCode analysis only, and can be cleared to restore default behavior.");
  } catch (error) { record("U55", "FAIL", safeError(error)); await screenshot("U55-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRepositoryInitialization() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const repositoryPath = "C:\\fixture\\项目介绍";
    const requests = [];
    const initialize = page.locator("#initialize-repository");
    const boardCards = page.locator("#board [data-generated-module]");
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const organization = () => page.evaluate(() => JSON.parse(localStorage.getItem(BoardMemory.storageKeys.organization)));
    await page.route("**/api/repository", (route) => route.fulfill({ json: { repositoryPath } }));
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const [root, purpose, flow, tests, ...reserved] = request.board.newIds;
      const topics = [
        [purpose, "服务谁", "输入是什么", "输出及边界"],
        [flow, "入口怎样处理请求", "业务逻辑如何选择", "错误怎样返回"],
        [tests, "验证关键链路", "边缘条件和回退", "从哪里运行验收"],
      ];
      const detail = reserved[3];
      const testDetail = reserved[6];
      const [source, testSource] = reserved.slice(-2);
      const item = (id, parentId, title, summary) => ({
        id, parentId, title, summary, category: parentId ? "reference" : "main", side: "auto", sources: [],
      });
      const map = {
        title: "工程介绍",
        summary: "从入口到验证的源码导览。",
        layout: { flow: "horizontal", density: "compact" },
        projectStructure: {
          version: 1, rootId: root, title: "从打开工程到验证",
          zones: [
            { id: "entry", title: "用途", role: "entry", size: "medium", lane: 0, nodes: [
              { id: "overview", cardId: root, label: "认识工程" }, { id: "purpose", cardId: purpose, label: "了解输入输出" },
            ] },
            { id: "execution", title: "运行与验收", role: "capability", size: "large", lane: 1, nodes: [
              { id: "flow", cardId: flow, label: "运行入口" }, { id: "tests", cardId: tests, label: "核对结果" },
            ] },
          ],
          links: [{ from: "flow", to: "tests", label: "复核输出", kind: "main", evidence: testDetail }],
        },
        items: [
          item(root, null, "样例工程", "`README.md` 描述工程面向谁。"),
          item(purpose, root, "工程用途", "`README.md` 描述输入和输出。"),
          item(flow, root, "运行链路", "`src/main.py` 负责入口调度。"),
          item(tests, root, "验证方式", "`tests/test_main.py` 覆盖入口调用。"),
          ...topics.flatMap(([parent, ...titles], chapter) => titles.map((title, index) =>
            item(reserved[chapter * 3 + index], parent, title, "本主题核对了 `src/main.py`。"))),
          { ...item(source, detail, "源码｜main.py", "本主题引用的源码片段。"),
            codePreview: { path: "src/main.py", text: "def run():\n    return 61" } },
          { ...item(testSource, testDetail, "源码｜test_main.py", "本主题引用的源码片段。"),
            codePreview: { path: "tests/test_main.py", text: "def test_run():\n    assert run() == 61" } },
        ],
      };
      const events = [{ type: "map", map }];
      if (requests.length > 1) events.push({ type: "done" });
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });
    assert.equal(await initialize.isVisible(), false, "The built-in board already has content");
    await page.locator("#board-manage").click();
    await page.locator("#board-create").click();
    await page.locator("#board-name").fill("工程介绍验收");
    await page.locator("#board-create-repository-path").fill(repositoryPath);
    await Promise.all([
      page.waitForURL((url) => /^board-[a-f0-9]+$/.test(url.searchParams.get("board") || "")),
      page.locator("#board-create-submit").click(),
    ]);
    await initialize.waitFor();
    const id = await page.locator("#board-switcher").inputValue();
    await chooseApi(page);
    assert.equal(await initialize.isDisabled(), true, "API direct must not offer local source analysis");
    assert.deepEqual(requests, []);
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();

    const run = async () => {
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/codex")),
        initialize.click(),
      ]);
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
    };
    await run();
    assert.equal(await initialize.isEnabled(), true, "An incomplete stream should allow retry");
    assert.equal(await boardCards.count(), 0, "An incomplete map must not appear on the canvas");
    assert.deepEqual((await organization())?.current?.items ?? [], []);

    await run();
    await initialize.waitFor({ state: "hidden" });
    await page.locator(".research-structure").getByRole("heading", { name: "从打开工程到验证", exact: true }).waitFor();
    assert.equal(await page.locator(".research-structure .research-edge").count(), 1);
    const legacyCanvas = new URL(page.url());
    legacyCanvas.searchParams.set("presentation", "cards");
    await page.goto(legacyCanvas.href, { waitUntil: "networkidle" });
    assert.equal(requests.length, 2, "Initialization must go directly to the generation request");
    for (const request of requests) {
      assert.equal(request.backend, "zcode");
      assert.equal(request.mode, "ask");
      assert.equal(request.scope, "organize");
      assert.equal(request.boardIntent, "repository_init");
      assert.equal(request.boardId, id);
      assert.equal(request.repositoryPath, repositoryPath);
      assert.deepEqual(request.board.nodes, []);
      assert.equal(request.board.newIds.length, 23);
      assert.equal(new Set(request.board.newIds).size, 23);
      assert.equal(Object.hasOwn(request, "api"), false);
    }
    const [root, purpose, flow, tests, ...reserved] = requests[1].board.newIds;
    const detail = reserved[3];
    const testDetail = reserved[6];
    const [source, testSource] = reserved.slice(-2);
    const parentRelations = [[root, null], [purpose, root], [flow, root], [tests, root],
      ...reserved.slice(0, 9).map((id, index) => [id, [purpose, flow, tests][Math.floor(index / 3)]]),
      [source, detail], [testSource, testDetail]];
    assert.deepEqual((await organization()).current.items.map(({ id, parentId }) => [id, parentId]), parentRelations);
    const diagram = (await organization()).current.projectStructure;
    assert.equal(diagram.rootId, root);
    assert.deepEqual(diagram.links, [{ from: "flow", to: "tests", label: "复核输出", kind: "main", evidence: testDetail }]);
    const branch = card(flow).locator(".branch-toggle");
    assert.equal(await branch.getAttribute("aria-expanded"), "false");
    assert.equal(await card(detail).isVisible(), false);
    await branch.press("Enter");
    await card(detail).waitFor();
    assert.equal(await card(source).isVisible(), false, "Opening an ability should reveal its topics before their evidence");
    await card(detail).locator(".branch-toggle").press("Enter");
    await card(source).waitFor();
    await card(tests).locator(".branch-toggle").press("Enter");
    await card(testDetail).locator(".branch-toggle").press("Enter");
    await card(testSource).waitFor();
    const code = card(source).locator(".organized-code-preview");
    assert.equal(await code.isVisible(), false, "Keep source bodies folded at first");
    await card(source).locator(".module-fold").press("Enter");
    assert.equal(await code.innerText(), "def run():\n    return 61");
    await branch.press("Enter");
    assert.equal(await card(source).isVisible(), false);
    await branch.press("Enter");
    await card(detail).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await card(detail).waitFor();
    assert.equal(await code.innerText(), "def run():\n    return 61");
    assert.deepEqual((await organization()).current.projectStructure, diagram);
    assert.deepEqual((await organization()).current.items.map(({ id, parentId }) => [id, parentId]), parentRelations);
    await page.locator("#undo-organization").click();
    await initialize.waitFor();
    assert.equal(await boardCards.count(), 0, "Undo should restore the empty canvas");
    await page.reload({ waitUntil: "networkidle" });
    await initialize.waitFor();
    assert.equal(await boardCards.count(), 0, "Reload must preserve the restored empty canvas");
    assert.equal(await page.locator("#board-repository-label").getAttribute("title"), repositoryPath);
    assertNoJsErrors(jsErrors);
    record("U56", "PASS", "A ZCode-bound empty board initializes chapters and folded source cards, rejects incomplete results, disables local analysis on API, and persists expansion and undo.");
  } catch (error) { record("U56", "FAIL", safeError(error)); await screenshot("U56-failure", session.page); }
  finally { await closeSession(session); }
}

async function testExecutionTrace() {
  const session = await openPage("execution-trace", "repo-atlas");
  const pendingReleases = [];
  const hold = () => new Promise((release) => pendingReleases.push(release));
  try {
    const { page, jsErrors } = session;
    const answer = "合成回答：入口函数会读取项目配置。";
    const failure = "合成工具执行失败";
    const code = "def load_settings():\n    return '<fixture-tag>'";
    const readPath = "repository/src/settings.py";
    const readLabel = "正在读取项目配置入口";
    const failedLabel = "项目工具调用失败";
    const cancelledLabel = "正在搜索项目用例";
    const staleLabel = "来自旧请求的事件";
    const privateMarker = "假造的内部推理内容";
    const executions = [];
    const showCode = hold();
    const finishAnswer = hold();
    const finishError = hold();
    const finishCancellation = hold();

    executionTraceFixture = async (request, response) => {
      const meta = { requestId: request.requestId, baseRevision: request.baseRevision };
      const send = (event) => {
        if (!response.destroyed && !response.writableEnded) stream(response, { ...meta, ...event });
      };
      if (request.scope === "plan") {
        send({ type: "answer", text: '{"action":"ask"}' });
        send({ type: "done" });
      } else {
        executions.push(request);
        if (executions.length === 1) {
          send({ type: "trace", step: "read-settings", kind: "read", state: "running", path: readPath, text: readLabel });
          await showCode;
          send({ type: "trace", step: "read-settings", kind: "read", state: "done", path: readPath,
            text: "已读取项目配置入口", detail: code, detailKind: "code" });
          send({ type: "reasoning", text: privateMarker });
          await finishAnswer;
          send({ type: "answer", text: answer });
          send({ type: "done" });
        } else if (executions.length === 2) {
          send({ type: "trace", step: "late-read", kind: "read", state: "done",
            requestId: executions[0].requestId, text: staleLabel });
          send({ type: "trace", step: "failed-tool", kind: "tool", state: "error", text: failedLabel });
          await finishError;
          send({ type: "error", text: failure });
        } else {
          send({ type: "trace", step: "pending-search", kind: "search", state: "running", text: cancelledLabel });
          await finishCancellation;
          send({ type: "trace", step: "after-stop", kind: "search", state: "done", text: "停止后的过期搜索" });
          send({ type: "answer", text: "停止后的过期回答" });
          send({ type: "done" });
        }
      }
      if (!response.destroyed && !response.writableEnded) response.end();
    };

    const panel = page.locator("#execution-trace");
    const rows = page.locator("#execution-trace-list [data-trace-step]");
    const traceStatus = page.locator("#execution-trace-status");
    const stop = page.locator("#stop-ai");
    const ask = async (question) => {
      await page.locator("#ask-board").click();
      await page.locator("#question").fill(question);
      await page.locator("#submit-question").click();
    };
    const answerCard = page.locator("#threads .thread-answer").filter({ hasText: answer });
    await ask("配置入口是怎么实现的？");
    const readRow = rows.filter({ hasText: readLabel });
    await readRow.waitFor();
    assert.equal(await panel.evaluate((element) => element.open), true, "The first live trace opened no disclosure");
    assert.match(await panel.locator(":scope > summary").innerText(), /执行过程/);
    assert.equal(await answerCard.count(), 0, "The reply completed before the staged live trace");
    assert.equal(await stop.isVisible(), true);

    pendingReleases.shift()();
    const completedRead = rows.filter({ hasText: "已读取项目配置入口" });
    await completedRead.waitFor();
    assert.equal(await rows.count(), 1, "A result duplicated its running tool row");
    assert.ok((await completedRead.innerText()).includes(readPath));
    const source = completedRead.locator("pre");
    assert.equal(await source.isVisible(), false, "The code preview should start folded");
    await completedRead.locator("details > summary").click();
    assert.equal(await source.isVisible(), true);
    assert.equal(await source.textContent(), code, "Code previews must retain indentation and treat tags as literal text");
    assert.equal(await source.locator("fixture-tag").count(), 0);

    pendingReleases.shift()();
    await answerCard.waitFor();
    await stop.waitFor({ state: "hidden" });
    assert.equal(await completedRead.isVisible(), true, "The trace disappeared after the final answer");
    assert.doesNotMatch(await panel.innerText(), new RegExp(privateMarker));
    assert.doesNotMatch(await answerCard.innerText(), /读取项目配置入口|fixture-tag/);

    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    await ask("下一轮检查调用错误。");
    const failedTool = rows.filter({ hasText: failedLabel });
    await failedTool.waitFor();
    assert.equal(await rows.count(), 1, "Earlier execution steps leaked into a later request");
    assert.doesNotMatch(await panel.innerText(), new RegExp(staleLabel));
    assert.equal(executions[0].backend, "codex");
    assert.equal(executions[1].backend, "zcode");
    pendingReleases.shift()();
    await stop.waitFor({ state: "hidden" });
    assert.equal(await failedTool.isVisible(), true, "The trace disappeared after a model error");
    assert.match(await traceStatus.innerText(), /失败|错误/);

    await ask("检查停止时的执行轨迹。");
    const cancelledTool = rows.filter({ hasText: cancelledLabel });
    await cancelledTool.waitFor();
    await stop.click();
    await stop.waitFor({ state: "hidden" });
    pendingReleases.shift()();
    assert.equal(await cancelledTool.isVisible(), true, "The trace disappeared after Stop");
    assert.match(await traceStatus.innerText(), /停止|取消/);
    assert.equal(await rows.count(), 1);
    assert.ok(telemetry.cancelRequests.some(({ requestId }) => requestId === executions[2].requestId));
    assert.equal(await page.locator("#threads .thread-answer").filter({ hasText: "停止后的过期回答" }).count(), 0);

    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    assert.doesNotMatch(stored, /fixture-tag|项目工具调用失败|正在搜索项目用例/, "Trace rows were saved to board storage");
    await page.reload();
    await answerCard.waitFor();
    assert.equal(await rows.count(), 0, "A trace reappeared after reload");
    assertNoJsErrors(jsErrors, true);
    record("U57", "PASS", "CLI tool steps update live, expand literal code previews, retain the latest trace through failure and cancellation, and keep saved answers separate.");
  } catch (error) { record("U57", "FAIL", safeError(error)); await screenshot("U57-failure", session.page); }
  finally {
    pendingReleases.forEach((release) => release());
    await closeSession(session);
    executionTraceFixture = undefined;
  }
}

async function testNestedGuideConnections() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const url = new URL(page.url());
    url.searchParams.set("board", "project-design");
    await page.goto(url.href, { waitUntil: "networkidle" });
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const tasks = ["E19", "E20", "E21"];
    await card("E07").locator(".branch-toggle").click();
    await card("E16").locator(".branch-toggle").click();
    await card("E21").waitFor();
    await page.locator("#quick-reorder").click();
    await page.waitForFunction(() => document.querySelector("#organization-status")?.textContent.includes("已快速重排"));

    const geometry = await page.evaluate((tasks) => {
      const ids = ["E07", "E16", "E17", ...tasks];
      const cards = Object.fromEntries(ids.map((id) => {
        const card = document.querySelector(`#board [data-element-id="${id}"]`);
        return [id, { x: parseFloat(card.style.left), y: parseFloat(card.style.top), height: card.offsetHeight }];
      }));
      const paths = Array.from(document.querySelectorAll(".guide-connection"));
      const edges = Object.fromEntries(ids.slice(1).map((id) => {
        const target = cards[id];
        // Also identify old, unlabelled paths by their visible left-hand endpoint.
        const path = paths.find((edge) => edge.dataset.childId === id) || paths.find((edge) => {
          const end = edge.getPointAtLength(edge.getTotalLength());
          return Math.abs(end.x - target.x) < 1 && end.y >= target.y && end.y <= target.y + target.height;
        });
        if (!path) return [id, null];
        const start = path.getPointAtLength(0);
        const oldRail = path.getAttribute("d").match(/H\s*(-?\d+(?:\.\d+)?)\s+V/)?.[1];
        return [id, { parentId: path.dataset.parentId, childId: path.dataset.childId,
          startY: start.y, railX: oldRail === undefined ? start.x : Number(oldRail) }];
      }));
      const { current } = JSON.parse(localStorage.getItem("whiteboard.codex.project-design.organization.v1"));
      return { cards, edges, parents: Object.fromEntries(current.items.map((item) => [item.id, item.parentId])) };
    }, tasks);

    assert.equal(geometry.parents.E16, "E07");
    assert.equal(geometry.parents.E17, "E07");
    const parentRail = geometry.edges.E16;
    assert.ok(parentRail, "The E07-to-E16 guide connection is missing");
    for (const id of tasks) {
      const edge = geometry.edges[id];
      assert.equal(geometry.parents[id], "E16", `${id} should belong to M1`);
      assert.ok(edge, `${id} has no rendered connection`);
      assert.ok(Math.abs(edge.railX - parentRail.railX) >= 18, `${id} visually shares the E07-level rail`);
      assert.ok(Math.abs(edge.startY - geometry.cards.E16.y - geometry.cards.E16.height) <= 1,
        `${id} should branch from the bottom of its M1 card`);
      assert.ok(geometry.cards[id].x - geometry.cards.E16.x >= 26, `${id} needs a visible nested indent`);
      assert.equal(edge.parentId, "E16");
      assert.equal(edge.childId, id);
    }
    assert.equal(geometry.edges.E17.parentId, "E07");
    assertNoJsErrors(jsErrors);
    const shot = await screenshot("U14-milestone-branches", page);

    await card("E16").locator(".branch-toggle").click();
    for (const id of tasks) {
      await card(id).waitFor({ state: "hidden" });
      assert.equal(await page.locator(`.guide-connection[data-child-id="${id}"]`).count(), 0);
    }
    await card("E17").waitFor();
    assert.equal(await page.locator('.guide-connection[data-parent-id="E07"][data-child-id="E17"]').count(), 1);
    record("U14", "PASS", "After quick reorder, M1 tasks use their own indented rail and collapse independently of M2.", { screenshot: shot });
  } catch (error) { record("U14", "FAIL", safeError(error)); await screenshot("U14-failure", session.page); }
  finally { await closeSession(session); }
}

async function testGuideReadingLayout() {
  const session = await openPage("normal", "repo-atlas");
  try {
    const { page, jsErrors } = session;
    await page.setViewportSize({ width: 865, height: 720 });
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const zoom = async () => Number.parseInt(await page.locator("#zoom-value").textContent(), 10);
    const gaps = () => page.evaluate(() => {
      const element = (id) => document.querySelector(`#board [data-element-id="${id}"]`);
      const verticalGap = (parent, child) => Number.parseFloat(element(child).style.top) -
        Number.parseFloat(element(parent).style.top) - element(parent).offsetHeight;
      return [verticalGap("E04", "E05"), verticalGap("E09", "E10")];
    });

    await card("E05").locator(".branch-toggle").click();
    const chapterZoom = await zoom();
    await card("E09").locator(".branch-toggle").click();
    const detailZoom = await zoom();
    assert.ok(detailZoom >= 80 && detailZoom >= chapterZoom, "Expanding nested content should keep readable zoom");
    const before = await gaps();
    await page.locator("#quick-reorder").click();
    const after = await gaps();
    assert.ok(after.every((gap, index) => gap > 0 && gap < before[index]), "Guide quick reorder must reduce real gaps");
    assert.equal(await zoom(), detailZoom, "Quick reorder should retain the reading zoom");
    const firstChild = await card("E10").boundingBox();
    const viewport = await page.locator("#viewport").boundingBox();
    assert.ok(firstChild.y >= viewport.y && firstChild.y + Math.min(48, firstChild.height) <= viewport.y + viewport.height,
      "The first expanded card should be in the reading viewport after reordering");
    await page.locator("#undo-organization").click();
    assert.deepEqual(await gaps(), before);
    await card("E09").locator(".branch-toggle").click();
    await card("E10").waitFor({ state: "hidden" });
    await card("E12").waitFor();
    assertNoJsErrors(jsErrors);
    record("U18", "PASS", "Nested guide expansion stays readable at a narrow viewport, and quick reorder applies real spacing with undo.");
  } catch (error) { record("U18", "FAIL", safeError(error)); await screenshot("U18-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRepositoryIndex() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const scan = page.getByRole("button", { name: "扫描当前仓库", exact: true });
    const switcher = page.locator("#board-switcher");
    const switchTo = async (board) => {
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("board") === board),
        switcher.selectOption(board),
      ]);
    };
    const readBoards = () => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
      .filter(([key]) => /^whiteboard\.codex(?:\.(?:project-design|repo-manual))?(?:\.organization)?\.v1$/.test(key))));
    assert.equal(await scan.isVisible(), false, "The original whiteboard exposes repository scanning");
    await openDetails(page, "sidebar-tools", "project-memory");
    await page.locator("#project-goal").fill("Existing original board goal.");
    await switchTo("project-design");
    assert.equal(await scan.isVisible(), false, "The project-design whiteboard exposes repository scanning");
    await openDetails(page, "sidebar-tools", "project-memory");
    await page.locator("#project-goal").fill("Existing project-design board goal.");
    await switchTo("repo-manual");
    await openDetails(page, "sidebar-tools", "repo-index-panel");
    await scan.waitFor();

    const chapter = page.locator('#board [data-element-id="E12"]');
    await page.locator('#board [data-element-id="E05"] .branch-toggle').click();
    await chapter.locator(".organized-title").click();
    await chapter.and(page.locator('[aria-pressed="true"]')).waitFor();
    const before = await readBoards();
    assert.ok(before["whiteboard.codex.v1"] && before["whiteboard.codex.project-design.v1"] &&
      before["whiteboard.codex.repo-manual.organization.v1"], "Missing independent board state before scanning");

    const symbol = { name: "decomposeBoard", file: "app.js", line: 2243, kind: "Function" };
    const index = { engine: "GitNexus", version: "1.99.0", snapshot: "29dbf17ca5326ed0".repeat(4),
      files: [{ path: "app.js", bytes: 182_700 }, { path: "organization.js", bytes: 49_700 },
        { path: "server.py", bytes: 85_700 }, { path: "attachments.py", bytes: 21_300 }] };
    const requests = [];
    const failure = "GitNexus 索引暂时不可用，请重试。";
    await page.route("**/api/repo-index", async (route) => {
      const request = route.request();
      const payload = request.postDataJSON();
      requests.push({ method: request.method(), payload });
      if (requests.length === 1) {
        await route.fulfill({ status: 503, json: { type: "error", text: failure } });
      } else if (payload.action === "scan") {
        const sameName = { ...symbol, file: "attachments.py", line: 8 };
        await route.fulfill({ json: { ...index, symbols: [symbol, sameName] } });
      } else {
        await route.fulfill({ json: { ...index, context: { symbol: symbol.name, file: symbol.file,
          line: symbol.line, kind: symbol.kind, callers: [],
          callees: [{ name: "decompositionContext", file: "app.js", line: 2213, kind: "Function" }] } } });
      }
    });

    await scan.click();
    const status = page.locator("#repo-index-status");
    await status.filter({ hasText: failure }).waitFor();
    assert.equal(await scan.isEnabled(), true, "A failed scan prevents retrying");
    assert.deepEqual(await readBoards(), before, "Failed scan mutated a whiteboard");

    await scan.click();
    const summary = page.locator("#repo-index-summary");
    await summary.filter({ hasText: "GitNexus" }).waitFor();
    assert.match(await summary.innerText(), /29dbf17c/);
    const chapterFiles = page.locator("#repo-index-chapter");
    await chapterFiles.filter({ hasText: "app.js" }).waitFor();
    assert.match(await chapterFiles.innerText(), /organization\.js/);
    assert.doesNotMatch(await chapterFiles.innerText(), /attachments\.py/);

    await page.locator("#repo-index-chapter-symbols")
      .getByRole("button", { name: symbol.name, exact: true }).click();
    const evidence = page.locator("#repo-index-context");
    await evidence.filter({ hasText: "decompositionContext" }).waitFor();
    assert.match(await evidence.innerText(), /app\.js/);
    assert.deepEqual(requests, [
      { method: "POST", payload: { action: "scan" } },
      { method: "POST", payload: { action: "scan" } },
      { method: "POST", payload: { action: "context", symbol: symbol.name, file: symbol.file } },
    ]);
    assert.deepEqual(await readBoards(), before, "Repository evidence mutated a whiteboard");
    assertNoJsErrors(jsErrors.filter((entry) => !/^Failed to load resource: .*503/.test(entry)));
    const shot = await screenshot("U15-repository-index", page);
    record("U15", "PASS", "The code manual retries a failed GitNexus scan and opens a selected chapter's file-scoped symbol context without changing any board.", { screenshot: shot });
  } catch (error) { record("U15", "FAIL", safeError(error)); await screenshot("U15-failure", session.page); }
  finally { await closeSession(session); }
}

async function testCompactSidebar() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const tools = page.locator("#sidebar-tools");
    const toolsSummary = tools.locator(":scope > summary");
    const actions = page.locator("#selection-actions");
    const goal = "明确选区到回答之间的数据边界。";
    const rule = "解释前先定位选区使用的源码。";
    const question = "这段交互是怎样处理坐标的？";
    const answer = "合成回答：先把屏幕位置转换为白板坐标。";
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const text = request.scope === "plan" ? '{"action":"ask"}' : answer;
      const events = [{ type: "answer", text }, { type: "done" }];
      await route.fulfill({ contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });
    const assertCompact = async () => {
      for (const id of ["ask-board", "organize-board", "quick-reorder"]) {
        assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} should stay available`);
      }
      for (const id of ["selection-actions", "scan-repository", "project-goal", "project-constraints",
        "organization-opinion", "file-orphans", "payload", "sent-context"]) {
        assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} should start hidden`);
      }
      assert.equal(await tools.evaluate((element) => element.open), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        "The compact sidebar should not introduce horizontal overflow");
    };

    await assertCompact();
    await toolsSummary.press("Enter");
    assert.equal(await tools.evaluate((element) => element.open), true, "Advanced tools are keyboard accessible");
    await openDetails(page, "project-memory");
    await page.locator("#project-goal").fill(goal);
    await page.locator("#project-constraints").fill(rule);
    await page.reload({ waitUntil: "networkidle" });
    await assertCompact();
    assert.equal(await page.locator("#project-goal").inputValue(), goal);
    assert.equal(await page.locator("#project-constraints").inputValue(), rule);

    await page.locator('#board [data-element-id="E05"]').press("Enter");
    await actions.waitFor();
    for (const id of ["split-module", "organize-branch", "regenerate-branch"]) {
      const action = actions.locator(`#${id}`);
      assert.equal(await action.isVisible(), true, `${id} should appear for a selected module`);
      assert.equal(await action.isEnabled(), true);
    }
    await page.locator("#ask-open").click();
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    await page.locator("#board .thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.project.goal, goal);
      assert.deepEqual(request.project.constraints, [rule]);
    }
    assert.equal(await tools.evaluate((element) => element.open), false);
    await page.reload({ waitUntil: "networkidle" });
    await page.setViewportSize({ width: 390, height: 820 });
    await assertCompact();
    await toolsSummary.scrollIntoViewIfNeeded();
    assert.equal(await toolsSummary.isVisible(), true, "Advanced tools should remain reachable on narrow screens");
    assertNoJsErrors(jsErrors);
    record("U52", "PASS", "The compact sidebar shows relevant actions, keeps advanced tools accessible by keyboard, and sends persisted rules while their editor is closed.");
  } catch (error) { record("U52", "FAIL", safeError(error)); await screenshot("U52-failure", session.page); }
  finally { await closeSession(session); }
}

async function lassoBox(page, { x, y, width, height }, padding = 2) {
  const left = x - padding, right = x + width + padding;
  const top = y - padding, bottom = y + height + padding;
  await page.mouse.move(left, top);
  await page.mouse.down();
  for (const [nextX, nextY] of [[right, top], [right, bottom], [left, bottom], [left, top]]) {
    await page.mouse.move(nextX, nextY, { steps: 6 });
  }
  await page.mouse.up();
}

async function lassoTitle(page, id) {
  const title = page.locator(`#board [data-element-id="${id}"] .organized-title`);
  await title.waitFor();
  await lassoBox(page, await title.boundingBox());
  await page.locator("#selection-highlights rect").first().waitFor({ state: "attached" });
  await page.locator("#ask-open").click();
}

async function testLassoAnswer() {
  const session = await openPage("normal", "repo-atlas");
  try {
    const { page, jsErrors } = session;
    const title = page.locator('#board [data-element-id="E05"] .organized-title');
    const summary = page.locator('#board [data-element-id="E05"] .organized-summary');
    const rootTitle = page.locator('#board [data-element-id="E04"] .organized-title');
    const rootSummary = page.locator('#board [data-element-id="E04"] .organized-summary');
    const branch = page.locator('#board [data-element-id="E05"] .branch-toggle');
    assert.equal(await branch.getAttribute("aria-expanded"), "false");
    const question = "请解释这一段的实现。";
    const answer = "合成回答：先把鼠标位置转换成场景坐标。";
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "answer", text: request.scope === "plan" ? '{"action":"ask"}' : answer },
          { type: "done" },
        ].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const note = page.locator('#threads .thread-note[data-anchor="E05"]');
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await note.evaluate((element) => {
      const noteBounds = element.getBoundingClientRect();
      const view = document.querySelector("#viewport").getBoundingClientRect();
      return noteBounds.left < view.right && noteBounds.right > view.left &&
        noteBounds.top < view.bottom && noteBounds.bottom > view.top;
    }), true, "The finished note should appear within the whiteboard viewport");
    assert.equal(await note.locator(".thread-question").innerText(), question);
    assert.deepEqual(requests.map(({ scope, mode }) => [scope, mode]), [["plan", "ask"], [undefined, "ask"]]);
    const quotedTitle = await title.innerText();
    const fullSummary = await summary.innerText();
    const path = [{ id: "E04", title: await rootTitle.innerText() }, { id: "E05", title: quotedTitle }];
    const parentSummary = await rootSummary.innerText();
    for (const request of requests) {
      assert.deepEqual(request.anchor.elementIds, ["E05"]);
      assert.equal(request.anchor.quote, quotedTitle);
      assert.equal(request.anchor.wholeCardIds, undefined);
      assert.deepEqual(request.anchor.sourceFiles, ["geometry.js", "app.js"]);
      assert.deepEqual(request.project.selectedCards?.map(({ id }) => id), ["E05"]);
      assert.equal(request.project.selectedCards[0].summary, fullSummary);
      assert.deepEqual(request.project.selectedCards[0].path, path);
      assert.equal(request.project.selectedCards[0].parent?.summary, parentSummary);
    }
    assert.equal(await branch.getAttribute("aria-expanded"), "false", "An answer should leave the chapter folded");
    const id = await note.getAttribute("data-element-id");
    const earlierAnswer = "此前已保存的执行说明。";
    await page.evaluate((answer) => {
      const key = "whiteboard.codex.repo-atlas.v1";
      const state = JSON.parse(localStorage.getItem(key));
      const rect = { x: 370, y: 500, width: 240, height: 120 };
      state.notes.push({ id: "A99", kind: "note", rect, anchors: [rect], sourceCardIds: ["E06"], answer,
        payload: { question: "执行章节旧批注", anchor: { elementIds: ["E06"], box: rect } } });
      localStorage.setItem(key, JSON.stringify(state));
    }, earlierAnswer);
    await page.reload();
    await page.locator(`#threads [data-element-id="${id}"] .thread-answer`).filter({ hasText: answer }).waitFor();
    await page.locator('#threads [data-element-id="A99"] .thread-answer').filter({ hasText: earlierAnswer }).waitFor();
    assert.equal(await branch.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('#board [data-element-id="E06"] .branch-toggle').getAttribute("aria-expanded"), "false");
    assertNoJsErrors(jsErrors);
    record("U16", "PASS", "A real title lasso sends its exact quote, full card summary, source references, and ancestor path to planning and answering. The reply persists after reload.");
  } catch (error) { record("U16", "FAIL", safeError(error)); await screenshot("U16-failure", session.page); }
  finally { await closeSession(session); }
}

async function testLassoAnswerRetry() {
  const session = await openPage("normal", "repo-atlas");
  try {
    const { page, jsErrors } = session;
    const question = "请解释这章的作用。";
    const invalidPlan = "Synthetic planner prose";
    const failure = "测试服务本轮连接超时";
    const answer = "合成回答：此章解释从圈选到问题锚点的转换。";
    const answers = [];
    let plans = 0;
    let finishFirstPlan;
    const firstPlan = new Promise((resolvePlan) => { finishFirstPlan = resolvePlan; });
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      let events;
      if (request.scope === "plan") {
        plans += 1;
        if (plans === 1) await firstPlan;
        events = [{ type: "answer", text: plans === 1 ? invalidPlan : '{"action":"ask"}' }, { type: "done" }];
      } else {
        answers.push(request);
        events = answers.length === 1
          ? [{ type: "error", text: failure }]
          : [{ type: "answer", text: answer }, { type: "done" }];
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await lassoTitle(page, "E05");
    const draft = page.locator("#question");
    const send = page.locator("#submit-question");
    const feedback = page.locator("#ask-feedback");
    await draft.fill(question);
    await send.click();
    try {
      await page.locator("#running-questions").getByText(/判断意图/).waitFor();
      assert.equal(await draft.inputValue(), "");
      assert.equal(await draft.isVisible(), false, "The empty composer is closed after submitting");
    } finally {
      finishFirstPlan();
    }
    await feedback.filter({ hasText: /重试|再次发送/ }).waitFor();
    assert.doesNotMatch(await feedback.innerText(), /Synthetic planner prose/);
    assert.equal(await draft.inputValue(), question);
    assert.equal(await send.isEnabled(), true);
    assert.equal(answers.length, 0, "Invalid planning output must not send an execution request");

    await send.click();
    await feedback.filter({ hasText: failure }).waitFor();
    assert.equal(await draft.inputValue(), question);
    assert.equal(await send.isEnabled(), true);
    const failedNote = page.locator('#threads .thread-note[data-anchor="E05"]');
    assert.equal(await failedNote.count(), 1);
    const failedId = await failedNote.getAttribute("data-element-id");

    await send.click();
    const note = page.locator('#threads .thread-note[data-anchor="E05"]');
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await note.count(), 1);
    assert.equal(await note.getAttribute("data-element-id"), failedId);
    assert.deepEqual(answers[1].anchor.elementIds, answers[0].anchor.elementIds);
    assert.equal(answers[1].anchor.quote, answers[0].anchor.quote);
    assert.equal(answers[1].question, answers[0].question);
    assertNoJsErrors(jsErrors);
    record("U17", "PASS", "A failed explanation retains the lasso and question, shows its error in the composer, and retries without creating a duplicate note.");
  } catch (error) { record("U17", "FAIL", safeError(error)); await screenshot("U17-failure", session.page); }
  finally { await closeSession(session); }
}

async function testSentQuestionDelivery() {
  const session = await openPage("normal", "repo-atlas");
  let releaseAnswer;
  const heldAnswer = new Promise((resolveAnswer) => { releaseAnswer = resolveAnswer; });
  try {
    const { page, jsErrors } = session;
    const question = "请解释这一处，并保留提问记录。";
    const failure = "合成连接失败，请重试";
    const answer = "合成重试结果：问题和回答保存在同一张批注卡。";
    const executions = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      let events;
      if (request.scope === "plan") {
        events = [{ type: "answer", text: '{"action":"ask"}' }, { type: "done" }];
      } else {
        executions.push(request);
        if (executions.length === 1) {
          await heldAnswer;
          events = [{ type: "error", text: failure }];
        } else {
          events = [{ type: "answer", text: answer }, { type: "done" }];
        }
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const note = page.locator('#threads .thread-note[data-anchor="E05"]');
    await note.locator(".thread-question").filter({ hasText: question }).waitFor();
    const id = await note.getAttribute("data-element-id");
    const storedQuestion = await page.evaluate((noteId) => {
      const state = JSON.parse(localStorage.getItem("whiteboard.codex.repo-atlas.v1"));
      return state.notes.find((entry) => entry.id === noteId)?.payload.question;
    }, id);
    assert.equal(storedQuestion, question, "The question must be saved while its answer is still pending");
    await note.locator(".thread-status").waitFor();

    const viewport = await page.locator("#viewport").boundingBox();
    await page.mouse.click(viewport.x + 6, viewport.y + 6);
    releaseAnswer();
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    await note.locator(".thread-status").filter({ hasText: failure }).waitFor();
    await note.locator("[data-retry-question]").waitFor();
    assert.equal(await note.locator(".thread-question").innerText(), question);

    await page.reload();
    const restored = page.locator(`#threads [data-element-id="${id}"]`);
    await restored.locator(".thread-question").filter({ hasText: question }).waitFor();
    await restored.locator("[data-retry-question]").click();
    await restored.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await page.locator('#threads .thread-note[data-anchor="E05"]').count(), 1);
    assert.deepEqual(executions[1].anchor, executions[0].anchor);
    assert.equal(executions[1].question, executions[0].question);
    assert.equal(executions[1].mode, "ask");
    assertNoJsErrors(jsErrors);
    record("U19", "PASS", "A sent question remains saved through clicking away, a failed reply and reload, then retries on the same annotation.");
  } catch (error) { record("U19", "FAIL", safeError(error)); await screenshot("U19-failure", session.page); }
  finally { releaseAnswer(); await closeSession(session); }
}

async function testPendingQuestionReload() {
  const session = await openPage("normal", "repo-atlas");
  let releaseAnswer;
  const heldAnswer = new Promise((resolveAnswer) => { releaseAnswer = resolveAnswer; });
  try {
    const { page, jsErrors } = session;
    const question = "等待中的问题刷新后还应能继续。";
    const answer = "合成回答：刷新后继续提交成功。";
    let executions = 0;
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      if (request.scope !== "plan" && ++executions === 1) {
        await heldAnswer;
        await route.abort().catch(() => {});
        return;
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text: request.scope === "plan" ? '{"action":"ask"}' : answer },
          { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const pending = page.locator('#threads .thread-note[data-anchor="E05"]');
    await pending.locator(".thread-question").filter({ hasText: question }).waitFor();
    const id = await pending.getAttribute("data-element-id");
    await page.reload();
    releaseAnswer();
    const restored = page.locator(`#threads [data-element-id="${id}"]`);
    await restored.locator(".thread-question").filter({ hasText: question }).waitFor();
    await restored.locator(".thread-status").waitFor();
    await restored.locator("[data-retry-question]").click();
    await restored.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await page.locator("#threads .thread-note").count(), 1);
    assertNoJsErrors(jsErrors);
    record("U20", "PASS", "Reloading during a pending answer restores the sent question and offers a retry on that same annotation.");
  } catch (error) { record("U20", "FAIL", safeError(error)); await screenshot("U20-failure", session.page); }
  finally { releaseAnswer(); await closeSession(session); }
}

async function testFoldedChapterExtension() {
  const session = await openPage("normal", "repo-atlas");
  try {
    const { page, jsErrors } = session;
    const question = "沿着这个问题继续展开讨论。";
    const answer = "合成分支回答：从坐标转换继续讨论命中范围。";
    const failure = "合成分支请求首次失败";
    let attempts = 0;
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      const events = request.scope === "plan"
        ? [{ type: "answer", text: '{"action":"extend"}' }, { type: "done" }]
        : ++attempts === 1
          ? [{ type: "error", text: failure }]
          : [{ type: "answer", text: answer }, { type: "done" }];
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });
    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const branch = page.locator('#threads .branch-note[data-anchor="E05"]');
    await branch.locator(".thread-status").filter({ hasText: failure }).waitFor();
    const toggle = page.locator('#board [data-element-id="E05"] .branch-toggle');
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const id = await branch.getAttribute("data-element-id");
    await page.reload();
    await branch.locator(".thread-status").filter({ hasText: failure }).waitFor();
    await toggle.click();
    await branch.waitFor({ state: "hidden" });

    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    await branch.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await branch.count(), 1);
    assert.equal(await branch.getAttribute("data-element-id"), id);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await page.reload();
    await page.locator(`#threads [data-element-id="${id}"] .thread-answer`).filter({ hasText: answer }).waitFor();
    await toggle.click();
    await branch.waitFor({ state: "hidden" });
    assertNoJsErrors(jsErrors);
    record("U21", "PASS", "A failed extension under a folded chapter remains available, opens again on retry, and stays on the same card.");
  } catch (error) { record("U21", "FAIL", safeError(error)); await screenshot("U21-failure", session.page); }
  finally { await closeSession(session); }
}

async function testNoteAfterOtherChapterDecomposition() {
  const session = await openPage("normal", "repo-atlas");
  try {
    const { page, jsErrors } = session;
    const question = "解释命中这一章。";
    const answer = "合成已有回答：此处负责选区命中。";
    let plans = 0;
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      let event;
      if (request.scope === "plan") {
        event = { type: "answer", text: JSON.stringify({ action: ++plans === 1 ? "ask" : "decompose" }) };
      } else if (request.scope === "decompose") {
        event = { type: "children", children: [firstTask] };
      } else {
        event = { type: "answer", text: answer };
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [event, { type: "done" }].map((value) => JSON.stringify(value)).join("\n") + "\n",
      });
    });
    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const note = page.locator('#threads .thread-note[data-anchor="E05"]');
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    const id = await note.getAttribute("data-element-id");
    await page.locator("#fit").click();
    await page.locator('#board [data-element-id="E06"] .organized-title').click();
    await page.locator("#ask-open").click();
    await page.locator("#question").fill("把这个模块拆成可执行任务。");
    await page.locator("#submit-question").click();
    await page.getByText(firstTask.title, { exact: true }).waitFor();
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await page.locator('#board [data-element-id="E05"] .branch-toggle').getAttribute("aria-expanded"), "false");
    await page.reload();
    await page.locator(`#threads [data-element-id="${id}"] .thread-answer`).filter({ hasText: answer }).waitFor();
    assertNoJsErrors(jsErrors);
    record("U22", "PASS", "An existing annotation remains visible when another folded chapter is decomposed and the full tree is applied again.");
  } catch (error) { record("U22", "FAIL", safeError(error)); await screenshot("U22-failure", session.page); }
  finally { await closeSession(session); }
}

async function testQuestionDuringPlanning() {
  const session = await openPage("normal", "repo-atlas");
  let releasePlan;
  const heldPlan = new Promise((resolvePlan) => { releasePlan = resolvePlan; });
  try {
    const { page, jsErrors } = session;
    const question = "解释选中内容的处理过程。";
    const answer = "合成回答：本次提问已正常执行。";
    const executions = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      const planning = request.scope === "plan";
      if (planning) await heldPlan;
      else executions.push(request);
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text: planning ? '{"action":"ask"}' : answer },
          { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const task = page.locator("#running-questions li").filter({ hasText: question });
    await task.getByText(/判断意图/).waitFor();
    const viewport = await page.locator("#viewport").boundingBox();
    await page.mouse.click(viewport.x + 6, viewport.y + 6);
    assert.equal(await task.isVisible(), true);
    const camera = () => page.locator("#board").evaluate((board) => board.style.transform);
    const beforePan = await camera();
    await page.mouse.down();
    await page.mouse.move(viewport.x + 48, viewport.y + 42, { steps: 8 });
    await page.mouse.up();
    assert.notEqual(await camera(), beforePan, "The canvas can still pan while question planning is pending");
    assert.equal(await task.isVisible(), true);
    releasePlan();
    const note = page.locator('#threads .thread-note[data-anchor="E05"]');
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await note.locator(".thread-question").innerText(), question);
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0].anchor.elementIds, ["E05"]);
    assertNoJsErrors(jsErrors);
    record("U23", "PASS", "Clicking and dragging blank canvas while a plan is pending preserve the question and execute the sent anchor when planning completes.");
  } catch (error) { record("U23", "FAIL", safeError(error)); await screenshot("U23-failure", session.page); }
  finally { releasePlan(); await closeSession(session); }
}

function visibleCardRects(page) {
  return page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("#board [data-element-id]:not([hidden])"), (element) => [
    element.dataset.elementId,
    { x: Number.parseFloat(element.style.left), y: Number.parseFloat(element.style.top),
      width: element.offsetWidth, height: element.offsetHeight },
  ])));
}

async function clearCardSelection(page) {
  await page.locator("#select-mode").click();
  const point = await page.locator("#viewport").evaluate((viewport) => {
    const box = viewport.getBoundingClientRect();
    for (let y = box.top + 6; y < box.bottom - 6; y += 28) {
      for (let x = box.left + 6; x < box.right - 6; x += 28) {
        const element = document.elementFromPoint(x, y);
        if (viewport.contains(element) && !element.closest("[data-element-id], #ask-popover, button, summary")) return { x, y };
      }
    }
    return null;
  });
  assert.ok(point, "The selection-clear action needs an empty canvas point");
  await page.mouse.click(point.x, point.y);
}

function cardGap(a, b) {
  const horizontal = Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0);
  const vertical = Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0);
  return Math.hypot(horizontal, vertical);
}

function assertCardOnEdge(point, rect, message) {
  const inRange = (value, start, size) => value >= start - 2 && value <= start + size + 2;
  assert.ok(inRange(point.x, rect.x, rect.width) && inRange(point.y, rect.y, rect.height) &&
    Math.min(Math.abs(point.x - rect.x), Math.abs(point.x - rect.x - rect.width),
      Math.abs(point.y - rect.y), Math.abs(point.y - rect.y - rect.height)) <= 2, message);
}

async function dragCard(page, id, dx, dy) {
  const title = page.locator(`#board [data-element-id="${id}"] .organized-title`);
  await page.locator("#pan-mode").click();
  const box = await title.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.locator("#select-mode").click();
}

async function testAnswerBesideMovedCard() {
  const session = await openPage("normal", "repo-manual");
  let releaseAnswer;
  const heldAnswer = new Promise((resolveAnswer) => { releaseAnswer = resolveAnswer; });
  try {
    const { page, jsErrors } = session;
    const question = "请解释工作区和源文件的关系。";
    const answer = "合成回答：工作区的只读或写入权限由这次请求决定。";
    const executions = [];
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    await card("E07").locator(".branch-toggle").click();
    await card("E21").locator(".branch-toggle").click();
    await card("E23").locator(".branch-toggle").click();
    await page.locator("#fit").click();
    const original = (await visibleCardRects(page)).E25;
    await dragCard(page, "E25", 245, -115);
    const moved = (await visibleCardRects(page)).E25;
    assert.ok(Math.hypot(moved.x - original.x, moved.y - original.y) > 240, "The pointer drag must move the actual question anchor");

    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      const planning = request.scope === "plan";
      if (!planning) {
        executions.push(request);
        await heldAnswer;
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text: planning ? '{"action":"ask"}' : answer },
          { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });
    await lassoTitle(page, "E25");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const note = page.locator('#threads .thread-note[data-anchor="E25"]');
    await note.locator(".thread-status").filter({ hasText: /等待/ }).waitFor();
    const id = await note.getAttribute("data-element-id");
    const checkPlacement = async (inViewport = false) => {
      const rects = await visibleCardRects(page);
      const anchor = rects.E25;
      const reply = rects[id];
      assert.equal(anchor.x, moved.x, "Asking should retain the manual anchor x");
      assert.equal(anchor.y, moved.y, "Asking should retain the manual anchor y");
      const distance = cardGap(anchor, reply);
      assert.ok(distance >= 8 && distance <= 156, `Reply should be near its displayed anchor, measured gap ${distance}`);
      for (const [otherId, rect] of Object.entries(rects)) {
        if (otherId === id) continue;
        assert.ok(cardGap(rect, reply) > 0, `Reply should avoid visible card ${otherId}`);
      }
      const edge = page.locator(`#connections path[data-parent-id="E25"][data-child-id="${id}"]`);
      assert.equal(await edge.count(), 1, "The reply should be connected to E25");
      const [start, end] = await edge.evaluate((path) => {
        return [0, path.getTotalLength()].map((length) => {
          const { x, y } = path.getPointAtLength(length);
          return { x, y };
        });
      });
      assertCardOnEdge(start, anchor, "The connection must start at the moved card");
      assertCardOnEdge(end, reply, "The connection must reach the reply");
      if (inViewport) {
        const view = await page.locator("#viewport").boundingBox();
        for (const [name, element] of [["source", card("E25").locator(".organized-title")], ["reply", note.locator(".thread-question")]]) {
          const box = await element.boundingBox();
          assert.ok(box.x >= view.x && box.x + box.width <= view.x + view.width &&
            box.y >= view.y && box.y + box.height <= view.y + view.height,
          `The ${name} text should remain readable in the viewport`);
        }
      }
      return reply;
    };
    await checkPlacement(true);
    releaseAnswer();
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.deepEqual(executions.map((request) => request.anchor.elementIds), [["E25"]]);
    const placed = await checkPlacement(true);
    const shot = await screenshot("U24-moved-card-answer", page);
    await page.reload();
    await note.locator(".thread-answer").filter({ hasText: answer }).waitFor();
    assert.deepEqual(await checkPlacement(), placed, "The answered reply should stay in place across reload");
    assertNoJsErrors(jsErrors);
    record("U24", "PASS", `Asking beside a manually moved card places the note ${cardGap(moved, placed).toFixed(1)} scene px from the actual anchor and preserves its position on reload.`, { screenshot: shot });
  } catch (error) { record("U24", "FAIL", safeError(error)); await screenshot("U24-failure", session.page); }
  finally { releaseAnswer(); await closeSession(session); }
}

async function testQuickReorderMovedBranches() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const toggle = (id) => card(id).locator(".branch-toggle");
    const title = (id) => card(id).locator(".organized-title");
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current);
    for (const id of ["E05", "E07", "E21", "E23", "E25", "E27"]) {
      await toggle(id).click();
      await page.locator("#fit").click();
    }

    await dragCard(page, "E28", -150, -65);
    await toggle("E27").click();
    await card("E28").waitFor({ state: "hidden" });
    await page.locator("#fit").click();
    await dragCard(page, "E08", 25, -70);
    await page.locator("#pin-mode").click();
    await title("E08").click();
    assert.ok(await card("E08").evaluate((element) => element.classList.contains("board-pinned")));
    await page.locator("#select-mode").click();
    await dragCard(page, "E25", 195, -95);
    await clearCardSelection(page);

    const previous = await stored();
    assert.ok(previous.positions.E08 && previous.positions.E25 && previous.positions.E28, "The scenario must include all three manual moves");
    await page.locator("#quick-reorder").click();
    const current = await stored();
    assert.deepEqual(current.items, previous.items, "Quick reorder must keep the chapter tree and its content");
    assert.deepEqual(current.collapsedBranches, previous.collapsedBranches, "Quick reorder must preserve folded branches");
    assert.deepEqual(current.positions.E08, previous.positions.E08, "Quick reorder must preserve a hand-positioned pin");
    assert.deepEqual(current.positions.E28, previous.positions.E28, "Quick reorder must preserve a hidden manual position");
    assert.equal(current.positions.E25, undefined, "A visible unpinned override should be available for reflow");

    const rects = await visibleCardRects(page);
    const chapterChildren = ["E21", "E23", "E25", "E27"];
    assert.equal(new Set(chapterChildren.map((id) => rects[id].x)).size, 2, "Four expanded detail subtrees should use two columns");
    for (const id of ["E05", "E06", "E07"]) {
      assert.ok(rects[id].y > rects.E04.y + rects.E04.height, "An automatic chapter should stay below the overview");
    }
    const entries = Object.entries(rects);
    for (const [index, [id, rect]] of entries.entries()) {
      for (const [otherId, other] of entries.slice(index + 1)) {
        assert.ok(cardGap(rect, other) > 0, `Quick reorder must keep cards ${id} and ${otherId} clear of one another`);
      }
    }
    for (const [parent, child] of [["E07", "E21"], ["E07", "E23"], ["E07", "E25"], ["E07", "E27"],
      ["E21", "E22"], ["E23", "E24"], ["E25", "E26"]]) {
      assert.equal(await page.locator(`#connections path[data-parent-id="${parent}"][data-child-id="${child}"]`).count(), 1,
        `Quick reorder must retain rendered edge ${parent} → ${child}`);
    }
    for (const [parent, child] of [["E21", "E22"], ["E23", "E24"], ["E25", "E26"]]) {
      assert.ok(rects[child].x >= rects[parent].x && rects[child].x < rects[parent].x + rects[parent].width &&
        rects[child].y >= rects[parent].y + rects[parent].height, `Subtree detail ${child} must remain under ${parent}`);
    }
    await page.locator("#fit").click();
    const shot = await screenshot("U25-quick-reorder", page);

    await page.locator("#undo-organization").click();
    const restored = await stored();
    assert.deepEqual(restored.positions, previous.positions);
    assert.deepEqual(restored.layout, previous.layout);
    assertNoJsErrors(jsErrors);
    record("U25", "PASS", "Whole-board quick reorder compacts expanded branches, protects pinned and folded manual positions, and supports undo.", { screenshot: shot });
  } catch (error) { record("U25", "FAIL", safeError(error)); await screenshot("U25-failure", session.page); }
  finally { await closeSession(session); }
}

const explanationFixture = {
  summary: "先固定问题的锚点，再用分开的卡片解释上下文和调用过程。",
  sections: [
    { title: "选区提供锚点", text: "客户端收集卡片编号和圈选摘录，作为后续讨论的定位依据。" },
    { title: "发送时补齐上下文", text: "请求再携带当前项目约束，服务在收到请求后选择对应的解释路径。" },
    { title: "批注保留关系", text: "中间卡记录问题和总览，每张细节卡独立保留对应的回答。" },
  ],
};

function readManualNotes(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.v1")).notes);
}

async function askFromCard(page, id, question) {
  await page.locator(`#board [data-element-id="${id}"]`).press("Enter");
  await page.locator("#ask-open").click();
  await page.locator("#question").fill(question);
  await page.locator("#submit-question").click();
}

async function testStructuredExplanation() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const question = "请按几个层次讲清楚这一段，并展开为多个内容卡。";
    const followup = "请继续把这张细节卡拆开说明。";
    const splitChild = "让这张细节卡变成总览，把它的原回答拆成多个下级卡片。";
    const nested = {
      summary: "定位依赖两类信息。",
      sections: [
        { title: "可引用的元素编号", text: "编号用于区分画布上的卡片。" },
        { title: "可阅读的摘录", text: "摘录保留本次解释真正关心的文字。" },
      ],
    };
    const executions = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      if (request.scope === "organize") {
        await route.fulfill({
          contentType: "application/x-ndjson",
          body: JSON.stringify({ type: "error", text: "合成局部整理失败，验证本地保留关系。" }) + "\n",
        });
        return;
      }
      const planning = request.scope === "plan";
      if (!planning) executions.push(request);
      const action = request.question.includes(splitChild) ? "splitAnswer" : "explain";
      const event = planning ? { type: "answer", text: JSON.stringify({ action }) } :
        { type: "explanation", explanation: request.question === question ? explanationFixture : nested };
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [event, { type: "done" }].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      });
    });

    const sourceToggle = page.locator('#board [data-element-id="E05"] .branch-toggle');
    assert.equal(await sourceToggle.getAttribute("aria-expanded"), "false");
    await lassoTitle(page, "E05");
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const bridge = page.locator('#threads .thread-note[data-anchor="E05"]').filter({ hasText: question });
    await bridge.locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    const parentId = await bridge.getAttribute("data-element-id");
    assert.equal(await bridge.locator(".thread-question").innerText(), question);
    assert.equal(await bridge.locator(".thread-answer").innerText(), explanationFixture.summary,
      "The middle card should show the overview, not duplicate the detail cards");
    const sections = page.locator(`#threads [data-section-of="${parentId}"]`);
    await sections.last().waitFor();
    assert.equal(await sections.count(), 3);
    const notes = await readManualNotes(page);
    assert.equal(notes.find((note) => note.id === parentId).outline, true);
    const storedChildren = notes.filter((note) => note.sectionOf === parentId);
    assert.equal(storedChildren.length, 3);
    for (const { id, payload } of storedChildren) {
      assert.deepEqual(payload.anchor.elementIds, [parentId]);
      assert.equal(await page.locator(`#connections path[data-parent-id="${parentId}"][data-child-id="${id}"]`).count(), 1);
    }
    const rects = await visibleCardRects(page);
    const parentRect = rects[parentId];
    const detailRects = storedChildren.map(({ id }) => rects[id]);
    assert.ok(detailRects.every((rect) => rect.y >= parentRect.y + parentRect.height),
      "The explanation cards should be below their overview");
    assert.equal(detailRects[0].y, detailRects[1].y, "The first explanation row should use two columns");
    assert.ok(cardGap(detailRects[0], detailRects[1]) > 0);
    for (const [index, section] of explanationFixture.sections.entries()) {
      assert.match(await sections.nth(index).innerText(), new RegExp(section.title));
      assert.match(await sections.nth(index).innerText(), new RegExp(section.text));
    }
    const viewport = await page.locator("#viewport").boundingBox();
    for (const card of [bridge, ...await sections.all()]) {
      const box = await card.boundingBox();
      assert.ok(box.x >= viewport.x && box.x + box.width <= viewport.x + viewport.width &&
        box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height,
      "The complete short explanation should be in the viewport immediately after generation");
    }
    assert.deepEqual(executions.map(({ mode, scope, anchor }) => [mode, scope, anchor.elementIds]), [
      ["ask", "explain", ["E05"]],
    ]);
    const fold = bridge.locator(".branch-toggle");
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    const shot = await screenshot("U26-structured-explanation", page);
    await fold.click();
    await sections.first().waitFor({ state: "hidden" });
    assert.equal(await bridge.isVisible(), true);
    await page.reload();
    await fold.waitFor();
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    assert.equal(await sections.first().isVisible(), false);
    assert.equal(await sourceToggle.getAttribute("aria-expanded"), "true", "The new outline opens its source branch");
    await page.locator("#fit").click();
    await fold.click();
    await sections.first().waitFor();

    const childId = await sections.first().getAttribute("data-element-id");
    await askFromCard(page, childId, followup);
    const nestedBridge = page.locator(`#threads .thread-note[data-anchor="${childId}"]`).filter({ hasText: followup });
    await nestedBridge.locator(".thread-answer").filter({ hasText: nested.summary }).waitFor();
    assert.deepEqual(executions.at(-1).anchor.elementIds, [childId]);
    assert.match(executions.at(-1).anchor.quote, /客户端收集卡片编号/);
    const nestedId = await nestedBridge.getAttribute("data-element-id");
    const nestedCards = page.locator(`#threads [data-section-of="${nestedId}"]`);
    assert.equal(await nestedCards.count(), 2);
    assert.equal(await page.locator(`#connections path[data-parent-id="${childId}"][data-child-id="${nestedId}"]`).count(), 1);

    const converted = sections.nth(1);
    const convertedId = await converted.getAttribute("data-element-id");
    await askFromCard(page, convertedId, splitChild);
    await converted.locator(".thread-answer").filter({ hasText: nested.summary }).waitFor();
    assert.equal(await converted.getAttribute("data-section-of"), parentId);
    assert.equal(await converted.locator(".thread-question").innerText(), explanationFixture.sections[1].title);
    assert.equal(await sections.count(), 3, "Converting a section keeps it in its original parent's group");
    assert.equal(await page.locator(`#threads [data-section-of="${convertedId}"]`).count(), 2);
    const original = explanationFixture.sections[1];
    assert.deepEqual(executions.at(-1).sourceAnswer, { question: original.title, answer: original.text });
    assert.equal((await readManualNotes(page)).find(({ id }) => id === convertedId).originalAnswer, original.text);

    await bridge.press("Enter");
    await page.locator("#delete-selection").click();
    await bridge.waitFor({ state: "detached" });
    await page.locator("#repair-delete").waitFor();
    const remaining = await readManualNotes(page);
    for (const { id } of storedChildren) {
      const child = remaining.find((note) => note.id === id);
      assert.equal(child.sectionOf, undefined);
      assert.deepEqual(child.payload.anchor.elementIds, ["E05"], "Deleted bridge children should stay attached to its source card");
    }
    assert.equal(remaining.filter((note) => note.sectionOf === convertedId).length, 2,
      "Reattaching a section should preserve its own children");
    await page.locator("#undo-delete").click();
    await bridge.waitFor();
    assert.equal(await sections.count(), 3);
    assert.equal(await page.locator(`#threads [data-section-of="${convertedId}"]`).count(), 2);
    assertNoJsErrors(jsErrors);
    record("U26", "PASS", "An explanation shows a concise bridge and grouped details. Recursive follow-up, in-place splitting, folding, deletion and undo preserve detail relationships.", { screenshot: shot });
  } catch (error) { record("U26", "FAIL", safeError(error)); await screenshot("U26-failure", session.page); }
  finally { await closeSession(session); }
}

async function testSplitExistingAnswer() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const originalQuestion = "白板如何把问题交给 Codex？";
    const originalAnswer = [
      "**原回答保留标记**",
      "这条批注先解释选区，再解释请求上下文。".repeat(24),
      "最后说明服务怎样校验请求并保存结果。".repeat(18),
    ].join("\n\n");
    const question = "把这个长回答拆成一张总览和几个独立内容卡。";
    const error = "ZCode 的解释分支未生成：第 2 张说明卡的标题与前面的卡片重复。";
    const markup = "<img src=x onerror=alert(1)>";
    const responsePreview = JSON.stringify({ summary: markup, sections: [{ title: "重复" }, { title: "重复" }] });
    await page.evaluate(({ originalQuestion, originalAnswer }) => {
      const key = "whiteboard.codex.repo-manual.v1";
      const state = JSON.parse(localStorage.getItem(key));
      const rect = { x: 360, y: 480, width: 300, height: 160 };
      state.notes.push({
        id: "A01", kind: "note", rect, sourceCardIds: ["E05"], anchors: [rect],
        payload: { question: originalQuestion, anchor: { elementIds: ["E05"], box: rect, quote: "为什么用白板" } },
        answer: originalAnswer,
      });
      localStorage.setItem(key, JSON.stringify(state));
    }, { originalQuestion, originalAnswer });
    await page.reload();
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    const executions = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      const planning = request.scope === "plan";
      if (!planning) executions.push(request);
      const event = planning ? { type: "answer", text: '{"action":"splitAnswer"}' } :
        { type: "explanation", explanation: explanationFixture };
      const events = !planning && executions.length === 2
        ? [{ type: "error", text: error, responsePreview }]
        : planning || executions.length > 2 ? [event, { type: "done" }] : [event];
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      });
    });

    const bridge = page.locator('#threads [data-element-id="A01"]');
    await bridge.locator(".thread-answer").filter({ hasText: "原回答保留标记" }).waitFor();
    const attempted = page.waitForRequest((entry) => entry.url().endsWith("/api/codex") &&
      entry.method() === "POST" && entry.postDataJSON().scope === "explain");
    await Promise.all([attempted, askFromCard(page, "A01", question)]);
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    assert.equal(await bridge.locator(".thread-answer").innerText(), originalAnswer,
      "An incomplete split must leave the previous answer intact");
    assert.equal(await page.locator('#threads [data-section-of="A01"]').count(), 0);

    await askFromCard(page, "A01", question);
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    await bridge.locator(".thread-status").filter({ hasText: error }).waitFor();
    assert.equal(await bridge.locator(".thread-answer").innerText(), originalAnswer,
      "A rejected ZCode candidate must preserve the original answer");
    assert.equal(await page.locator('#threads [data-section-of="A01"]').count(), 0);
    const failedNotes = await readManualNotes(page);
    assert.equal(failedNotes.length, 1, "A rejected ZCode candidate must save no new cards");
    assert.equal(failedNotes[0].answer, originalAnswer);
    assert.ok(!JSON.stringify(failedNotes).includes(markup), "Rejected response previews must stay in the current page");

    await page.locator("#fit").click();
    const previewButton = bridge.locator(".thread-response-preview");
    await previewButton.click();
    const dialog = page.locator("#response-preview-dialog");
    await dialog.waitFor();
    assert.equal(await page.locator("#response-preview-reason").textContent(), error);
    const preview = page.locator("#response-preview-text");
    assert.equal(await preview.textContent(), responsePreview);
    assert.equal(await preview.locator("img").count(), 0, "Model preview was interpreted as HTML");
    await dialog.getByRole("button", { name: "关闭" }).click();
    await bridge.locator(".thread-retry").click();
    await bridge.locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    assert.equal(await previewButton.isVisible(), false, "A successful retry must hide the previous failure preview");
    assert.equal(await bridge.getAttribute("data-anchor"), "E05");
    assert.equal(await bridge.locator(".thread-question").innerText(), originalQuestion);
    assert.deepEqual(executions.map(({ backend, mode, scope, anchor, sourceAnswer }) =>
      [backend, mode, scope, anchor.elementIds, sourceAnswer]), Array.from({ length: 3 }, () => [
      "zcode", "ask", "explain", ["A01"], { question: originalQuestion, answer: originalAnswer },
    ]));
    const sections = page.locator('#threads [data-section-of="A01"]');
    assert.equal(await sections.count(), 3);
    const notes = await readManualNotes(page);
    assert.equal(notes.length, 4, "The split should reuse the existing note, without adding another bridge");
    assert.equal(notes.find((note) => note.id === "A01").originalAnswer, originalAnswer);

    await page.reload();
    await bridge.locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    const archive = bridge.locator("details.thread-original");
    const archiveToggle = archive.locator("summary").filter({ hasText: "查看原回答" });
    assert.equal(await archive.getAttribute("open"), null);
    await page.locator("#fit").click();
    await archiveToggle.click();
    assert.equal(await archive.evaluate((element) => element.open), true);
    await archive.getByText("原回答保留标记", { exact: false }).waitFor();
    assertNoJsErrors(jsErrors);
    record("U27", "PASS", "A rejected ZCode split shows its reason and literal response preview without storing invalid cards or altering the original answer. Incomplete output also stays atomic, and a successful retry replaces the failure.");
  } catch (error) { record("U27", "FAIL", safeError(error)); await screenshot("U27-failure", session.page); }
  finally { await closeSession(session); }
}

async function testGeneratedExplanationHierarchy() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const toggle = (id) => card(id).locator(".branch-toggle");
    const expectFold = async (id, expanded, count) => {
      assert.equal(await toggle(id).getAttribute("aria-expanded"), String(expanded));
      assert.equal(await toggle(id).getAttribute("aria-label"),
        `${id} ${expanded ? "收起" : "展开"} ${count} 个下级节点`);
    };
    const question = "请一次生成多级说明卡，按请求链路拆到三级细节。";
    const explanation = {
      summary: "把请求链路和检查拆成两个分支，并逐级解释关键细节。",
      sections: [
        { title: "请求链路", text: "前端先准备当前选区的请求。", parentIndex: null },
        { title: "上下文组装", text: "请求会附上选中的卡片。", parentIndex: 0 },
        { title: "定位字段", text: "元素编号标明被选中的卡片。", parentIndex: 1 },
        { title: "验证方法", text: "检查返回内容和保存后的卡片。", parentIndex: null },
        { title: "回归入口", text: "刷新后核对生成的父子关系。", parentIndex: 3 },
      ],
    };
    const requests = [];
    let attempts = 0;
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      let event = { type: "answer", text: '{"action":"explain"}' };
      if (request.scope === "explain") {
        const first = attempts++ === 0;
        event = { type: "explanation", explanation: first ? {
          ...explanation,
          sections: explanation.sections.map((section, index) => index === 3 ? { ...section, parentIndex: 4 } : section),
        } : explanation };
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [event, { type: "done" }].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      });
    });

    await askFromCard(page, "E05", question);
    const bridge = card("A01");
    await bridge.locator('.thread-status[data-state="failed"]').waitFor();
    assert.equal(await page.locator("#threads [data-section-of]").count(), 0, "Invalid parent indices must not mount partial cards");
    assert.equal((await readManualNotes(page)).length, 1, "Invalid parent indices must not save partial cards");
    await page.locator("#fit").click();
    await bridge.locator(".thread-retry").click();
    await bridge.locator(".thread-answer").filter({ hasText: explanation.summary }).waitFor();
    assert.deepEqual(requests.map(({ backend, mode, scope, question }) => [backend, mode, scope, scope === "explain" ? question : null]),
      [["zcode", "ask", "plan", null], ["zcode", "ask", "explain", question], ["zcode", "ask", "explain", question]]);
    assert.deepEqual(requests.filter(({ scope }) => scope === "explain").map(({ minimumDepth }) => minimumDepth), [2, 2],
      "The question must ask for a hierarchy and retain that requirement on retry");

    const edges = [["A01", "A02"], ["A02", "A03"], ["A03", "A04"], ["A01", "A05"], ["A05", "A06"]];
    const checkParents = async () => {
      const notes = await readManualNotes(page);
      assert.equal(notes.length, 6, "One explanation result should create the whole tree exactly once");
      for (const [parent, child] of edges) {
        assert.equal(await card(child).getAttribute("data-section-of"), parent);
        const saved = notes.find(({ id }) => id === child);
        assert.equal(saved?.sectionOf, parent);
        assert.deepEqual(saved.payload.anchor.elementIds, [parent]);
      }
    };
    await checkParents();
    await expectFold("A01", true, 5);
    await expectFold("A02", false, 2);
    await expectFold("A05", false, 1);
    assert.equal(await card("A03").isVisible(), false);
    assert.equal(await card("A04").isVisible(), false);
    assert.equal(await card("A06").isVisible(), false);

    await toggle("A02").press("Enter");
    await card("A03").waitFor();
    await expectFold("A03", false, 1);
    assert.equal(await card("A04").isVisible(), false, "Opening one level must not unfold its child branch");
    await toggle("A03").press("Enter");
    await card("A04").waitFor();
    for (const [parent, child] of edges.slice(0, 4)) {
      await connectionPath(page, parent, child).waitFor({ state: "attached" });
    }
    await toggle("A01").press("Enter");
    await card("A02").waitFor({ state: "hidden" });
    await page.reload();
    await expectFold("A01", false, 5);
    await toggle("A01").press("Enter");
    await card("A04").waitFor();
    await expectFold("A02", true, 2);
    await expectFold("A03", true, 1);
    await expectFold("A05", false, 1);
    assert.equal(await card("A06").isVisible(), false);
    await checkParents();
    assertNoJsErrors(jsErrors);
    record("U59", "PASS", "A single validated ZCode explanation generates a three-level card tree, rejects invalid parent indices atomically, and persists independent folds and exact parents.");
  } catch (error) { record("U59", "FAIL", safeError(error)); await screenshot("U59-failure", session.page); }
  finally { await closeSession(session); }
}

async function testGeneratedTaskHierarchy() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const taskDetails = { task: "准备请求链路的验收。", dependencies: [], acceptance: ["能从页面提交。"] };
    const plan = candidate();
    plan.collapsedBranches = [];
    plan.items.push({ id: "E04", category: "reference", parentId: "E02", title: "验收请求链路",
      summary: taskDetails.task, taskDetails });
    await page.evaluate(([key, current]) => localStorage.setItem(key, JSON.stringify({ current })), [organizationKey, plan]);
    await page.reload();
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const toggle = (id) => card(id).locator(".branch-toggle");
    const children = [
      { title: "验证输入", task: "核对请求提交前的选区。", dependencies: [], acceptance: ["包含选中卡片 ID。"], parentIndex: null },
      { title: "验证持久化", task: "核对刷新后恢复的卡片。", dependencies: ["已生成说明卡。"], acceptance: ["能恢复父子关系。"], parentIndex: 0 },
      { title: "验证回归场景", task: "检查空选区不能提交。", dependencies: [], acceptance: ["空选区时提交按钮禁用。"], parentIndex: 1 },
    ];
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      requests.push(route.request().postDataJSON());
      const response = requests.length === 1 ? children.map(({ parentIndex, ...child }) => child) : children;
      const events = [{ type: "children", children: response }, { type: "done" }];
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      });
    });

    const before = await readOrganization(page);
    await card("E04").press("Enter");
    const split = page.locator("#split-module-tree");
    await split.click();
    await page.locator("#organization-status").filter({ hasText: /至少|层级|多级/ }).waitFor();
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    assert.deepEqual(await readOrganization(page), before, "Flat task results must be rejected without writing cards");
    await split.click();
    await page.getByText(children[0].title, { exact: true }).waitFor();
    assert.equal(requests.length, 2, "Each button click should send only one task generation request");
    for (const request of requests) {
      assert.equal(request.backend, "zcode");
      assert.equal(request.scope, "decompose");
      assert.equal(request.minimumDepth, 2);
      assert.equal(request.decomposition.targetId, "E04");
    }
    const current = await readOrganization(page);
    const additions = children.map(({ title }) => current.items.find((item) => item.title === title));
    assert.deepEqual(additions.map(({ parentId }) => parentId), ["E04", additions[0].id, additions[1].id]);
    assert.deepEqual(additions.map(({ taskDetails }) => taskDetails), children.map(({ title, parentIndex, ...details }) => details));
    const [first, second, third] = additions;
    assert.equal(await toggle(first.id).getAttribute("aria-expanded"), "false");
    assert.equal(await card(second.id).isVisible(), false);
    assert.equal(await card(third.id).isVisible(), false);
    await toggle(first.id).press("Enter");
    await card(second.id).waitFor();
    assert.equal(await toggle(second.id).getAttribute("aria-expanded"), "false");
    await toggle(second.id).press("Enter");
    await card(third.id).waitFor();
    await page.reload();
    await card(third.id).waitFor();
    assert.equal((await readOrganization(page)).items.find(({ id }) => id === third.id).parentId, second.id);
    await page.locator("#undo-organization").click();
    await card(first.id).waitFor({ state: "detached" });
    assert.deepEqual(await readOrganization(page), before, "Undo should remove the generated subtree together");
    assertNoJsErrors(jsErrors);
    record("U60", "PASS", "The explicit multilevel task action rejects a flat reply atomically, creates three levels in one response, and preserves folding, task details and undo.");
  } catch (error) { record("U60", "FAIL", safeError(error)); await screenshot("U60-failure", session.page); }
  finally { await closeSession(session); }
}

async function testOrganizeSelectedBranch() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const button = page.locator("#organize-branch");
    const readPlan = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current);
    const ids = [
      "E07", "E21", "E22", "E23", "E24", "E25", "E26", "E27", "E28",
      "E43", "E44", "E45", "E46", "E47", "E48", "E49",
    ];
    const scope = new Set(ids);
    const opinion = "把 HTTP 入口和意图判断分开说明，先突出输入输出。";
    const branchTitle = "从请求入口到模型结果";
    const foldedSummary = "草稿先校验整批操作，验证通过才提交到白板。";
    const attempts = [];

    assert.equal(await button.isEnabled(), false, "Branch organization requires a selected card");
    for (const id of ["E07", "E21"]) {
      await card(id).locator(".branch-toggle").click();
      await page.locator("#fit").click();
    }
    await card("E24").waitFor({ state: "hidden" });
    await dragCard(page, "E08", 120, -90);
    await page.locator("#fit").click();
    await dragCard(page, "E25", 95, 75);
    await page.locator("#pin-mode").click();
    await title("E25").click();
    assert.ok(await card("E25").evaluate((element) => element.classList.contains("board-pinned")));
    await page.locator("#select-mode").click();
    await page.locator("#fit").click();
    await dragCard(page, "E23", -135, 95);
    await page.locator("#fit").click();
    await title("E07").click();
    assert.equal(await button.isEnabled(), true);
    await openDetails(page, "organization-options");
    await page.locator("#organization-opinion").fill(opinion);

    const before = await readPlan();
    const beforeRects = await visibleCardRects(page);
    assert.ok(before.positions.E08 && before.positions.E25 && before.positions.E23,
      "The fixture must have unrelated, pinned, and movable manual positions");
    const outside = ({ id }) => !scope.has(id);
    const position = ({ x, y, width }) => ({ x, y, width });
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      attempts.push(request);
      const items = request.board.nodes.map((node) => ({
        id: node.id,
        parentId: node.id === "E22" ? (attempts.length === 1 ? "E08" : "E07") : node.layoutParentId,
        title: node.id === "E07" ? branchTitle : node.title,
        summary: node.id === "E24" ? foldedSummary : node.summary,
      }));
      const events = [{ type: "branch", branch: { items } }, { type: "done" }];
      await route.fulfill({ contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });
    const send = async () => {
      const response = page.waitForResponse((candidate) =>
        new URL(candidate.url()).pathname === "/api/codex" && candidate.request().method() === "POST");
      await button.click();
      await response;
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
    };

    await send();
    assert.deepEqual(await readPlan(), before, "A candidate with an outside parent must be rejected atomically");
    assert.equal(attempts[0].scope, "organizeBranch");
    assert.equal(attempts[0].mode, "ask");
    assert.equal(attempts[0].branchRootId, "E07");
    assert.ok(attempts[0].question.includes(opinion), "The selected branch request should include the optional instruction");
    assert.deepEqual(attempts[0].board.nodes.map(({ id }) => id).sort(), ids.toSorted());
    assert.equal(attempts[0].board.nodes.find(({ id }) => id === "E07").layoutParentId, null);
    assert.equal(attempts[0].board.nodes.find(({ id }) => id === "E24").layoutParentId, "E23");
    assert.equal(attempts[0].board.nodes.find(({ id }) => id === "E25").pinned, true);

    await send();
    await title("E07").filter({ hasText: branchTitle }).waitFor();
    const after = await readPlan();
    const afterRects = await visibleCardRects(page);
    assert.deepEqual(after.items.filter(outside), before.items.filter(outside));
    assert.deepEqual(after.layout, before.layout);
    assert.deepEqual(after.collapsedBranches, before.collapsedBranches);
    assert.equal(after.items.find(({ id }) => id === "E07").parentId, "E04");
    assert.equal(after.items.find(({ id }) => id === "E22").parentId, "E07");
    assert.equal(after.items.find(({ id }) => id === "E24").summary, foldedSummary);
    assert.equal(await card("E24").isVisible(), false);
    for (const id of Object.keys(beforeRects).filter((id) => !scope.has(id) || ["E07", "E25"].includes(id))) {
      assert.deepEqual(position(afterRects[id]), position(beforeRects[id]), `Branch organization moved fixed card ${id}`);
    }
    assert.notDeepEqual(position(afterRects.E23), position(beforeRects.E23), "A movable descendant should be arranged again");
    const shot = await screenshot("U28-organize-selected-branch", page);

    await page.reload();
    assert.deepEqual(await readPlan(), after);
    await page.locator("#fit").click();
    await card("E23").locator(".branch-toggle").click();
    await card("E24").waitFor({ state: "visible" });
    const opened = await visibleCardRects(page);
    assert.ok(cardGap(opened.E23, opened.E24) <= 180, "A folded detail should open near its reorganized parent");
    await page.locator("#fit").click();
    await card("E23").locator(".branch-toggle").click();
    await card("E24").waitFor({ state: "hidden" });
    await page.locator("#undo-organization").click();
    const undone = await readPlan();
    const undoneRects = await visibleCardRects(page);
    assert.deepEqual(undone.items, before.items);
    assert.deepEqual(undone.collapsedBranches, before.collapsedBranches);
    for (const [id, rect] of Object.entries(beforeRects)) {
      assert.deepEqual(position(undoneRects[id]), position(rect), `Undo did not restore card ${id}`);
    }
    assertNoJsErrors(jsErrors);
    record("U28", "PASS", "The selected branch sends folded descendants, rejects outside parents, and reorganizes locally with reload-safe undo.", { screenshot: shot });
  } catch (error) { record("U28", "FAIL", safeError(error)); await screenshot("U28-failure", session.page); }
  finally { await closeSession(session); }
}

async function testOrganizeExplanationBranch() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const node = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const question = "整理这张总览下面的说明，让每张卡只保留一个重点。";
    const revisedOverview = "整理后的总览：先定位选区，再提交和保存。";
    const revisedDetail = "编号和摘录分别用于定位和理解。";
    const nested = { summary: "锚点包含编号和摘录。", sections: [
      { title: "编号", text: "编号定位画布元素。" },
      { title: "摘录", text: "摘录保存用户关心的文字。" },
    ] };
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      let event;
      if (request.scope === "plan") event = { type: "answer", text: '{"action":"organizeBranch"}' };
      else if (request.scope === "explain") event = { type: "explanation",
        explanation: request.sourceAnswer ? nested : explanationFixture };
      else event = { type: "branch", branch: { items: request.board.nodes.map((entry) => ({
        id: entry.id, parentId: entry.layoutParentId, title: entry.title,
        summary: entry.id === "A01" ? revisedOverview : entry.id === "A02" ? revisedDetail : entry.summary || entry.text,
      })) } };
      await route.fulfill({ contentType: "application/x-ndjson",
        body: [event, { type: "done" }].map((entry) => JSON.stringify(entry)).join("\n") + "\n" });
    });

    const split = page.locator("#split-module");
    assert.equal(await split.isEnabled(), false);
    await node("E02").press("Enter");
    await split.click();
    await node("A01").locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    await node("A02").press("Enter");
    await split.click();
    await node("A02").locator(".thread-answer").filter({ hasText: nested.summary }).waitFor();
    assert.deepEqual(requests.map(({ mode, scope }) => [mode, scope]), [["ask", "explain"], ["ask", "explain"]]);
    assert.deepEqual(requests[1].sourceAnswer, {
      question: explanationFixture.sections[0].title, answer: explanationFixture.sections[0].text,
    });
    assert.equal(await node("A02").getAttribute("data-section-of"), "A01");
    assert.equal(await node("A05").getAttribute("data-section-of"), "A02");

    await page.locator("#fit").click();
    await node("A01").locator(".branch-toggle").click();
    await node("A05").waitFor({ state: "hidden" });
    await askFromCard(page, "A01", question);
    await node("A01").locator(".thread-answer").filter({ hasText: revisedOverview }).waitFor();
    assert.deepEqual(requests.slice(2).map(({ mode, scope }) => [mode, scope]),
      [["ask", "plan"], ["ask", "organizeBranch"]]);
    assert.equal(requests[3].branchRootId, "A01");
    assert.equal(requests[3].question, question);
    assert.deepEqual(requests[3].board.nodes.map(({ id }) => id).sort(), ["A01", "A02", "A03", "A04", "A05", "A06"]);
    assert.equal(await node("A01").getAttribute("data-anchor"), "E02");
    assert.equal(await node("A05").isVisible(), false, "Branch organization preserves the collapsed outline");
    await page.locator("#fit").click();
    await node("A01").locator(".branch-toggle").click();
    await node("A02").locator(".thread-answer").filter({ hasText: revisedDetail }).waitFor();
    await node("A05").waitFor();
    assert.equal(await node("A05").getAttribute("data-section-of"), "A02");
    const archive = node("A02").locator("details.thread-original");
    await page.locator("#fit").click();
    await archive.locator("summary").click();
    await archive.getByText(explanationFixture.sections[0].text, { exact: true }).waitFor();

    await page.locator("#undo-organization").click();
    await node("A01").locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    await node("A02").locator(".thread-answer").filter({ hasText: nested.summary }).waitFor();
    assert.equal(await node("A02").getAttribute("data-section-of"), "A01");
    assert.equal(await node("A05").getAttribute("data-section-of"), "A02");
    assertNoJsErrors(jsErrors);
    record("U29", "PASS", "Explicit splitting and prompt-driven branch organization preserve native explanation cards, folded descendants, source answers, and undo.");
  } catch (error) { record("U29", "FAIL", safeError(error)); await screenshot("U29-failure", session.page); }
  finally { await closeSession(session); }
}

async function selectConnection(page, parent, child, button = "left") {
  const target = page.locator(`.connection-hit[data-edge-parent="${parent}"][data-edge-child="${child}"]`);
  const point = await target.evaluate((path) => {
    const transform = path.getScreenCTM();
    const length = path.getTotalLength();
    for (const ratio of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]) {
      const at = path.getPointAtLength(length * ratio).matrixTransform(transform);
      if (document.elementFromPoint(at.x, at.y) === path) return { x: at.x, y: at.y };
    }
    return null;
  });
  assert.ok(point, `Connection ${parent} → ${child} needs a clickable stroke`);
  await page.mouse.click(point.x, point.y, { button });
}

function connectionPath(page, parent, child) {
  return page.locator(`#connections > path[data-parent-id="${parent}"][data-child-id="${child}"]`);
}

async function testManualConnections() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const connect = page.locator("#connect-mode");
    assert.equal(await connect.count(), 1, "The board needs a manual connection control");
    const remove = page.locator("#delete-connection");
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const readPlan = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current);
    const parentOf = async (id) => (await readPlan()).items.find((item) => item.id === id).parentId;
    const relate = async (parent, child) => {
      await title(parent).click();
      await title(child).click();
    };
    const modelPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST") modelPosts.push(new URL(request.url()).pathname);
    });

    for (const id of ["E07", "E06"]) {
      await card(id).locator(".branch-toggle").click();
      await page.locator("#fit").click();
    }
    const before = await visibleCardRects(page);
    assert.equal(await parentOf("E21"), "E07");
    assert.equal(await remove.isVisible(), false);
    await connect.click();
    assert.equal(await connect.getAttribute("aria-pressed"), "true");
    assert.equal(await remove.isEnabled(), false);

    await relate("E06", "E21");
    assert.equal(await parentOf("E21"), "E06");
    await connectionPath(page, "E06", "E21").waitFor();
    assert.equal(await connectionPath(page, "E07", "E21").count(), 0);
    const linked = await readPlan();

    await relate("E21", "E06");
    await page.locator("#status").filter({ hasText: /循环/ }).waitFor();
    assert.deepEqual(await readPlan(), linked, "A cycle must leave the stored board unchanged");

    await selectConnection(page, "E06", "E21");
    assert.equal(await remove.isEnabled(), true);
    const shot = await screenshot("U30-manual-connections", page);
    await remove.click();
    assert.equal(await parentOf("E21"), null);
    assert.equal(await connectionPath(page, "E06", "E21").count(), 0);
    await title("E21").waitFor({ state: "visible" });
    const assertPositions = async () => {
      const now = await visibleCardRects(page);
      assert.deepEqual(Object.keys(now).sort(), Object.keys(before).sort(), "Connection edits should keep the cards visible");
      for (const [id, { x, y, width }] of Object.entries(before)) {
        assert.deepEqual([now[id].x, now[id].y, now[id].width], [x, y, width], `Connection editing moved card ${id}`);
      }
    };
    await assertPositions();
    await page.reload();
    assert.equal(await parentOf("E21"), null);
    assert.equal(await connectionPath(page, "E06", "E21").count(), 0);
    await assertPositions();
    await page.locator("#undo-organization").click();
    assert.equal(await parentOf("E21"), "E06");
    await connectionPath(page, "E06", "E21").waitFor();
    await assertPositions();
    assert.deepEqual(modelPosts, [], "Connection editing must stay local to the browser");
    assertNoJsErrors(jsErrors);
    record("U30", "PASS", "Manual connection changes replace parents, reject cycles, preserve card positions, and support local deletion and reload-safe undo.", { screenshot: shot });
  } catch (error) { record("U30", "FAIL", safeError(error)); await screenshot("U30-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRawManualConnections() {
  const session = await openPage();
  try {
    const { page, jsErrors } = session;
    const posts = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    await page.evaluate(() => {
      const anchors = ["E02", "E03"].map((id) => {
        const card = document.querySelector(`#board [data-element-id="${id}"]`);
        return { x: card.offsetLeft + 28, y: card.offsetTop + 25, width: 60, height: 22 };
      });
      const rect = { x: 510, y: 610, width: 260, height: 120 };
      const note = { id: "A01", kind: "note", rect, sourceCardIds: ["E02", "E03"], anchors,
        payload: { question: "Keep the original explanation and references",
          anchor: { elementIds: ["E02", "E03"], box: anchors[0], quote: "Original quoted text" } },
        answer: "Original note body" };
      localStorage.setItem("whiteboard.codex.v1", JSON.stringify({ notes: [note] }));
    });
    await page.reload();
    await page.locator("#fit").click();
    const readGraph = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.organization.v1")));
    const readProvenance = () => page.evaluate(() => {
      const { payload, sourceCardIds, answer } = JSON.parse(localStorage.getItem("whiteboard.codex.v1")).notes[0];
      return { payload, sourceCardIds, answer };
    });
    const geometry = () => page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll("#board [data-element-id]:not([hidden])")].map((element) =>
        [element.dataset.elementId, [element.offsetLeft, element.offsetTop, element.offsetWidth]])));
    const before = await geometry();
    const provenance = await readProvenance();
    await connectionPath(page, "E02", "A01").waitFor();
    await connectionPath(page, "E03", "A01").waitFor();
    await page.locator("#connect-mode").click();
    await page.locator('#board [data-element-id="E01"] .element-title').click();
    await page.locator('#threads [data-element-id="A01"] .thread-answer').click();
    await connectionPath(page, "E01", "A01").waitFor();
    await connectionPath(page, "E03", "A01").waitFor();
    assert.equal(await connectionPath(page, "E02", "A01").count(), 0);
    const linked = await readGraph();
    assert.equal(linked.current, null);
    assert.deepEqual(linked.rawLinks.A01, ["E01", "E03"], "The secondary legacy connection should be preserved");

    await selectConnection(page, "E03", "A01");
    await page.locator("#delete-connection").click();
    assert.deepEqual((await readGraph()).rawLinks.A01, ["E01"]);
    await page.reload();
    await connectionPath(page, "E01", "A01").waitFor();
    assert.equal(await connectionPath(page, "E03", "A01").count(), 0);
    await page.locator("#undo-organization").click();
    assert.deepEqual((await readGraph()).rawLinks.A01, ["E01", "E03"]);
    await connectionPath(page, "E03", "A01").waitFor();
    assert.deepEqual(await geometry(), before);
    assert.deepEqual(await readProvenance(), provenance);

    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    await page.locator("#connect-mode").click();
    for (const [parent, child] of [["E01", "E02"], ["E02", "E03"]]) {
      await card(parent).press("Enter");
      await card(child).press("Enter");
      await connectionPath(page, parent, child).waitFor({ state: "attached" });
    }
    const original = await geometry();
    await page.locator("#select-mode").click();
    await card("E02").press("Enter");
    const quick = page.locator("#quick-reorder");
    const layouts = {};
    for (const mode of ["compact", "horizontal"]) {
      await quick.click();
      assert.equal((await readGraph()).branchQuickModes?.E02, mode);
      const placed = await geometry();
      for (const id of ["E01", "E02", "A01"]) {
        assert.deepEqual(placed[id], original[id], `Raw branch quick reorder moved fixed card ${id}`);
      }
      assert.notDeepEqual(placed.E03, original.E03, "The raw descendant should move on the rendered board");
      layouts[mode] = placed;
    }
    const assertGeometry = async (expected) => {
      const actual = await geometry();
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
      for (const [id, coordinates] of Object.entries(expected)) {
        assert.ok(coordinates.every((value, index) => Math.abs(value - actual[id][index]) <= 1),
          `Card ${id} should restore its position within one pixel of browser rounding`);
      }
    };
    assert.notDeepEqual(layouts.horizontal.E03, layouts.compact.E03);
    await page.reload();
    await assertGeometry(layouts.horizontal);
    await page.locator("#undo-organization").click();
    assert.equal((await readGraph()).branchQuickModes?.E02, "compact");
    await assertGeometry(layouts.compact);

    const toggle = (id) => card(id).locator(".branch-toggle");
    assert.equal(await toggle("E01").count(), 1, "A raw module controls its locally linked subtree");
    assert.equal(await toggle("E01").getAttribute("aria-label"), "E01 收起 3 个下级节点");
    await toggle("E02").press("Enter");
    assert.equal(await card("E03").isVisible(), false);
    assert.equal(await card("A01").isVisible(), true, "A secondary raw connection does not own the answer's fold");
    await connectionPath(page, "E01", "A01").waitFor({ state: "attached" });
    assert.equal(await connectionPath(page, "E03", "A01").count(), 0);
    await toggle("E01").press("Enter");
    await page.reload();
    assert.equal(await toggle("E01").getAttribute("aria-label"), "E01 展开 3 个下级节点");
    for (const id of ["E02", "E03", "A01"]) assert.equal(await card(id).isVisible(), false);
    await toggle("E01").press("Enter");
    await card("A01").waitFor();
    assert.equal(await toggle("E02").getAttribute("aria-expanded"), "false");
    await toggle("E02").press("Enter");
    await connectionPath(page, "E03", "A01").waitFor({ state: "attached" });
    assert.deepEqual(await readProvenance(), provenance);
    assert.deepEqual(posts, [], "Raw connection and quick reorder actions must stay local");
    assertNoJsErrors(jsErrors);
    record("U31", "PASS", "Raw links retain their second source and provenance. Scoped reflow and nested folds follow the primary local relationship, including after reload.");
  } catch (error) { record("U31", "FAIL", safeError(error)); await screenshot("U31-failure", session.page); }
  finally { await closeSession(session); }
}

async function testDirectionalConnectionDrag() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const connect = page.locator("#connect-mode");
    const preview = page.locator("#connection-preview");
    const readPlan = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current);
    const pointOn = async (id) => {
      const box = await title(id).boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const startDrag = async (id) => {
      const from = await pointOn(id);
      await page.keyboard.down("Shift");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
    };
    const finishDrag = async () => {
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await preview.waitFor({ state: "hidden" });
      assert.equal(await page.locator(".connection-target").count(), 0);
    };
    const modelPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST") modelPosts.push(new URL(request.url()).pathname);
    });

    for (const id of ["E07", "E06"]) {
      await card(id).locator(".branch-toggle").click();
      await page.locator("#fit").click();
    }
    await connect.click();
    await title("E06").click();
    const before = await readPlan();
    const initialRects = await visibleCardRects(page);
    const blank = await page.locator("#viewport").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      for (const offset of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = bounds.left + bounds.width * 0.08;
        const y = bounds.top + bounds.height * offset;
        const element = document.elementFromPoint(x, y);
        if (viewport.contains(element) && !element.closest("[data-element-id]")) return { x, y };
      }
      return null;
    });
    assert.ok(blank, "The drag needs empty canvas for its live preview and cancellation cases");
    await startDrag("E06");
    await page.mouse.move(blank.x, blank.y, { steps: 8 });
    await preview.waitFor();
    const toBlank = await preview.evaluate((path) => {
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
      return { x: end.x, y: end.y };
    });
    assert.ok(Math.hypot(toBlank.x - blank.x, toBlank.y - blank.y) < 3, "The preview arrow should follow the pointer in empty canvas");
    assert.deepEqual(await readPlan(), before, "The gesture must not change saved relationships before release");

    const to = await pointOn("E21");
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.locator('[data-element-id="E21"].connection-target').waitFor();
    assert.match(await preview.evaluate((path) => getComputedStyle(path).markerEnd), /#connection-preview-tip/);
    const previewEnds = await preview.evaluate((path) => {
      return [0, path.getTotalLength()].map((distance) => {
        const { x, y } = path.getPointAtLength(distance);
        return { x, y };
      });
    });
    assertCardOnEdge(previewEnds[0], initialRects.E06, "The preview should leave the selected source");
    assert.ok(previewEnds[1].x >= initialRects.E21.x - 2 && previewEnds[1].x <= initialRects.E21.x + initialRects.E21.width + 2 &&
      previewEnds[1].y >= initialRects.E21.y - 2 && previewEnds[1].y <= initialRects.E21.y + initialRects.E21.height + 2,
    "The preview arrowhead should point to the hovered target");
    await finishDrag();
    const edge = connectionPath(page, "E06", "E21");
    await edge.waitFor();
    const linked = await readPlan();
    assert.equal(linked.items.find((item) => item.id === "E21").parentId, "E06");
    assert.equal(await connectionPath(page, "E07", "E21").count(), 0);
    assert.match(await edge.evaluate((path) => getComputedStyle(path).markerEnd), /#connection-tip/);
    assert.deepEqual(await visibleCardRects(page), initialRects, "Drawing a line must preserve the card positions");

    await startDrag("E21");
    const cycle = await pointOn("E06");
    await page.mouse.move(cycle.x, cycle.y, { steps: 8 });
    await finishDrag();
    await page.locator("#status").filter({ hasText: /循环/ }).waitFor();
    assert.deepEqual(await readPlan(), linked, "A drag that would create a cycle must not change the board");
    await startDrag("E05");
    await page.mouse.move(blank.x, blank.y, { steps: 8 });
    await preview.waitFor();
    await finishDrag();
    assert.deepEqual(await readPlan(), linked, "Dropping the arrow over empty canvas must not change the board");

    await connect.click();
    await title("E05").click();
    await title("E06").click({ modifiers: ["Shift"] });
    assert.equal(await card("E05").getAttribute("aria-pressed"), "true");
    assert.equal(await card("E06").getAttribute("aria-pressed"), "true", "Shift-click must still add to ordinary selection");
    await page.reload();
    assert.equal((await readPlan()).items.find((item) => item.id === "E21").parentId, "E06");
    await connectionPath(page, "E06", "E21").waitFor();
    assert.deepEqual(modelPosts, [], "Dragging a connection must run locally");
    assertNoJsErrors(jsErrors);
    record("U32", "PASS", "Shift-drag previews direction, highlights the target, persists the directional relationship, and leaves the board intact on invalid drops.");
  } catch (error) { record("U32", "FAIL", safeError(error)); await screenshot("U32-failure", session.page); }
  finally { await closeSession(session); }
}

async function testQuickReorderPresets() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const quick = page.locator("#quick-reorder");
    const readOrganization = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));
    const modelPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST") modelPosts.push(new URL(request.url()).pathname);
    });

    for (const id of ["E07", "E25"]) {
      await card(id).locator(".branch-toggle").click();
      await page.locator("#fit").click();
    }
    await dragCard(page, "E26", 122, 45);
    await page.locator("#pin-mode").click();
    await title("E26").click();
    await page.locator("#select-mode").click();
    await clearCardSelection(page);
    assert.equal(await quick.innerText(), "快速重排整个白板");
    const initial = (await readOrganization()).current;
    assert.ok(initial.positions.E26, "The scenario must contain a manually positioned pin");
    assert.ok(initial.collapsedBranches.includes("E05"), "The scenario must contain a folded chapter");
    const { x: pinX, y: pinY } = (await visibleCardRects(page)).E26;
    const chapters = ["E05", "E06", "E07", "E08"];
    const locations = new Map();

    for (const [mode, label] of [["compact", "紧凑树形"], ["horizontal", "横向展开"], ["balanced", "双侧展开"], ["compact", "紧凑树形"]]) {
      await quick.click();
      const stored = await readOrganization();
      assert.equal(stored.quickMode, mode, "Each click must advance to the next layout preset");
      assert.match(await page.locator("#organization-status").textContent(), new RegExp(label));
      assert.deepEqual(stored.current.items, initial.items, `${label} changed the content or parent relationships`);
      assert.deepEqual(stored.current.collapsedBranches, initial.collapsedBranches, `${label} changed folded chapters`);
      assert.deepEqual(stored.current.positions.E26, initial.positions.E26, `${label} changed the manual pin`);

      const rects = await visibleCardRects(page);
      assert.deepEqual([rects.E26.x, rects.E26.y], [pinX, pinY], `${label} moved the rendered pin`);
      const entries = Object.entries(rects);
      for (const [index, [id, rect]] of entries.entries()) {
        for (const [otherId, other] of entries.slice(index + 1)) {
          assert.ok(cardGap(rect, other) > 0, `${label} overlapped ${id} and ${otherId}`);
        }
      }
      const { E04: root } = rects;
      const left = chapters.filter((id) => rects[id].x + rects[id].width < root.x);
      const right = chapters.filter((id) => rects[id].x > root.x + root.width);
      if (mode === "compact") {
        assert.ok(chapters.every((id) => rects[id].y > root.y + root.height), "Compact layout should keep chapters below the overview");
      } else if (mode === "horizontal") {
        assert.equal(right.length, chapters.length, "Horizontal layout should place each chapter to the right of the overview");
      } else {
        assert.ok(left.length && right.length, "Balanced layout needs chapters on both sides of the overview");
      }
      if (locations.has(mode)) assert.deepEqual(rects, locations.get(mode), "The preset cycle should return to the first layout");
      else locations.set(mode, rects);
      for (const id of chapters) assert.equal(await connectionPath(page, "E04", id).count(), 1);
    }

    const compact = locations.get("compact");
    const horizontal = locations.get("horizontal");
    const balanced = locations.get("balanced");
    assert.notDeepEqual(horizontal, compact);
    assert.notDeepEqual(balanced, horizontal);
    assert.notDeepEqual(balanced, compact);
    await page.reload();
    assert.equal((await readOrganization()).quickMode, "compact");
    assert.deepEqual(await visibleCardRects(page), compact, "Reload should reproduce the chosen preset");
    await page.locator("#undo-organization").click();
    assert.equal((await readOrganization()).quickMode, "balanced");
    assert.deepEqual(await visibleCardRects(page), balanced, "One undo should restore the immediately preceding preset");
    await page.reload();
    assert.deepEqual(await visibleCardRects(page), balanced, "The restored preset must survive reload");
    assert.deepEqual(modelPosts, [], "Quick reorder must run locally");
    assertNoJsErrors(jsErrors);
    record("U33", "PASS", "Without a card selection, whole-board quick reorder cycles through three distinct layouts, preserving relationships, folds and pinned positions. Reload and one-step undo retain the preset.");
  } catch (error) { record("U33", "FAIL", safeError(error)); await screenshot("U33-failure", session.page); }
  finally { await closeSession(session); }
}

async function testSelectedBranchQuickReorder() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const quick = page.locator("#quick-reorder");
    const readOrganization = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));
    const modelPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST") modelPosts.push(new URL(request.url()).pathname);
    });
    assert.equal(await quick.innerText(), "快速重排整个白板", "An unselected canvas should advertise whole-board scope");
    for (const id of ["E07", "E21", "E25"]) {
      await card(id).locator(".branch-toggle").click();
      await page.locator("#fit").click();
    }
    await dragCard(page, "E08", 100, -70);
    await page.locator("#fit").click();
    await dragCard(page, "E26", 110, 40);
    await page.locator("#pin-mode").click();
    await title("E26").click();
    await page.locator("#select-mode").click();
    await page.locator("#fit").click();
    await title("E07").click();
    assert.equal(await quick.innerText(), "快速重排选中分支");
    const initial = await readOrganization();
    const initialRects = await visibleCardRects(page);
    const scopeFor = (...roots) => {
      const ids = new Set(roots);
      for (const parent of ids) {
        for (const item of initial.current.items) if (item.parentId === parent) ids.add(item.id);
      }
      return ids;
    };
    const scope = scopeFor("E07");
    const fixed = Object.fromEntries(Object.entries(initialRects).filter(([id]) => !scope.has(id) || ["E07", "E26"].includes(id)));
    assert.ok(initial.current.collapsedBranches.includes("E23"), "The scenario must have folded descendants");
    assert.ok(initial.current.positions.E26, "The scenario must have a pinned descendant");
    const locations = new Map();
    for (const [mode, label] of [["compact", "紧凑树形"], ["horizontal", "横向展开"], ["balanced", "双侧展开"], ["compact", "紧凑树形"]]) {
      await quick.click();
      const stored = await readOrganization();
      assert.equal(stored.branchQuickModes?.E07, mode, "The selected root should have its own layout cycle");
      assert.equal(stored.quickMode, initial.quickMode, "A branch layout should not replace the whole-board preset");
      assert.deepEqual(stored.current.items, initial.current.items, `${label} changed content or relationships`);
      assert.deepEqual(stored.current.layout, initial.current.layout, `${label} changed the whole-board layout settings`);
      assert.deepEqual(stored.current.collapsedBranches, initial.current.collapsedBranches, `${label} changed folded branches`);
      assert.equal(await card("E07").getAttribute("aria-pressed"), "true", "The root selection should remain available for the next preset");
      assert.equal(await quick.innerText(), "快速重排选中分支");
      const rects = await visibleCardRects(page);
      for (const [id, rect] of Object.entries(fixed)) {
        assert.deepEqual(rects[id], rect, `${label} moved or resized fixed card ${id}`);
      }
      const entries = Object.entries(rects);
      for (const [index, [id, rect]] of entries.entries()) {
        for (const [otherId, other] of entries.slice(index + 1)) {
          assert.ok(cardGap(rect, other) > 0, `${label} overlapped ${id} and ${otherId}`);
        }
      }
      if (locations.has(mode)) assert.deepEqual(rects, locations.get(mode), "The local preset cycle should reproduce its first arrangement");
      else locations.set(mode, rects);
      for (const child of ["E21", "E23", "E25", "E27"]) {
        assert.equal(await connectionPath(page, "E07", child).count(), 1);
      }
      assert.equal(await card("E24").isVisible(), false, "Quick reorder must not expand a folded child");
    }
    assert.notDeepEqual(locations.get("compact"), locations.get("horizontal"), "The compact and horizontal local arrangements should differ");
    assert.notDeepEqual(locations.get("horizontal"), locations.get("balanced"), "The horizontal and balanced local arrangements should differ");
    assert.notDeepEqual(locations.get("balanced"), locations.get("compact"), "The balanced and compact local arrangements should differ");
    await page.reload();
    assert.equal(await quick.innerText(), "快速重排整个白板", "Reload should show the unselected scope");
    assert.equal((await readOrganization()).branchQuickModes.E07, "compact");
    assert.deepEqual(await visibleCardRects(page), locations.get("compact"), "Reload should reproduce the scoped layout");
    await page.locator("#undo-organization").click();
    assert.equal((await readOrganization()).branchQuickModes.E07, "balanced");
    assert.deepEqual(await visibleCardRects(page), locations.get("balanced"), "Undo should restore the previous local preset exactly");
    await page.reload();
    assert.deepEqual(await visibleCardRects(page), locations.get("balanced"), "The restored local preset should survive reload");
    await page.locator("#fit").click();
    await card("E23").locator(".branch-toggle").press("Enter");
    await card("E24").waitFor({ state: "visible" });
    const opened = await visibleCardRects(page);
    for (const [id, rect] of Object.entries(fixed)) {
      assert.deepEqual(opened[id], rect, `Opening a descendant shifted fixed card ${id}`);
    }
    assert.ok(cardGap(opened.E23, opened.E24) < 240, "A folded descendant should open near its parent in the saved branch layout");
    await page.locator("#fit").click();
    await card("E21").press("Enter");
    const beforeNested = await visibleCardRects(page);
    await quick.click();
    const nested = await readOrganization();
    assert.equal(nested.branchQuickModes.E07, "balanced", "A nested branch should retain its enclosing branch preset");
    assert.equal(nested.branchQuickModes.E21, "compact", "A nested root should start its own preset cycle");
    const afterNested = await visibleCardRects(page);
    const nestedScope = scopeFor("E21");
    for (const [id, rect] of Object.entries(beforeNested).filter(([id]) => id === "E21" || !nestedScope.has(id))) {
      assert.deepEqual(afterNested[id], rect, `Reordering the nested root changed card ${id}`);
    }
    await page.locator("#fit").click();
    await card("E05").press("Enter");
    await card("E21").press("Shift+Enter");
    assert.equal(await quick.innerText(), "快速重排选中分支", "Multiple selected roots should advertise branch scope");
    const beforeMultiple = await visibleCardRects(page);
    await quick.click();
    const multiple = await readOrganization();
    assert.equal(multiple.branchQuickModes.E05, "compact", "Each selected root should keep its independent layout cycle");
    assert.equal(multiple.branchQuickModes.E21, "horizontal", "An already reordered selected root should advance one preset");
    const multipleScope = scopeFor("E05", "E21");
    const afterMultiple = await visibleCardRects(page);
    for (const [id, rect] of Object.entries(beforeMultiple).filter(([id]) => !multipleScope.has(id) || ["E05", "E21"].includes(id))) {
      assert.deepEqual(afterMultiple[id], rect, `Reordering multiple roots changed fixed card ${id}`);
    }
    await clearCardSelection(page);
    assert.equal(await quick.innerText(), "快速重排整个白板", "Clearing the selection should advertise whole-board scope");
    assert.deepEqual(modelPosts, [], "Scoped quick reorder must run locally");
    assertNoJsErrors(jsErrors);
    record("U34", "PASS", "A selected subtree cycles local layouts with a fixed root, pinned descendant and exact outside rectangles. Scope labels, folding, reload and undo remain consistent.");
  } catch (error) { record("U34", "FAIL", safeError(error)); await screenshot("U34-failure", session.page); }
  finally { await closeSession(session); }
}

async function testAnswerSectionsQuickReorder() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const answer = {
      summary: "项目白板把源代码阅读、操作回顾和回答整理在同一个空间。".repeat(6),
      sections: ["界面交互", "内容对话", "项目组织", "模型接入", "执行边界", "工程维护"].map((title, index) => ({
        title,
        text: "保留原始上下文和卡片之间的父子关系，便于在阅读代码时就地核对操作结果。".repeat(3 + index % 2),
      })),
    };
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      let event;
      if (request.scope === "explain") {
        event = { type: "explanation", explanation: answer };
      } else {
        const items = request.board.nodes.map((node) => ({
          id: node.id,
          parentId: node.layoutParentId ?? node.parentIds[0] ?? null,
          category: node.category || "reference",
          title: node.title,
          summary: node.id === "A01" ? answer.summary : node.summary || node.text,
          ...(node.id !== "A01" && node.id.startsWith("A") ? { nativeFace: true } : {}),
        }));
        const bridgeIndex = items.findIndex(({ id }) => id === "A01");
        const [bridge] = items.splice(bridgeIndex, 1);
        items.splice(items.findIndex(({ id }) => id === "E07"), 0, bridge);
        event = { type: "map", map: {
          title: "包含拆分回答的手册", layout: { flow: "vertical", density: "normal" }, items,
        } };
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [event, { type: "done" }].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      });
    });

    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    await card("E04").press("Enter");
    await page.locator("#split-module").click();
    await card("A01").locator(".thread-answer").filter({ hasText: answer.summary }).waitFor();
    await clearCardSelection(page);
    await submitOrganization(page);
    await card("A01").locator(".organized-title").waitFor();
    const children = (await readManualNotes(page)).filter(({ sectionOf }) => sectionOf === "A01").map(({ id }) => id);
    assert.equal(children.length, 6);
    const quick = page.locator("#quick-reorder");
    const readOrganization = () => page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));
    const outside = (rects) => Object.fromEntries(Object.entries(rects).filter(([id]) => !children.includes(id)));
    const checkDirectional = async (mode) => {
      const rects = await visibleCardRects(page);
      const parent = rects.A01;
      const details = children.map((id) => rects[id]);
      assert.ok(details.every(Boolean), "The organized answer should retain all six visible sections");
      assert.ok(details.every((rect) => rect.x >= parent.x + parent.width ||
        (mode === "balanced" && rect.x + rect.width <= parent.x)),
      `${mode} should lay out answer details beside their parent instead of underneath a neighboring chapter`);
      const columns = new Map();
      for (const rect of details) {
        const facingEdge = rect.x < parent.x ? rect.x + rect.width : rect.x;
        const column = Math.round(facingEdge);
        columns.set(column, (columns.get(column) || 0) + 1);
      }
      assert.deepEqual([...columns.values()].sort(), [3, 3], `${mode} should use two columns of three explanation cards`);
      const height = Math.max(...details.map(({ y, height }) => y + height)) - Math.min(...details.map(({ y }) => y));
      const singleColumnHeight = details.reduce((total, rect) => total + rect.height, 0);
      assert.ok(height < singleColumnHeight * 0.75, `${mode} should substantially shorten the answer's vertical span`);
      assert.ok(Math.min(...details.map((rect) => cardGap(parent, rect))) <= 120,
        `${mode} pushed the entire explanation branch away from its parent`);
      for (const [index, rect] of details.entries()) {
        const id = children[index];
        for (const [other, position] of Object.entries(rects)) {
          if (other !== id) assert.ok(cardGap(rect, position) > 0, `${mode} overlaps ${id} and ${other}`);
        }
        const crossed = await connectionPath(page, "A01", id).evaluate((path, cards) => {
          const length = path.getTotalLength();
          for (let offset = 3; offset < length; offset += 4) {
            const point = path.getPointAtLength(offset);
            for (const [id, { x, y, width, height }] of Object.entries(cards)) {
              if (point.x > x + 2 && point.x < x + width - 2 &&
                  point.y > y + 2 && point.y < y + height - 2) return id;
            }
          }
          return null;
        }, Object.fromEntries(Object.entries(rects).filter(([other]) => other !== "A01" && other !== id)));
        assert.equal(crossed, null, `${mode} routes A01 → ${id} through ${crossed}`);
      }
      return rects;
    };

    await quick.click();
    let balanced;
    for (const mode of ["horizontal", "balanced"]) {
      await quick.click();
      assert.equal((await readOrganization()).quickMode, mode);
      const rects = await checkDirectional(mode);
      if (mode === "balanced") balanced = rects;
    }
    await page.reload();
    assert.deepEqual(await checkDirectional("balanced"), balanced, "Reload should restore the whole-board explanation columns");
    await page.locator("#fit").click();
    const shot = await screenshot("U35-answer-reflow", page);
    await card("A01").press("Enter");
    assert.equal(await quick.innerText(), "快速重排选中分支");
    await quick.click();
    assert.equal((await readOrganization()).branchQuickModes.A01, "horizontal", "The first scoped reflow should show the explanation columns");
    const scopedHorizontal = await checkDirectional("horizontal");
    assert.deepEqual(outside(scopedHorizontal), outside(balanced),
      "Scoped reflow should keep the answer overview and all unrelated cards in place");
    await page.reload();
    assert.equal((await readOrganization()).branchQuickModes.A01, "horizontal");
    assert.deepEqual(await checkDirectional("horizontal"), scopedHorizontal, "Reload should restore the scoped explanation columns");
    await page.locator("#undo-organization").click();
    assert.equal((await readOrganization()).branchQuickModes?.A01, undefined);
    assert.deepEqual(await visibleCardRects(page), balanced, "Undo should restore the layout before scoped reflow exactly");
    await card("A01").press("Enter");
    await quick.click();
    await quick.click();
    assert.equal((await readOrganization()).branchQuickModes.A01, "balanced");
    assert.deepEqual(outside(await checkDirectional("balanced")), outside(balanced), "Scoped balanced reflow moved the overview or an unrelated card");
    assertNoJsErrors(jsErrors);
    record("U35", "PASS", "Six answer sections reflow into two compact columns with unobstructed relationships. Scoped reflow keeps the overview and unrelated cards fixed across reload and undo.", { screenshot: shot });
  } catch (error) { record("U35", "FAIL", safeError(error)); await screenshot("U35-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRepoManualDetailsMigration() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const keys = ["whiteboard.codex.repo-manual.organization.v1", "whiteboard.codex.repo-manual.v1"];
    const before = await page.evaluate(([organizationKey, memoryKey]) => {
      const { details } = JSON.parse(document.querySelector("#repo-manual-data").textContent);
      const detailIds = new Set(details.map(({ id }) => id));
      const { current } = JSON.parse(localStorage.getItem(organizationKey));
      current.items = current.items.filter(({ id }) => !detailIds.has(id));
      current.title = "My saved handbook";
      current.items.find(({ id }) => id === "E05").title = "My chapter title";
      current.items.find(({ id }) => id === "E17").summary = "My own layout notes";
      current.items.push({ id: "E36", parentId: "E05", title: "My existing E36", summary: "Keep this card", category: "reference" });
      current.positions.E36 = { x: 776, y: 392, width: 250 };
      current.collapsedBranches = ["E05", "E06", "E07", "E08"];
      const memory = JSON.parse(localStorage.getItem(memoryKey));
      const box = { x: 90, y: 300, width: 220, height: 120 };
      memory.project.goal = "My project goal";
      memory.project.decisions.push({ text: "My saved decision", sourceIds: ["E36"] });
      memory.notes.push({ id: "A01", kind: "note", rect: box, answer: "My saved answer", sourceCardIds: ["E36"], anchors: [box],
        payload: { boardId: "repo-manual", question: "My question", anchor: { elementIds: ["E04"], box, quote: "" } } });
      const memoryText = JSON.stringify(memory);
      localStorage.setItem(memoryKey, memoryText);
      localStorage.setItem(organizationKey, JSON.stringify({ current, appliedGuideId: "repo-manual-v1", undoAvailable: false }));
      return { current, details, memoryText };
    }, keys);
    const read = () => page.evaluate(([organizationKey, memoryKey]) => ({
      organization: JSON.parse(localStorage.getItem(organizationKey)),
      memoryText: localStorage.getItem(memoryKey),
    }), keys);
    await page.reload({ waitUntil: "networkidle" });
    const migrated = await read();
    assert.equal(migrated.organization.appliedGuideId, "repo-manual-v2");
    assert.equal(migrated.memoryText, before.memoryText);
    const { items, collapsedBranches, ...rest } = migrated.organization.current;
    const oldCount = before.current.items.length;
    assert.deepEqual({ ...rest, items: items.slice(0, oldCount), collapsedBranches: before.current.collapsedBranches }, before.current);
    assert.ok(before.current.collapsedBranches.every((id) => collapsedBranches.includes(id)));
    const additions = items.slice(oldCount);
    assert.equal(additions.length, before.details.length);
    const remapped = new Map(before.details.map(({ id }, index) => [id, additions[index].id]));
    assert.notEqual(remapped.get("E36"), "E36");
    assert.deepEqual(additions, before.details.map((item) => ({
      ...item, id: remapped.get(item.id), parentId: remapped.get(item.parentId) || item.parentId,
    })));
    await page.locator('[data-element-id="A01"]').getByText("My saved answer").waitFor();
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await read(), migrated);
    await page.locator("#undo-organization").click();
    const undone = await read();
    assert.deepEqual(undone.organization.current, before.current);
    assert.equal(undone.memoryText, before.memoryText);
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await read(), undone);
    assertNoJsErrors(jsErrors);
    record("U36", "PASS", "The v1 handbook gains remapped detail cards while retaining user content, geometry, and notes. Reload and undo preserve the intended version.");
  } catch (error) { record("U36", "FAIL", safeError(error)); await screenshot("U36-failure", session.page); }
  finally { await closeSession(session); }
}

async function testMoveSelectedCards() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const key = "whiteboard.codex.repo-manual.organization.v1";
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const selected = () => page.locator('#board [aria-pressed="true"][data-element-id]').evaluateAll((cards) =>
      cards.map((card) => card.dataset.elementId).sort());
    const plan = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).current, key);
    const readCamera = () => page.locator("#board").evaluate((board) => board.style.transform);
    const initial = await visibleCardRects(page);
    await page.evaluate(({ key, initial }) => {
      const state = JSON.parse(localStorage.getItem(key));
      state.current.positions.E05 = { x: initial.E05.x + 0.25, y: initial.E05.y + 0.75, width: 220 };
      state.current.positions.E06 = { x: initial.E06.x + 0.75, y: initial.E06.y + 0.25, width: 260 };
      localStorage.setItem(key, JSON.stringify(state));
    }, { key, initial });
    await page.reload({ waitUntil: "networkidle" });
    const before = await visibleCardRects(page);
    const beforePlan = await plan();
    assert.notEqual(before.E05.width, before.E06.width);

    await page.locator("#pan-mode").click();
    await title("E05").click();
    await title("E06").click({ modifiers: ["Shift"] });
    await title("E07").click({ modifiers: ["Shift"] });
    assert.deepEqual(await selected(), ["E05", "E06", "E07"]);
    await title("E07").click({ modifiers: ["Shift"] });
    assert.deepEqual(await selected(), ["E05", "E06"]);
    await title("E05").click();
    assert.deepEqual(await selected(), ["E05", "E06"], "Clicking a selected card should keep the group");

    const beginDrag = async (id, dx, dy) => {
      const box = await title(id).boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
    };
    await beginDrag("E06", 42, 90);
    await page.mouse.up();
    const after = await visibleCardRects(page);
    const afterPlan = await plan();
    const delta = { x: after.E05.x - before.E05.x, y: after.E05.y - before.E05.y };
    assert.ok(delta.x > 15 && delta.y > 30, "Dragging one selected card should move the other selected card");
    assert.deepEqual({ x: after.E06.x - before.E06.x, y: after.E06.y - before.E06.y }, delta,
      "Every selected card should move by the same scene-coordinate delta");
    for (const id of ["E05", "E06"]) {
      assert.deepEqual({ ...after[id], x: before[id].x, y: before[id].y }, before[id], `Dragging should preserve ${id}'s dimensions`);
      assert.deepEqual(afterPlan.positions[id], { x: after[id].x, y: after[id].y, width: before[id].width });
    }
    assert.deepEqual(after.E07, before.E07, "An unselected card should stay in place");
    assert.deepEqual(afterPlan.items, beforePlan.items, "Moving cards should preserve their parent relationships");
    assert.deepEqual(await selected(), ["E05", "E06"], "A completed drag should keep the group selected");

    const viewport = page.locator("#viewport");
    await viewport.evaluate((element) => element.addEventListener("pointerdown", (event) => {
      element.dataset.acceptancePointer = String(event.pointerId);
    }, { once: true }));
    await beginDrag("E05", -25, 35);
    await page.waitForFunction((x) => Number.parseFloat(document.querySelector('[data-element-id="E05"]').style.left) < x, after.E05.x);
    await viewport.evaluate((element) => element.dispatchEvent(new PointerEvent("pointercancel", {
      pointerId: Number(element.dataset.acceptancePointer), pointerType: "mouse",
    })));
    await page.mouse.up();
    assert.deepEqual(await visibleCardRects(page), after, "Cancelling the drag should restore all card positions");
    assert.deepEqual(await plan(), afterPlan, "Cancelling the drag should leave saved positions intact");

    const blank = await viewport.evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (let y = box.top + 12; y < box.bottom - 90; y += 24) {
        for (let x = box.left + 12; x < box.right - 90; x += 24) {
          const target = document.elementFromPoint(x, y);
          if (element.contains(target) && !target.closest("[data-element-id], #ask-popover, button, summary")) return { x, y };
        }
      }
      return null;
    });
    assert.ok(blank, "The pan test needs an empty point on the canvas");
    const camera = await readCamera();
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.down();
    await page.mouse.move(blank.x + 55, blank.y + 65, { steps: 8 });
    await page.mouse.up();
    assert.notEqual(await readCamera(), camera, "Dragging empty space in Move mode should still pan the view");
    assert.deepEqual(await visibleCardRects(page), after, "Panning should leave card coordinates intact");
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await visibleCardRects(page), after, "Reload should restore the moved group exactly");
    assertNoJsErrors(jsErrors);
    record("U37", "PASS", "Shift-click selects and deselects cards in Move mode. Dragging the group preserves relative positions, selection and relationships across save and reload. Cancellation and empty-space panning preserve card positions.");
  } catch (error) { record("U37", "FAIL", safeError(error)); await screenshot("U37-failure", session.page); }
  finally { await closeSession(session); }
}

async function testLassoSelectionMove() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = card("E05").locator(".organized-title");
    const handle = page.locator("#move-selection");
    const selectMode = page.locator("#select-mode");
    const panMode = page.locator("#pan-mode");
    const selectedIds = () => page.locator('#board [data-element-id][aria-pressed="true"]').evaluateAll((cards) =>
      cards.map((element) => element.dataset.elementId).sort());
    const plan = () => page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current);
    const before = await visibleCardRects(page);
    const beforePlan = await plan();
    const requestsBefore = telemetry.requests.length;
    const startDrag = async (target, dx, dy) => {
      const box = await target.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
    };
    const circleCards = async () => {
      const [first, second, partial] = await Promise.all(["E05", "E06", "E07"].map((id) => card(id).boundingBox()));
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      // Include part of the third card's title without enclosing that card.
      await page.keyboard.down("Shift");
      try {
        await lassoBox(page, { x, y, width: partial.x + partial.width / 3 - x,
          height: Math.max(first.y + first.height, second.y + second.height) - y }, 5);
      } finally {
        await page.keyboard.up("Shift");
      }
      assert.deepEqual(await selectedIds(), ["E05", "E06"]);
      assert.equal(await page.locator("#selection-highlights rect").count(), 0);
      await handle.waitFor();
      const actions = await page.locator("#ask-popover").boundingBox();
      assert.ok([first, second].every((box) => actions.x + actions.width <= box.x || box.x + box.width <= actions.x ||
        actions.y + actions.height <= box.y || box.y + box.height <= actions.y),
        "The toolbar should stay outside the selected cards when the viewport has room");
    };

    await lassoBox(page, await title.boundingBox());
    assert.deepEqual(await selectedIds(), ["E05"]);
    assert.ok(await page.locator("#selection-highlights rect").count());
    assert.equal(await handle.isVisible(), false, "A fragment lasso should keep the text question without offering card movement");
    const fragment = JSON.parse(await page.locator("#payload").textContent());
    assert.equal(fragment.anchor.quote, await title.innerText());
    assert.equal(await page.locator("#ask-open").isVisible(), true);

    await circleCards();
    assert.deepEqual(await visibleCardRects(page), before, "Completing a card lasso should leave every card in place");
    await startDrag(title, 65, 38);
    await page.mouse.up();
    assert.deepEqual(await visibleCardRects(page), before, "A card-surface drag in lasso mode should leave positions intact");
    assert.deepEqual(await plan(), beforePlan);

    await circleCards();
    await handle.click();
    assert.equal(await panMode.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await selectedIds(), ["E05", "E06"]);
    assert.deepEqual(await visibleCardRects(page), before, "Activating Move mode should preserve card coordinates");
    await selectMode.click();
    await handle.press("Enter");
    assert.equal(await panMode.getAttribute("aria-pressed"), "true", "The handle should offer keyboard access to Move mode");
    assert.deepEqual(await selectedIds(), ["E05", "E06"]);
    await selectMode.click();

    await startDrag(handle, 48, 80);
    await page.mouse.up();
    const after = await visibleCardRects(page);
    const afterPlan = await plan();
    const delta = { x: after.E05.x - before.E05.x, y: after.E05.y - before.E05.y };
    assert.ok(delta.x > 15 && delta.y > 30, "Dragging the handle should move the selected cards");
    for (const id of ["E05", "E06"]) {
      assert.deepEqual(after[id], { ...before[id], x: before[id].x + delta.x, y: before[id].y + delta.y });
      assert.deepEqual(afterPlan.positions[id], { x: after[id].x, y: after[id].y, width: before[id].width });
    }
    for (const [id, rect] of Object.entries(before)) {
      if (id !== "E05" && id !== "E06") assert.deepEqual(after[id], rect, `Unselected ${id} should stay in place`);
    }
    assert.deepEqual(afterPlan.items, beforePlan.items, "Moving a lasso group should preserve parent relationships");
    assert.equal(await selectMode.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await selectedIds(), ["E05", "E06"]);

    await startDrag(handle, -24, 25);
    await page.waitForFunction((x) => Number.parseFloat(document.querySelector('[data-element-id="E05"]').style.left) < x, after.E05.x);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual(await visibleCardRects(page), after, "Escape should restore the group to its pre-drag coordinates");
    assert.deepEqual(await plan(), afterPlan);
    assert.deepEqual(await selectedIds(), ["E05", "E06"]);
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(await visibleCardRects(page), after, "Reload should restore the saved positions");
    assert.equal(telemetry.requests.length, requestsBefore, "Lasso movement should not submit a model request");
    assertNoJsErrors(jsErrors);
    record("U53", "PASS", "A title lasso keeps its text quote. A card lasso offers intentional group drag, accessible Move mode, cancellation, and persisted positions without affecting other cards.");
  } catch (error) { record("U53", "FAIL", safeError(error)); await screenshot("U53-failure", session.page); }
  finally { await closeSession(session); }
}

async function writeReports() {
  const counts = Object.fromEntries(["PASS", "FAIL", "BLOCKED"].map((outcome) => [outcome, results.filter((result) => result.outcome === outcome).length]));
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), startedAt, command,
    scope: "Isolated browser acceptance with a temporary loopback fake adapter only; no real API, Codex, ZCode, user board, user storage, or port 8791.",
    browser: { channel: "msedge executablePath", executable: EDGE, version: browser?.version?.() || "closed" },
    safety: { randomLoopbackPort: port, port8791Touched: false, realProviderCalls: false, realCliProcesses: false, externalNetwork: false, serviceWorkersBlocked: true, cleanup },
    fakeAdapter: { backends: FIXTURE.backends.map(({ id }) => id), telemetry }, counts, results,
    realBackends: { api: "NOT_RUN", codex: "NOT_RUN", zcode: "NOT_RUN", reason: "All backend claims above are fake-adapter UI branches only." }
  };
  const json = redact(JSON.stringify(report, null, 2)) + "\n";
  await writeFile(join(HERE, "browser-report.json"), json, "utf8");
  const screenshotNotes = results.filter((result) => result.screenshot).map((result) => `${result.id}: \`${result.screenshot}\``).join("；");
  const lines = ["# 隔离浏览器验收报告", "", `开始：${startedAt}`, `命令：\`${command}\``, `Edge：${report.browser.version}（已安装 msedge channel）`, `临时回环端口：127.0.0.1:${port}`, "", `结果：PASS ${counts.PASS}；FAIL ${counts.FAIL}；BLOCKED ${counts.BLOCKED}。`, "", "| 用例 | 结果 | 摘要 |", "| --- | --- | --- |", ...results.map((result) => `| ${result.id} | ${result.outcome} | ${result.detail.replaceAll("|", "\\|")} |`), "", "模拟声明：服务只在随机回环端口提供静态资源和假适配器；未调用真实 API/Codex/ZCode，也不能据此宣称任何真实后端可用。", "清理：浏览器、contexts 和临时服务已关闭；未扫描或终止任何用户进程。", `截图：${screenshotNotes || "无"}。`, ""];
  await writeFile(join(HERE, "browser-report.md"), redact(lines.join("\n")), "utf8");
  return counts;
}

async function testRegenerateSelectedBranch() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const regenerate = page.locator("#regenerate-branch");
    const opinion = "旧回答把选区坐标和屏幕坐标混用了，请逐张核对后重写。";
    const correctedTitle = (id) => `核对后的 ${id} 标题`;
    const correctedSummary = (id) => `核对后的 ${id} 正文，已区分屏幕坐标和画布坐标。`;
    const repairStatus = "ZCode 正在自动修正输出格式（1 次）…";
    const invalidBranch = "重新生成结果中 E90 的父卡与原来不同。";
    const invalidPlan = "模型没有返回有效的操作类型。";
    const responsePreview = "这里是返回片段 <literal-preview>";
    const read = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));
    const requests = [];
    let responseKind = "";
    let modelRequests = 0;
    await page.route("**/api/codex", async (route) => {
      modelRequests += 1;
      const request = route.request().postDataJSON();
      const events = [];
      if (request.scope === "explain") {
        events.push({ type: "explanation", explanation: explanationFixture }, { type: "done" });
      } else if (request.scope === "plan") {
        if (responseKind === "invalid-plan") {
          events.push({ type: "status", phase: "repair", text: repairStatus },
            { type: "error", text: invalidPlan, responsePreview });
        } else {
          events.push({ type: "answer", text: '{"action":"regenerate"}' }, { type: "done" });
        }
      } else {
        requests.push(request);
        const items = request.board.nodes.map((node) => ({
          id: node.id, parentId: responseKind === "wrong-parent" && node.id === "E90" ? "A01" : node.layoutParentId,
          title: correctedTitle(node.id), summary: correctedSummary(node.id),
        }));
        if (responseKind === "invalid-structure") {
          events.push({ type: "status", phase: "repair", text: repairStatus },
            { type: "error", text: invalidBranch, responsePreview });
        } else {
          events.push({ type: "branch", branch: { items } });
          if (responseKind === "complete") {
            events.push({ type: "error", requestId: "previous-request", text: "迟到的错误", responsePreview },
              { type: "done", baseRevision: request.baseRevision });
          } else if (responseKind !== "incomplete") {
            events.push({ type: "done", baseRevision: responseKind === "wrong-revision" ? "stale" : request.baseRevision });
          }
        }
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });
    assert.equal(await regenerate.isEnabled(), false, "Regeneration requires one selected module");
    await card("E04").press("Enter");
    await page.locator("#split-module").click();
    await card("A01").locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    await page.locator("#stop-ai").waitFor({ state: "hidden" });

    // Attach a generated card under an existing native answer section. The regenerated branch then
    // includes both note-backed content and generated modules, including the folded grandchild.
    await page.evaluate(() => {
      const key = "whiteboard.codex.repo-manual.organization.v1";
      const stored = JSON.parse(localStorage.getItem(key));
      stored.current.items.push(
        { id: "A01", parentId: "E04", title: "选区说明", summary: "原回答总览", category: "reference", nativeFace: true },
        { id: "A02", parentId: "A01", title: "锚点", summary: "原说明", category: "reference", nativeFace: true },
        { id: "E90", parentId: "A02", title: "坐标推导", summary: "待校正的推导", category: "reference",
          sources: ["app.js"], folded: false },
      );
      stored.current.positions.E90 = { x: 1280, y: 530, width: 250 };
      stored.current.collapsedBranches.push("A02");
      localStorage.setItem(key, JSON.stringify(stored));
    });
    await page.reload();
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    await card("E90").waitFor({ state: "hidden" });
    const beforeNotes = await readManualNotes(page);
    await card("A01").press("Enter");
    const before = await read();
    const beforeRects = await visibleCardRects(page);
    const scope = new Set(["A01", "A02", "A03", "A04", "E90"]);
    const send = async (kind, fromMenu = false) => {
      responseKind = kind;
      const response = page.waitForResponse((candidate) =>
        new URL(candidate.url()).pathname === "/api/codex" && candidate.request().method() === "POST");
      const beforeOpen = modelRequests;
      if (fromMenu) {
        await page.locator("#fit").click();
        await card("E04").press("Enter");
        await card("A01").locator(".thread-answer").click({ button: "right" });
        assert.equal(await page.locator("#canvas-menu-organize-branch").isVisible(), true);
        await page.locator("#canvas-menu-regenerate-branch").click();
        assert.equal(await card("A01").getAttribute("aria-pressed"), "true");
      } else {
        await regenerate.click();
      }
      await page.locator("#regenerate-branch-dialog[open]").waitFor();
      assert.match(await page.locator("#regenerate-branch-scope").innerText(), /A01.*4 张下级/);
      assert.equal(modelRequests, beforeOpen, "Opening the regeneration dialog must not send a request");
      await page.locator("#regenerate-branch-opinion").fill(opinion);
      await page.locator("#confirm-regenerate-branch").click();
      await response;
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
    };

    const checkFailure = async (message) => {
      await page.locator("#execution-trace-error").filter({ hasText: message }).waitFor();
      assert.match(await page.locator("#execution-trace-repair").innerText(), /修正输出格式/);
      const preview = page.locator("#execution-trace-preview");
      await preview.click();
      await page.locator("#response-preview-dialog").waitFor();
      assert.equal(await page.locator("#response-preview-reason").textContent(), message);
      assert.equal(await page.locator("#response-preview-text").textContent(), responsePreview);
      assert.equal(await page.locator("#response-preview-text literal-preview").count(), 0);
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    };
    for (const rejected of ["incomplete", "wrong-parent", "wrong-revision", "invalid-structure"]) {
      await send(rejected);
      assert.deepEqual(await read(), before, `${rejected} must leave the previous branch and undo untouched`);
      assert.deepEqual(await readManualNotes(page), beforeNotes, `${rejected} must leave native source notes untouched`);
    }
    await checkFailure(invalidBranch);
    await send("complete", true);
    await card("A01").locator(".thread-answer").filter({ hasText: correctedSummary("A01") }).waitFor();
    assert.equal(await page.locator("#execution-trace-preview").isVisible(), false);
    for (const request of requests) {
      assert.equal(request.scope, "organizeBranch");
      assert.equal(request.branchIntent, "regenerate");
      assert.equal(request.mode, "ask");
      assert.equal(request.branchRootId, "A01");
      assert.ok(request.question.includes(opinion), "The correction should be sent with the branch");
      assert.deepEqual(request.board.nodes.map(({ id }) => id).sort(), [...scope].sort());
      assert.equal(request.board.nodes.find(({ id }) => id === "A01").layoutParentId, null);
      assert.equal(request.board.nodes.find(({ id }) => id === "E90").layoutParentId, "A02");
    }
    const after = await read();
    const find = (plan, id) => plan.current.items.find((item) => item.id === id);
    const outside = ({ id }) => !scope.has(id);
    assert.deepEqual(after.current.items.filter(outside), before.current.items.filter(outside));
    assert.deepEqual(after.current.layout, before.current.layout);
    assert.deepEqual(after.current.collapsedBranches, before.current.collapsedBranches);
    assert.equal(find(after, "A01").parentId, "E04", "The regenerated root retains its parent outside the branch");
    for (const id of scope) {
      assert.equal(find(after, id).title, correctedTitle(id));
      assert.equal(find(after, id).summary, correctedSummary(id));
    }
    assert.equal(find(after, "A02").parentId, "A01");
    assert.equal(find(after, "E90").parentId, "A02");
    assert.deepEqual(find(after, "E90").sources, ["app.js"]);
    assert.deepEqual(after.current.positions.E90, before.current.positions.E90);
    const position = ({ x, y, width }) => ({ x, y, width });
    const afterRects = await visibleCardRects(page);
    for (const [id, rect] of Object.entries(beforeRects)) {
      if (scope.has(id) && id !== "A01") continue;
      assert.deepEqual(position(afterRects[id]), position(rect), `Regeneration moved ${id}`);
    }
    assert.equal(await card("E90").isVisible(), false, "Regeneration must not open a folded branch");
    assert.deepEqual(await readManualNotes(page), beforeNotes);
    await page.reload();
    assert.deepEqual(await read(), after);
    await card("A01").locator(".thread-answer").filter({ hasText: correctedSummary("A01") }).waitFor();
    assert.equal(await card("A01").locator(".thread-question").textContent(), correctedTitle("A01"));
    responseKind = "invalid-plan";
    const requestCount = requests.length;
    await askFromCard(page, "A01", "本轮操作判断失败");
    await checkFailure(invalidPlan);
    assert.equal(requests.length, requestCount, "Failed action planning must not start branch regeneration");
    const typed = "请再重新生成整个模块和下级，引用能够核对的源码。";
    responseKind = "incomplete";
    const typedResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/codex" &&
      candidate.request().method() === "POST" && candidate.request().postDataJSON()?.scope === "organizeBranch");
    await askFromCard(page, "A01", typed);
    await typedResponse;
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    const typedRequest = requests.at(-1);
    assert.ok(typedRequest.question.includes(typed), "The general question entry point should regenerate the selected branch");
    assert.deepEqual(typedRequest.anchor.elementIds, ["A01"]);
    assert.equal(typedRequest.board.nodes.find(({ id }) => id === "A01").summary, correctedSummary("A01"));
    assert.deepEqual(await read(), after, "A failed typed regeneration should preserve the previous rewrite and undo");
    await card("A02").locator(".branch-toggle").press("Enter");
    await card("E90").locator(".organized-summary").filter({ hasText: correctedSummary("E90") }).waitFor();
    await page.locator("#undo-organization").click();
    assert.deepEqual((await read()).current, before.current);
    await card("A01").locator(".thread-answer").filter({ hasText: explanationFixture.summary }).waitFor();
    await page.reload();
    assert.deepEqual((await read()).current, before.current);
    assert.deepEqual(await readManualNotes(page), beforeNotes);
    assertNoJsErrors(jsErrors);
    record("U38", "PASS", "Button and typed regeneration cover the selected answer and its folded descendants. Wrong parents, missing completion, and stale revisions leave the branch untouched. Updated context, original notes, geometry, reload and undo are verified.");
  } catch (error) { record("U38", "FAIL", safeError(error)); await screenshot("U38-failure", session.page); }
  finally { await closeSession(session); }
}

async function testProjectWorkbench() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const switcher = page.locator("#board-switcher");
    const manualGoal = "旧白板保留这个项目目标";
    const manualOpinion = "旧白板保留这条整理意见";
    const readManual = () => page.evaluate(() => [
      localStorage.getItem("whiteboard.codex.repo-manual.v1"),
      localStorage.getItem("whiteboard.codex.repo-manual.organization.v1"),
    ]);
    const readWorkbench = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.project-workbench.organization.v1")));

    await openDetails(page, "sidebar-tools", "project-memory");
    await page.locator("#project-goal").fill(manualGoal);
    await openDetails(page, "organization-options");
    await page.locator("#organization-opinion").fill(manualOpinion);
    const manual = await readManual();
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("board") === "project-workbench"),
      switcher.selectOption("project-workbench"),
    ]);
    assert.equal(await switcher.inputValue(), "project-workbench");
    const seeded = await readWorkbench();
    const items = seeded.current.items;
    const roots = items.filter(({ parentId }) => parentId === null);
    assert.equal(roots.length, 1);
    const chapters = items.filter(({ parentId }) => parentId === roots[0].id);
    assert.equal(chapters.length, 5);
    await card(roots[0].id).waitFor();
    for (const { id } of chapters) await card(id).waitFor();
    assert.deepEqual(await readManual(), manual, "Opening the workbench must not overwrite the manual");

    const byId = new Map(items.map((item) => [item.id, item]));
    const lineage = (item) => {
      const path = [];
      for (let node = item; node; node = byId.get(node.parentId)) path.unshift(node);
      return path;
    };
    const requirementOf = (item) => lineage(item).findLast(({ spec }) => spec?.kind === "requirement");
    const allCases = items.filter(({ spec }) => spec?.kind === "case");
    const selectedCase = allCases.find(({ spec }) => spec.id === "TC-REGEN-01");
    assert.ok(selectedCase, "The sample must contain test cases under more than one requirement");
    const requirement = requirementOf(selectedCase);
    assert.ok(allCases.some((other) => requirementOf(other)?.id !== requirement.id));
    const path = lineage(selectedCase);
    assert.equal(path[0].id, roots[0].id);
    const expand = async (ancestors) => {
      for (const { id } of ancestors) {
        const toggle = card(id).locator('.branch-toggle[aria-expanded="false"]');
        if (await toggle.count()) await toggle.click();
      }
    };
    assert.equal(await page.locator("#quick-reorder").textContent(), "快速重排整个白板");
    await page.locator("#quick-reorder").click();
    assert.equal((await readWorkbench()).quickMode, "compact");
    const chapterColumns = async () => {
      const rectangles = await visibleCardRects(page);
      return chapters.map(({ id }) => ({ id, x: rectangles[id].x, width: rectangles[id].width }));
    };
    const columnsBefore = await chapterColumns();
    await expand(path.slice(0, -1));
    const otherRequirements = items.filter(({ spec }) => spec?.kind === "requirement" &&
      ["REQ-ASK-01", "REQ-TREE-01"].includes(spec.id));
    assert.equal(otherRequirements.length, 2);
    for (const other of otherRequirements) await expand(lineage(other));
    assert.deepEqual(await chapterColumns(), columnsBefore,
      "Opening several chapters and a deeper branch must not move or resize the chapter columns");
    const rectangles = Object.entries(await visibleCardRects(page));
    for (const [index, [id, rect]] of rectangles.entries()) {
      for (const [otherId, other] of rectangles.slice(index + 1)) {
        const overlapX = Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x);
        const overlapY = Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y);
        assert.ok(overlapX <= 0.5 || overlapY <= 0.5, `${id} overlaps ${otherId}`);
      }
    }
    await card(selectedCase.id).waitFor();

    const requests = [];
    let plannedAction = "ask";
    const draftCase = {
      title: "停止后收到迟到分支的验证草稿",
      task: "给定待提交的分支候选，点击停止后再送达终态。",
      dependencies: [],
      acceptance: ["组织快照和撤销记录与停止前完全相同"],
    };
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const result = request.scope === "decompose" ? { type: "children", children: [draftCase] }
        : { type: "answer", text: request.scope === "plan" ? JSON.stringify({ action: plannedAction })
          : `工作台测试回复 ${requests.length}` };
      await route.fulfill({ contentType: "application/x-ndjson", body:
        [JSON.stringify(result), JSON.stringify({ type: "done" }), ""].join("\n") });
    });
    const cardContext = ({ id, title, summary, spec }) => ({ id, title, summary, ...(spec ? { spec } : {}) });
    const askAndCheck = async (question, expected) => {
      const start = requests.length;
      await askFromCard(page, expected.id, question);
      await page.getByText(`工作台测试回复 ${start + 2}`, { exact: true }).waitFor();
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
      const [plan, execution] = requests.slice(start);
      assert.equal(requests.length, start + 2);
      assert.equal(plan.scope, "plan");
      assert.equal(execution.mode, "ask");
      assert.equal(execution.question, question);
      const current = (await readWorkbench()).current.items;
      const chosenCases = current.filter((item) => item.spec?.kind === "case" && requirementOf(item)?.id === requirement.id);
      for (const request of [plan, execution]) {
        assert.equal(request.boardId, "project-workbench");
        const focus = request.project?.focus;
        assert.ok(focus, "Both turns must include the selected requirement and its test cases");
        assert.deepEqual(focus.path.map(({ id }) => id), path.map(({ id }) => id));
        for (const entry of focus.path) {
          const original = current.find(({ id }) => id === entry.id);
          const chars = Array.from(original.summary);
          assert.equal(entry.title, original.title);
          assert.equal(entry.summary, chars.length <= 120 ? original.summary
            : `${chars.slice(0, 89).join("")}…${chars.slice(-30).join("")}`);
        }
        assert.deepEqual(focus.requirement, cardContext(current.find(({ id }) => id === requirement.id)));
        assert.deepEqual(focus.selected, cardContext(expected));
        assert.deepEqual(focus.cases.map(({ id }) => id).sort(), chosenCases.map(({ id }) => id).sort());
        for (const item of chosenCases) {
          assert.deepEqual(focus.cases.find(({ id }) => id === item.id), cardContext(item));
        }
      }
    };
    await askAndCheck("按这个测试案例解释验证步骤。", selectedCase);

    await card(selectedCase.id).press("Enter");
    await page.locator("#edit-workbench-card").click();
    const title = page.locator("#workbench-card-title");
    const body = page.locator("#workbench-card-body");
    const editedTitle = "已编辑的用例标题";
    const editedBody = "在子卡收起时提交纠错，验证保存后原父节点仍然存在。";
    assert.equal(await title.inputValue(), selectedCase.title);
    assert.equal(await body.inputValue(), selectedCase.summary);
    await title.fill(editedTitle);
    await body.fill(editedBody);
    assert.deepEqual((await readWorkbench()).current.items.find(({ id }) => id === selectedCase.id), selectedCase,
      "Editing an unsaved draft must not write to the board");
    await page.locator("#cancel-workbench-card").click();
    await page.locator("#workbench-card-form").waitFor({ state: "hidden" });
    await page.locator("#edit-workbench-card").click();
    assert.equal(await title.inputValue(), selectedCase.title);
    assert.equal(await body.inputValue(), selectedCase.summary);
    await title.fill(editedTitle);
    await body.fill(editedBody);
    await page.locator("#save-workbench-card").click();
    await card(selectedCase.id).getByText(editedTitle, { exact: true }).waitFor();
    const edited = (await readWorkbench()).current.items.find(({ id }) => id === selectedCase.id);
    assert.equal(edited.title, editedTitle);
    assert.equal(edited.summary, editedBody);
    assert.equal(edited.parentId, selectedCase.parentId);
    assert.equal(edited.spec.kind, "case");
    assert.equal(selectedCase.spec.status, "mock-pass");
    assert.equal(edited.spec.status, "pending", "Changing the case invalidates evidence for its prior assertion");
    await page.reload();
    await card(selectedCase.id).getByText(editedTitle, { exact: true }).waitFor();
    assert.deepEqual((await readWorkbench()).current.items.find(({ id }) => id === selectedCase.id), edited);
    await askAndCheck("按我编辑后的用例说明验收规则。", edited);

    plannedAction = "decompose";
    const draftQuestion = "给本需求拆出一个新的测试用例草稿，写明前置、触发和验收。";
    const beforeDraft = requests.length;
    await askFromCard(page, requirement.id, draftQuestion);
    await page.getByText(draftCase.title, { exact: true }).waitFor();
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    const [draftPlan, draftExecution] = requests.slice(beforeDraft);
    assert.equal(requests.length, beforeDraft + 2);
    assert.equal(draftPlan.scope, "plan");
    assert.equal(draftExecution.scope, "decompose");
    assert.equal(draftExecution.decomposition.targetId, requirement.id);
    assert.ok(draftExecution.question.includes(draftQuestion));
    for (const request of [draftPlan, draftExecution]) {
      const focus = request.project.focus;
      assert.equal(focus.selected.id, requirement.id);
      assert.deepEqual(focus.requirement, cardContext(requirement));
      assert.deepEqual(focus.cases.find(({ id }) => id === edited.id), cardContext(edited));
    }
    const draftItem = (await readWorkbench()).current.items.find(({ title }) => title === draftCase.title);
    assert.equal(draftItem.parentId, requirement.id);
    assert.equal(draftItem.spec, undefined, "Generated drafts should not assume a test result");
    assert.deepEqual(draftItem.taskDetails, {
      task: draftCase.task, dependencies: draftCase.dependencies, acceptance: draftCase.acceptance,
    });
    await card(draftItem.id).press("Enter");
    await page.locator("#edit-workbench-card").click();
    await page.locator("#workbench-card-kind").selectOption("case");
    await page.locator("#save-workbench-card").click();
    const acceptedDraft = (await readWorkbench()).current.items.find(({ id }) => id === draftItem.id);
    assert.equal(acceptedDraft.parentId, requirement.id);
    assert.equal(acceptedDraft.spec.kind, "case");
    assert.equal(acceptedDraft.spec.status, "pending");

    assert.deepEqual(await readManual(), manual, "Workbench edits and questions must not write to the manual");
    assertNoJsErrors(jsErrors);
    record("U39", "PASS", "Five compact chapter columns stay fixed and non-overlapping when expanded. Scoped planning and execution read persisted case edits, and an AI draft is generated and accepted as a pending test under the selected requirement. The prior board is untouched.");
  } catch (error) { record("U39", "FAIL", safeError(error)); await screenshot("U39-failure", session.page); }
  finally { await closeSession(session); }
}

async function testQuickReorderParentPaths() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const key = "whiteboard.codex.repo-manual.organization.v1";
    const expanded = ["E05", "E06", "E07", "E08", "E10", "E12", "E16", "E18", "E21", "E23", "E25", "E27", "E30"];
    await page.evaluate(({ key, expanded }) => {
      const state = JSON.parse(localStorage.getItem(key));
      state.current.collapsedBranches = state.current.collapsedBranches.filter((id) => !expanded.includes(id));
      localStorage.setItem(key, JSON.stringify(state));
    }, { key, expanded });
    await page.reload();
    const readPlan = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
    const initial = (await readPlan()).current;
    const quick = page.locator("#quick-reorder");
    const assertPaths = async (mode, root) => {
      const state = await readPlan();
      const label = root ? `${root} scoped ${mode}` : `whole-board ${mode}`;
      assert.equal(root ? state.branchQuickModes?.[root] : state.quickMode, mode);
      assert.deepEqual(state.current.items, initial.items, `${label} changed saved cards or their parents`);
      assert.deepEqual(state.current.collapsedBranches, initial.collapsedBranches, `${label} changed folding`);
      const cards = await visibleCardRects(page);
      const expected = initial.items.filter(({ id, parentId }) => cards[id] && cards[parentId])
        .map(({ id, parentId }) => `${parentId}>${id}`).sort();
      const rendered = await page.locator("#connections > path[data-parent-id][data-child-id]").evaluateAll((paths, cards) =>
        paths.map((path) => {
          const { parentId, childId } = path.dataset;
          const obstacles = Object.entries(cards).filter(([id]) => id !== parentId && id !== childId);
          const length = path.getTotalLength();
          let crossed = null;
          for (let distance = 2; distance < length && !crossed; distance += 2) {
            const { x, y } = path.getPointAtLength(distance);
            crossed = obstacles.find(([, rect]) => x > rect.x + 2 && x < rect.x + rect.width - 2 &&
              y > rect.y + 2 && y < rect.y + rect.height - 2)?.[0] || null;
          }
          const point = (distance) => {
            const { x, y } = path.getPointAtLength(distance);
            return { x, y };
          };
          return { parentId, childId, start: point(0), end: point(length), crossed };
        }), cards);
      assert.deepEqual(rendered.map(({ parentId, childId }) => `${parentId}>${childId}`).sort(), expected,
        `${label} should draw exactly the visible stored parent-child edges`);
      for (const { parentId, childId, start, end, crossed } of rendered) {
        const edge = `${label} ${parentId} → ${childId}`;
        assertCardOnEdge(start, cards[parentId], `${edge} must start on the parent`);
        assertCardOnEdge(end, cards[childId], `${edge} must end on the child`);
        assert.equal(crossed, null, `${edge} crosses unrelated card ${crossed}`);
      }
    };
    const modes = ["compact", "horizontal", "balanced"];
    for (const mode of modes) {
      await quick.click();
      await assertPaths(mode);
    }
    for (const root of ["E05", "E06", "E07", "E08", "E25"]) {
      await page.locator(`#board [data-element-id="${root}"]`).press("Enter");
      for (const mode of modes) {
        await quick.click();
        await assertPaths(mode, root);
      }
    }
    await page.reload();
    await assertPaths("balanced", "E25");
    assertNoJsErrors(jsErrors);
    record("U40", "PASS", "Whole-board and scoped quick reorder keep each visible manual edge attached to its saved parent and child and clear of unrelated cards, including after reload.");
  } catch (error) { record("U40", "FAIL", safeError(error)); await screenshot("U40-failure", session.page); }
  finally { await closeSession(session); }
}

async function testQuickReorderUnevenBranches() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const key = "whiteboard.codex.repo-manual.organization.v1";
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const quick = page.locator("#quick-reorder");
    await page.evaluate((key) => {
      const state = JSON.parse(localStorage.getItem(key));
      const replaced = new Set(["E07"]);
      for (const parent of replaced) {
        for (const item of state.current.items) {
          if (item.parentId === parent) replaced.add(item.id);
        }
      }
      const details = (id, parentId, title) => ({
        id, parentId, title, category: "reference", folded: true, summary: "测试分支正文。",
      });
      state.current.items = [
        ...state.current.items.filter(({ id }) => id === "E07" || !replaced.has(id)),
        details("E60", "E07", "收起的接入说明"),
        details("E61", "E07", "已展开的模型调用与校验"),
        details("E62", "E07", "收起的运维说明"),
        ...["E63", "E64", "E65", "E66"].map((id, index) => details(id, "E61", `执行步骤 ${index + 1}`)),
        ...Array.from({ length: 8 }, (_, index) => details(`E${80 + index}`, "E63", `边界检查 ${index + 1}`)),
        details("E88", "E60", "折叠状态下隐藏的接入细节"),
        details("E89", "E62", "折叠状态下隐藏的运维细节"),
      ];
      state.current.collapsedBranches = [
        ...state.current.collapsedBranches.filter((id) => !replaced.has(id)), "E60", "E62",
      ];
      localStorage.setItem(key, JSON.stringify(state));
    }, key);
    await page.reload();
    const readPlan = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
    const initial = (await readPlan()).current;
    const siblings = ["E60", "E61", "E62"];
    const siblingGaps = {};
    const assertLayout = async (mode, { scoped = false, deepFolded = false } = {}) => {
      const state = await readPlan();
      const label = scoped ? `scoped ${mode}` : `whole-board ${mode}`;
      assert.equal(scoped ? state.branchQuickModes?.E07 : state.quickMode, mode);
      assert.deepEqual(state.current.items, initial.items, `${label} changed card content or parent relationships`);
      const folded = deepFolded ? [...initial.collapsedBranches, "E61"] : initial.collapsedBranches;
      assert.deepEqual([...state.current.collapsedBranches].sort(), [...folded].sort(), `${label} changed folding`);
      const rects = await visibleCardRects(page);
      assert.ok(rects.E60 && rects.E61 && rects.E62, `${label} must show all three sibling cards`);
      assert.ok(!rects.E88 && !rects.E89, `${label} rendered hidden descendants of collapsed siblings`);
      assert.equal(Boolean(rects.E87), !deepFolded, `${label} did not respect the deepest branch's visibility`);
      const entries = Object.entries(rects);
      for (const [index, [id, rect]] of entries.entries()) {
        for (const [otherId, other] of entries.slice(index + 1)) {
          assert.ok(cardGap(rect, other) > 0, `${label} overlapped ${id} and ${otherId}`);
        }
      }
      const sides = new Map();
      for (const id of siblings) {
        assert.equal(await connectionPath(page, "E07", id).count(), 1, `${label} lost the E07 → ${id} edge`);
        const side = rects[id].x < rects.E07.x ? "left" : "right";
        if (!sides.has(side)) sides.set(side, []);
        sides.get(side).push(rects[id]);
      }
      if (!scoped || mode === "horizontal") {
        assert.equal(sides.size, 1, `${label} must keep these siblings in one column`);
      }
      const gaps = [];
      for (const column of sides.values()) {
        column.sort((a, b) => a.y - b.y);
        for (let index = 1; index < column.length; index++) {
          const previous = column[index - 1];
          const gap = column[index].y - previous.y - previous.height;
          gaps.push(gap);
          assert.ok(gap > 0 && gap <= 80, `${label} left a ${gap}px gap between adjacent sibling cards`);
        }
      }
      siblingGaps[`${label}${deepFolded ? " (folded)" : ""}`] = gaps;
      return rects;
    };

    await quick.click();
    await quick.click();
    await assertLayout("horizontal");
    await quick.click();
    const balanced = await assertLayout("balanced");
    await page.reload();
    assert.deepEqual(await assertLayout("balanced"), balanced, "Reload changed the whole-board arrangement");
    await card("E61").locator(".branch-toggle").press("Enter");
    await assertLayout("balanced", { deepFolded: true });
    await card("E61").locator(".branch-toggle").press("Enter");
    assert.deepEqual(await assertLayout("balanced"), balanced, "Reopening the branch should restore its previous arrangement");

    await card("E07").press("Enter");
    await quick.click();
    const scope = new Set(["E07"]);
    for (const parent of scope) {
      for (const { id, parentId } of initial.items) {
        if (parentId === parent) scope.add(id);
      }
    }
    const fixed = Object.fromEntries(Object.entries(balanced).filter(([id]) => id === "E07" || !scope.has(id)));
    let scoped;
    for (const mode of ["horizontal", "balanced"]) {
      await quick.click();
      scoped = await assertLayout(mode, { scoped: true });
      for (const [id, rect] of Object.entries(fixed)) {
        assert.deepEqual(scoped[id], rect, `scoped ${mode} moved fixed card ${id}`);
      }
    }
    await page.reload();
    assert.deepEqual(await assertLayout("balanced", { scoped: true }), scoped, "Reload changed the scoped arrangement");
    assertNoJsErrors(jsErrors);
    record("U41", "PASS", "Directional quick reorder keeps siblings compact beside deep descendants, without overlap or changes to relationships, folding, fixed cards, or the restored layout.", { siblingGaps });
  } catch (error) { record("U41", "FAIL", safeError(error)); await screenshot("U41-failure", session.page); }
  finally { await closeSession(session); }
}

async function testExpandMovedBranch() {
  for (const mode of ["guide", "obstructed", "horizontal", "legacy"]) {
    const session = await openPage("normal", "repo-manual");
    try {
      const { page, jsErrors } = session;
      const key = "whiteboard.codex.repo-manual.organization.v1";
      const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
      const toggle = (id) => card(id).locator(".branch-toggle");
      const plan = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
      const parent = "E07";
      const child = "E21";
      const grandchild = "E22";

      if (mode === "horizontal") {
        await card(parent).press("Enter");
        await page.locator("#quick-reorder").click();
        await page.locator("#quick-reorder").click();
        assert.equal((await plan()).branchQuickModes[parent], "horizontal");
      }
      await toggle(parent).press("Enter");
      const original = await visibleCardRects(page);
      const originalChild = original[child];
      assert.ok(originalChild, `${mode} needs an original visible child position`);
      await toggle(child).press("Enter");
      const originalGrandchild = (await visibleCardRects(page))[grandchild];
      assert.ok(originalGrandchild, `${mode} needs an original visible grandchild position`);
      await toggle(child).press("Enter");
      await toggle(parent).press("Enter");
      await card(child).waitFor({ state: "hidden" });
      await page.locator("#fit").click();
      const beforeDrag = await visibleCardRects(page);
      const items = (await plan()).current.items;
      await dragCard(page, parent, ...(mode === "obstructed" ? [170, -305] : [-470, 250]));
      const moved = await visibleCardRects(page);
      assert.ok(cardGap(moved[parent], originalChild) > 220,
        `${mode} drag left the parent ${cardGap(moved[parent], originalChild).toFixed(1)}px from the original child position`);
      if (mode === "legacy") {
        await page.evaluate(({ key, child, original }) => {
          const state = JSON.parse(localStorage.getItem(key));
          for (const id of [child, "E23"]) {
            const { x, y, width } = original[id];
            state.current.positions[id] = { x, y, width };
          }
          localStorage.setItem(key, JSON.stringify(state));
          const memoryKey = "whiteboard.codex.repo-manual.v1";
          const saved = JSON.parse(localStorage.getItem(memoryKey));
          saved.pinnedIds.push("E23");
          localStorage.setItem(memoryKey, JSON.stringify(saved));
        }, { key, child, original });
        await page.reload();
      }
      const unrelated = Object.fromEntries(Object.entries(beforeDrag).filter(([id]) => id !== parent));
      const assertAttached = async () => {
        const rects = await visibleCardRects(page);
        assert.deepEqual(rects[parent], moved[parent], `${mode} moved the parent while opening its descendants`);
        assert.ok(rects[child] && cardGap(rects[parent], rects[child]) < 180,
          `${mode} expanded the child ${rects[child] ? cardGap(rects[parent], rects[child]).toFixed(1) : "an unknown number of"}px away from its dragged parent`);
        assert.ok(cardGap(rects[child], originalChild) > 150, `${mode} reopened the child at the original branch position`);
        if (mode === "legacy") assert.deepEqual(rects.E23, original.E23, "Opening a moved branch should preserve a pinned child");
        for (const [id, rect] of Object.entries(unrelated)) {
          assert.deepEqual(rects[id], rect, `${mode} moved unrelated card ${id}`);
        }
        assert.deepEqual((await plan()).current.items, items, `${mode} changed the saved hierarchy`);
        return rects;
      };

      await toggle(parent).press("Enter");
      await assertAttached();
      await toggle(child).press("Enter");
      const expanded = await assertAttached();
      assert.ok(expanded[grandchild] && cardGap(expanded[child], expanded[grandchild]) < 400,
        `${mode} opened the grandchild ${expanded[grandchild] ? cardGap(expanded[child], expanded[grandchild]).toFixed(1) : "an unknown number of"}px away from the moved branch`);
      assert.ok(cardGap(expanded[grandchild], originalGrandchild) > 150, `${mode} reopened the grandchild at its original position`);
      await toggle(parent).press("Enter");
      await card(grandchild).waitFor({ state: "hidden" });
      await page.reload();
      assert.deepEqual((await visibleCardRects(page))[parent], moved[parent]);
      await card(child).waitFor({ state: "hidden" });
      await toggle(parent).press("Enter");
      const reopened = await assertAttached();
      assert.deepEqual(reopened[child], expanded[child]);
      assert.deepEqual(reopened[grandchild], expanded[grandchild]);
      assertNoJsErrors(jsErrors);
    } catch (error) {
      record("U42", "FAIL", safeError(error));
      await screenshot(`U42-${mode}-failure`, session.page);
      return;
    } finally {
      await closeSession(session);
    }
  }
  record("U42", "PASS", "Folded guide and horizontally arranged branches open beside their dragged parent, keep nested details aligned across reload, and preserve other cards and relationships.");
}

async function testCreateManualCard() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const create = page.locator("#new-card");
    assert.equal(await create.count(), 1, "The board needs a new-card control");
    const form = page.locator("#workbench-card-form");
    const title = page.locator("#workbench-card-title");
    const summary = page.locator("#workbench-card-body");
    const kind = page.locator("#workbench-card-kind");
    const save = page.locator("#save-workbench-card");
    const readPlan = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));
    const initial = await readPlan();
    const initialRects = await visibleCardRects(page);
    const originalTitle = "接口兼容约束";
    const originalSummary = "保留旧接口的字段命名。";
    const editedTitle = "接口兼容与迁移约束";
    const editedSummary = "保留旧接口的字段命名，新增字段允许缺省。";
    const answer = "先确认缺省字段的读取行为，再增加新旧接口并行验收。";
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text: request.scope === "plan" ? '{"action":"ask"}' : `${answer}${requests.length}` },
          { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    await create.click();
    await form.waitFor();
    await title.fill("取消的草稿");
    await summary.fill("这段正文还没有保存。");
    assert.deepEqual(await readPlan(), initial, "Opening and typing a new card must leave the board unchanged");
    await page.locator("#cancel-workbench-card").click();
    await form.waitFor({ state: "hidden" });
    assert.deepEqual(await readPlan(), initial, "Cancelling a draft must not create a card");

    await create.click();
    await form.waitFor();
    assert.equal(await title.inputValue(), "");
    assert.equal(await summary.inputValue(), "");
    await title.fill(originalTitle);
    await summary.fill(originalSummary);
    await kind.selectOption("constraint");
    await save.click();
    await form.waitFor({ state: "hidden" });
    const afterCreate = (await readPlan()).current.items;
    const created = afterCreate.find((item) => item.title === originalTitle);
    assert.ok(created, "Saving must create an item in the active board");
    assert.equal(created.parentId, null);
    assert.equal(created.summary, originalSummary);
    assert.equal(created.spec.kind, "constraint");
    assert.deepEqual(afterCreate.filter(({ id }) => id !== created.id), initial.current.items);
    const card = page.locator(`#board [data-element-id="${created.id}"]`);
    await card.getByText(originalTitle, { exact: true }).waitFor();
    const cardSummary = card.locator(".organized-summary");
    assert.equal(await cardSummary.textContent(), originalSummary);
    const cardBounds = await card.boundingBox();
    const viewport = await page.locator("#viewport").boundingBox();
    assert.ok(cardGap(cardBounds, viewport) === 0, "A new card must appear in the visible canvas");
    const afterCreateRects = await visibleCardRects(page);
    for (const [id, rect] of Object.entries(initialRects)) {
      assert.deepEqual(afterCreateRects[id], rect, `Creating a card moved existing card ${id}`);
      assert.ok(cardGap(afterCreateRects[created.id], rect) > 0, `A new card overlaps existing card ${id}`);
    }

    await card.press("Enter");
    await page.locator("#edit-workbench-card").click();
    assert.equal(await title.inputValue(), originalTitle);
    assert.equal(await summary.inputValue(), originalSummary);
    assert.equal(await kind.inputValue(), "constraint");
    await title.fill(editedTitle);
    await summary.fill(editedSummary);
    await save.click();
    await form.waitFor({ state: "hidden" });
    await card.getByText(editedTitle, { exact: true }).waitFor();
    assert.equal(await cardSummary.textContent(), editedSummary);

    await page.locator("#pin-mode").click();
    await card.press("Enter");
    assert.ok(await card.evaluate((element) => element.classList.contains("board-pinned")));
    const parent = "E06";
    await page.locator("#connect-mode").click();
    const parentCard = page.locator(`#board [data-element-id="${parent}"]`);
    await parentCard.press("Enter");
    await card.press("Enter");
    await parentCard.locator(".branch-toggle").press("Enter");
    await connectionPath(page, parent, created.id).waitFor({ state: "attached" });
    assert.deepEqual(requests, [], "Creating, editing, pinning and connecting a card must stay local");
    await page.reload();
    await card.getByText(editedTitle, { exact: true }).waitFor();
    assert.equal(await cardSummary.textContent(), editedSummary);
    await connectionPath(page, parent, created.id).waitFor({ state: "attached" });
    const restored = (await readPlan()).current.items.find(({ id }) => id === created.id);
    assert.equal(restored.parentId, parent);
    assert.equal(restored.title, editedTitle);
    assert.equal(restored.summary, editedSummary);
    assert.deepEqual(restored.spec, created.spec);
    assert.ok(await card.evaluate((element) => element.classList.contains("board-pinned")));

    const askAndRead = async (id, question) => {
      const start = requests.length;
      await askFromCard(page, id, question);
      await page.getByText(`${answer}${start + 2}`, { exact: true }).waitFor();
      await page.locator("#stop-ai").waitFor({ state: "hidden" });
      const [planning, execution] = requests.slice(start);
      assert.equal(requests.length, start + 2);
      assert.equal(planning.scope, "plan");
      assert.equal(execution.mode, "ask");
      assert.equal(execution.question, question);
      assert.deepEqual(planning.anchor.elementIds, [id]);
      assert.deepEqual(execution.anchor.elementIds, [id]);
      return [planning, execution];
    };
    const expectedConstraint = { id: created.id, title: editedTitle, summary: editedSummary };
    for (const request of await askAndRead(created.id, "请细化这条约束，并建议验收方法。")) {
      assert.ok(request.anchor.quote.includes(editedTitle));
      assert.ok(request.anchor.quote.includes(editedSummary));
      assert.deepEqual(request.project.constraintCards, [expectedConstraint]);
    }
    for (const request of await askAndRead(parent, "请按本模块约束写实现步骤。")) {
      assert.deepEqual(request.project.constraintCards, [expectedConstraint]);
    }
    for (const request of await askAndRead("E07", "请说明这个模块负责什么。")) {
      assert.deepEqual(request.project.constraintCards || [], [], "An unrelated module must not inherit the linked constraint");
    }
    assertNoJsErrors(jsErrors);
    record("U43", "PASS", "A manual constraint card can be drafted, saved, edited, pinned, linked, restored after reload, and included in AI context only where relevant.");
  } catch (error) { record("U43", "FAIL", safeError(error)); await screenshot("U43-failure", session.page); }
  finally { await closeSession(session); }
}

async function testCanvasNavigation() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const viewport = page.locator("#viewport");
    const title = page.locator('#board [data-element-id="E05"] .organized-title');
    const camera = () => page.locator("#board").evaluate((board) => {
      const { e: x, f: y, a: scale } = new DOMMatrixReadOnly(getComputedStyle(board).transform);
      return { x, y, scale };
    });
    const blank = async () => {
      const point = await viewport.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        for (let y = Math.ceil(bounds.top) + 20; y < bounds.bottom - 100; y += 24) {
          for (let x = Math.ceil(bounds.left) + 20; x < bounds.right - 100; x += 24) {
            const hit = document.elementFromPoint(x, y);
            if (hit && element.contains(hit) && !hit.closest("[data-element-id], #ask-popover, button, summary, .connection-hit")) return { x, y };
          }
        }
        return null;
      });
      assert.ok(point, "Navigation needs an empty canvas point");
      return point;
    };
    const drag = async ({ x, y }, dx, dy, button = "left") => {
      await page.mouse.move(x, y);
      await page.mouse.down({ button });
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up({ button });
    };
    const dragFromCard = async (button) => {
      const box = await title.boundingBox();
      await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, 42, 36, button);
    };
    const assertTranslation = async (before, dx, dy) => {
      const after = await camera();
      assert.equal(after.scale, before.scale);
      assert.ok(Math.abs(after.x - before.x - dx) < 0.1 && Math.abs(after.y - before.y - dy) < 0.1,
        `Expected canvas translation (${dx}, ${dy}), got (${after.x - before.x}, ${after.y - before.y})`);
    };
    const activeElementId = () => page.evaluate(() => document.activeElement.id);
    const initialRects = await visibleCardRects(page);
    const initialPositions = await page.evaluate(() => localStorage.getItem("whiteboard.codex.repo-manual.organization.v1"));
    const requestCount = telemetry.requests.length;

    let point = await blank();
    await page.mouse.click(point.x, point.y);
    assert.equal(await activeElementId(), "viewport");
    const initial = await camera();
    await page.keyboard.press("ArrowRight");
    const right = await camera();
    assert.ok(right.x < initial.x && right.y === initial.y && right.scale === initial.scale);
    await page.keyboard.press("ArrowDown");
    const down = await camera();
    assert.ok(down.y < right.y && down.x === right.x && down.scale === right.scale);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await assertTranslation(initial, 0, 0);

    const card = page.locator('#board [data-element-id="E05"]');
    await card.press("Space");
    assert.equal(await card.getAttribute("aria-pressed"), "true", "Tapping Space should still activate the focused card");
    await assertTranslation(initial, 0, 0);
    await title.click();
    await page.keyboard.press("ArrowRight");
    assert.equal((await camera()).x, right.x, "Arrow navigation should still work after a card is selected");
    await page.keyboard.press("ArrowLeft");
    await page.locator("#ask-open").click();
    const question = page.locator("#question");
    await question.fill("abcd");
    const editing = await camera();
    await question.press("Home");
    await question.press("ArrowRight");
    assert.equal(await question.evaluate((element) => element.selectionStart), 1);
    assert.deepEqual(await camera(), editing, "Moving the text caret should leave the canvas still");
    await question.press("Escape");

    point = await blank();
    await page.mouse.click(point.x, point.y, { button: "right" });
    const menu = page.locator("#canvas-menu");
    await menu.waitFor();
    const previousItem = await activeElementId();
    const context = await camera();
    await page.keyboard.press("ArrowDown");
    assert.notEqual(await activeElementId(), previousItem);
    assert.deepEqual(await camera(), context, "Arrow navigation inside the context menu should stay there");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });

    for (const mode of ["select", "pan", "pin", "connect"]) {
      await page.locator("#fit").click();
      const button = page.locator(`#${mode}-mode`);
      await button.click();
      const before = await camera();
      await drag(await blank(), 42, 36);
      await assertTranslation(before, 42, 36);
      assert.equal(await button.getAttribute("aria-pressed"), "true");
    }

    await page.locator("#fit").click();
    await page.locator("#pan-mode").click();
    await title.click();
    const beforeSpace = await camera();
    await page.keyboard.down("Space");
    try {
      await dragFromCard();
    } finally {
      await page.keyboard.up("Space");
    }
    await assertTranslation(beforeSpace, 42, 36);
    const beforeMiddle = await camera();
    await dragFromCard("middle");
    await assertTranslation(beforeMiddle, 42, 36);
    assert.equal(await page.locator("#pan-mode").getAttribute("aria-pressed"), "true");

    point = await blank();
    await page.mouse.move(point.x, point.y);
    const beforeWheel = await camera();
    await page.mouse.wheel(30, 48);
    await page.waitForFunction(({ x, y }) => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(document.querySelector("#board")).transform);
      return transform.e !== x || transform.f !== y;
    }, beforeWheel);
    await assertTranslation(beforeWheel, -30, -48);
    const beforeZoom = await camera();
    await page.keyboard.down("Control");
    try {
      await page.mouse.wheel(0, -120);
      await page.waitForFunction((scale) => new DOMMatrixReadOnly(
        getComputedStyle(document.querySelector("#board")).transform).a > scale, beforeZoom.scale);
    } finally {
      await page.keyboard.up("Control");
    }
    assert.ok((await camera()).scale > beforeZoom.scale, "Ctrl+wheel should zoom the canvas");
    assert.deepEqual(await visibleCardRects(page), initialRects);
    assert.equal(await page.evaluate(() => localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")), initialPositions);
    assert.equal(telemetry.requests.length, requestCount);
    assertNoJsErrors(jsErrors);
    record("U61", "PASS", "The keyboard, blank-space drag in each mode, Space or middle-button drag from a card, and wheel operate the camera while preserving card positions, text and context-menu navigation, and local-only behavior.");
  } catch (error) { record("U61", "FAIL", safeError(error)); await screenshot("U61-failure", session.page); }
  finally { await closeSession(session); }
}

async function testCanvasContextMenu() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const viewport = page.locator("#viewport");
    const board = page.locator("#board");
    const menu = page.locator("#canvas-menu");
    const create = page.locator("#canvas-menu-new");
    const edit = page.locator("#canvas-menu-edit");
    const pin = page.locator("#canvas-menu-pin");
    const form = page.locator("#workbench-card-form");
    const title = page.locator("#workbench-card-title");
    const summary = page.locator("#workbench-card-body");
    const cancel = page.locator("#cancel-workbench-card");
    const readPlan = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")));

    const initial = await readPlan();
    const initialRects = await visibleCardRects(page);
    await page.locator("#zoom-in").click();
    await page.locator("#pan-mode").click();
    const panning = await viewport.evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (let y = Math.ceil(box.top) + 16; y < box.bottom - 40; y += 22) {
        for (let x = Math.ceil(box.left) + 16; x < box.left + box.width / 3; x += 22) {
          const target = document.elementFromPoint(x, y);
          if (target && element.contains(target) && !target.closest("[data-element-id], #ask-popover, button, summary")) {
            return { x, y, destination: Math.floor(box.right) - 30 };
          }
        }
      }
      return null;
    });
    assert.ok(panning, "The camera test needs an empty starting point");
    const camera = await board.evaluate((element) => getComputedStyle(element).transform);
    await page.mouse.move(panning.x, panning.y);
    await page.mouse.down();
    await page.mouse.move(panning.destination, panning.y, { steps: 8 });
    await page.mouse.up();
    assert.notEqual(await board.evaluate((element) => getComputedStyle(element).transform), camera);
    assert.deepEqual(await visibleCardRects(page), initialRects, "Panning and zooming must leave scene rectangles intact");

    const location = await viewport.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const board = element.querySelector("#board");
      const boardBounds = board.getBoundingClientRect();
      const scale = new DOMMatrixReadOnly(getComputedStyle(board).transform).a;
      const width = 360 * scale;
      const height = 180 * scale;
      const cards = [...board.querySelectorAll("[data-element-id]:not([hidden])")]
        .map((card) => card.getBoundingClientRect());
      for (let y = Math.ceil(bounds.top) + 44; y + height < bounds.bottom - 20; y += 26) {
        for (let x = Math.ceil(bounds.left) + 44; x + width < bounds.right - 20; x += 26) {
          const target = document.elementFromPoint(x, y);
          if (!target || !element.contains(target) || target.closest("[data-element-id], #ask-popover, button, summary")) continue;
          if (cards.some((card) => x < card.right + 12 && x + width > card.left - 12 &&
            y < card.bottom + 12 && y + height > card.top - 12)) continue;
          return { x, y, sceneX: (x - boardBounds.left) / scale, sceneY: (y - boardBounds.top) / scale };
        }
      }
      return null;
    });
    assert.ok(location, "The placement test needs an unobstructed card-sized canvas area");
    const rightClickBlank = () => page.mouse.click(location.x, location.y, { button: "right" });
    await rightClickBlank();
    assert.equal(await menu.isVisible(), true, "Right-clicking blank canvas must open its action menu");
    assert.equal(await create.isVisible(), true);
    assert.equal(await edit.isVisible(), false);
    assert.equal(await pin.isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false, "Escape should close the canvas menu");
    assert.deepEqual(await readPlan(), initial);

    await rightClickBlank();
    await create.click();
    await form.waitFor();
    await title.fill("取消的右键草稿");
    await cancel.click();
    await form.waitFor({ state: "hidden" });
    assert.deepEqual(await readPlan(), initial, "Cancelling contextual creation must not add a card");

    await rightClickBlank();
    await create.click();
    await form.waitFor();
    const cardTitle = "画布右键定位";
    await title.fill(cardTitle);
    await summary.fill("这张卡在鼠标指定的位置保存。");
    await page.locator("#save-workbench-card").click();
    await form.waitFor({ state: "hidden" });
    const saved = await readPlan();
    const created = saved.current.items.find((item) => item.title === cardTitle);
    assert.ok(created, "Saving the contextual editor must create a card");
    assert.equal(created.parentId, null);
    const { x, y } = saved.current.positions[created.id];
    assert.ok(Math.abs(x - location.sceneX) <= 1 && Math.abs(y - location.sceneY) <= 1,
      `The card should start at the clicked scene point (${location.sceneX}, ${location.sceneY}), got (${x}, ${y})`);
    const afterCreate = await visibleCardRects(page);
    assert.ok(Math.abs(afterCreate[created.id].x - x) <= 0.1 && Math.abs(afterCreate[created.id].y - y) <= 0.1);
    assert.deepEqual(Object.fromEntries(Object.entries(afterCreate).filter(([id]) => id !== created.id)), initialRects,
      "Creating at a chosen point must preserve existing scene rectangles");

    const card = page.locator(`#board [data-element-id="${created.id}"]`);
    const rightClickCard = () => card.locator(".organized-title").click({ button: "right" });
    await rightClickCard();
    await menu.waitFor();
    assert.equal(await edit.isVisible(), true);
    assert.equal(await pin.isVisible(), true);
    await edit.click();
    await form.waitFor();
    assert.equal(await title.inputValue(), cardTitle, "The menu must edit the right-clicked card");
    await cancel.click();
    await rightClickCard();
    await pin.click();
    assert.equal(await card.evaluate((element) => element.classList.contains("board-pinned")), true);
    await page.reload();
    await card.getByText(cardTitle, { exact: true }).waitFor();
    assert.equal(await card.evaluate((element) => element.classList.contains("board-pinned")), true);
    assert.deepEqual(await visibleCardRects(page), afterCreate, "Reload must restore the chosen position");
    await card.press("Shift+F10");
    await menu.waitFor();
    assert.equal(await pin.textContent(), "取消固定");
    await pin.click();
    assert.equal(await card.evaluate((element) => element.classList.contains("board-pinned")), false);
    assertNoJsErrors(jsErrors);
    record("U44", "PASS", "On a zoomed and panned canvas, the blank-area context menu creates a card at the clicked scene point and preserves other cards. Escape, draft cancellation, card edit and pin actions, and reload also work.");
  } catch (error) { record("U44", "FAIL", safeError(error)); await screenshot("U44-failure", session.page); }
  finally { await closeSession(session); }
}

async function testCanvasContextModesAndDeletion() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const viewport = page.locator("#viewport");
    const menu = page.locator("#canvas-menu");
    const deleteCards = page.locator("#canvas-menu-delete");
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const title = (id) => card(id).locator(".organized-title");
    const rightClickCard = (id) => title(id).click({ button: "right" });
    const readBoard = () => page.evaluate(() => ({
      plan: JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")),
      notes: JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.v1")),
    }));
    const selectedCards = () => page.locator('#board [data-element-id][aria-pressed="true"]')
      .evaluateAll((elements) => elements.map((element) => element.dataset.elementId).sort());
    const modelPosts = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/codex") modelPosts.push(path);
    });

    // Independent cards let the test exercise both deletion scopes without a relationship repair.
    await page.evaluate(() => {
      const key = "whiteboard.codex.repo-manual.organization.v1";
      const plan = JSON.parse(localStorage.getItem(key));
      for (const [index, id] of ["E90", "E91", "E92"].entries()) {
        plan.current.items.push({ id, title: `右键测试 ${id}`, summary: "", parentId: null, category: "reference" });
        plan.current.positions[id] = { x: 65 + 315 * index, y: 555, width: 250 };
      }
      localStorage.setItem(key, JSON.stringify(plan));
    });
    await page.reload();
    await page.locator("#fit").click();
    const initial = await readBoard();
    const blank = await viewport.evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (let y = box.top + 28; y < box.bottom - 28; y += 28) {
        for (let x = box.left + 28; x < box.right - 28; x += 28) {
          const hit = document.elementFromPoint(x, y);
          if (element.contains(hit) && !hit.closest("[data-element-id], #ask-popover, button, summary, .connection-hit")) return { x, y };
        }
      }
      return null;
    });
    assert.ok(blank, "The mode menu needs an empty canvas point");
    const rightClickBlank = () => page.mouse.click(blank.x, blank.y, { button: "right" });
    const switchMode = async (mode, open, toolbarMode = mode) => {
      await open();
      await menu.waitFor();
      await page.locator(`#canvas-menu-${mode}`).click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await viewport.getAttribute("data-mode"), toolbarMode);
      assert.equal(await page.locator(`#${toolbarMode}-mode`).getAttribute("aria-pressed"), "true");
    };
    await switchMode("pan", rightClickBlank);
    await switchMode("pin-mode", () => rightClickCard("E90"), "pin");
    await switchMode("connect", rightClickBlank);
    assert.deepEqual(await readBoard(), initial, "Switching tools must leave the stored board intact");

    await selectConnection(page, "E04", "E07", "right");
    await menu.waitFor();
    await page.locator("#canvas-menu-delete-edge").click();
    assert.equal((await readBoard()).plan.current.items.find(({ id }) => id === "E07").parentId, null);
    assert.equal(await connectionPath(page, "E04", "E07").count(), 0);
    assert.equal(await card("E07").isVisible(), true, "Deleting an edge must keep its target card");
    await page.locator("#undo-organization").click();
    await connectionPath(page, "E04", "E07").waitFor();

    await switchMode("select", () => rightClickCard("E90"));
    const selectGroup = async () => {
      await title("E90").click();
      await title("E91").click({ modifiers: ["Shift"] });
      assert.deepEqual(await selectedCards(), ["E90", "E91"]);
    };
    await selectGroup();
    const beforeDelete = await readBoard();
    await rightClickCard("E92");
    await deleteCards.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.deepEqual(await selectedCards(), ["E90", "E91"], "Dismissing the menu must preserve the current selection");
    assert.deepEqual(await readBoard(), beforeDelete, "Dismissing the menu must leave all cards intact");

    await rightClickCard("E92");
    await deleteCards.click();
    await card("E92").waitFor({ state: "hidden" });
    assert.equal(await card("E90").isVisible(), true);
    assert.equal(await card("E91").isVisible(), true);
    assert.ok((await readBoard()).notes.deletedIds.includes("E92"), "Deleting an unrelated card must save its deletion");
    await page.locator("#undo-delete").click();
    await card("E92").waitFor();

    await selectGroup();
    await rightClickCard("E91");
    await deleteCards.click();
    await card("E90").waitFor({ state: "hidden" });
    await card("E91").waitFor({ state: "hidden" });
    assert.equal(await card("E92").isVisible(), true);
    const deleted = (await readBoard()).notes.deletedIds;
    assert.ok(deleted.includes("E90") && deleted.includes("E91") && !deleted.includes("E92"));
    await page.locator("#undo-delete").click();
    await card("E90").waitFor();
    await card("E91").waitFor();
    assert.deepEqual((await readBoard()).plan.current.items, initial.plan.current.items);
    assert.deepEqual((await readBoard()).notes.deletedIds, initial.notes.deletedIds);
    assert.deepEqual(modelPosts, [], "Deleting a connection or an isolated card must not request AI");
    assertNoJsErrors(jsErrors);
    record("U45", "PASS", "The context menu switches all four canvas tools and deletes a hovered connection, an unrelated card, or the current group. Escape preserves selection, and the existing undo controls restore the deleted objects.");
  } catch (error) { record("U45", "FAIL", safeError(error)); await screenshot("U45-failure", session.page); }
  finally { await closeSession(session); }
}

async function testDeleteWithoutWaitingForAnswer() {
  const session = await openPage("normal", "repo-manual");
  let finishAnswer;
  const holdAnswer = new Promise((resolve) => { finishAnswer = resolve; });
  try {
    const { page, jsErrors } = session;
    const cards = [["E90", null], ["E91", "E90"], ["E92", null], ["E93", "E92"], ["E94", "E93"], ["E95", "E92"]];
    await page.evaluate((fixture) => {
      const key = "whiteboard.codex.repo-manual.organization.v1";
      const plan = JSON.parse(localStorage.getItem(key));
      for (const [index, [id, parentId]] of fixture.entries()) {
        plan.current.items.push({ id, parentId, title: `删除测试 ${id}`, summary: "", category: "reference" });
        plan.current.positions[id] = { x: 90 + 315 * (index % 3), y: 550 + 180 * Math.floor(index / 3), width: 250 };
      }
      localStorage.setItem(key, JSON.stringify(plan));
      const noteKey = "whiteboard.codex.repo-manual.v1";
      const state = JSON.parse(localStorage.getItem(noteKey)) || {};
      const rect = { x: 910, y: 700, width: 270, height: 180 };
      state.notes = [...(state.notes || []), { id: "A90", rect, kind: "note", sourceCardIds: ["E91", "E95"], anchors: [],
        payload: { anchor: { elementIds: ["E91", "E95"], quote: "引用", box: rect }, question: "跨分支引用" },
        answer: "主挂接到 E91，补充引用 E95。" }];
      localStorage.setItem(noteKey, JSON.stringify(state));
    }, cards);
    await page.reload();
    await page.locator(".connection-settings > summary").click();
    await page.locator("#backend-select").selectOption("zcode");
    await page.locator(".connection-settings > summary").click();
    const requests = [];
    const answer = "保留这次 ZCode 回答。";
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const meta = { requestId: request.requestId, baseRevision: request.baseRevision };
      if (request.scope === "plan") {
        await route.fulfill({ contentType: "application/x-ndjson", body: [
          JSON.stringify({ ...meta, type: "answer", text: '{"action":"ask"}' }),
          JSON.stringify({ ...meta, type: "done" }),
        ].join("\n") });
        return;
      }
      if (request.scope !== "organize") await holdAnswer;
      await route.fulfill({ contentType: "application/x-ndjson", body: [
        JSON.stringify({ ...meta, type: "answer", text: answer }),
        JSON.stringify({ ...meta, type: "done", changedFiles: [] }),
      ].join("\n") });
    });
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const remove = page.locator("#delete-selection");
    const undo = page.locator("#undo-delete");
    const stop = page.locator("#stop-ai");
    await page.locator("#fit").click();

    await card("E95").press("Enter");
    await remove.click();
    await card("E95").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#repair-delete").isVisible(), false, "A secondary reference must not trigger repair");
    assert.deepEqual((await readManualNotes(page)).find(({ id }) => id === "A90").payload.anchor.elementIds, ["E91"]);
    await undo.click();
    await card("E95").waitFor();

    await card("E92").locator(".organized-title").click();
    for (const id of ["E93", "E94", "E95"]) await card(id).locator(".organized-title").click({ modifiers: ["Shift"] });
    await remove.click();
    for (const id of ["E92", "E93", "E94", "E95"]) await card(id).waitFor({ state: "hidden" });
    assert.equal(await page.locator("#repair-delete").isVisible(), false, "Deleting the full selection needs no repair");
    assert.equal(requests.length, 0);
    await undo.click();
    await card("E95").waitFor();

    await askFromCard(page, "E91", "正在处理的另一条分支");
    await page.waitForFunction(() => document.querySelector('#threads [data-anchor="E91"][aria-busy="true"]'));
    await stop.waitFor();
    await card("E90").press("Enter");
    assert.equal(await remove.isDisabled(), true, "The active question's ancestor must be protected");
    await page.locator("#fit").click();
    await card("E95").press("Shift+F10");
    await page.locator("#canvas-menu-delete").click();
    await card("E95").waitFor({ state: "hidden" });
    assert.equal(await stop.isVisible(), true, "Unrelated deletion should not wait for the answer or cancel it");
    assert.equal(await undo.isDisabled(), true);
    assert.deepEqual(requests.map(({ backend, scope }) => [backend, scope]), [["zcode", "plan"], ["zcode", undefined]]);
    finishAnswer();
    await page.locator("#threads .thread-answer").filter({ hasText: answer }).waitFor();
    await stop.waitFor({ state: "hidden" });
    await undo.click();
    await card("E95").waitFor();
    assert.ok((await readManualNotes(page)).some((note) => note.answer === answer), "Undo must not rewind the unrelated answer");
    await page.reload();
    await card("E95").waitFor();
    assert.ok((await readManualNotes(page)).some((note) => note.answer === answer));
    assertNoJsErrors(jsErrors);
    record("U58", "PASS", "Leaf and complete subtree deletion make zero model calls. While ZCode answers another branch, local deletion completes, active ancestors are protected, and undo retains the answer.");
  } catch (error) { record("U58", "FAIL", safeError(error)); await screenshot("U58-failure", session.page); }
  finally { finishAnswer(); await closeSession(session); }
}

async function testIndependentQuestionAndOrphanFiling() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const independent = page.locator("#ask-independent");
    const file = page.locator("#file-orphans");
    const integrate = page.locator("#integrate-draft");
    const stop = page.locator("#stop-ai");
    const undo = page.locator("#undo-organization");
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const keys = { organization: "whiteboard.codex.repo-manual.organization.v1", memory: "whiteboard.codex.repo-manual.v1" };
    const readBoard = () => page.evaluate((keys) => ({
      plan: JSON.parse(localStorage.getItem(keys.organization)),
      notes: JSON.parse(localStorage.getItem(keys.memory)),
    }), keys);
    const parentOf = async (id) => (await readBoard()).plan.current.items.find((item) => item.id === id)?.parentId ?? null;
    assert.equal(await independent.count(), 1, "The canvas needs an independent-question entry");
    assert.equal(await file.count(), 1, "The canvas needs a way to file detached cards");

    await page.evaluate(({ organization }) => {
      const stored = JSON.parse(localStorage.getItem(organization));
      stored.current.collapsedBranches = stored.current.collapsedBranches.filter((id) => id !== "E06" && id !== "E07");
      stored.current.items.push(
        { id: "E90", parentId: null, title: "HTTP 请求幂等", summary: "写入应支持重试。", category: "reference", folded: false },
        { id: "E91", parentId: null, title: "本机状态恢复", summary: "刷新后恢复编辑进度。", category: "reference", folded: false },
        { id: "E92", parentId: "E90", title: "幂等键", summary: "限制重复写入。", category: "reference", folded: false },
        { id: "E93", parentId: null, title: "已归档草稿", summary: "已归档内容。", category: "archive" },
      );
      Object.assign(stored.current.positions, {
        E90: { x: 90, y: 410, width: 210 },
        E91: { x: 350, y: 410, width: 210 },
        E92: { x: 90, y: 555, width: 210 },
      });
      localStorage.setItem(organization, JSON.stringify(stored));
    }, keys);
    await page.reload();
    const initial = await readBoard();
    const requests = [];
    const question = "刷新后要怎样恢复浏览器里的编辑进度？";
    const answer = "在浏览器本机保存进度，并在页面初始化时按模块编号恢复。";
    const separateQuestion = "怎么安排周末骑行路线？";
    const separateAnswer = "按路程和道路条件选择适合的骑行路线。";
    let proposal = ({ orphans }) => orphans.map(({ id }) => ({ childId: id, parentId: "E06" }));
    let pauseFiling;
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const text = request.scope === "independent" ? (request.question === separateQuestion ? separateAnswer : answer) : request.scope === "fileOrphans"
        ? JSON.stringify({ links: proposal(request.project.filing) }) : '{"action":"ask"}';
      if (request.scope === "fileOrphans") await pauseFiling;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text }, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });
    const assertFiling = (request) => {
      assert.equal(request.scope, "fileOrphans");
      assert.equal(request.mode, "ask");
      const { orphans, parents } = request.project.filing;
      assert.ok(parents.some(({ id, parentId, title }) => id === "E06" && parentId === "E04" && title));
      assert.ok(parents.some(({ id }) => id === "E07"));
      for (const id of new Set([...orphans.map(({ id }) => id), "E91", "E93"])) {
        assert.equal(parents.some((parent) => parent.id === id), false, `${id} is not an eligible parent`);
      }
      return orphans;
    };
    const fileAndRead = async (action = file) => {
      const start = requests.length;
      const response = page.waitForResponse((response) => response.url().endsWith("/api/codex") &&
        response.request().postDataJSON()?.scope === "fileOrphans");
      await action.click();
      await response;
      await stop.waitFor({ state: "hidden" });
      assert.equal(requests.length, start + 1);
      return assertFiling(requests[start]);
    };

    await card("E05").press("Enter");
    await independent.click();
    await page.locator("#question").fill(question);
    await page.locator("#submit-question").click();
    const reply = page.locator("#board .thread-note").filter({ hasText: answer });
    await reply.waitFor();
    const answerId = await reply.getAttribute("data-element-id");
    await stop.waitFor({ state: "hidden" });
    await page.waitForLoadState("networkidle");
    assert.equal(requests.length, 1, "Answering an independent question must not start an integration request");
    assert.equal(requests[0].scope, "independent");
    assert.equal(requests[0].mode, "ask");
    assert.equal(requests[0].question, question);
    assert.deepEqual(requests[0].anchor.elementIds, ["board"]);
    assert.equal(await parentOf(answerId), null);
    assert.equal(await connectionPath(page, "E06", answerId).count(), 0);
    assert.deepEqual((await readBoard()).plan.current.items.filter(({ id }) => id !== answerId), initial.plan.current.items);

    await page.reload();
    await card(answerId).getByText(answer, { exact: true }).waitFor();
    assert.equal(await parentOf(answerId), null, "An unintegrated draft remains detached after reload");
    await card(answerId).press("Enter");
    assert.equal(await file.isEnabled(), false, "Selecting a draft must not make it eligible for ordinary filing");
    const scope = await fileAndRead(integrate);
    assert.deepEqual(scope.map(({ id }) => id), [answerId]);
    assert.ok(JSON.stringify(scope).includes(question));
    assert.equal(requests.at(-1).project.filing.parents.some(({ id }) => id === "E90"), false);
    await connectionPath(page, "E06", answerId).waitFor({ state: "attached" });
    assert.equal(await parentOf(answerId), "E06");
    await page.reload();
    await connectionPath(page, "E06", answerId).waitFor({ state: "attached" });
    await undo.click();
    assert.equal(await parentOf(answerId), null);
    assert.equal(await connectionPath(page, "E06", answerId).count(), 0);
    await card(answerId).getByText(answer, { exact: true }).waitFor();

    proposal = ({ orphans }) => orphans.map(({ id }) => ({ childId: id, parentId: null }));
    await independent.click();
    await page.locator("#question").fill(separateQuestion);
    await page.locator("#submit-question").click();
    const separateReply = page.locator("#board .thread-note").filter({ hasText: separateAnswer });
    await separateReply.waitFor();
    await stop.waitFor({ state: "hidden" });
    const separateId = await separateReply.getAttribute("data-element-id");
    await card(separateId).press("Enter");
    assert.deepEqual((await fileAndRead(integrate)).map(({ id }) => id), [separateId]);
    assert.equal(await parentOf(separateId), null);
    assert.ok((await readBoard()).notes.notes.some((note) => note.id === separateId && note.answer === separateAnswer),
      "A no-match result must keep the independent answer saved");

    await card("E90").press("Enter");
    await openDetails(page, "organization-options");
    const detached = await readBoard();
    for (const links of [
      [{ childId: "E90", parentId: null }],
      [{ childId: "E90", parentId: "E92" }],
      [{ childId: "E90", parentId: "E07" }, { childId: "E91", parentId: "E06" }],
    ]) {
      proposal = () => links;
      assert.deepEqual((await fileAndRead()).map(({ id }) => id), ["E90"]);
      const request = requests.at(-1);
      assert.equal(request.project.filing.parents.some(({ id }) => id === "E92"), false, "A descendant cannot become the orphan's parent");
      assert.deepEqual(await readBoard(), detached, "No match or an invalid proposal must preserve the stored board");
    }

    proposal = () => [{ childId: "E90", parentId: "E07" }];
    let releaseFiling;
    pauseFiling = new Promise((resolve) => { releaseFiling = resolve; });
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/codex") &&
      request.postDataJSON()?.scope === "fileOrphans");
    let updated;
    try {
      await file.click();
      await sent;
      await page.locator("#organization-opinion").fill("同页正在补充白板意见。");
      updated = await readBoard();
    } finally {
      releaseFiling();
      pauseFiling = undefined;
    }
    await page.locator("#organization-status").filter({ hasText: "归位期间白板已变化" }).waitFor();
    await stop.waitFor({ state: "hidden" });
    assert.deepEqual(await readBoard(), updated, "A stale proposal must preserve the new board revision");

    assert.deepEqual((await fileAndRead()).map(({ id }) => id), ["E90"]);
    await connectionPath(page, "E07", "E90").waitFor({ state: "attached" });
    assert.equal(await parentOf("E90"), "E07");
    assert.equal(await parentOf("E91"), null, "Filing a selected card must leave other detached cards alone");
    assert.equal(await parentOf("E92"), "E90", "Filing a branch must preserve its children");
    const beforeNoScope = await readBoard();
    await card("E92").press("Enter");
    if (await file.isVisible() && await file.isEnabled()) await file.click();
    assert.equal(await stop.isVisible(), false, "Selecting an already linked card must not start a filing run");
    assert.deepEqual(await readBoard(), beforeNoScope);

    await clearCardSelection(page);
    proposal = ({ orphans }) => orphans.map(({ id }) => ({ childId: id, parentId: id === "E91" ? "E06" : null }));
    const batch = (await fileAndRead()).map(({ id }) => id);
    assert.ok(batch.includes("E91"));
    assert.equal(batch.includes(answerId), false, "Batch filing must skip the independent draft restored by undo");
    assert.equal(batch.includes(separateId), false, "A no-match draft must remain outside ordinary filing");
    await connectionPath(page, "E06", "E91").waitFor({ state: "attached" });
    assert.equal(await parentOf("E91"), "E06");
    await page.reload();
    await connectionPath(page, "E07", "E90").waitFor({ state: "attached" });
    await connectionPath(page, "E06", "E91").waitFor({ state: "attached" });
    await undo.click();
    assert.equal(await parentOf("E91"), null);
    assert.equal(await parentOf("E90"), "E07");
    assert.equal(await parentOf("E92"), "E90");
    assertNoJsErrors(jsErrors);
    record("U46", "PASS", "Independent answers stay detached until explicit integration. Ordinary selected and batch filing skips drafts, preserves hierarchy, rejects invalid or stale proposals, and supports undo after reload.");
  } catch (error) { record("U46", "FAIL", safeError(error)); await screenshot("U46-failure", session.page); }
  finally { await closeSession(session); }
}

async function testDraftBranchWorkflow() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const items = () => page.evaluate(() => JSON.parse(
      localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current.items);
    const readItem = async (id) => (await items()).find((item) => item.id === id);
    const integrate = page.locator("#integrate-draft");
    const stop = page.locator("#stop-ai");
    const rootTitle = "草稿：关闭页面后的编辑恢复";
    const review = "先明确恢复哪些进度，并列出需要确认的边界。";
    const implemented = "模拟服务收到明确授权的改码请求。";
    const followup = "在已整合的讨论下继续核对验收边界。";
    const followupAnswer = "沿当前项目分支继续核对验收。";
    const task = {
      title: "定义恢复进度的验收",
      task: "写下刷新前后的输入和期望。",
      dependencies: [],
      acceptance: ["刷新后能恢复与原任务匹配的进度"],
    };
    const requests = [];
    let plannedAction = "ask";
    let organizerItems;
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const result = request.scope === "organize" ? { type: "map", map: {
        title: "测试：整理后的主线", summary: "草稿保留在原地。",
        layout: request.board.layout, items: organizerItems, positions: {},
      } } : request.scope === "decompose" ? { type: "children", children: [task] }
        : { type: "answer", text: request.scope === "plan" ? JSON.stringify({ action: plannedAction })
          : request.scope === "fileOrphans" ? JSON.stringify({
            links: request.project.filing.orphans.map(({ id }) => ({ childId: id, parentId: "E06" })),
          }) : request.mode === "edit" ? implemented : request.question === followup ? followupAnswer : review };
      await route.fulfill({ contentType: "application/x-ndjson",
        body: [result, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });
    const assertContext = (turns, rootId, selectedId) => {
      for (const request of turns) {
        const branch = request.project?.draftBranch;
        assert.equal(branch?.rootId, rootId, "Both planning and execution must include the active draft branch");
        assert.deepEqual(branch.path.map(({ id }) => id), rootId === selectedId ? [rootId] : [rootId, selectedId]);
        assert.ok(branch.nodes.some(({ id }) => id === rootId));
        assert.ok(branch.nodes.some(({ id }) => id === selectedId));
        assert.equal(branch.nodes.some(({ id }) => id === "E06"), false, "Unrelated modules do not belong to the draft");
      }
    };

    await page.locator("#new-card").click();
    await page.locator("#workbench-card-title").fill(rootTitle);
    await page.locator("#workbench-card-body").fill("讨论关闭页面后如何恢复编辑进度，验证完成后纳入主线。");
    await page.locator("#save-workbench-card").click();
    await page.getByText(rootTitle, { exact: true }).waitFor();
    const root = (await items()).find(({ title }) => title === rootTitle);
    assert.equal(root.draft, true);
    assert.equal(root.parentId, null);
    assert.equal(await page.locator("#file-orphans").isEnabled(), false, "Draft roots require explicit integration");

    await askFromCard(page, root.id, "这个草稿还缺哪些边界？");
    const discussion = page.locator("#board .thread-note").filter({ hasText: review });
    await discussion.waitFor();
    const discussionId = await discussion.getAttribute("data-element-id");
    await connectionPath(page, root.id, discussionId).waitFor({ state: "attached" });
    await stop.waitFor({ state: "hidden" });
    assert.deepEqual(requests.map(({ scope }) => scope), ["plan", undefined], "Discussion must not automatically integrate the draft");
    assertContext(requests, root.id, root.id);
    assert.equal((await readItem(root.id)).parentId, null);

    plannedAction = "decompose";
    const beforeSplit = requests.length;
    await askFromCard(page, root.id, "拆出一个可验证的子任务。");
    await page.getByText(task.title, { exact: true }).waitFor();
    await stop.waitFor({ state: "hidden" });
    assert.deepEqual(requests.slice(beforeSplit).map(({ scope }) => scope), ["plan", "decompose"]);
    assertContext(requests.slice(beforeSplit), root.id, root.id);
    assert.ok(requests.at(-1).project.draftBranch.nodes.some(({ id }) => id === discussionId),
      "Decomposition must see the earlier draft discussion");
    const child = (await items()).find(({ title }) => title === task.title);
    assert.equal(child.parentId, root.id);
    assert.equal((await readItem(root.id)).parentId, null);

    plannedAction = "edit";
    const beforeEdit = requests.length;
    await askFromCard(page, child.id, "修改白板代码以实现本草稿的恢复步骤。");
    await page.locator("#ask-feedback").filter({ hasText: "本轮未允许修改代码" }).waitFor();
    assert.deepEqual(requests.slice(beforeEdit).map(({ scope, mode }) => [scope, mode]), [["plan", "ask"]]);
    await page.locator("#allow-source-edit").check();
    await page.locator("#submit-question").click();
    await page.getByText(implemented, { exact: true }).waitFor();
    await stop.waitFor({ state: "hidden" });
    assert.deepEqual(requests.slice(beforeEdit + 1).map(({ mode }) => mode), ["ask", "edit"]);
    assertContext(requests.slice(beforeEdit + 1), root.id, child.id);
    assert.equal((await readItem(root.id)).parentId, null, "An authorized edit does not integrate the draft");

    const draftIds = [root.id, child.id, discussionId];
    const priorItems = await items();
    const draftRects = await visibleCardRects(page);
    organizerItems = priorItems.filter(({ id }) => !draftIds.includes(id));
    await clearCardSelection(page);
    await page.locator("#organize-board").click();
    const scope = await page.locator("#organize-board-scope").innerText();
    assert.equal(Number(scope.match(/(\d+)\s*张/)?.[1]), organizerItems.length);
    assert.match(scope, /独立草稿/);
    await page.locator("#confirm-organize-board").click();
    await page.getByText("测试：整理后的主线", { exact: true }).waitFor();
    await stop.waitFor({ state: "hidden" });
    const organize = requests.at(-1);
    assert.equal(organize.scope, "organize");
    assert.equal(organize.project.draftBranch, undefined);
    assert.equal(organize.board.nodes.some(({ id }) => draftIds.includes(id)), false,
      "Whole-board organization must leave draft members out of the model proposal");
    const afterOrganize = await items();
    const afterRects = await visibleCardRects(page);
    for (const id of draftIds) {
      assert.deepEqual(afterOrganize.find((item) => item.id === id), priorItems.find((item) => item.id === id));
      assert.deepEqual(afterRects[id], draftRects[id], "Whole-board organization must preserve the draft card position");
    }

    await page.reload();
    await card(child.id).waitFor();
    await card(child.id).press("Enter");
    const beforeIntegration = requests.length;
    await integrate.click();
    await stop.waitFor({ state: "hidden" });
    const integration = requests[beforeIntegration];
    assert.equal(requests.length, beforeIntegration + 1);
    assert.equal(integration.mode, "ask");
    assert.equal(integration.scope, "fileOrphans");
    const { orphans, parents } = integration.project.filing;
    assert.deepEqual(orphans.map(({ id }) => id), [root.id]);
    assert.ok(JSON.stringify(orphans[0].branch).includes(task.title), "Integration must see the finalized subtree");
    assert.equal(parents.some(({ id }) => id === child.id), false);
    assert.equal((await readItem(root.id)).parentId, "E06");
    assert.deepEqual(await readItem(child.id), child);
    const collapsedParent = card("E06").locator('.branch-toggle[aria-expanded="false"]');
    if (await collapsedParent.count()) await collapsedParent.click();
    await connectionPath(page, "E06", root.id).waitFor({ state: "attached" });
    await connectionPath(page, root.id, discussionId).waitFor({ state: "attached" });
    assert.equal(await card(root.id).getAttribute("data-draft-root"), null);
    const parentToggle = card("E06").locator(".branch-toggle");
    await parentToggle.press("Enter");
    for (const id of draftIds) assert.equal(await card(id).isVisible(), false, `${id} must follow the new ancestor's fold`);
    await parentToggle.press("Enter");
    await connectionPath(page, root.id, discussionId).waitFor({ state: "attached" });
    await page.reload();
    await connectionPath(page, "E06", root.id).waitFor({ state: "attached" });
    plannedAction = "ask";
    const beforeFollowup = requests.length;
    await askFromCard(page, discussionId, followup);
    await page.getByText(followupAnswer, { exact: true }).waitFor();
    await stop.waitFor({ state: "hidden" });
    const followupTurns = requests.slice(beforeFollowup);
    assert.deepEqual(followupTurns.map(({ scope }) => scope), ["plan", undefined]);
    for (const turn of followupTurns) {
      assert.deepEqual(turn.anchor.elementIds, [discussionId]);
      assert.equal(turn.project.draftBranch, undefined, "A follow-up under the filed branch uses the main board's context");
    }
    await page.locator("#undo-organization").click();
    assert.equal((await readItem(root.id)).parentId, null);
    assert.equal((await readItem(root.id)).draft, true);
    assert.deepEqual(await readItem(child.id), child);
    await connectionPath(page, root.id, discussionId).waitFor({ state: "attached" });
    await card(child.id).press("Enter");
    assert.equal(await integrate.isEnabled(), true);
    assertNoJsErrors(jsErrors);
    record("U47", "PASS", "A detached card supports scoped discussion, decomposition, and explicitly authorized edits. Integration links its root, applies the new ancestor's fold and follow-up scope, and supports undo.");
  } catch (error) { record("U47", "FAIL", safeError(error)); await screenshot("U47-failure", session.page); }
  finally { await closeSession(session); }
}

async function testFoldedCardSearchAndContext() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const chapter = card("E07").locator(".branch-toggle");
    const search = page.locator("#card-search-input");
    const results = page.locator("#card-search-results button.card-search-result");
    const overview = page.locator("#return-overview");
    const stop = page.locator("#stop-ai");
    const topic = "事件流";
    const savedExcerpt = "回复沿 NDJSON 传 context、状态、结果和终态";
    const wholeQuestion = "请解释事件流在白板里怎么工作。";
    const selectedQuestion = "这张卡提到的事件流怎样传状态和终态？";
    const draftTitle = "事件流终态检查草稿";
    const wholeAnswer = "模拟整板回答已找到 E27。";
    const selectedAnswer = "模拟选卡回答使用了 E27 的正文。";
    const requests = [];
    const send = async (question, answer) => {
      await page.locator("#question").fill(question);
      await page.locator("#submit-question").click();
      await page.locator("#threads").getByText(answer, { exact: true }).waitFor();
      await stop.waitFor({ state: "hidden" });
    };
    const currentItems = () => page.evaluate(() => JSON.parse(
      localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current.items);
    const camera = () => page.locator("#board").evaluate((element) => element.style.transform);
    const viewContains = (target) => target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const view = document.querySelector("#viewport").getBoundingClientRect();
      return rect.left >= view.left - 1 && rect.top >= view.top - 1 &&
        rect.right <= view.right + 1 && rect.bottom <= view.bottom + 1;
    });
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const text = request.scope === "plan" ? '{"action":"ask"}'
        : request.scope === "fileOrphans" ? JSON.stringify({
          links: request.project.filing.orphans.map(({ id }) => ({ childId: id, parentId: "E27" })),
        }) : request.question === wholeQuestion ? wholeAnswer : selectedAnswer;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [{ type: "answer", text }, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    });

    assert.equal(await chapter.getAttribute("aria-expanded"), "false");
    assert.equal(await card("E27").isVisible(), false);
    assert.equal(await overview.isVisible(), false);
    const overviewCamera = await camera();
    await page.locator("#ask-board").click();
    await send(wholeQuestion, wholeAnswer);
    assert.deepEqual(requests.map(({ scope }) => scope), ["plan", undefined]);
    for (const request of requests) {
      assert.deepEqual(request.anchor.elementIds, ["board"]);
      const match = request.project?.relevantCards?.find(({ id }) => id === "E27");
      assert.ok(match, "The question about 事件流 must retrieve E27 while its chapter is folded");
      assert.match(match.summary, /NDJSON/);
      assert.deepEqual(match.path.map(({ id }) => id), ["E04", "E07", "E27"]);
    }
    assert.equal(await card("E27").isVisible(), false, "Question context should be independent of folding");

    await page.locator("#card-search-toggle").click();
    await search.fill(topic);
    const first = results.first();
    await first.waitFor();
    assert.equal(await first.getAttribute("data-card-id"), "E27", "The title match should rank first");
    assert.match(await first.innerText(), /附件、连接设置和事件流/);
    await search.press("Enter");
    await card("E27").waitFor();
    assert.equal(await chapter.getAttribute("aria-expanded"), "true");
    assert.equal(await card("E27").getAttribute("aria-pressed"), "true");
    assert.equal(await viewContains(card("E27")), true, "Search should pan the actual card into the viewport");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1"))
      .current.collapsedBranches.includes("E07")), true, "Search must not save a new fold state");
    await overview.waitFor();
    assert.equal(await page.locator("#card-search").evaluate((element) => element.open), false);
    assert.equal(await card("E27").locator(".module-fold").getAttribute("aria-expanded"), "false");

    await page.locator("#ask-open").click();
    await send(selectedQuestion, selectedAnswer);
    const selectedRequests = requests.slice(2);
    assert.deepEqual(selectedRequests.map(({ scope }) => scope), ["plan", undefined]);
    for (const request of selectedRequests) {
      assert.deepEqual(request.anchor.elementIds, ["E27"]);
      assert.ok(request.anchor.quote.includes(savedExcerpt), "Selecting the whole folded card must include its saved body");
      const match = request.project?.selectedCards?.find(({ id }) => id === "E27");
      assert.ok(match?.summary.includes(savedExcerpt));
    }

    await overview.click();
    await overview.waitFor({ state: "hidden" });
    assert.equal(await chapter.getAttribute("aria-expanded"), "false");
    assert.equal(await card("E27").isVisible(), false);
    assert.equal(await card("E27").getAttribute("aria-pressed"), "false");
    assert.equal(await viewContains(card("E04")), true);
    assert.equal(await camera(), overviewCamera);

    await page.locator("#new-card").click();
    await page.locator("#workbench-card-title").fill(draftTitle);
    await page.locator("#workbench-card-body").fill("核对事件流结束、done 和候选回答提交。");
    await page.locator("#save-workbench-card").click();
    const draft = page.locator("#board [data-draft-root]").filter({ hasText: draftTitle });
    await draft.waitFor();
    const draftId = await draft.getAttribute("data-element-id");
    assert.equal(await card("E27").isVisible(), false);
    await page.locator("#integrate-draft").click();
    await page.waitForFunction((id) => JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1"))
      .current.items.some((item) => item.id === id && item.parentId === "E27"), draftId);
    await stop.waitFor({ state: "hidden" });
    const filed = requests.at(-1);
    assert.equal(filed.scope, "fileOrphans");
    assert.deepEqual(filed.project.filing.orphans.map(({ id }) => id), [draftId]);
    assert.ok(filed.project.filing.parents.some(({ id, parentId }) => id === "E27" && parentId === "E07"));
    assert.equal((await currentItems()).find(({ id }) => id === draftId).parentId, "E27");
    assertNoJsErrors(jsErrors);
    record("U54", "PASS", "Search ranks and reveals folded E27, then restores overview in one click. Questions and filing retrieve saved E27 independently of folding, and the filing link is persisted.");
  } catch (error) { record("U54", "FAIL", safeError(error)); await screenshot("U54-failure", session.page); }
  finally { await closeSession(session); }
}

async function testStructuredAnswerInSourceBranch() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const toggle = (id) => card(id).locator(".branch-toggle");
    const expectFold = async (id, expanded, count) => {
      assert.equal(await toggle(id).count(), 1, `${id} must control its own branch`);
      assert.equal(await toggle(id).getAttribute("aria-expanded"), String(expanded));
      assert.equal(await toggle(id).getAttribute("aria-label"),
        `${id} ${expanded ? "收起" : "展开"} ${count} 个下级节点`);
    };
    const relations = [
      ["E90", "A10"], ["A10", "A11"], ["A10", "A12"], ["A11", "A13"], ["A11", "E91"],
    ];
    await page.evaluate(() => {
      const organizationKey = "whiteboard.codex.repo-manual.organization.v1";
      const organization = JSON.parse(localStorage.getItem(organizationKey));
      organization.current.items.push(
        { id: "E90", parentId: "E04", title: "发送请求怎样选中后端", summary: "连接设置指定服务和模型。", category: "reference" },
        { id: "A10", parentId: "E90", title: "后端主要的设计是什么", summary: "后端执行概览。", category: "reference", nativeFace: true },
        { id: "A11", parentId: "A10", title: "模型服务接入", summary: "模型选择和验收。", category: "reference", nativeFace: true },
        { id: "E91", parentId: "A11", title: "验收任务", summary: "核对模型选择的实际请求。", category: "task" },
      );
      organization.current.collapsedBranches = organization.current.collapsedBranches.filter((id) => id !== "E04");
      organization.current.collapsedBranches.push("E90");
      localStorage.setItem(organizationKey, JSON.stringify(organization));

      const memoryKey = "whiteboard.codex.repo-manual.v1";
      const memory = JSON.parse(localStorage.getItem(memoryKey));
      const makeNote = (id, parentId, question, details = {}) => {
        const rect = { x: 600, y: 480, width: 250, height: 110 };
        return {
          id, rect, kind: "note", answer: `${question}的内容。`, sourceCardIds: [parentId],
          payload: {
            boardId: "repo-manual", mode: "ask", question, scope: details.outline ? "explain" : undefined,
            anchor: { elementIds: [parentId], quote: question, box: rect },
          },
          ...details,
        };
      };
      memory.notes.push(
        makeNote("A10", "E90", "后端主要的设计是什么", { kind: "branch", outline: true, outlineCollapsed: true }),
        makeNote("A11", "A10", "模型服务接入", { sectionOf: "A10", outline: true, outlineCollapsed: true }),
        makeNote("A12", "A10", "白板内容组织", { sectionOf: "A10" }),
        makeNote("A13", "A11", "请求使用的模型字段", { sectionOf: "A11" }),
        makeNote("A15", "E90", "短批注"),
      );
      localStorage.setItem(memoryKey, JSON.stringify(memory));
    });

    await page.reload();
    await card("E90").waitFor();
    await card("A15").waitFor();
    await expectFold("E90", false, 5);
    for (const [, id] of relations) assert.equal(await card(id).isVisible(), false, `${id} must follow its source branch`);
    assert.equal(await connectionPath(page, "E90", "A10").count(), 0);
    await connectionPath(page, "E90", "A15").waitFor({ state: "attached" });

    await toggle("E90").press("Enter");
    await card("A10").waitFor();
    await expectFold("A10", false, 4);
    assert.equal(await card("A11").isVisible(), false, "Opening the source preserves its answer's folded state");
    await connectionPath(page, "E90", "A10").waitFor({ state: "attached" });
    await toggle("A10").press("Enter");
    await card("A12").waitFor();
    await expectFold("A11", false, 2);
    assert.equal(await card("A13").isVisible(), false);
    assert.equal(await card("E91").isVisible(), false);
    await toggle("A11").press("Enter");
    await card("E91").waitFor();
    for (const [parent, child] of relations) await connectionPath(page, parent, child).waitFor({ state: "attached" });

    await toggle("A11").press("Enter");
    await toggle("E90").press("Enter");
    await card("A10").waitFor({ state: "hidden" });
    assert.equal(await card("A15").isVisible(), true, "The ordinary inline note remains visible when its source is folded");
    await page.reload();
    await card("A15").waitFor();
    await expectFold("E90", false, 5);
    assert.equal(await card("A10").isVisible(), false);
    await toggle("E90").press("Enter");
    await card("A12").waitFor();
    await expectFold("A10", true, 4);
    await expectFold("A11", false, 2);
    assert.equal(await card("E91").isVisible(), false);
    await toggle("A11").press("Enter");
    await card("E91").waitFor();
    for (const [parent, child] of relations) await connectionPath(page, parent, child).waitFor({ state: "attached" });
    const savedItems = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("whiteboard.codex.repo-manual.organization.v1")).current.items);
    for (const id of ["A10", "A11", "E91"]) {
      assert.equal(savedItems.find((item) => item.id === id).parentId,
        relations.find(([, child]) => child === id)[0]);
    }
    const notes = await readManualNotes(page);
    for (const [parent, child] of relations.filter(([, id]) => id.startsWith("A"))) {
      const saved = notes.find((note) => note.id === child);
      assert.deepEqual(saved.payload.anchor.elementIds, [parent]);
      assert.equal(saved.sectionOf, child === "A10" ? undefined : parent);
    }
    assertNoJsErrors(jsErrors);
    record("U48", "PASS", "A source module counts and folds its full structured answer tree. Reload preserves independent nested folds, visible links and stored parents, and ordinary inline notes stay visible.");
  } catch (error) { record("U48", "FAIL", safeError(error)); await screenshot("U48-failure", session.page); }
  finally { await closeSession(session); }
}

async function testReparentAnswerOwnership() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const toggle = (id) => card(id).locator(".branch-toggle");
    const originalQuestion = "这个后端入口为什么先解析连接设置？";
    const answer = "选区保留原始出处，问题可以在新分支继续。";
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const result = { type: "answer", text: request.scope === "plan" ? JSON.stringify({ action: "ask" }) : answer };
      await route.fulfill({ contentType: "application/x-ndjson",
        body: [result, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });
    await page.evaluate((question) => {
      const organizationKey = "whiteboard.codex.repo-manual.organization.v1";
      const organization = JSON.parse(localStorage.getItem(organizationKey));
      organization.current.items = organization.current.items.filter(({ id }) => ["E04", "E06", "E07"].includes(id));
      organization.current.collapsedBranches = [];
      localStorage.setItem(organizationKey, JSON.stringify(organization));

      const memoryKey = "whiteboard.codex.repo-manual.v1";
      const memory = JSON.parse(localStorage.getItem(memoryKey));
      const rect = { x: 600, y: 480, width: 250, height: 110 };
      memory.notes = [{ id: "A90", rect, kind: "note", answer: "先验证连接参数。", sourceCardIds: ["E07"],
        payload: { boardId: "repo-manual", mode: "ask", question,
          anchor: { elementIds: ["E07"], quote: "原始选区", box: rect } }, anchors: [rect] }];
      localStorage.setItem(memoryKey, JSON.stringify(memory));
    }, originalQuestion);

    await page.reload();
    await connectionPath(page, "E07", "A90").waitFor({ state: "attached" });
    await page.locator("#connect-mode").click();
    await card("E06").press("Enter");
    await card("A90").press("Enter");
    await connectionPath(page, "E06", "A90").waitFor({ state: "attached" });
    assert.equal(await connectionPath(page, "E07", "A90").count(), 0);
    assert.equal(await toggle("E07").count(), 0);
    assert.equal(await toggle("E06").count(), 1, "The new parent must immediately control a locally attached answer");
    assert.equal(await toggle("E06").getAttribute("aria-label"), "E06 收起 1 个下级节点");
    assert.deepEqual(requests, [], "Attaching and counting an existing answer must stay local");
    const original = (await readManualNotes(page)).find(({ id }) => id === "A90");
    assert.deepEqual(original.payload.anchor.elementIds, ["E07"]);
    assert.deepEqual(original.sourceCardIds, ["E07"]);
    assert.equal(original.payload.anchor.quote, "原始选区");

    await toggle("E06").press("Enter");
    await card("A90").waitFor({ state: "hidden" });
    await page.reload();
    assert.equal(await toggle("E06").getAttribute("aria-label"), "E06 展开 1 个下级节点");
    assert.equal(await card("A90").isVisible(), false);
    await toggle("E06").press("Enter");
    await connectionPath(page, "E06", "A90").waitFor({ state: "attached" });
    await page.locator("#select-mode").click();
    await card("A90").press("Enter");
    const branchLabel = await page.locator("#branch-label").innerText();
    assert.match(branchLabel, /E06/);
    assert.doesNotMatch(branchLabel, /E07/);
    await page.locator("#ask-open").click();
    await page.locator("#question").fill("就这个回答继续确认连接设置。");
    await page.locator("#submit-question").click();
    await page.getByText(answer, { exact: true }).waitFor();
    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    const executed = requests.at(-1);
    assert.deepEqual(executed.anchor.elementIds, ["A90"]);
    assert.equal(executed.branch.label, branchLabel);
    assert.ok(executed.branch.recent.some(({ question }) => question === originalQuestion));
    const sent = requests.length;
    await page.locator("#connect-mode").click();
    await card("E07").press("Enter");
    await card("A90").press("Enter");
    await connectionPath(page, "E07", "A90").waitFor({ state: "attached" });
    assert.equal(await toggle("E07").getAttribute("aria-label"), "E07 收起 2 个下级节点",
      "An explicit link back to the original source still owns the branch");
    assert.equal(await toggle("E06").count(), 0);
    await toggle("E07").press("Enter");
    await card("A90").waitFor({ state: "hidden" });
    await page.reload();
    assert.equal(await toggle("E07").getAttribute("aria-label"), "E07 展开 2 个下级节点");
    assert.equal(await card("A90").isVisible(), false);
    assert.equal(requests.length, sent);
    assertNoJsErrors(jsErrors);
    record("U49", "PASS", "Local reparenting updates the new owner's fold and live discussion lineage immediately, and preserves source provenance and reload state.");
  } catch (error) { record("U49", "FAIL", safeError(error)); await screenshot("U49-failure", session.page); }
  finally { await closeSession(session); }
}

async function testProjectHomeWorkflow() {
  const session = await openPage("normal", null);
  try {
    const { page, jsErrors } = session;
    const home = page.locator("#local-projects");
    const canvas = page.locator("#board-workspace");
    const tab = (view) => page.locator(`[data-project-view="${view}"]`);
    const onProjectCanvas = (id) => (url) =>
      url.searchParams.get("board") === `board-${id}` &&
      url.searchParams.get("project") === id && url.searchParams.get("view") === "canvas";
    const waitProjectName = (name) =>
      page.waitForFunction((title) => document.querySelector("#project-context-title")?.textContent === title, name);
    const projectLink = (within, project) => page.locator(`${within} a[href*="project=${project.id}"]`).first();
    const closeProject = async () => {
      await page.locator("#close-project").click();
      await home.waitFor();
      const params = new URL(page.url()).searchParams;
      assert.equal(params.has("project"), false);
      assert.equal(params.has("board"), false);
      assert.equal(await canvas.isVisible(), false);
    };

    assert.equal(await canvas.isVisible(), false);
    await projectLink("#local-project-cards", parentProject).click();
    await page.waitForURL(onProjectCanvas(parentProject.id));
    await canvas.waitFor();
    await waitProjectName(parentProject.name);
    assert.equal(await tab("canvas").count(), 0, "The workspace is the project page");

    const cardTitle = "接口版本写作提纲";
    await page.locator("#empty-canvas-write").click();
    await page.locator("#workbench-card-title").fill(cardTitle);
    await page.locator("#workbench-card-body").fill("先写清调用入口，再补上兼容性例子。");
    let leaveDialogType;
    page.once("dialog", async (dialog) => {
      leaveDialogType = dialog.type();
      await dialog.dismiss();
    });
    await page.locator("#close-project").click();
    assert.equal(leaveDialogType, "confirm", "Closing a project with an unsaved card must ask first");
    assert.ok(onProjectCanvas(parentProject.id)(new URL(page.url())));
    assert.equal(await page.locator("#workbench-card-title").inputValue(), cardTitle);
    await page.locator("#save-workbench-card").click();
    const writtenCard = page.locator('#board [data-organized-category="main"]').getByText(cardTitle, { exact: true });
    await writtenCard.waitFor();

    const legacy = new URL(page.url());
    legacy.searchParams.set("board", "project-workbench");
    legacy.searchParams.set("view", "graph");
    await page.goto(legacy.href);
    await page.waitForURL(onProjectCanvas(parentProject.id));
    await writtenCard.waitFor();
    assert.equal(await tab("graph").count(), 0);
    legacy.searchParams.set("view", "actions");
    await page.goto(legacy.href);
    await page.locator('[data-activity="timeline"]').getByText("该项目暂无 AI 动作记录。").waitFor();
    assert.ok(onProjectCanvas(parentProject.id)(new URL(page.url())));
    assert.equal(await canvas.isVisible(), true);
    await page.locator("#project-info-close").click();
    await page.locator("#project-context-views summary").click();
    await tab("projects").click();
    await page.getByRole("dialog", { name: "子项目" }).waitFor();
    await projectLink("#project-children-cards", childProject).click();
    await page.waitForURL(onProjectCanvas(childProject.id));
    await canvas.waitFor();
    await waitProjectName(childProject.name);
    assert.equal(await writtenCard.count(), 0, "The parent canvas must stay separate from its child project");

    await closeProject();
    await page.reload();
    await home.waitFor();
    await projectLink("#local-project-cards", parentProject).click();
    await page.waitForURL(onProjectCanvas(parentProject.id));
    await writtenCard.waitFor();
    await closeProject();
    assert.equal(await page.locator(`#home-board-list a[href*="board=board-${parentProject.id}"]`).count(), 0,
      "Project canvases must appear under their projects only");

    await page.locator("#home-add-project").click();
    const registration = page.locator("#project-register-form");
    await registration.waitFor();
    const name = "新登记的写作工具";
    const path = "C:\\fixture\\写作工具";
    await page.locator("#project-register-name").fill(name);
    await page.locator("#project-register-description").fill("试用项目主路线。");
    await page.locator("#project-register-path").fill("missing-directory");
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/local-projects") && response.status() === 422),
      page.locator("#project-register-submit").click(),
    ]);
    await page.locator("#project-register-error").waitFor();
    assert.equal(await page.locator("#project-register-name").inputValue(), name);
    await page.locator("#project-register-path").fill(path);
    await page.locator("#project-register-submit").click();
    await page.waitForURL(onProjectCanvas(registeredProjectId));
    await canvas.waitFor();
    await waitProjectName(name);
    assert.equal((await page.locator("#project-context-directory").textContent()).trim(), path);
    await closeProject();
    await page.locator("#local-project-cards").getByText(name, { exact: true }).waitFor();

    await page.locator("#home-create-board").click();
    const note = "独立写作草稿";
    await page.locator("#board-name").fill(note);
    await page.locator("#board-create-submit").click();
    await canvas.waitFor();
    const independent = new URL(page.url()).searchParams;
    assert.match(independent.get("board"), /^board-[a-f0-9]{32}$/);
    assert.equal(independent.has("project"), false);
    await page.locator("#local-project-link").click();
    await home.waitFor();
    const localBoard = page.locator(`#home-board-list a[href*="board=${independent.get("board")}"]`);
    await localBoard.click();
    await page.waitForFunction(title => document.querySelector("#canvas-title")?.textContent.trim() === title, note);
    assert.equal((await page.locator("#canvas-title").textContent()).trim(), note);
    assertNoJsErrors(jsErrors.filter((message) => !/^Failed to load resource:.*\b422\b/.test(message)));
    record("U62", "PASS", "The homepage opens registered project canvases first, guards a card draft before closing, preserves saved cards through reopen, and separates project registration from independent boards.");
  } catch (error) { record("U62", "FAIL", safeError(error)); await screenshot("U62-failure", session.page); }
  finally { await closeSession(session); }
}

async function testLinkedProjectBoards() {
  const session = await openPage("normal", null);
  try {
    const { context, page, jsErrors } = session;
    const root = {
      ...parentProject,
      id: "d".repeat(32),
      name: "已有讲义项目",
      boardUrl: `http://127.0.0.1:18797/?board=board-${"f".repeat(32)}`,
    };
    const child = {
      ...childProject,
      id: "e".repeat(32),
      parentId: root.id,
      name: "已保存的研讨稿",
      boardUrl: `http://127.0.0.1:18797/?board=board-${"1".repeat(32)}`,
    };
    const home = page.locator("#local-projects");
    const homeUrl = page.url();
    const getRequests = [];
    await page.route("**/api/local-projects", async (route) => {
      const request = route.request().postDataJSON();
      if (request.action === "list") {
        await route.fulfill({ json: { projects: [root, child] } });
      } else if (request.action === "get" && request.id === root.id) {
        getRequests.push(request.id);
        await route.fulfill({ json: { project: root, ancestors: [], children: [child] } });
      } else {
        await route.fulfill({ status: 422, json: { text: "Unexpected project request" } });
      }
    });
    for (const project of [root, child]) {
      await context.route(project.boardUrl, (route) => route.fulfill({ contentType: "text/plain; charset=utf-8", body: project.name }));
    }
    await page.reload();
    await home.waitFor();

    const catalog = () => page.evaluate(() => localStorage.getItem(window.BoardMemory.catalogKey));
    const before = await catalog();
    const openExisting = async (link, { name, boardUrl }) => {
      assert.equal(await link.getAttribute("href"), boardUrl);
      await Promise.all([
        page.waitForURL((url) => url.href === boardUrl),
        link.click(),
      ]);
      assert.equal(await page.locator("body").innerText(), name);
      await page.goBack();
      await home.waitFor();
      assert.equal(await catalog(), before, "Opening a linked board must not allocate a shadow local canvas");
    };
    await openExisting(home.getByRole("link", { name: `打开项目：${root.name}` }), root);
    await page.locator("#local-project-search").fill(child.name);
    await openExisting(home.getByRole("link", { name: child.name, exact: true }), child);
    assert.deepEqual(getRequests, [], "Homepage links must open linked boards directly");

    const oldProjectUrl = new URL(homeUrl);
    oldProjectUrl.searchParams.set("board", `board-${root.id}`);
    oldProjectUrl.searchParams.set("project", root.id);
    oldProjectUrl.searchParams.set("view", "canvas");
    await page.goto(oldProjectUrl.href);
    await page.waitForURL((url) => url.href === root.boardUrl);
    assert.equal(await page.locator("body").innerText(), root.name);
    assert.deepEqual(getRequests, [root.id]);
    await page.goto(homeUrl);
    await home.waitFor();
    assert.equal(await catalog(), before, "An older project URL must redirect without provisioning a local canvas");
    assertNoJsErrors(jsErrors);
    record("U63", "PASS", "Homepage project cards and nested search results open the existing board URL without creating a local canvas.");
  } catch (error) { record("U63", "FAIL", safeError(error)); await screenshot("U63-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRegisteredProjectIntroduction() {
  const session = await openPage("normal", null);
  try {
    const { page, jsErrors } = session;
    const fresh = parentProject;
    const empty = { ...childProject, name: "已打开的空项目" };
    const edited = { ...parentProject, id: "2".repeat(32), name: "已有自写内容的项目" };
    const cleared = { ...parentProject, id: "3".repeat(32), name: "已主动清空的项目" };
    const legacy = { ...parentProject, id: "4".repeat(32), name: "原有动作项目" };
    const initialBoard = {
      title: "工程说明",
      summary: "从项目用途到源码位置。",
      items: [
        { id: "E04", parentId: null, category: "main", title: "项目总览", summary: "这是分层说明的根卡。" },
        { id: "E05", parentId: "E04", category: "reference", title: "运行流程", summary: "按请求生命周期阅读。" },
        { id: "E06", parentId: "E05", category: "reference", title: "处理上传", summary: "解析请求、校验输入。",
          sources: ["frontend/src/Upload.ts", "backend/app/main.py"] },
      ],
      collapsedBranches: ["E05"],
    };
    const editedCard = { id: "E90", parentId: null, category: "main", title: "用户写过的卡片", summary: "必须原样保留。" };
    const projects = [fresh, empty, edited, cleared, legacy];
    await page.route("**/api/local-projects", async (route) => {
      const request = route.request().postDataJSON();
      if (request.action === "list") await route.fulfill({ json: { projects } });
      else {
        const project = projects.find(({ id }) => id === request.id);
        assert.ok(project, "The canvas must open the selected project");
        await route.fulfill({ json: { project, ancestors: [], children: [] } });
      }
    });
    await page.route("**/api/workbench-activity", (route) => {
      const { projectId } = route.request().postDataJSON();
      const base = { version: 1, id: "project-introduction", projectId, branches: [], events: [] };
      const activity = projectId === legacy.id
        ? { ...base, branches: [{ id: "legacy-step", title: "历史动作分支", desc: "旧快照分支可以继续使用。" }] }
        : { ...base, initialBoard };
      return route.fulfill({ json: { activity } });
    });

    await page.evaluate(({ empty, edited, cleared, editedCard }) => {
      const setStored = (project, organization, memory) => {
        const keys = BoardMemory.boardStorageKeys("board-" + project.id);
        localStorage.setItem(keys.organization, JSON.stringify(organization));
        localStorage.setItem(keys.memory, JSON.stringify(memory));
      };
      const blank = { current: { title: "浏览过的空板", items: [] } };
      setStored(empty, blank, { notes: [] });
      setStored(edited, { current: { title: "用户已有的白板", items: [editedCard] } }, { notes: [] });
      setStored(cleared, { ...blank, previous: { title: "删除前的白板", items: [editedCard] } },
        { notes: [], deletedIds: [editedCard.id] });
    }, { empty, edited, cleared, editedCard });

    const openCanvas = async (project) => {
      const url = new URL("/", page.url());
      url.searchParams.set("board", "board-" + project.id);
      url.searchParams.set("project", project.id);
      url.searchParams.set("view", "canvas");
      await page.goto(url.href, { waitUntil: "networkidle" });
      assert.equal((await page.locator("#project-context-title").textContent()).trim(), project.name);
      await page.locator("#board-workspace").waitFor();
    };
    const card = (id) => page.locator("#board [data-element-id=\"" + id + "\"]");
    const savedOrganization = () => page.evaluate(() => JSON.parse(localStorage.getItem(BoardMemory.storageKeys.organization)));

    for (const project of [fresh, empty]) {
      await openCanvas(project);
      await card("E04").getByText("项目总览", { exact: true }).waitFor();
      await card("E05").getByText("运行流程", { exact: true }).waitFor();
      assert.equal(await card("E06").isVisible(), false, "The prepared child branch should start collapsed");

      const expectedItems = initialBoard.items.map(({ id, parentId, sources }) => [id, parentId, sources ?? []]);
      const persistedItems = async () => (await savedOrganization()).current.items
        .map(({ id, parentId, repositoryFiles }) => [id, parentId, repositoryFiles ?? []]);
      assert.deepEqual(await persistedItems(), expectedItems, "The saved introduction must retain hierarchy and project source paths");
      await card("E05").locator(".branch-toggle").click();
      await card("E06").getByText("处理上传", { exact: true }).waitFor();
      assert.match(await card("E06").locator(".organized-evidence").textContent(), /frontend\/src\/Upload\.ts/);
      await page.reload({ waitUntil: "networkidle" });
      await card("E06").waitFor();
      assert.deepEqual(await persistedItems(), expectedItems, "Reload must preserve folds and avoid inserting a second copy");
      await card("E06").locator(".organized-title").click();
      assert.deepEqual(JSON.parse(await page.locator("#payload").textContent()).anchor.repositoryFiles,
        initialBoard.items[2].sources, "Selecting the saved card must send project-relative references to the local CLI");
    }

    await openCanvas(edited);
    await card(editedCard.id).getByText(editedCard.title, { exact: true }).waitFor();
    assert.deepEqual((await savedOrganization()).current.items.map(({ id }) => id), [editedCard.id]);

    await openCanvas(cleared);
    assert.equal(await card("E04").count(), 0, "A project the user intentionally cleared must stay empty");
    assert.deepEqual((await savedOrganization()).current.items, []);

    await openCanvas(legacy);
    await page.locator("#board").getByText("历史动作分支", { exact: true }).waitFor();
    const legacyItems = (await savedOrganization()).current.items;
    assert.deepEqual(legacyItems.map(({ parentId, title }) => [parentId, title]),
      [[null, legacy.name], [legacyItems[0].id, "历史动作分支"]]);
    assertNoJsErrors(jsErrors);
    record("U64", "PASS", "Registered projects with a prepared introduction recover fresh and visited empty canvases, retain nesting and sources, and preserve saved boards and older activity snapshots.");
  } catch (error) { record("U64", "FAIL", safeError(error)); await screenshot("U64-failure", session.page); }
  finally { await closeSession(session); }
}

async function testRequirementAttachment() {
  const session = await openPage("normal", null);
  try {
    const { context, page, jsErrors } = session;
    const detail = { id: "E12", parentId: "E04", category: "reference",
      title: "检测与分类｜用户整理过的名称", summary: "现有的实现说明应保留。", folded: false,
      repositoryFiles: ["backend/predictor.rs"] };
    const sibling = { id: "E13", parentId: "E04", category: "reference",
      title: "与需求无关的卡片", summary: "这是同一张画布的另一条分支。", folded: false };
    const root = { id: "E04", parentId: null, category: "main", title: "原有识别项目", summary: "测试保留本机画布。" };
    const original = { current: { title: "用户原有画布", items: [root, detail, sibling], collapsedBranches: [] } };
    const documentText = "# REQ-REC-012\n\n现有检测与分类的可验证需求。\n";
    const attachment = { id: "d".repeat(32), name: "REQ-REC-012.md", size: Buffer.byteLength(documentText, "utf8") };
    const evidence = { id: "e".repeat(32), name: "同框 Resize 对照.png", size: 312 };
    const attachmentPath = "/api/attachments/" + attachment.id;
    const requirement = {
      cardId: detail.id,
      requirementId: "REQ-REC-012",
      title: "图中目标检测与候选分类",
      need: "用户可以查看各个图中目标的识别候选和对应区域。",
      method: "解码后根据手动画框、自动检测或整图确定分类区域。",
      methodDetails: [
        { title: "检测输入", description: "等比例缩放到 640，再补灰边。" },
        { title: "分类输入", description: "从原图裁剪，再等比缩放至 224 并补黑边。" },
      ],
      validation: [
        { id: "V-REC-012-01", title: "手动画框", condition: "只对用户框出的区域分类。" },
        { id: "V-REC-012-02", title: "无候选框", condition: "检查当前识别入口配置的整图回退。" },
      ],
    };
    await page.route("**/api/workbench-activity", (route) => {
      const { projectId } = route.request().postDataJSON();
      const activity = projectId === parentProject.id ? {
        version: 1, id: "project-requirements", projectId, branches: [], events: [],
        cardRequirements: [{ ...requirement, attachment, evidenceAttachments: [evidence] }],
      } : null;
      return route.fulfill({ json: { activity } });
    });
    await context.route("**" + attachmentPath, (route) => route.fulfill({
      contentType: "text/plain; charset=utf-8", body: documentText,
    }));
    await page.evaluate(({ projects, original }) => {
      for (const project of projects) {
        const keys = BoardMemory.boardStorageKeys("board-" + project.id);
        localStorage.setItem(keys.organization, JSON.stringify(original));
        localStorage.setItem(keys.memory, JSON.stringify({ notes: [], project: { goal: "保留原有项目目标" } }));
      }
    }, { projects: [parentProject, childProject], original });
    const openCanvas = async (project) => {
      const url = new URL("/", page.url());
      url.searchParams.set("board", "board-" + project.id);
      url.searchParams.set("project", project.id);
      url.searchParams.set("view", "canvas");
      await page.goto(url.href, { waitUntil: "networkidle" });
      assert.equal((await page.locator("#project-context-title").textContent()).trim(), project.name);
      await page.locator("#board").getByText(detail.title, { exact: true }).waitFor();
    };
    const card = page.locator('#board [data-element-id="E12"]');
    const panel = card.locator(".card-requirement");
    const link = card.getByRole("link", { name: attachment.name, exact: true });
    const savedBoard = () => page.evaluate(() => {
      const { organization, memory } = BoardMemory.storageKeys;
      return [localStorage.getItem(organization), localStorage.getItem(memory)];
    });

    await openCanvas(childProject);
    assert.equal(await panel.count(), 0, "Matching card IDs in another project must not receive the requirement");
    await openCanvas(parentProject);
    const saved = await savedBoard();
    await panel.getByText(requirement.requirementId, { exact: false }).waitFor();
    await panel.getByText(requirement.need, { exact: true }).waitFor();
    await panel.getByText(requirement.method, { exact: true }).waitFor();
    const detailedMethod = panel.getByText(requirement.methodDetails[0].description, { exact: true });
    assert.equal(await detailedMethod.isVisible(), false);
    await panel.locator("summary", { hasText: "实现细节" }).click();
    await detailedMethod.waitFor();
    await panel.locator("summary", { hasText: "实现细节" }).click();
    assert.equal(await panel.getByText(requirement.validation[0].condition, { exact: true }).isVisible(), false);
    await panel.locator("summary", { hasText: "验收场景" }).click();
    await panel.getByText(requirement.validation[0].condition, { exact: true }).waitFor();
    assert.equal(new URL(await link.getAttribute("href"), page.url()).pathname, attachmentPath);
    assert.equal(await card.getByRole("link", { name: evidence.name, exact: true }).getAttribute("href"), "/api/attachments/" + evidence.id);
    const [documentPage] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await documentPage.waitForURL((url) => url.pathname === attachmentPath);
    assert.equal((await documentPage.locator("body").innerText()).trim(), documentText.trim());
    await documentPage.close();

    await page.reload({ waitUntil: "networkidle" });
    await panel.waitFor();
    assert.equal(await panel.count(), 1);
    assert.equal(await link.count(), 1);
    assert.equal(await page.locator('#board [data-element-id="E13"] .card-requirement').count(), 0);
    assert.equal(await card.getByText(detail.title, { exact: true }).count(), 1);
    assert.equal(await page.locator('#board [data-element-id="E13"]').getByText(sibling.summary, { exact: true }).count(), 1);
    assert.deepEqual(await savedBoard(), saved, "Requirement rendering and reading must preserve existing user storage");
    assert.deepEqual(JSON.parse(saved[0]).current.items, original.current.items);

    const requests = [];
    const reply = "夹具回答：按验收条件核对识别路径。";
    await page.route("**/api/codex", (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const answer = request.scope === "plan" ? '{"action":"ask"}' : reply;
      return route.fulfill({ contentType: "application/x-ndjson",
        body: [{ type: "answer", text: answer }, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });
    await lassoTitle(page, detail.id);
    await page.locator("#question").fill("这项需求如何验收？");
    await page.locator("#submit-question").click();
    await page.locator("#board").getByText(reply, { exact: true }).waitFor();
    assert.deepEqual(requests.map(({ scope }) => scope), ["plan", undefined]);
    for (const request of requests) {
      assert.deepEqual(request.anchor.elementIds, [detail.id]);
      assert.equal(request.anchor.quote, detail.title);
      assert.equal(request.anchor.wholeCardIds, undefined);
      assert.deepEqual(request.anchor.repositoryFiles, detail.repositoryFiles);
      assert.deepEqual(request.project.requirements, [requirement]);
      assert.deepEqual(request.project.selectedCards?.map(({ id }) => id), [detail.id]);
      const [selectedCard] = request.project.selectedCards;
      assert.equal(selectedCard.summary, detail.summary);
      assert.deepEqual(selectedCard.path, [root, detail].map(({ id, title }) => ({ id, title })));
      assert.deepEqual(selectedCard.repositoryFiles, detail.repositoryFiles);
    }
    assert.deepEqual(requests.at(-1).attachments, [attachment, evidence]);
    assertNoJsErrors(jsErrors);
    record("U65", "PASS", "Linked requirements and attachments persist across reload. A title lasso sends the exact quote, card context, and project-relative source references with the scoped question.");
  } catch (error) { record("U65", "FAIL", safeError(error)); await screenshot("U65-failure", session.page); }
  finally { await closeSession(session); }
}

async function testExpandCardWithFocus() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const target = { id: "E72", parentId: "E71", category: "reference",
      title: "上传校验", summary: "上传前检查附件，失败时提示用户。", folded: false,
      followupQuestion: "旧版保存的问题，不应填入方向输入框。" };
    const existing = { id: "E73", parentId: target.id, category: "reference",
      title: "文件类型", summary: "按允许的 MIME 类型检查。", folded: false };
    const items = [
      { id: "E70", parentId: null, category: "main", title: "附件项目", summary: "可附加文件。" },
      { id: "E71", parentId: "E70", category: "reference", title: "上传规则", summary: "校验失败时保留已选文件。" },
      target,
      existing,
    ];
    await page.evaluate((items) => {
      const { organization, memory } = BoardMemory.storageKeys;
      localStorage.setItem(organization, JSON.stringify({ current: {
        title: "附件使用说明", items, collapsedBranches: [],
      } }));
      localStorage.setItem(memory, JSON.stringify({ notes: [], pinnedIds: ["E71"] }));
    }, items);
    await page.reload({ waitUntil: "networkidle" });
    await chooseApi(page);
    assert.ok(await card("E71").evaluate((element) => element.classList.contains("board-pinned")));

    const focus = "测试文件大小边界时，哪三个输入能覆盖阈值判断？";
    const children = [
      { title: "大小拦截", summary: "读取文件字节数，超过阈值就停止上传。" },
      { title: "超限后重试", summary: "用较小的文件替换超限附件，再提交。" },
    ];
    const grandchildren = [
      { title: "小于和等于阈值", summary: "分别用阈值减一字节和等于阈值的文件验证允许提交。" },
      { title: "超过阈值一字节", summary: "预期阻止发送请求并告知上限。" },
    ];
    const splitSections = [
      { title: "核对允许的文件类型", text: "用允许列表判断附件的类型。" },
      { title: "提示不支持的类型", text: "拒绝附件并保留用户输入。" },
    ];
    const treeSections = [
      { title: "附件校验路径", text: "先检查类型，再检查文件大小。", parentIndex: null },
      { title: "验收边界输入", text: "用边界值检查文件大小提示。", parentIndex: 0 },
    ];
    const requests = [];
    await page.route("**/api/codex", async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const result = request.scope === "explain"
        ? { type: "explanation", explanation: { summary: "按上传规则拆分验证步骤。",
          sections: request.minimumDepth === 2 ? treeSections : splitSections } }
        : { type: "children", children: request.project.expansion.targetId === target.id ? children : grandchildren };
      await route.fulfill({ contentType: "application/x-ndjson; charset=utf-8",
        body: [result, { type: "done" }].map((event) => JSON.stringify(event)).join("\n") + "\n" });
    });

    const expand = page.locator("#expand-card-open");
    const form = page.locator("#expand-card-form");
    const input = page.locator("#expand-card-focus");
    const confirm = page.locator("#expand-card-submit");
    assert.equal(await expand.isVisible(), false);
    await card(target.id).locator(".organized-title").click();
    assert.match(await expand.innerText(), /拆分节点/);
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    await expand.click();
    await form.waitFor();
    assert.equal(await expand.getAttribute("aria-expanded"), "true");
    assert.equal(await input.inputValue(), "", "An older saved recommendation should not fill the form");
    assert.equal(requests.length, 0, "Opening the form should not call a model");
    assert.equal(await confirm.innerText(), "生成下级");
    await confirm.click();

    const expectChildren = async (parentId, expected) => {
      for (const { title } of expected) {
        await page.locator("#board").getByText(title, { exact: true }).waitFor();
      }
      const saved = await page.evaluate(() =>
        JSON.parse(localStorage.getItem(BoardMemory.storageKeys.organization)).current.items);
      const direct = saved.filter((item) => item.parentId === parentId);
      assert.deepEqual(direct.map(({ title, summary }) => ({ title, summary })),
        expected.map(({ title, summary }) => ({ title, summary })));
      assert.ok(direct.every((item) => !Object.hasOwn(item, "followupQuestion")));
      for (const item of direct) {
        await connectionPath(page, parentId, item.id).waitFor({ state: "attached" });
      }
      return direct;
    };
    await expectChildren(target.id, [existing, ...children]);
    assert.equal(requests.length, 1, "Confirming a blank field should send one scoped expansion request");
    const [request] = requests;
    assert.equal(request.backend, "api");
    assert.equal(request.scope, "expandCard");
    assert.equal(request.mode, "ask");
    assert.equal(request.question, "");
    assert.deepEqual(request.anchor.elementIds, [target.id]);
    const expansion = request.project.expansion;
    assert.equal(expansion.targetId, target.id);
    assert.deepEqual(expansion.path.map(({ id, parentId }) => [id, parentId]),
      [["E70", null], ["E71", "E70"], [target.id, target.parentId]]);
    assert.deepEqual(expansion.pinned.map(({ id }) => id), ["E71"]);
    assert.deepEqual(expansion.children.map(({ id, parentId, title }) => [id, parentId, title]),
      [[existing.id, target.id, existing.title]]);
    await page.reload({ waitUntil: "networkidle" });
    const [, generated] = await expectChildren(target.id, [existing, ...children]);
    assert.equal(requests.length, 1, "Reload should restore saved children without a new request");
    await chooseApi(page);
    await card(generated.id).locator(".organized-title").click();
    await expand.click();
    assert.equal(await input.inputValue(), "", "A generated child should also start with a blank field");
    await input.fill(focus);
    assert.equal(requests.length, 1, "Typing a focus should not call a model");
    await confirm.click();
    await expectChildren(generated.id, grandchildren);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].scope, "expandCard");
    assert.equal(requests[1].question, focus);
    assert.deepEqual(requests[1].anchor.elementIds, [generated.id]);
    assert.deepEqual(requests[1].project.expansion.path.slice(-2).map(({ id }) => id), [target.id, generated.id]);

    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    await page.locator("#fit").click();
    await card(generated.id).press("Enter");
    await card(existing.id).locator(".organized-title").click({ button: "right" });
    await page.locator("#canvas-menu-split").click();
    await form.waitFor();
    assert.equal(await card(existing.id).getAttribute("aria-pressed"), "true", "The context menu should retarget the chosen card");
    assert.equal(requests.length, 2, "Opening split options from the context menu should not call a model");
    await page.locator("#expand-card-split").click();
    await page.getByText(splitSections[0].title, { exact: true }).waitFor();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].scope, "explain");
    assert.equal(requests[2].minimumDepth, undefined);
    assert.deepEqual(requests[2].anchor.elementIds, [existing.id]);

    await page.locator("#stop-ai").waitFor({ state: "hidden" });
    await card(target.id).press("Enter");
    await expand.click();
    assert.equal(requests.length, 3);
    await page.locator("#expand-card-split-tree").click();
    await page.getByText(treeSections[0].title, { exact: true }).waitFor();
    assert.equal(requests.length, 4);
    assert.equal(requests[3].scope, "explain");
    assert.equal(requests[3].minimumDepth, 2);
    assert.deepEqual(requests[3].anchor.elementIds, [target.id]);
    assertNoJsErrors(jsErrors);
    record("U66", "PASS", "The visible card action and context menu open the same split form locally. Guided expansion persists two levels, and direct and multi-level splits call the model once on the chosen card.");
  } catch (error) { record("U66", "FAIL", safeError(error)); await screenshot("U66-failure", session.page); }
  finally { await closeSession(session); }
}

async function testQuestionCardNavigation() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const position = page.locator("#card-search-position");
    const viewport = page.locator("#viewport");
    const centered = async (id) => {
      const view = await viewport.boundingBox();
      const item = await card(id).boundingBox();
      assert.ok(view && item);
      assert.ok(Math.abs(view.x + view.width / 2 - item.x - item.width / 2) < 5);
      assert.ok(Math.abs(view.y + view.height / 2 - item.y - item.height / 2) < 5);
    };
    const requests = [];
    await page.route("**/api/card-search", async (route) => {
      const request = route.request().postDataJSON();
      if (!request.query) {
        await route.fulfill({ json: { matches: [], mode: "indexing" } });
        return;
      }
      requests.push(request);
      await route.fulfill({ json: { matches: ["E27", "E07"], mode: "semantic" } });
    });

    assert.equal(await card("E27").isVisible(), false);
    const query = "模型的回答怎样分段更新到页面？";
    await page.locator("#card-search-toggle").click();
    await page.locator("#card-search-input").fill(query);
    await page.locator("#card-search-question").click();
    await position.waitFor();
    assert.equal(await position.textContent(), "1 / 2");
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0]).sort(), ["cards", "query"]);
    assert.equal(requests[0].query, query);
    const eventStream = requests[0].cards.find(({ id }) => id === "E27");
    assert.ok(eventStream);
    assert.match(eventStream.summary, /NDJSON/);
    assert.ok(eventStream.path);
    assert.equal(await card("E27").getAttribute("aria-pressed"), "true");
    await centered("E27");

    await page.keyboard.press("ArrowDown");
    assert.equal(await position.textContent(), "2 / 2");
    assert.equal(await card("E07").getAttribute("aria-pressed"), "true");
    await centered("E07");
    await page.locator("#card-search-prev").click();
    assert.equal(await position.textContent(), "1 / 2");
    assert.equal(await requests.length, 1);

    await page.locator("#return-overview").click();
    assert.equal(await card("E27").isVisible(), false);
    assert.equal(await page.locator("#card-search-nav").isVisible(), false);
    assertNoJsErrors(jsErrors);
    record("U67", "PASS", "The local question search receives only the query and current-board cards, reveals the first folded match centered, navigates by rank with buttons and arrows, and returns to the original folds.");
  } catch (error) { record("U67", "FAIL", safeError(error)); await screenshot("U67-failure", session.page); }
  finally { await closeSession(session); }
}

async function testFullBoardQuestionSearch() {
  const session = await openPage("normal", "repo-manual");
  let finishIndex;
  const indexReady = new Promise((resolveIndex) => { finishIndex = resolveIndex; });
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const viewport = page.locator("#viewport");
    const position = page.locator("#card-search-position");
    const query = "识别特大原图入口如何收敛像素？";
    const branch = { id: "E801", parentId: "E800", category: "main", title: "图像缩放路径" };
    const target = { id: "E802", parentId: branch.id, category: "reference", title: "长边约束",
      summary: "大图片等比缩小再送入检测器，保持宽高比例。" };
    const second = { id: "E803", parentId: branch.id, category: "reference", title: "补边尺寸",
      summary: "分类网络读取正方形画面，等比缩放后补边。" };
    const archive = { id: "E807", parentId: null, category: "archive", title: "归档设置" };
    const items = [
      { id: "E800", parentId: null, category: "main", title: "本地识别链路" },
      branch,
      { id: "E804", parentId: branch.id, category: "reference", title: "配置目录" },
      target,
      second,
      { id: "E805", parentId: "E800", category: "main", title: "旧讨论" },
      archive,
      // Distractors fill the former keyword shortlist and leave the hidden target between its sampled cards.
      ...Array.from({ length: 120 }, (_, index) => ({
        id: `E${900 + index}`, parentId: "E805", category: "reference",
        title: index < 48 ? `旧讨论 ${index} ${query}` : `配置备忘 ${index}`,
      })),
    ];
    await page.evaluate(({ items, branchId }) => {
      const key = BoardMemory.storageKeys.organization;
      const saved = JSON.parse(localStorage.getItem(key));
      saved.current = { title: "识别项目白板", items, collapsedBranches: [branchId, "E805"] };
      localStorage.setItem(key, JSON.stringify(saved));
    }, { items, branchId: branch.id });
    await page.reload({ waitUntil: "networkidle" });

    const warmRequests = [];
    const searches = [];
    await page.route("**/api/card-search", async (route) => {
      const request = route.request().postDataJSON();
      if (request.query === "") {
        warmRequests.push(request);
        await route.fulfill({ json: { matches: [], mode: "indexing" } });
      } else {
        searches.push(request);
        if (searches.length === 1) {
          await route.fulfill({ json: { matches: [], mode: "indexing" } });
        } else {
          await indexReady;
          const ids = new Set(request.cards.map(({ id }) => id));
          await route.fulfill({ json: { matches: [target.id, second.id].filter((id) => ids.has(id)), mode: "semantic" } });
        }
      }
    });

    assert.equal(await card(target.id).isVisible(), false);
    const warmResponse = page.waitForResponse((response) => response.url().endsWith("/api/card-search") &&
      response.request().postDataJSON().query === "");
    await page.locator("#card-search-toggle").click();
    await warmResponse;
    assert.equal(warmRequests.length, 1);
    await page.locator("#card-search-input").fill(query);
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/card-search") &&
      response.request().postDataJSON().query === query);
    await page.locator("#card-search-question").click();
    assert.equal((await (await firstResponse).json()).mode, "indexing");
    assert.equal(await position.isVisible(), false, "The camera should wait for the full index");
    assert.equal(await card(target.id).isVisible(), false);
    const expectedIds = items.filter(({ category }) => category !== "archive").map(({ id }) => id);
    for (const request of [warmRequests[0], searches[0]]) {
      assert.deepEqual(Object.keys(request).sort(), ["cards", "query"]);
      const ids = new Set(request.cards.map(({ id }) => id));
      assert.equal(ids.size, request.cards.length, "The index should receive each card only once");
      assert.ok(expectedIds.every((id) => ids.has(id)), "Every active fixture card should reach the local model");
      assert.equal(ids.has(archive.id), false);
      assert.equal(request.cards.find(({ id }) => id === target.id).summary, target.summary);
    }

    finishIndex();
    await position.waitFor();
    assert.equal(await position.textContent(), "1 / 2");
    assert.equal(await card(target.id).getAttribute("aria-pressed"), "true");
    const view = await viewport.boundingBox();
    const item = await card(target.id).boundingBox();
    assert.ok(view && item);
    assert.ok(Math.abs(view.x + view.width / 2 - item.x - item.width / 2) < 5);
    assert.ok(Math.abs(view.y + view.height / 2 - item.y - item.height / 2) < 5);

    await page.keyboard.press("ArrowDown");
    assert.equal(await position.textContent(), "2 / 2");
    assert.equal(await card(second.id).getAttribute("aria-pressed"), "true");
    await page.keyboard.press("ArrowUp");
    assert.equal(await position.textContent(), "1 / 2");
    assert.equal(await card(target.id).getAttribute("aria-pressed"), "true");
    assert.equal(searches.length, 2, "Viewing another ranked result should not search again");
    assert.equal(warmRequests.length, 1, "Viewing another ranked result should not warm again");

    await page.locator("#return-overview").click();
    assert.equal(await card(target.id).isVisible(), false);
    assertNoJsErrors(jsErrors);
    record("U68", "PASS", "The local model receives all active cards on a long board, finishes indexing before positioning a hidden semantic match, and keeps rank navigation local.");
  } catch (error) { record("U68", "FAIL", safeError(error)); await screenshot("U68-failure", session.page); }
  finally { finishIndex(); await closeSession(session); }
}

async function testAdaptiveReorder() {
  const session = await openPage("normal", "repo-manual");
  try {
    const { page, jsErrors } = session;
    const card = (id) => page.locator(`#board [data-element-id="${id}"]`);
    const readState = () => page.evaluate(() => JSON.parse(localStorage.getItem(window.BoardMemory.storageKeys.organization)));
    const modelRequests = telemetry.requests.length;
    const items = [
      ["E04", null, 4], ["E05", "E04", 4], ["E09", "E04", 6], ["E14", "E04", 4], ["E19", "E04", 4], ["E24", "E04", 5],
      ["E10", "E09", 6], ["E11", "E09", 7], ["E12", "E09", 10], ["E13", "E09", 6],
      ...Array.from({ length: 7 }, (_, i) => [`E${29 + i}`, "E12", 5 + i % 3]), ["E36", "E05", 2],
    ].map(([id, parentId, length]) => ({ id, parentId, category: "main", title: `测试卡片 ${id}`,
      summary: "验证卡片正文使用不同长度，检查分支的空间和连线。".repeat(length) }));
    await page.evaluate((items) => {
      const { memory, organization } = window.BoardMemory.storageKeys;
      const saved = JSON.parse(localStorage.getItem(organization));
      saved.quickMode = "balanced";
      saved.branchQuickModes = {};
      Object.assign(saved.current, { items, collapsedBranches: ["E05"], positions: { E36: { x: 10000, y: -10000 } } });
      localStorage.setItem(organization, JSON.stringify(saved));
      const board = JSON.parse(localStorage.getItem(memory));
      board.pinnedIds = [];
      localStorage.setItem(memory, JSON.stringify(board));
    }, items);
    await page.reload();
    await card("E35").waitFor();
    const initial = await readState();
    const original = await visibleCardRects(page);
    assert.equal(Object.keys(original).length, 17);
    const zoom = async () => Number.parseInt(await page.locator("#zoom-value").textContent(), 10);
    await page.locator("#fit").click();
    const originalZoom = await zoom();
    const adaptiveAction = page.locator("#adaptive-reorder");
    await adaptiveAction.click();
    const arranged = await visibleCardRects(page);
    const newZoom = await zoom();
    assert.equal((await readState()).quickMode, "adaptive");
    assert.deepEqual((await readState()).current.items, initial.current.items);
    assert.deepEqual((await readState()).current.collapsedBranches, ["E05"]);
    assert.ok(newZoom > originalZoom, "Fitting the rearranged board should increase visual zoom");
    const { width, height } = await page.locator("#viewport").evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
    const visible = Object.values(arranged);
    const spanX = Math.max(...visible.map(({ x, width }) => x + width)) - Math.min(...visible.map(({ x }) => x));
    const spanY = Math.max(...visible.map(({ y, height }) => y + height)) - Math.min(...visible.map(({ y }) => y));
    const fit = Math.max(0.15, Math.min(1.15, (width - 48) / spanX, (height - 48) / spanY));
    assert.equal(newZoom, Math.round(fit * 100), "Camera fit should use visible card bounds");
    for (const [index, rect] of visible.entries()) {
      assert.ok(visible.slice(index + 1).every((other) => cardGap(rect, other) > 0), "Adaptive cards should not overlap");
    }
    const expected = items.filter(({ id, parentId }) => arranged[id] && arranged[parentId]).map(({ id, parentId }) => `${parentId}>${id}`).sort();
    const edges = await page.locator("#connections > path[data-parent-id][data-child-id]").evaluateAll((paths, cards) =>
      paths.map((path) => {
        const { parentId, childId } = path.dataset;
        const length = path.getTotalLength();
        let crossed = null;
        const obstacles = Object.entries(cards).filter(([id]) => id !== parentId && id !== childId);
        for (let distance = 2; distance < length && !crossed; distance += 3) {
          const { x, y } = path.getPointAtLength(distance);
          crossed = obstacles.find(([, rect]) => x > rect.x + 2 && x < rect.x + rect.width - 2 &&
            y > rect.y + 2 && y < rect.y + rect.height - 2)?.[0] || null;
        }
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(length);
        return { parentId, childId, crossed, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y },
          rounded: /Q/.test(path.getAttribute("d")), bundled: path.classList.contains("connection-bundled") };
      }), arranged);
    assert.deepEqual(edges.map(({ parentId, childId }) => `${parentId}>${childId}`).sort(), expected);
    for (const { parentId, childId, start, end, crossed } of edges) {
      assert.equal(crossed, null, `Adaptive path ${parentId} → ${childId} crosses ${crossed}`);
      assertCardOnEdge(start, arranged[parentId], "Adaptive path starts on its recorded parent");
      assertCardOnEdge(end, arranged[childId], "Adaptive path ends on its recorded child");
    }
    const rounded = edges.find((edge) => edge.rounded && !edge.bundled);
    assert.ok(rounded, "An individual orthogonal route should have a rounded bend");
    const roundedLine = connectionPath(page, rounded.parentId, rounded.childId);
    const readLine = () => roundedLine.evaluate((path) => {
      const style = getComputedStyle(path);
      return { shape: path.getAttribute("d"), related: path.classList.contains("connection-related"),
        weight: parseFloat(style.strokeWidth) * Number(style.strokeOpacity) * Number(style.opacity) };
    });
    const resting = await readLine();
    assert.ok(resting.weight > 0 && !resting.related, "A resting edge should remain visible without focus");
    await card(rounded.childId).press("Enter");
    const focused = await readLine();
    assert.ok(focused.related && focused.weight > resting.weight, "Focusing a card should emphasize its quieter edge");
    assert.equal(focused.shape, resting.shape, "Focusing a card should preserve its route");
    await clearCardSelection(page);
    assert.deepEqual(await readLine(), resting, "Clearing the card selection should restore the edge style");

    const editable = edges.find((edge) => edge.bundled) || rounded;
    const editableLine = connectionPath(page, editable.parentId, editable.childId);
    const hit = page.locator(`.connection-hit[data-edge-parent="${editable.parentId}"][data-edge-child="${editable.childId}"]`);
    const visibleShape = await editableLine.getAttribute("d");
    const hitShape = await hit.getAttribute("d");
    assert.ok(hitShape);
    if (editable.bundled) assert.notEqual(hitShape, visibleShape, "A bundled edge should expose only its own tail for editing");
    await page.locator("#connect-mode").click();
    await selectConnection(page, editable.parentId, editable.childId);
    assert.equal(await editableLine.evaluate((path) => path.classList.contains("connection-selected")), true);
    assert.equal(await page.locator("#delete-connection").isEnabled(), true);
    await hit.press("Escape");
    assert.equal(await page.locator("#delete-connection").isEnabled(), false);
    assert.equal(await editableLine.getAttribute("d"), visibleShape);
    assert.equal(await hit.getAttribute("d"), hitShape);
    await page.locator("#select-mode").click();
    await page.reload();
    await card("E35").waitFor();
    assert.deepEqual(await visibleCardRects(page), arranged);
    await page.locator("#undo-organization").click();
    assert.deepEqual(await visibleCardRects(page), original);

    await page.locator("#pin-mode").click();
    await card("E35").press("Enter");
    const beforeScope = await visibleCardRects(page);
    await card("E12").press("Enter");
    await adaptiveAction.click();
    const scoped = await visibleCardRects(page);
    const scopedState = await readState();
    assert.equal(scopedState.quickMode, "balanced");
    assert.equal(scopedState.branchQuickModes?.E12, "adaptive");
    assert.deepEqual(scopedState.current.items, initial.current.items);
    assert.notDeepEqual(scoped.E29, beforeScope.E29, "Scoped adaptive layout should move a descendant");
    for (const [id, rect] of Object.entries(beforeScope).filter(([id]) => id === "E35" || items.find((item) => item.id === id).parentId !== "E12")) {
      assert.deepEqual(scoped[id], rect, `Scoped adaptive layout moved fixed card ${id}`);
    }
    await page.reload();
    await card("E35").waitFor();
    assert.deepEqual(await visibleCardRects(page), scoped);
    await page.locator("#undo-organization").click();
    assert.deepEqual(await visibleCardRects(page), beforeScope);
    assert.equal(telemetry.requests.length, modelRequests, "Adaptive reorder is local");
    assertNoJsErrors(jsErrors);
    record("U69", "PASS", "Adaptive reorder fits visible cards, preserves rounded parent paths and reversible edge selection, fits a selected subtree around fixed cards, and supports reload and undo.", { originalZoom, newZoom });
  } catch (error) { record("U69", "FAIL", safeError(error)); await screenshot("U69-failure", session.page); }
  finally { await closeSession(session); }
}

try {
  if (!existsSync(EDGE)) throw new Error(`BLOCKED: installed msedge channel not found at ${EDGE}`);
  server = createServer((req, res) => { relay(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  port = server.address().port;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const selected = new Set((process.env.BROWSER_CASES || "U01,U02,U05-A,U04-A,U04-B,U03,U06,U07,U08,U09-A,U09-B,U10,U11,U12,U13,U14,U15,U16,U17,U18,U19,U20,U21,U22,U23,U24,U25,U26,U27,U28,U29,U30,U31,U32,U33,U34,U35,U36,U37,U38,U39,U40,U41,U42,U43,U44,U45,U46,U47,U48,U49,U50,U51,U52,U53,U54,U55,U56,U57,U58,U59,U60,U61,U62,U63,U64,U65,U66,U67,U68,U69").split(","));
  if (selected.has("U01")) { console.log("BROWSER_CASE=U01"); await testCapabilities(); }
  if (selected.has("U02")) { console.log("BROWSER_CASE=U02"); await testKeyEphemeral(); }
  if (selected.has("U05-A")) { console.log("BROWSER_CASE=U05-A"); await testStopLateEvents(); }
  if (selected.has("U04-A")) { console.log("BROWSER_CASE=U04-A"); await testSamePageStale(); }
  if (selected.has("U04-B")) { console.log("BROWSER_CASE=U04-B"); await testCrossPageStale(); }
  if (selected.has("U03")) { console.log("BROWSER_CASE=U03"); await testUndo(); }
  if (selected.has("U06")) { console.log("BROWSER_CASE=U06"); await testBranchCollapse(); }
  if (selected.has("U07")) { console.log("BROWSER_CASE=U07"); await testProjectTemplate(); }
  if (selected.has("U08")) { console.log("BROWSER_CASE=U08"); await testDecomposition(); }
  if (selected.has("U09-A")) { console.log("BROWSER_CASE=U09-A"); await testUncommittedDecomposition("U09-A", "decompose-incomplete"); }
  if (selected.has("U09-B")) { console.log("BROWSER_CASE=U09-B"); await testUncommittedDecomposition("U09-B", "decompose-stale"); }
  if (selected.has("U10")) { console.log("BROWSER_CASE=U10"); await testRawBoardDecomposition(); }
  if (selected.has("U11")) { console.log("BROWSER_CASE=U11"); await testPublishedGuide(); }
  if (selected.has("U12")) { console.log("BROWSER_CASE=U12"); await testRebuiltProjectGuide(); }
  if (selected.has("U13")) { console.log("BROWSER_CASE=U13"); await testBoardSwitcher(); }
  if (selected.has("U14")) { console.log("BROWSER_CASE=U14"); await testNestedGuideConnections(); }
  if (selected.has("U15")) { console.log("BROWSER_CASE=U15"); await testRepositoryIndex(); }
  if (selected.has("U16")) { console.log("BROWSER_CASE=U16"); await testLassoAnswer(); }
  if (selected.has("U17")) { console.log("BROWSER_CASE=U17"); await testLassoAnswerRetry(); }
  if (selected.has("U18")) { console.log("BROWSER_CASE=U18"); await testGuideReadingLayout(); }
  if (selected.has("U19")) { console.log("BROWSER_CASE=U19"); await testSentQuestionDelivery(); }
  if (selected.has("U20")) { console.log("BROWSER_CASE=U20"); await testPendingQuestionReload(); }
  if (selected.has("U21")) { console.log("BROWSER_CASE=U21"); await testFoldedChapterExtension(); }
  if (selected.has("U22")) { console.log("BROWSER_CASE=U22"); await testNoteAfterOtherChapterDecomposition(); }
  if (selected.has("U23")) { console.log("BROWSER_CASE=U23"); await testQuestionDuringPlanning(); }
  if (selected.has("U24")) { console.log("BROWSER_CASE=U24"); await testAnswerBesideMovedCard(); }
  if (selected.has("U25")) { console.log("BROWSER_CASE=U25"); await testQuickReorderMovedBranches(); }
  if (selected.has("U26")) { console.log("BROWSER_CASE=U26"); await testStructuredExplanation(); }
  if (selected.has("U27")) { console.log("BROWSER_CASE=U27"); await testSplitExistingAnswer(); }
  if (selected.has("U28")) { console.log("BROWSER_CASE=U28"); await testOrganizeSelectedBranch(); }
  if (selected.has("U29")) { console.log("BROWSER_CASE=U29"); await testOrganizeExplanationBranch(); }
  if (selected.has("U30")) { console.log("BROWSER_CASE=U30"); await testManualConnections(); }
  if (selected.has("U31")) { console.log("BROWSER_CASE=U31"); await testRawManualConnections(); }
  if (selected.has("U32")) { console.log("BROWSER_CASE=U32"); await testDirectionalConnectionDrag(); }
  if (selected.has("U33")) { console.log("BROWSER_CASE=U33"); await testQuickReorderPresets(); }
  if (selected.has("U34")) { console.log("BROWSER_CASE=U34"); await testSelectedBranchQuickReorder(); }
  if (selected.has("U35")) { console.log("BROWSER_CASE=U35"); await testAnswerSectionsQuickReorder(); }
  if (selected.has("U36")) { console.log("BROWSER_CASE=U36"); await testRepoManualDetailsMigration(); }
  if (selected.has("U37")) { console.log("BROWSER_CASE=U37"); await testMoveSelectedCards(); }
  if (selected.has("U38")) { console.log("BROWSER_CASE=U38"); await testRegenerateSelectedBranch(); }
  if (selected.has("U39")) { console.log("BROWSER_CASE=U39"); await testProjectWorkbench(); }
  if (selected.has("U40")) { console.log("BROWSER_CASE=U40"); await testQuickReorderParentPaths(); }
  if (selected.has("U41")) { console.log("BROWSER_CASE=U41"); await testQuickReorderUnevenBranches(); }
  if (selected.has("U42")) { console.log("BROWSER_CASE=U42"); await testExpandMovedBranch(); }
  if (selected.has("U43")) { console.log("BROWSER_CASE=U43"); await testCreateManualCard(); }
  if (selected.has("U44")) { console.log("BROWSER_CASE=U44"); await testCanvasContextMenu(); }
  if (selected.has("U45")) { console.log("BROWSER_CASE=U45"); await testCanvasContextModesAndDeletion(); }
  if (selected.has("U46")) { console.log("BROWSER_CASE=U46"); await testIndependentQuestionAndOrphanFiling(); }
  if (selected.has("U47")) { console.log("BROWSER_CASE=U47"); await testDraftBranchWorkflow(); }
  if (selected.has("U48")) { console.log("BROWSER_CASE=U48"); await testStructuredAnswerInSourceBranch(); }
  if (selected.has("U49")) { console.log("BROWSER_CASE=U49"); await testReparentAnswerOwnership(); }
  if (selected.has("U50")) { console.log("BROWSER_CASE=U50"); await testBoardLifecycle(); }
  if (selected.has("U51")) { console.log("BROWSER_CASE=U51"); await testLastBoardLifecycle(); }
  if (selected.has("U52")) { console.log("BROWSER_CASE=U52"); await testCompactSidebar(); }
  if (selected.has("U53")) { console.log("BROWSER_CASE=U53"); await testLassoSelectionMove(); }
  if (selected.has("U54")) { console.log("BROWSER_CASE=U54"); await testFoldedCardSearchAndContext(); }
  if (selected.has("U55")) { console.log("BROWSER_CASE=U55"); await testBoardRepositoryBinding(); }
  if (selected.has("U56")) { console.log("BROWSER_CASE=U56"); await testRepositoryInitialization(); }
  if (selected.has("U57")) { console.log("BROWSER_CASE=U57"); await testExecutionTrace(); }
  if (selected.has("U58")) { console.log("BROWSER_CASE=U58"); await testDeleteWithoutWaitingForAnswer(); }
  if (selected.has("U59")) { console.log("BROWSER_CASE=U59"); await testGeneratedExplanationHierarchy(); }
  if (selected.has("U60")) { console.log("BROWSER_CASE=U60"); await testGeneratedTaskHierarchy(); }
  if (selected.has("U61")) { console.log("BROWSER_CASE=U61"); await testCanvasNavigation(); }
  if (selected.has("U62")) { console.log("BROWSER_CASE=U62"); await testProjectHomeWorkflow(); }
  if (selected.has("U63")) { console.log("BROWSER_CASE=U63"); await testLinkedProjectBoards(); }
  if (selected.has("U64")) { console.log("BROWSER_CASE=U64"); await testRegisteredProjectIntroduction(); }
  if (selected.has("U65")) { console.log("BROWSER_CASE=U65"); await testRequirementAttachment(); }
  if (selected.has("U66")) { console.log("BROWSER_CASE=U66"); await testExpandCardWithFocus(); }
  if (selected.has("U67")) { console.log("BROWSER_CASE=U67"); await testQuestionCardNavigation(); }
  if (selected.has("U68")) { console.log("BROWSER_CASE=U68"); await testFullBoardQuestionSearch(); }
  if (selected.has("U69")) { console.log("BROWSER_CASE=U69"); await testAdaptiveReorder(); }
} catch (error) {
  record("HARNESS", String(error?.message || "").startsWith("BLOCKED:") ? "BLOCKED" : "FAIL", safeError(error));
} finally {
  if (browser) { await browser.close(); cleanup.browserClosed = true; }
  if (server) { await new Promise((resolveClose) => server.close(() => resolveClose())); cleanup.serverClosed = true; }
  const counts = await writeReports();
  if (counts.FAIL || counts.BLOCKED) process.exitCode = 1;
}
