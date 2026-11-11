/* One user-authorized real DeepSeek whiteboard session; no retry path exists. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TARGET = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-flash";
const startedAt = new Date().toISOString();
const deadline = Date.now() + 60_000;
// Historical real-deepseek-report.* is immutable evidence.  This harness only
// writes a separately named repair report when explicitly authorized.
let runId = "not-started";
let reportPath;
let markdownPath;
const realAuthorized = process.argv.includes("--real")
  && process.env.REAL_DEEPSEEK_ACCEPTANCE_MODE === "real"
  && process.env.REAL_DEEPSEEK_ACCEPTANCE_AUTHORIZATION === "ONE_TIME_USER_AUTHORIZED";
const run = {
  runId: null,
  actualSessionStarted: false,
  browser: { isolatedEdgeContext: false, closed: false },
  controller: { started: false, closed: false, randomLoopbackPort: null },
  checks: { fixedHost: TARGET === "https://api.deepseek.com/chat/completions", port8791Touched: false, browserKeyEmpty: null, localStorageContainsKey: null },
  layers: { uiToController: "NOT_RUN", apiAdapter: "NOT_RUN", realToolLoop: "NOT_RUN", candidateApplied: "NOT_RUN", undo: "NOT_RUN" },
  telemetry: null,
  result: "NOT_RUN",
  error: null,
  notes: ["The controller injects the environment key server-side. This run does not test entering a real key in the UI."],
};
let child;
let childExit;
let browser;
let context;
let base;

function timeRemaining() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("end-to-end 60 second acceptance budget exhausted");
  return remaining;
}

function safeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
function spawnController() {
  return new Promise((resolveReady, rejectReady) => {
    // The controller reads the approved user environment value itself. Its
    // command line contains only this script path; neither browser storage nor
    // browser process environments receive the value.
    child = spawn("python", [join(HERE, "real_deepseek_controller.py")], { cwd: HERE, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd); buffer = buffer.slice(lineEnd + 1);
      try {
        const message = JSON.parse(line);
        if (message.status === "ready" && message.host === "127.0.0.1" && Number.isInteger(message.port)) resolveReady(message);
        else rejectReady(new Error(message.reason || "controller did not become ready"));
      } catch { rejectReady(new Error("controller emitted an invalid readiness record")); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-800); });
    child.once("error", rejectReady);
    child.once("exit", (code) => { if (!base) rejectReady(new Error(`controller exited before ready (${code}): ${stderr}`)); });
  });
}
async function getTelemetry() {
  if (!base) return null;
  const response = await fetch(`${base}/acceptance/telemetry`);
  if (!response.ok) throw new Error(`telemetry endpoint HTTP ${response.status}`);
  return response.json();
}
async function stopController() {
  if (!child) return;
  try { await fetch(`${base}/acceptance/shutdown`, { method: "POST" }); } catch { /* Server may have already stopped. */ }
  const exited = await Promise.race([childExit.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!exited) {
    // This exact child PID was created by this harness; do not enumerate or
    // affect any user processes.
    child.kill();
    const killed = await Promise.race([childExit.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
    run.controller.closed = killed === true;
  } else run.controller.closed = true;
}
async function writeReports() {
  // A report is never named after a previous run.  Blocked-before-ready
  // invocations have no real controller run ID and receive no live report.
  if (!reportPath || !markdownPath) return;
  const json = JSON.stringify(run, null, 2) + "\n";
  await writeFile(reportPath, json, "utf8");
  const t = run.telemetry;
  const toolSummary = t?.toolCalls?.length ? t.toolCalls.map((item) => `${item.name} (${item.id}; ${JSON.stringify(item.parameters)})`).join("；") : "无";
  const lines = [
    "# DeepSeek 真实白板工具调用验收报告", "",
    `开始：${startedAt}`, `固定目标：${TARGET}`, `模型：${MODEL}`, `结果：${run.result}`, "",
    "| 层级 | 结果 |", "| --- | --- |",
    ...Object.entries(run.layers).map(([name, value]) => `| ${name} | ${value} |`), "",
    `HTTP 尝试：${t?.http?.attempted ?? "UNVERIFIED"}/3；HTTP 成功：${t?.http?.succeeded ?? "UNVERIFIED"}；每响应 max_tokens 强制为 1024：${t?.maxTokensForced === true ? "是" : "UNVERIFIED"}；工具调用：${t?.toolCalls?.length ?? "UNVERIFIED"}/4。`,
    `工具（去敏摘要）：${toolSummary}。`,
    `供应商 HTTP 状态：${t?.providerHttpStatus ?? "未取得"}；usage：${t?.vendorUsage ? JSON.stringify(t.vendorUsage) : "供应商未返回或请求未完成，无法估算费用。"}`,
    "费用说明：本报告不保存费率或估算金额；实际费用只能按供应商账户的模型计费与 usage 核对。",
    "安全边界：浏览器的 API Key 输入为空；控制器从 HKCU 用户环境读取后仅注入请求本地的 Authorization，并拒绝非固定 DeepSeek 目标和重定向。未测试真实 Key 的 UI 输入。",
    `清理：Edge/隔离 context 已关闭=${run.browser.closed}；随机回环服务已关闭=${run.controller.closed}；未触碰 8791=${run.checks.port8791Touched}。`,
    run.error ? `错误（去敏）：${run.error}` : "",
    "",
  ].filter(Boolean);
  await writeFile(markdownPath, lines.join("\n"), "utf8");
}

try {
  if (!realAuthorized) {
    run.result = "DRY_RUN";
    run.notes.push("Default dry-run/mock mode: no key read, no provider request, and no product port 8791 access.");
    throw new Error("dry-run complete");
  }
  if (!run.checks.fixedHost) throw new Error("fixed DeepSeek host check failed");
  if (!existsSync(EDGE)) throw new Error("installed Edge channel unavailable");
  const ready = await spawnController();
  runId = ready.runId;
  run.runId = runId;
  reportPath = join(HERE, `real-deepseek-live-${runId}.json`);
  markdownPath = join(HERE, `real-deepseek-live-${runId}.md`);
  console.log(JSON.stringify({ phase: "ready", runId }));
  run.controller.started = true;
  run.controller.randomLoopbackPort = ready.port;
  base = `http://127.0.0.1:${ready.port}`;
  const edgeEnv = { ...process.env };
  delete edgeEnv.DEEPSEEK_API_KEY;
  browser = await chromium.launch({ executablePath: EDGE, headless: true, env: edgeEnv });
  context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  run.browser.isolatedEdgeContext = true;
  await context.addInitScript(() => {
    localStorage.setItem("whiteboard.codex.v1", JSON.stringify({
      notes: [{ id: "A01", kind: "note", rect: { x: 120, y: 120, width: 300, height: 156 },
        payload: { boardId: "synthetic-real-deepseek", anchor: { elementIds: ["board"], box: { x: 0, y: 0, width: 1, height: 1 }, quote: "" }, question: "合成初始标题" },
        sourceCardIds: [], answer: "Synthetic acceptance-only note.", anchors: [] }],
      pinnedIds: [], deletedIds: ["E01", "E02", "E03"], pendingRepair: "", project: { goal: "", constraints: [], decisions: [] },
    }));
    localStorage.removeItem("whiteboard.codex.organization.v1");
    localStorage.removeItem("whiteboard.codex.connection.v1");
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(safeError(error)));
  await page.goto(base, { waitUntil: "networkidle", timeout: timeRemaining() });
  await page.waitForFunction(() => {
    const select = document.querySelector("#backend-select");
    const label = document.querySelector("#connection-label")?.textContent || "";
    return select?.options?.length === 3 && label && !label.includes("正在连接");
  }, undefined, { timeout: timeRemaining() });
  await page.locator(".connection-settings > summary").click();
  await page.locator("#backend-select").selectOption("api");
  await page.waitForFunction(() => document.querySelector("#connection-label")?.textContent?.includes("API 适配器可用"), undefined, { timeout: timeRemaining() });
  await page.locator("#model-input").fill(MODEL);
  await page.locator("#api-url").fill(TARGET);
  run.checks.browserKeyEmpty = (await page.locator("#api-key").inputValue()) === "";
  await page.locator(".connection-settings > summary").click();
  assert.equal(run.checks.browserKeyEmpty, true, "browser API key field was not empty");
  run.actualSessionStarted = true;
  await page.locator("#organize-board").click();
  run.layers.uiToController = "PASS";
  await page.locator("#stop-ai").waitFor({ state: "visible", timeout: timeRemaining() });
  await page.locator("#undo-organization").waitFor({ state: "visible", timeout: timeRemaining() });
  const appliedTitle = await page.locator('article[data-element-id="A01"] .organized-title').textContent();
  const organizationStorage = await page.evaluate(() => localStorage.getItem("whiteboard.codex.organization.v1") || "");
  assert.equal(appliedTitle, "已验证工具调用", "candidate title was not rendered in UI");
  assert.ok(organizationStorage.includes("已验证工具调用"), "candidate title was not persisted to isolated storage");
  run.layers.candidateApplied = "PASS";
  run.checks.localStorageContainsKey = await page.evaluate(() => JSON.stringify(localStorage).includes("sk-"));
  assert.equal(run.checks.localStorageContainsKey, false, "unexpected key-like text persisted in isolated storage");
  await page.locator("#undo-organization").click();
  await page.locator("#undo-organization").waitFor({ state: "hidden", timeout: timeRemaining() });
  const afterUndo = await page.evaluate(() => localStorage.getItem("whiteboard.codex.organization.v1") || "");
  assert.equal(afterUndo.includes("已验证工具调用"), false, "undo left the candidate in organization storage");
  run.layers.undo = "PASS";
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join(" | ")}`);
  run.telemetry = await getTelemetry();
  run.layers.apiAdapter = run.telemetry.http?.succeeded > 0 ? "PASS" : "FAIL";
  const update = run.telemetry.toolCalls.find((item) => item.name === "update_node" && item.executed && item.ok);
  assert.ok(update, "provider did not execute a successful update_node tool call");
  assert.ok(run.telemetry.http.attempted >= 1 && run.telemetry.http.attempted <= 3, "transport request count exceeded the bound");
  assert.ok(run.telemetry.toolCalls.length <= 4, "tool count exceeded the bound");
  assert.equal(run.telemetry.maxTokensForced, true, "transport did not force max_tokens=1024");
  assert.equal(run.telemetry.candidateEventSent, true, "controller did not emit candidate map");
  assert.equal(run.telemetry.terminalEvent, "done", "controller did not reach done");
  run.layers.realToolLoop = "PASS";
  run.result = "PASS";
} catch (error) {
  if (run.result === "DRY_RUN") {
    run.error = null;
  } else {
  run.error = safeError(error);
  try { run.telemetry = await getTelemetry(); } catch { /* Preserve the original failure. */ }
  if (run.actualSessionStarted) {
    run.layers.realToolLoop = "FAIL";
    if (run.layers.candidateApplied === "NOT_RUN") run.layers.candidateApplied = "FAIL";
  }
  run.result = run.actualSessionStarted ? "FAIL" : "BLOCKED";
  }
} finally {
  if (context) await context.close();
  if (browser) { await browser.close(); run.browser.closed = true; }
  await stopController();
  await writeReports();
}

if (!["PASS", "DRY_RUN"].includes(run.result)) process.exitCode = 1;
