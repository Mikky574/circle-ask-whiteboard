/* Isolated acceptance against the real server and a temporary SQLite database.
 * Run with `node test_shared_boards_browser.mjs`. No provider calls are allowed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "whiteboard-shared-browser-"));
const repository = join(temporary, "example-project");
await mkdir(repository);
await writeFile(join(repository, "README.md"), "# Isolated shared-board test project\n");
const database = join(temporary, "boards.sqlite3");
const projectFile = join(temporary, "projects.json");
await writeFile(projectFile, "[]");
const contexts = [];
const errors = [];
const observations = [];
let service;
let browser;
let origin;

function passed(message) {
  observations.push(message);
  console.log(`PASS ${message}`);
}

async function eventually(check, message, milliseconds = 12000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { return await check(); } catch (error) { last = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 80));
  }
  throw new Error(`${message}: ${last?.message || "timed out"}`);
}

async function startService() {
  const code = [
    "import server",
    "from http.server import ThreadingHTTPServer",
    "httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.WhiteboardHandler)",
    "server.PORT = httpd.server_port",
    "server.ALLOWED_HOSTS = {'127.0.0.1:' + str(httpd.server_port), 'localhost:' + str(httpd.server_port)}",
    "print('SHARED_TEST_PORT=' + str(httpd.server_port), flush=True)",
    "httpd.serve_forever()",
  ].join("\n");
  const child = spawn(process.env.PYTHON || "python", ["-B", "-u", "-c", code], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, WHITEBOARD_BOARDS_FILE: database, WHITEBOARD_PROJECTS_FILE: projectFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test server did not start. ${logs}`)), 20000);
    child.stdout.on("data", data => {
      logs += data.toString();
      const match = logs.match(/SHARED_TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
    child.stderr.on("data", data => { logs = (logs + data.toString()).slice(-7000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}. ${logs}`)); });
  });
  service = child;
  origin = `http://127.0.0.1:${port}`;
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  const child = service;
  service = null;
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  child.kill();
  await exited;
}

async function store(action, fields = {}, expectedStatus = 200) {
  const response = await fetch(`${origin}/api/board-store`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ action, ...fields }),
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(result));
  return result;
}

async function openContext(base = origin, seed) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  contexts.push(context);
  if (seed) await context.addInitScript(entries => {
    if (sessionStorage.getItem("shared-test-seeded")) return;
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    sessionStorage.setItem("shared-test-seeded", "yes");
  }, seed);
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (![new URL(base).origin, origin].includes(url.origin)) return route.abort();
    if (request.resourceType() === "document" && url.pathname === "/") {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace(" data-reading-only", "") });
    }
    if (url.pathname === "/api/status") return route.fulfill({
      contentType: "application/json", body: JSON.stringify({ available: true, busy: false,
        backends: [{ id: "codex", available: true, installed: true }] }),
    });
    if (request.method() !== "GET" && !["/api/board-store", "/api/repository", "/api/local-projects", "/api/workbench-activity"].includes(url.pathname)) {
      return route.fulfill({ status: 418, contentType: "application/json", body: '{"text":"No model/provider calls in isolated acceptance"}' });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => {
    const restoring = dialog.type() === "confirm" && /^把 v\d+ 恢复为一个新版本/.test(dialog.message());
    return dialog.type() === "beforeunload" || restoring ? dialog.accept() : dialog.dismiss();
  });
  return { context, page, base };
}

async function ready(page) {
  await page.waitForFunction(() => Boolean(window.BoardMemory && window.BoardOrganization));
  assert.equal(await page.evaluate(() => Boolean(window.BoardSync)), true, "Shared-board synchronization script must load");
}

async function openBoard(client, id) {
  await client.page.goto(`${client.base}/?board=${id}`, { waitUntil: "networkidle" });
  await ready(client.page);
  assert.equal(await client.page.evaluate(() => window.BoardMemory.activeBoard), id);
}

async function createCard(page, title, body) {
  await page.locator("#new-card").click();
  await page.locator("#workbench-card-title").fill(title);
  await page.locator("#workbench-card-body").fill(body);
  await page.locator("#save-workbench-card").click();
  const card = page.locator("#board [data-element-id]").filter({ has: page.locator(".organized-title", { hasText: title }) });
  await card.waitFor({ state: "visible" });
  return card.getAttribute("data-element-id");
}

async function editCard(page, id, title, body) {
  const card = page.locator(`#board [data-element-id="${id}"]`);
  await card.locator(".organized-title").click();
  await page.locator("#edit-workbench-card").click();
  await page.locator("#workbench-card-title").fill(title);
  await page.locator("#workbench-card-body").fill(body);
  await page.locator("#save-workbench-card").click();
}

async function savedContaining(id, text) {
  return eventually(async () => {
    const { board } = await store("load", { id });
    assert.ok(board, "board not saved yet");
    assert.ok(JSON.stringify(board.storage).includes(text), `server has not saved ${text}`);
    return board;
  }, `Wait for ${id} to be persisted`);
}

async function updateServiceCard(id, cardId, summary) {
  const { board } = await store("load", { id });
  const organization = JSON.parse(board.storage.organization);
  const card = (organization.current?.items || organization.rawCards).find(item => item.id === cardId);
  assert.ok(card, "The service-side edit must target an existing card");
  card.summary = summary;
  return (await store("save", { id, expectedRevision: board.revision,
    metadata: { title: board.title, repositoryPath: board.repositoryPath },
    storage: { ...board.storage, organization: JSON.stringify(organization) } })).board;
}

async function readerState(page) {
  return page.evaluate(() => {
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector("#board")).transform);
    return { boot: performance.timeOrigin, scale: matrix.a, offsetX: matrix.e, offsetY: matrix.f,
      mode: document.querySelector("#viewport").dataset.mode,
      selected: [...document.querySelectorAll('#board [data-element-id][aria-pressed="true"]')].map(element => element.dataset.elementId) };
  });
}

async function waitForRemoteCard(page, cardId, text) {
  await page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: text }).waitFor();
  await ready(page);
  assert.equal(await page.evaluate(() => window.BoardSync.writable), true);
}

async function assertDeferred(page, boot) {
  await page.evaluate(() => window.BoardSync.refresh());
  assert.equal((await readerState(page)).boot, boot, "A draft must prevent background navigation");
  assert.equal(await page.evaluate(() => window.BoardSync.writable), false, "An outdated reader must not overwrite the newer service document");
  assert.match(await page.locator("#board-sync-message").textContent(), /服务端.*新版本/);
}

try {
  await startService();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const first = await openContext();
  await first.page.goto(origin, { waitUntil: "networkidle" });
  await ready(first.page);
  await first.page.locator("#home-create-board").click();
  await first.page.locator("#board-name").fill("共享存储验收白板");
  await first.page.locator("#board-create-repository-path").fill(repository);
  await first.page.locator("#board-create-submit").click();
  await first.page.waitForURL(/\?board=board-[0-9a-f]{32}/);
  await ready(first.page);
  const id = await first.page.evaluate(() => window.BoardMemory.activeBoard);
  const cardId = await createCard(first.page, "跨浏览器说明卡", "第一份内容来自真实新建卡片入口。");
  await first.page.reload({ waitUntil: "networkidle" });
  await ready(first.page);
  await first.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "跨浏览器说明卡" }).waitFor();
  const created = await savedContaining(id, "跨浏览器说明卡");
  assert.equal(created.repositoryPath, repository);
  passed("UI-created board and card survive immediate reload with the bound repository path");

  const second = await openContext(origin.replace("127.0.0.1", "localhost"));
  await openBoard(second, id);
  assert.equal(await second.page.evaluate(() => window.BoardMemory.activeBoardInfo.repositoryPath), repository);
  await second.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "跨浏览器说明卡" }).waitFor();
  passed("A fresh localhost browser context sees the 127.0.0.1 board and card without copied storage");

  const authoredId = "board-" + "e".repeat(32);
  const authoredStorage = Object.fromEntries(Object.entries(created.storage).map(([key, value]) =>
    [key, value?.replaceAll("跨浏览器说明卡", "由后台创建的说明卡") ?? null]));
  await store("save", { id: authoredId, expectedRevision: 0,
    metadata: { title: "由后台创建的项目白板", repositoryPath: repository }, storage: authoredStorage });
  const external = await openContext();
  await openBoard(external, authoredId);
  await external.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "由后台创建的说明卡" }).waitFor();
  assert.equal(await external.page.evaluate(() => window.BoardMemory.activeBoardInfo.repositoryPath), repository);
  passed("A board created directly through the backend opens in a browser that never owned its local data");

  // Use an independent origin with no copied localStorage. The edit below is
  // equivalent to an external Codex/ZCode skill committing over HTTP.
  const reader = await openContext(origin.replace("127.0.0.1", "localhost"));
  await openBoard(reader, authoredId);
  await reader.page.locator("#pan-mode").click();
  await reader.page.locator(`#board [data-element-id="${cardId}"] .organized-title`).click();
  await reader.page.locator("#zoom-in").click();
  const beforeRemote = await readerState(reader.page);
  assert.deepEqual(beforeRemote.selected, [cardId]);
  await updateServiceCard(authoredId, cardId, "外部技能通过 HTTP 更新后，已打开的浏览器自动看见正文。");
  // Deliberately do not call refresh/reload: exercise the real five-second poll.
  await waitForRemoteCard(reader.page, cardId, "外部技能通过 HTTP 更新后，已打开的浏览器自动看见正文。");
  const afterRemote = await readerState(reader.page);
  assert.notEqual(afterRemote.boot, beforeRemote.boot, "The clean reader should adopt a complete fresh document");
  for (const field of ["scale", "offsetX", "offsetY"]) {
    assert.ok(Math.abs(afterRemote[field] - beforeRemote[field]) < 0.02, `Remote refresh preserves ${field}`);
  }
  assert.deepEqual(afterRemote.selected, beforeRemote.selected);
  assert.equal(afterRemote.mode, beforeRemote.mode);
  passed("An already-open independent browser sees HTTP skill writes through natural polling while preserving camera, selection and interaction mode");

  await reader.page.locator("#ask-board").click();
  await reader.page.locator("#question").fill("保留我还没有发送的问题。");
  await reader.page.locator("#attachment-input").setInputFiles({ name: "unsent-evidence.txt", mimeType: "text/plain", buffer: Buffer.from("unsent attachment") });
  const draftBoot = (await readerState(reader.page)).boot;
  await updateServiceCard(authoredId, cardId, "有问题和附件草稿时，服务的新正文等待安全刷新。");
  await assertDeferred(reader.page, draftBoot);
  assert.equal(await reader.page.locator("#question").inputValue(), "保留我还没有发送的问题。");
  assert.match(await reader.page.locator("#attachment-list").textContent(), /unsent-evidence\.txt/);
  assert.ok(!(await reader.page.locator(`#board [data-element-id="${cardId}"]`).textContent()).includes("有问题和附件草稿时"));
  await reader.page.locator("#question").fill("");
  await reader.page.getByRole("button", { name: "移除附件 unsent-evidence.txt", exact: true }).click();
  await reader.page.locator("#ask-close").click();
  await reader.page.evaluate(() => window.BoardSync.refresh());
  await waitForRemoteCard(reader.page, cardId, "有问题和附件草稿时，服务的新正文等待安全刷新。");
  passed("Unsent question and File attachment survive external writes; clearing those drafts lets the same reader adopt the new service version");

  await reader.page.locator("#select-mode").click();
  await reader.page.locator(`#board [data-element-id="${cardId}"] .organized-title`).click();
  await reader.page.locator("#edit-workbench-card").click();
  await reader.page.locator("#workbench-card-body").fill("还没有保存的卡片编辑。");
  const editBoot = (await readerState(reader.page)).boot;
  await updateServiceCard(authoredId, cardId, "卡片编辑结束后再载入的新版本。");
  await assertDeferred(reader.page, editBoot);
  assert.equal(await reader.page.locator("#workbench-card-body").inputValue(), "还没有保存的卡片编辑。");
  await reader.page.locator("#cancel-workbench-card").click();
  await reader.page.evaluate(() => window.BoardSync.refresh());
  await waitForRemoteCard(reader.page, cardId, "卡片编辑结束后再载入的新版本。");
  passed("An unsaved card editor is protected until explicitly cancelled");

  await reader.page.locator(".connection-settings > summary").click();
  await reader.page.locator("#backend-select").selectOption("api");
  await reader.page.locator("#api-key").fill("test-only-not-a-real-key");
  await reader.page.locator(".connection-settings > summary").click();
  const keyBoot = (await readerState(reader.page)).boot;
  await updateServiceCard(authoredId, cardId, "仅当前页面的连接密钥也不能被后台刷新丢弃。");
  await assertDeferred(reader.page, keyBoot);
  assert.equal(await reader.page.locator("#api-key").inputValue(), "test-only-not-a-real-key");
  assert.ok(!JSON.stringify((await store("load", { id: authoredId })).board.storage).includes("test-only-not-a-real-key"));
  assert.equal(await reader.page.evaluate(() => Object.values(localStorage).some(value => value.includes("test-only-not-a-real-key"))), false);
  await reader.page.locator(".connection-settings > summary").click();
  await reader.page.locator("#api-key").fill("");
  await reader.page.locator(".connection-settings > summary").click();
  await reader.page.evaluate(() => window.BoardSync.refresh());
  await waitForRemoteCard(reader.page, cardId, "仅当前页面的连接密钥也不能被后台刷新丢弃。");
  passed("An in-page API key prevents automatic navigation without being persisted to the server or browser storage");

  await reader.page.locator(".connection-settings > summary").click();
  await reader.page.locator("#backend-select").selectOption("codex");
  await reader.page.locator(".connection-settings > summary").click();
  await reader.page.locator("#ask-board").click();
  await reader.page.locator("#question").fill("执行期间不能刷新并丢掉本轮问题。");
  let releasePlan;
  let planArrived;
  const heldPlan = new Promise(resolvePlan => { releasePlan = resolvePlan; });
  const arrival = new Promise(resolveArrival => { planArrived = resolveArrival; });
  const holdPlan = async route => {
    planArrived();
    await heldPlan;
    return route.fulfill({ status: 418, contentType: "application/json", body: '{"text":"Isolated test deliberately ends the held planner request"}' });
  };
  await reader.page.route("**/api/codex", holdPlan);
  await reader.page.locator("#submit-question").click();
  await Promise.race([arrival, new Promise((_, reject) => setTimeout(() => reject(new Error("The isolated planner request did not start")), 12000))]);
  const runBoot = (await readerState(reader.page)).boot;
  await updateServiceCard(authoredId, cardId, "模型执行时到达的外部版本等待本页处理。");
  await assertDeferred(reader.page, runBoot);
  assert.equal(await reader.page.locator("#stop-ai").isVisible(), true, "The held model task stays active instead of navigating away");
  releasePlan();
  await reader.page.locator("#stop-ai").waitFor({ state: "hidden" });
  assert.equal(await reader.page.locator("#question").inputValue(), "执行期间不能刷新并丢掉本轮问题。");
  await reader.page.unroute("**/api/codex", holdPlan);
  await reader.page.locator("#question").fill("");
  await reader.page.locator("#ask-close").click();
  await reader.page.evaluate(() => window.BoardSync.refresh());
  await waitForRemoteCard(reader.page, cardId, "模型执行时到达的外部版本等待本页处理。");
  passed("An active held planner request and its question survive an external update; no provider is called and clearing the retained draft permits refresh");

  // A second tab in the very same context receives native StorageEvents before
  // the first tab's HTTP acknowledgement. That cache event must not permanently
  // block an otherwise clean reader from adopting the confirmed service write.
  const sameOrigin = await openContext();
  await openBoard(sameOrigin, authoredId);
  const sibling = await sameOrigin.context.newPage();
  sibling.setDefaultTimeout(12000);
  sibling.on("pageerror", error => errors.push(error.message));
  sibling.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  await sibling.goto(`${origin}/?board=${authoredId}`, { waitUntil: "networkidle" });
  await ready(sibling);
  const siblingBoot = (await readerState(sibling)).boot;
  await editCard(sameOrigin.page, cardId, "由后台创建的说明卡", "同源另一标签页的正式保存也要自动可见。");
  await savedContaining(authoredId, "同源另一标签页的正式保存也要自动可见。");
  await waitForRemoteCard(sibling, cardId, "同源另一标签页的正式保存也要自动可见。");
  assert.notEqual((await readerState(sibling)).boot, siblingBoot);
  assert.equal(await sibling.locator("#storage-conflict").isVisible(), false);
  passed("Two tabs sharing the same browser storage recover from native cache-change protection after the service confirms the new revision");

  await editCard(first.page, cardId, "跨浏览器说明卡", "第一位用户修改后的正文。");
  await savedContaining(id, "第一位用户修改后的正文。");
  await second.page.reload({ waitUntil: "networkidle" });
  await ready(second.page);
  await second.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一位用户修改后的正文。" }).waitFor();
  passed("Reload hydrates the latest saved content in an independent origin");

  const beforeConflict = (await store("load", { id })).board;
  // Freeze only this reader's list response to make a genuine stale CAS save
  // deterministic even when the new automatic background refresh is enabled.
  const staleListing = await store("list");
  const holdListing = async route => {
    if (route.request().postDataJSON().action !== "list") return route.fallback();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(staleListing) });
  };
  await second.page.route("**/api/board-store", holdListing);
  await editCard(first.page, cardId, "跨浏览器说明卡", "并发胜出版本。");
  const winner = await savedContaining(id, "并发胜出版本。");
  await editCard(second.page, cardId, "跨浏览器说明卡", "过时浏览器版本不可覆盖。");
  await eventually(async () => {
    const state = await second.page.locator("#board-sync-message").textContent();
    assert.match(state, /冲突|(?:其他|另一).*(?:浏览器|页面)|刷新.*(?:重试|更改|白板|操作)/);
  }, "Show a stale-save conflict");
  const afterConflict = (await store("load", { id })).board;
  assert.ok(JSON.stringify(afterConflict.storage).includes("并发胜出版本。"));
  assert.ok(!JSON.stringify(afterConflict.storage).includes("过时浏览器版本不可覆盖。"));
  const previousMetadata = { id, title: beforeConflict.title, repositoryPath: beforeConflict.repositoryPath };
  await store("save", { id, metadata: previousMetadata, storage: beforeConflict.storage,
    expectedRevision: beforeConflict.revision }, 409);
  assert.ok(winner.revision > beforeConflict.revision);
  await second.page.unroute("**/api/board-store", holdListing);
  await second.page.reload({ waitUntil: "networkidle" });
  await ready(second.page);
  await second.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "并发胜出版本。" }).waitFor();
  passed("Conflicting browser edits and stale API revisions preserve the winning server snapshot");

  await second.page.route("**/api/board-store", async route => {
    const payload = route.request().postDataJSON();
    if (payload.action !== "save") return route.fallback();
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"text":"Test-only temporary save outage"}' });
  });
  await editCard(second.page, cardId, "跨浏览器说明卡", "暂时断线后的待保存正文。");
  await eventually(async () => {
    const state = await second.page.locator("#board-sync-message").textContent();
    assert.match(state, /未保存|保存失败|同步失败|无法.*保存|待同步/);
  }, "Show pending content after a server save failure");
  assert.ok(!JSON.stringify((await store("load", { id })).board.storage).includes("暂时断线后的待保存正文。"));
  await second.page.reload({ waitUntil: "networkidle" });
  await ready(second.page);
  await second.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "暂时断线后的待保存正文。" }).waitFor();
  await second.page.unroute("**/api/board-store");
  await second.page.locator("#board-sync-retry").click();
  await savedContaining(id, "暂时断线后的待保存正文。");
  passed("A failed save is visible, retains its pending draft across reload, and retries after recovery");

  const migrationId = "board-" + "d".repeat(32);
  const migrationPrefix = `whiteboard.codex.${migrationId}`;
  const seed = {
    "whiteboard.codex.boards.v1": JSON.stringify([{ id: migrationId, title: "旧浏览器迁移白板", repositoryPath: repository }]),
    [`${migrationPrefix}.v1`]: JSON.stringify({ project: { goal: "保留旧目标", constraints: ["保留旧约束"], decisions: [] }, notes: [], pinnedIds: ["E04"], deletedIds: [] }),
    [`${migrationPrefix}.organization.v1`]: JSON.stringify({ rawCards: [{ id: "E04", parentId: null, category: "main", title: "旧浏览器说明卡", summary: "必须保留的旧正文。", sources: [] }], rawPositions: { E04: { x: 60, y: 80, width: 320 } } }),
    [`${migrationPrefix}.template-backup.v1`]: JSON.stringify({ marker: "must preserve the original template backup" }),
    [`${migrationPrefix}.project-guide-backup.v1`]: JSON.stringify({ marker: "must preserve the original guide backup" }),
  };
  const migrating = await openContext(origin, seed);
  await openBoard(migrating, migrationId);
  const migrated = await savedContaining(migrationId, "旧浏览器说明卡");
  assert.equal(migrated.storage.templateBackup, seed[`${migrationPrefix}.template-backup.v1`]);
  assert.equal(migrated.storage.guideBackup, seed[`${migrationPrefix}.project-guide-backup.v1`]);
  assert.ok(migrated.storage.memory.includes("保留旧目标"));
  assert.deepEqual(JSON.parse(migrated.storage.memory).pinnedIds, ["E04"]);
  assert.deepEqual(JSON.parse(migrated.storage.memory).project.constraints, ["保留旧约束"]);
  const migrationFresh = await openContext();
  await openBoard(migrationFresh, migrationId);
  await migrationFresh.page.locator('#board [data-element-id="E04"]').filter({ hasText: "必须保留的旧正文。" }).waitFor();
  passed("Preexisting browser boards migrate with content, project rules, pins and both exact backup snapshots");

  const history = await store("history", { id, limit: 100 });
  assert.ok(history.versions.some(version => version.revision === created.revision));
  assert.ok(history.versions.every((version, index) => index === 0 || version.revision < history.versions[index - 1].revision));
  const originalVersion = (await store("load", { id, revision: created.revision })).board;
  assert.deepEqual(originalVersion.storage, created.storage);
  const parentBeforeFork = (await store("load", { id })).board;
  const forkClient = await openContext();
  await openBoard(forkClient, id);
  await forkClient.page.locator("#board-versions-button").click();
  const sourceRow = forkClient.page.locator(`#board-version-list [data-revision="${created.revision}"]`);
  await sourceRow.getByRole("button", { name: "预览", exact: true }).click();
  await eventually(async () => assert.match(await forkClient.page.locator("#board-version-preview").textContent(), /第一份内容来自真实新建卡片入口。/), "Preview the saved parent revision");
  await forkClient.page.locator("#board-version-name").fill("从已保存版本创建的分支");
  await sourceRow.getByRole("button", { name: "从此版本建分支", exact: true }).click();
  await forkClient.page.waitForURL(url => url.searchParams.get("board") !== id && /^board-/.test(url.searchParams.get("board") || ""));
  await ready(forkClient.page);
  const forkId = await forkClient.page.evaluate(() => window.BoardMemory.activeBoard);
  const fork = (await store("load", { id: forkId })).board;
  assert.notEqual(fork.id, id);
  assert.equal(fork.revision, 1);
  assert.equal(fork.repositoryPath, repository);
  const expectedForkOrganization = JSON.parse(created.storage.organization);
  if (expectedForkOrganization?.current) expectedForkOrganization.current.title = "从已保存版本创建的分支";
  assert.deepEqual(
    { ...fork.storage, organization: JSON.parse(fork.storage.organization) },
    { ...created.storage, organization: expectedForkOrganization },
    "The fork changes its board title while preserving all cards, positions, memory and backups",
  );
  assert.equal(fork.forkedFrom.boardId, id);
  assert.equal(fork.forkedFrom.revision, created.revision);
  await forkClient.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一份内容来自真实新建卡片入口。" }).waitFor();
  const forkFresh = await openContext();
  await openBoard(forkFresh, fork.id);
  await forkFresh.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一份内容来自真实新建卡片入口。" }).waitFor();
  await forkFresh.page.locator("#board-versions-button").click();
  await eventually(async () => {
    const text = await forkFresh.page.locator("#board-version-origin").textContent();
    assert.ok(text.includes(`v${created.revision}`));
    assert.ok(text.includes(parentBeforeFork.title));
  }, "Display the fork source and revision");
  await forkFresh.page.locator("#board-version-close").click();
  await editCard(forkClient.page, cardId, "跨浏览器说明卡", "分支独立修改正文。");
  const editedFork = await savedContaining(fork.id, "分支独立修改正文。");
  assert.deepEqual((await store("load", { id })).board, parentBeforeFork);
  passed("UI preview and fork from a saved revision create an independent board visible in a fresh browser with source lineage");

  const restoredFork = (await store("restore", { id: fork.id, revision: 1, expectedRevision: editedFork.revision })).board;
  assert.equal(restoredFork.revision, editedFork.revision + 1);
  assert.deepEqual(restoredFork.storage, fork.storage);
  const forkHistory = (await store("history", { id: fork.id })).versions;
  assert.equal(forkHistory[0].operation, "restore");
  assert.equal(forkHistory[0].restoredFromRevision, 1);
  assert.ok(forkHistory.some(version => version.revision === editedFork.revision));
  assert.deepEqual((await store("load", { id: fork.id, revision: editedFork.revision })).board.storage, editedFork.storage);
  await forkClient.page.reload({ waitUntil: "networkidle" });
  await ready(forkClient.page);
  await forkClient.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一份内容来自真实新建卡片入口。" }).waitFor();
  passed("Restoring an old snapshot creates a new revision, preserves intermediate history, and refreshes the fork's content");

  const restoring = await openContext();
  await openBoard(restoring, id);
  await restoring.page.locator("#board-versions-button").click();
  const originalRow = restoring.page.locator(`#board-version-list [data-revision="${created.revision}"]`);
  await Promise.all([
    restoring.page.waitForEvent("load"),
    originalRow.getByRole("button", { name: "恢复", exact: true }).click(),
  ]);
  await ready(restoring.page);
  const restoredParent = (await store("load", { id })).board;
  assert.equal(restoredParent.revision, parentBeforeFork.revision + 1);
  assert.deepEqual(restoredParent.storage, created.storage);
  assert.deepEqual((await store("load", { id, revision: parentBeforeFork.revision })).board.storage, parentBeforeFork.storage);
  await restoring.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一份内容来自真实新建卡片入口。" }).waitFor();
  passed("The UI restore action creates a new parent revision and keeps the prior parent version intact");

  await stopService();
  await startService();
  const cold = await openContext();
  await openBoard(cold, id);
  await cold.page.locator(`#board [data-element-id="${cardId}"]`).filter({ hasText: "第一份内容来自真实新建卡片入口。" }).waitFor();
  assert.ok((await store("list")).boards.some(board => board.id === migrationId));
  passed("A restarted server and cold browser origin recover both canonical boards from SQLite");

  const stale = await openContext();
  await openBoard(stale, id);
  const beforeDeleteListing = await store("list");
  await stale.page.route("**/api/board-store", async route => {
    if (route.request().postDataJSON().action !== "list") return route.fallback();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(beforeDeleteListing) });
  });
  await cold.page.locator("#board-manage").click();
  await cold.page.locator("#board-delete").click();
  await cold.page.locator("#board-delete-confirm").click();
  await eventually(async () => assert.equal((await store("load", { id })).board, null), "Delete the canonical board");
  await editCard(stale.page, cardId, "跨浏览器说明卡", "已删除白板不得复活。");
  await eventually(async () => {
    const state = await stale.page.locator("#board-sync-message").textContent();
    assert.match(state, /冲突|删除|不存在|刷新/);
  }, "Reject an edit to a deleted board");
  assert.equal((await store("load", { id })).board, null);
  const deletedFresh = await openContext();
  await deletedFresh.page.goto(`${origin}/?board=${id}`, { waitUntil: "networkidle" });
  await ready(deletedFresh.page);
  assert.ok(!(await deletedFresh.page.evaluate(() => window.BoardMemory.listBoards())).some(board => board.id === id));
  assert.equal((await store("load", { id })).board, null);
  passed("Deleting a shared board removes it from fresh catalogs and stale clients cannot resurrect it");

  assert.deepEqual(errors, [], "No browser JavaScript errors");
  console.log(`\n${observations.length} shared-board acceptance checks passed.`);
} catch (error) {
  console.error(error.stack || error);
  for (const context of contexts) {
    for (const page of context.pages()) {
      console.error(JSON.stringify({ url: page.url(), status: await page.locator('[role="status"], [role="alert"]').allTextContents().catch(() => []) }));
    }
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopService();
  const resolvedTemporary = resolve(temporary);
  assert.equal(dirname(resolvedTemporary), resolve(tmpdir()));
  assert.ok(resolvedTemporary.startsWith(join(resolve(tmpdir()), "whiteboard-shared-browser-")));
  await rm(resolvedTemporary, { recursive: true, force: true });
}
