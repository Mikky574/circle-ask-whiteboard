(() => {
  const memory = window.BoardMemory;
  const sync = window.BoardSync;
  const button = document.getElementById("board-versions-button");
  const dialog = document.getElementById("board-versions-dialog");
  if (!memory || !sync || !button || !dialog) return;
  const id = memory.activeBoard;
  if (!id || id === memory.localProjectsBoard) return;
  button.hidden = false;
  const list = document.getElementById("board-version-list");
  const error = document.getElementById("board-version-error");
  const heading = document.getElementById("board-version-heading");
  const origin = document.getElementById("board-version-origin");
  const preview = document.getElementById("board-version-preview");
  const name = document.getElementById("board-version-name");
  const more = document.getElementById("board-version-more");
  let busy = false;
  let before = null;
  let sequence = 0;
  const operations = { save: "保存", restore: "恢复", fork: "建立分支", delete: "删除" };

  function report(text = "") {
    error.textContent = text;
    error.hidden = !text;
  }

  function update() {
    button.textContent = sync.currentRevision ? `版本 v${sync.currentRevision} · 分支` : "版本与分支";
    button.disabled = !sync.currentRevision && !sync.pending;
    for (const action of dialog.querySelectorAll("button[data-version-action]")) action.disabled = busy || sync.failed;
    more.disabled = busy;
    name.disabled = busy;
    document.getElementById("board-version-close").disabled = busy;
  }

  async function request(action, fields = {}) {
    const response = await fetch("/api/board-store", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id, ...fields }), signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.text || `白板版本操作失败（${response.status}）。`);
    return value;
  }

  function boardUrl(boardId) {
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("board", boardId);
    url.hash = "";
    return url.href;
  }

  function canChange() {
    if (document.getElementById("board-manage")?.disabled) {
      report("请等待当前任务完成，或先停止任务，再操作白板版本。");
      return false;
    }
    const draft = document.getElementById("question")?.value.trim();
    const attachmentDraft = document.querySelector("#attachment-list button");
    const editing = document.querySelector("#workbench-card-form:not([hidden])");
    return !(draft || attachmentDraft || editing) || window.confirm("本页仍有未发送的问题或卡片编辑。离开前请先保留这些草稿，继续切换白板吗？");
  }

  async function perform(action) {
    if (busy) return;
    busy = true;
    report();
    update();
    try { await action(); }
    catch (failure) { report(failure.message || "无法读取白板版本，请稍后重试。"); }
    finally { busy = false; update(); }
  }

  async function fork(revision) {
    if (!canChange()) return;
    const title = name.value.trim();
    if (!title || title.length > 80) throw new Error("请给新分支填写名称，最多 80 字。");
    await sync.flush();
    const { board } = await request("fork", { revision: revision ?? sync.currentRevision, title });
    if (!board?.id) throw new Error("服务没有返回新分支，当前白板未改变。");
    location.assign(boardUrl(board.id));
  }

  async function restore(revision) {
    if (!canChange() || !window.confirm(`把 v${revision} 恢复为一个新版本？当前版本仍会保留在历史中。`)) return;
    await sync.flush();
    await request("restore", { revision, expectedRevision: sync.currentRevision });
    location.reload();
  }

  function append(parent, tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  async function showPreview(revision) {
    const { board } = await request("load", { revision });
    if (!board) throw new Error("这个历史版本不存在。");
    const organization = JSON.parse(board.storage.organization || "{}");
    const saved = JSON.parse(board.storage.memory || "{}");
    const cards = organization.current?.items || organization.rawCards || [];
    const notes = saved.notes || [];
    const lines = [`${board.title} · v${board.revision}`, `模块 ${cards.length} · 讨论 ${notes.length}`, ""];
    for (const item of cards) {
      lines.push(`${item.id} · ${item.title || "未命名"}${item.parentId ? `（上级 ${item.parentId}）` : ""}`, item.summary || "", "");
      if (lines.join("\n").length > 100000) { lines.push("更多正文未在预览中显示；建立分支后可完整查看。"); break; }
    }
    for (const note of notes) {
      if (lines.join("\n").length > 100000) break;
      lines.push(`${note.id} · ${note.payload?.question || note.question || "讨论"}`, note.answer || "", "");
    }
    preview.textContent = lines.join("\n");
    preview.hidden = false;
  }

  function addVersion(version) {
    const row = append(list, "li", "", "board-version-row");
    row.dataset.revision = version.revision;
    const text = append(row, "div", "");
    append(text, "strong", `v${version.revision} · ${operations[version.operation] || "保存"}`);
    const time = new Date(version.updatedAt);
    append(text, "span", Number.isNaN(time.getTime()) ? version.updatedAt : time.toLocaleString(), "board-version-time");
    const actions = append(row, "div", "", "board-version-actions");
    for (const [label, action] of [
      ["预览", () => showPreview(version.revision)],
      ["从此版本建分支", () => fork(version.revision)],
      ...(version.revision === sync.currentRevision ? [] : [["恢复", () => restore(version.revision)]]),
    ]) {
      const control = append(actions, "button", label, "tool-button");
      control.type = "button";
      control.dataset.versionAction = label;
      control.addEventListener("click", () => void perform(action));
    }
  }

  async function loadHistory(reset = false) {
    if (reset) { before = null; list.replaceChildren(); preview.hidden = true; }
    const data = await request("history", { limit: 25, ...(before ? { beforeRevision: before } : {}) });
    if (!Array.isArray(data.versions)) throw new Error("服务未提供版本记录，请更新并重新启动服务。");
    data.versions.forEach(addVersion);
    before = data.nextBeforeRevision;
    more.hidden = !before;
    if (!list.children.length) append(list, "li", "这张白板还没有保存的版本。");
  }

  button.addEventListener("click", () => {
    if (busy) return;
    dialog.showModal();
    void perform(async () => {
      await sync.flush();
      const token = ++sequence;
      const { board } = await request("load");
      if (token !== sequence || !dialog.open) return;
      if (!board) throw new Error("这张白板尚未保存或已经删除，请刷新白板。");
      if (board.revision !== sync.currentRevision) {
        await sync.refresh();
        throw new Error("服务端已有较新的白板版本，请保留本页草稿并刷新后，再操作当前版本。");
      }
      heading.textContent = `${board.title} · 当前 v${board.revision}`;
      origin.replaceChildren();
      if (board.forkedFrom) {
        append(origin, "span", `分支来源：${board.forkedFrom.title} · v${board.forkedFrom.revision} `);
        const link = append(origin, "a", "打开原白板");
        link.href = boardUrl(board.forkedFrom.boardId);
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void perform(async () => {
            if (!canChange()) return;
            await sync.flush();
            location.assign(link.href);
          });
        });
      } else origin.textContent = "独立白板。每次保存保留历史，从任一版本可建立独立分支。";
      name.value = `${board.title.slice(0, 74)} 分支`;
      await loadHistory(true);
    });
  });
  document.getElementById("board-version-fork-current").addEventListener("click", () => void perform(() => fork()));
  document.getElementById("board-version-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { sequence += 1; button.focus(); });
  more.addEventListener("click", () => void perform(() => loadHistory()));
  window.addEventListener("whiteboard-sync-status", update);
  update();
})();
