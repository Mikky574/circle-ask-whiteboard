(() => {
  // The service owns documents; localStorage is only the synchronous UI cache.
  // Keep this before memory.js and project-specific installers in index.html.
  const endpoint = "/api/board-store";
  const catalogKey = "whiteboard.codex.boards.v1";
  const recoveryPrefix = "whiteboard.codex.browser-backup.";
  const pendingKey = "whiteboard.codex.pending-server-saves.v1";
  const fields = ["memory", "organization", "templateBackup", "guideBackup"];
  const defaults = [
    ["original", "原白板"], ["project-design", "项目定义与交付"],
    ["repo-manual", "代码仓库详解手册"], ["repo-atlas", "源码架构手册（Codex）"],
    ["project-workbench", "项目工作台"],
  ].map(([id, title]) => ({ id, title }));
  const builtins = new Set(defaults.map(({ id }) => id));
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  const cache = window.localStorage;
  const records = new Map();
  const dirty = new Map();
  const ownedPending = new Set();
  const owner = crypto.getRandomValues(new Uint32Array(2)).join("-");
  let catalog = [];
  let blocked = false;
  let conflict = false;
  let failure = "";
  let work = null;
  let inFlight = null;
  let generation = 0;
  let timer = null;
  let checking = false;
  let message = "正在连接本机白板服务…";
  let backups = false;
  const params = new URLSearchParams(location.search);
  const requested = params.get("board") || (/^[0-9a-f]{32}$/.test(params.get("project") || "")
    ? `board-${params.get("project")}` : params.has("project-guide") || params.has("rebuild-project")
      || location.hash === "#project-template" ? "original" : null);

  const get = (key) => nativeGet.call(cache, key);
  const put = (key, value) => value === null ? nativeRemove.call(cache, key) : nativeSet.call(cache, key, value);
  const validId = (id) => builtins.has(id) || /^board-[0-9a-f]{32}$/.test(id || "");
  const keys = (id) => {
    const prefix = id === "original" ? "whiteboard.codex" : `whiteboard.codex.${id}`;
    return { memory: `${prefix}.v1`, organization: `${prefix}.organization.v1`,
      templateBackup: `${prefix}.template-backup.v1`, guideBackup: `${prefix}.project-guide-backup.v1` };
  };
  const read = (id) => Object.fromEntries(Object.entries(keys(id)).map(([field, key]) => [field, get(key)]));
  const equalStorage = (a, b) => fields.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
  const metadata = (entry) => ({ id: entry.id, title: entry.title,
    ...(typeof entry.repositoryPath === "string" && entry.repositoryPath.trim() && entry.repositoryPath.length <= 1024
      ? { repositoryPath: entry.repositoryPath.trim() } : {}),
    ...(typeof entry.projectId === "string" && /^[0-9a-f]{32}$/.test(entry.projectId) && entry.id === `board-${entry.projectId}`
      ? { projectId: entry.projectId } : {}) });
  const sameMetadata = (a, b) => JSON.stringify(metadata(a)) === JSON.stringify(metadata(b));

  function cleanCatalog(value) {
    if (!Array.isArray(value)) return null;
    const result = new Map();
    for (const entry of value) {
      if (!entry || !validId(entry.id) || typeof entry.title !== "string" || !entry.title.trim()
          || entry.title.length > 80) continue;
      result.set(entry.id, metadata({ ...entry, title: entry.title.trim() }));
    }
    return [...result.values()];
  }

  function parseCatalog(raw) {
    try { return cleanCatalog(JSON.parse(raw)); } catch { return null; }
  }

  function requestSync(body) {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint, false);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(body));
    let result;
    try { result = JSON.parse(xhr.responseText); } catch { result = {}; }
    if (xhr.status < 200 || xhr.status >= 300) {
      const error = new Error(result.text || "无法读取本机白板服务，请检查服务并重试。旧内容仍保留在浏览器中。");
      error.status = xhr.status;
      error.result = result;
      throw error;
    }
    return result;
  }

  async function request(body) {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.text || "白板尚未保存到本机服务，请重试。浏览器副本已保留。");
      error.status = response.status;
      error.result = result;
      throw error;
    }
    return result;
  }

  function preserve(id, storage = read(id), entry = catalog.find((item) => item.id === id)) {
    if (!fields.some((field) => storage[field] !== null)) return;
    const value = { board: id, metadata: entry || { id, title: id }, storage, savedAt: new Date().toISOString() };
    // This browser-only recovery record is deliberately outside the document whitelist.
    for (let index = 0; index < cache.length; index += 1) {
      const key = cache.key(index);
      if (!key?.startsWith(`${recoveryPrefix}${id}.`)) continue;
      try {
        if (equalStorage(JSON.parse(get(key))?.storage, storage)) { backups = true; return; }
      } catch { /* Preserve malformed old recovery files instead of replacing them. */ }
    }
    put(`${recoveryPrefix}${id}.${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}.v1`, JSON.stringify(value));
    backups = true;
  }

  function hydrate(board) {
    const previous = read(board.id);
    if (!equalStorage(previous, board.storage)) preserve(board.id, previous);
    for (const [field, key] of Object.entries(keys(board.id))) put(key, board.storage[field] ?? null);
    records.set(board.id, board);
  }

  function notifyCatalog(next) {
    const oldValue = get(catalogKey);
    catalog = next;
    const newValue = JSON.stringify(next);
    if (oldValue === newValue) return;
    put(catalogKey, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key: catalogKey, oldValue, newValue, storageArea: cache }));
  }

  function render() {
    const panel = document.getElementById("board-sync-status");
    if (!panel) return;
    const pending = dirty.size > 0 || Boolean(work);
    panel.dataset.state = blocked || conflict || failure ? "error" : pending ? "saving" : "saved";
    const text = failure || message;
    document.getElementById("board-sync-message").textContent = text;
    document.getElementById("board-sync-retry").hidden = !blocked && !conflict && !failure;
    document.getElementById("board-sync-retry").textContent = conflict || blocked ? "重新加载" : "重试保存";
    document.getElementById("board-sync-export").hidden = !backups && !blocked && !conflict && !failure;
    panel.hidden = false;
    window.dispatchEvent(new CustomEvent("whiteboard-sync-status", { detail: { pending, blocked, conflict, failure } }));
  }

  function remoteConflict(text) {
    conflict = true;
    failure = text || "这张白板已在其他浏览器更新。本页内容已保留，请导出未保存内容后重新加载。";
    for (const id of dirty.keys()) { try { preserve(id); } catch { /* The original cache remains available for export. */ } }
    render();
    window.dispatchEvent(new Event("whiteboard-storage-conflict"));
  }

  function start() {
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      throw new Error("请通过本机白板服务打开，直接打开 HTML 不能共享白板。");
    }
    const local = parseCatalog(get(catalogKey)) || defaults;
    const listing = requestSync({ action: "list" });
    if (!Array.isArray(listing.boards) || !Array.isArray(listing.deleted)) throw new Error("白板服务返回的目录无效，请更新服务后重试。");
    const deleted = new Set(listing.deleted.map(({ id }) => id));
    const remote = new Map(listing.boards.map((board) => [board.id, board]));
    catalog = local;
    // A reload can happen between a synchronous UI save and its HTTP acknowledgement.
    // Resume only against the same server revision; never replace a newer document.
    let pending;
    try { pending = JSON.parse(get(pendingKey)) || {}; } catch { pending = {}; }
    for (const [id, saved] of Object.entries(pending)) {
      if (!validId(id) || !saved || !Number.isSafeInteger(saved.baseRevision)) continue;
      const current = remote.get(id);
      const entry = local.find((item) => item.id === id) || saved.metadata;
      if (deleted.has(id) || (current?.revision ?? 0) !== saved.baseRevision) {
        if (current && !saved.deleted && entry) {
          const latest = requestSync({ action: "load", id }).board;
          if (latest && sameMetadata(latest, entry) && equalStorage(latest.storage, read(id))) {
            records.set(id, latest);
            delete pending[id];
            continue;
          }
        }
        preserve(id, read(id), entry);
        delete pending[id];
        continue;
      }
      try {
      if (saved.deleted) {
        if (current) requestSync({ action: "delete", id, expectedRevision: saved.baseRevision });
        remote.delete(id);
        deleted.add(id);
      } else if (entry) {
        const previous = current ? requestSync({ action: "load", id }).board : null;
        if (previous) records.set(id, previous);
        const snapshot = read(id);
        const storage = previous ? { ...previous.storage } : snapshot;
        for (const field of saved.fields || []) if (fields.includes(field)) storage[field] = snapshot[field];
        const result = requestSync({ action: "save", id, expectedRevision: saved.baseRevision,
          metadata: metadata(entry), storage });
        remote.set(id, result.board);
        records.set(id, result.board);
      }
      delete pending[id];
      } catch (error) {
        if (error.status === 409) {
          preserve(id, read(id), entry);
          delete pending[id];
          const latest = requestSync({ action: "load", id });
          if (latest.board) { remote.set(id, latest.board); records.set(id, latest.board); }
          else if (latest.deleted) { remote.delete(id); deleted.add(id); }
          continue;
        }
        dirty.set(id, { fields: new Set((saved.fields || []).filter((field) => fields.includes(field))),
          metadata: true, deleted: Boolean(saved.deleted) });
        ownedPending.add(id);
        failure = "保存失败，浏览器副本仍保留。服务恢复后请点「重试保存」。";
        pending[id].owner = owner;
      }
    }
    put(pendingKey, JSON.stringify(pending));
    // Import legacy browser records once, without replacing any server document.
    for (const entry of local) {
      if (remote.has(entry.id) || deleted.has(entry.id) || pending[entry.id]) continue;
      const storage = read(entry.id);
      if (builtins.has(entry.id) && !fields.some((field) => storage[field] !== null)) continue;
      try {
        const result = requestSync({ action: "save", id: entry.id, expectedRevision: 0, metadata: entry, storage });
        remote.set(entry.id, result.board);
        records.set(entry.id, result.board);
      } catch (error) {
        if (error.status !== 409) throw error;
        if (error.result.deleted) deleted.add(entry.id);
        else if (error.result.board) remote.set(entry.id, error.result.board);
        else throw error;
      }
    }
    for (const entry of local) if (deleted.has(entry.id)) preserve(entry.id, read(entry.id), entry);
    const next = new Map(local.filter(({ id }) => !deleted.has(id)).map((entry) => [entry.id, entry]));
    for (const board of remote.values()) {
      next.set(board.id, metadata(board));
      if (!records.has(board.id)) records.set(board.id, { ...board, storage: null });
    }
    catalog = [...next.values()];
    if (requested && remote.has(requested) && !dirty.has(requested)) {
      const result = remote.get(requested).storage ? { board: remote.get(requested) } : requestSync({ action: "load", id: requested });
      if (result.board) {
        hydrate(result.board);
        catalog = catalog.map((entry) => entry.id === requested ? metadata(result.board) : entry);
      } else if (result.deleted) {
        preserve(requested);
        catalog = catalog.filter(({ id }) => id !== requested);
        records.delete(requested);
      }
    }
    put(catalogKey, JSON.stringify(catalog));
    message = "已连接本机服务";
    if (backups) message += " · 已保留本浏览器旧版本";
  }

  function changed(id) {
    ownedPending.add(id);
    if (!dirty.has(id)) dirty.set(id, { fields: new Set(), metadata: false, deleted: false });
    return dirty.get(id);
  }

  function schedule() {
    generation += 1;
    persistPending();
    message = "正在保存到本机服务…";
    render();
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => {}); }, 140);
  }

  function persistPending() {
    if (blocked || conflict) return;
    const pending = new Map(dirty);
    if (inFlight && !pending.has(inFlight.id)) pending.set(inFlight.id, inFlight.change);
    else if (inFlight) {
      const latest = pending.get(inFlight.id);
      pending.set(inFlight.id, { ...latest, fields: new Set([...inFlight.change.fields, ...latest.fields]),
        metadata: inFlight.change.metadata || latest.metadata, deleted: inFlight.change.deleted || latest.deleted });
    }
    let savedPending;
    try { savedPending = JSON.parse(get(pendingKey)) || {}; } catch { savedPending = {}; }
    for (const [id, value] of Object.entries(savedPending)) {
      if (value.owner === owner && !pending.has(id)) delete savedPending[id];
    }
    const entries = [...pending].map(([id, value]) => [id, {
      owner,
      baseRevision: records.get(id)?.revision || 0, fields: [...value.fields], deleted: value.deleted,
      metadata: catalog.find((entry) => entry.id === id) || (records.get(id) ? metadata(records.get(id)) : null),
    }]);
    put(pendingKey, JSON.stringify({ ...savedPending, ...Object.fromEntries(entries) }));
  }

  function ensureWritable() {
    if (blocked || conflict || failure) throw new Error(failure || "白板服务尚未就绪，请保留本页内容后重新加载。");
  }

  function identify(key) {
    for (const entry of catalog) {
      for (const [field, item] of Object.entries(keys(entry.id))) if (item === key) return { id: entry.id, field };
    }
    return null;
  }

  function cacheWrite(storage, key, value, remove = false) {
    const native = remove ? nativeRemove : nativeSet;
    if (storage !== cache) return remove ? native.call(storage, key) : native.call(storage, key, value);
    key = String(key);
    if (key === catalogKey) {
      ensureWritable();
      const next = remove ? defaults : parseCatalog(String(value));
      if (!next) throw new Error("白板目录无效，未保存。");
      const before = new Map(catalog.map((entry) => [entry.id, entry]));
      const after = new Map(next.map((entry) => [entry.id, entry]));
      for (const [id, entry] of after) {
        if (!before.has(id) || !sameMetadata(entry, before.get(id))) {
          const change = changed(id);
          change.metadata = true;
          change.deleted = false;
        }
      }
      for (const id of before.keys()) if (!after.has(id)) changed(id).deleted = true;
      put(key, JSON.stringify(next));
      catalog = next;
      if (dirty.size) schedule();
      return;
    }
    const board = identify(key);
    if (!board) return remove ? native.call(storage, key) : native.call(storage, key, value);
    ensureWritable();
    const previous = get(key);
    const next = remove ? null : String(value);
    if (previous === next) return;
    put(key, next);
    changed(board.id).fields.add(board.field);
    schedule();
  }

  function accept(board) {
    records.set(board.id, board);
    message = "已保存到本机服务";
  }

  async function commit(id, change, snapshot, entry) {
    let record = records.get(id);
    if (change.deleted) {
      if (!record?.revision) { records.delete(id); return; }
      try { await request({ action: "delete", id, expectedRevision: record.revision }); }
      catch (error) { if (error.status !== 409 || !error.result.deleted) throw error; }
      records.delete(id);
      message = "已保存到本机服务";
      return;
    }
    if (!entry) return;
    if (record && !record.storage) {
      const loaded = await request({ action: "load", id });
      if (!loaded.board || loaded.board.revision !== record.revision) {
        const error = new Error("这张白板已在其他浏览器更新，请保留本页内容后重新加载。");
        error.status = 409;
        throw error;
      }
      record = loaded.board;
      records.set(id, record);
    }
    const storage = record ? { ...record.storage } : { ...snapshot };
    for (const field of change.fields) storage[field] = snapshot[field];
    try {
      const result = await request({ action: "save", id, expectedRevision: record?.revision || 0, metadata: entry, storage });
      accept(result.board);
    } catch (error) {
      // An interrupted acknowledgement may have committed. Accept only an exact match.
      const saved = error.result?.board;
      if (error.status === 409 && saved && sameMetadata(saved, entry) && equalStorage(saved.storage, storage)) accept(saved);
      else throw error;
    }
  }

  async function flush() {
    clearTimeout(timer);
    if (blocked || conflict) throw new Error(failure || "请重新加载白板。");
    if (work) return work;
    if (failure) throw new Error(failure);
    if (!dirty.size) return;
    const operation = async () => {
      while (dirty.size) {
        const [id, change] = dirty.entries().next().value;
        const entry = catalog.find((item) => item.id === id);
        const snapshot = read(id);
        dirty.delete(id);
        inFlight = { id, change };
        try { await commit(id, change, snapshot, entry); }
        catch (error) {
          const later = dirty.get(id);
          if (later) {
            change.fields.forEach((field) => later.fields.add(field));
            later.metadata ||= change.metadata;
            later.deleted ||= change.deleted;
          } else dirty.set(id, change);
          if (error.status === 409) remoteConflict(error.message);
          else {
            failure = `保存失败：${error.message || "连接中断"} 浏览器副本已保留，尚未保存到服务端。`;
            for (const boardId of dirty.keys()) { try { preserve(boardId); } catch { /* The live cache remains intact. */ } }
          }
          throw error;
        } finally { inFlight = null; persistPending(); }
      }
    };
    work = operation();
    render();
    try { await work; }
    finally { work = null; persistPending(); render(); }
  }

  async function refresh() {
    if (checking || blocked || conflict || failure || work || dirty.size || document.visibilityState === "hidden") return;
    checking = true;
    const before = generation;
    try {
      const listing = await request({ action: "list" });
      if (generation !== before || work || dirty.size || blocked || conflict || failure) return;
      if (!Array.isArray(listing.boards) || !Array.isArray(listing.deleted)) return;
      const remote = new Map(listing.boards.map((board) => [board.id, board]));
      const deleted = new Set(listing.deleted.map(({ id }) => id));
      const active = window.BoardMemory?.activeBoard || requested;
      const saved = records.get(active);
      if ((saved && (deleted.has(active) || (remote.get(active)?.revision ?? 0) !== saved.revision)) ||
          (!saved && remote.has(active))) {
        remoteConflict("这张白板已在其他浏览器更新。本页草稿仍在，请先保留草稿，再点「重新加载」。");
        return;
      }
      const next = new Map(catalog.filter(({ id }) => !deleted.has(id)).map((entry) => [entry.id, entry]));
      for (const board of remote.values()) {
        next.set(board.id, metadata(board));
        if (board.id !== active) records.set(board.id, { ...board, storage: null });
      }
      notifyCatalog([...next.values()]);
    } catch { /* A read-only poll must not turn a healthy local edit into a conflict. */ }
    finally { checking = false; }
  }

  function exportLocal() {
    const documents = catalog.map((entry) => ({ ...entry, storage: read(entry.id) }));
    const recovered = [];
    for (let i = 0; i < cache.length; i += 1) {
      const key = cache.key(i);
      if (key?.startsWith(recoveryPrefix)) {
        try { recovered.push(JSON.parse(get(key))); } catch { /* Skip malformed old backups. */ }
      }
    }
    const blob = new Blob([JSON.stringify({ format: "circle-ask-whiteboard-recovery-v1", documents, recovered }, null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `白板本机备份-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  try {
    for (let i = 0; i < cache.length; i += 1) {
      if (cache.key(i)?.startsWith(recoveryPrefix)) { backups = true; break; }
    }
    start();
  }
  catch (error) {
    blocked = true;
    failure = error.message || "无法读取本机白板服务。请保留本浏览器内容后重试。";
    // No writes are allowed after an incomplete bootstrap.
    catalog = parseCatalog(get(catalogKey)) || defaults;
  }
  Storage.prototype.setItem = function (key, value) { return cacheWrite(this, key, value); };
  Storage.prototype.removeItem = function (key) { return cacheWrite(this, key, null, true); };
  window.BoardSync = {
    ready: Promise.resolve(), flush, refresh, exportLocal,
    hasServerBoard(id) { return Boolean(records.get(id)?.storage?.organization); },
    get currentRevision() { return records.get(window.BoardMemory?.activeBoard || requested)?.revision || 0; },
    get pending() { return Boolean(work || dirty.size); },
    get writable() { return !blocked && !conflict && !failure; },
    get failed() { return Boolean(blocked || conflict || failure); },
  };
  document.getElementById("board-sync-retry")?.addEventListener("click", () => {
    if (blocked || conflict) {
      if (window.confirm("重新加载会放弃本页尚未发送的问题和未保存编辑。可先点「导出本机副本」保留白板内容，是否继续？")) {
        if (conflict) {
          let pending;
          try { pending = JSON.parse(get(pendingKey)) || {}; } catch { pending = {}; }
          for (const [id, value] of Object.entries(pending)) {
            if (value.owner === owner || id === requested) delete pending[id];
          }
          put(pendingKey, JSON.stringify(pending));
          dirty.clear();
        }
        location.reload();
      }
    } else {
      failure = "";
      message = "正在保存到本机服务…";
      void flush().catch(() => {});
    }
  });
  document.getElementById("board-sync-export")?.addEventListener("click", exportLocal);
  window.addEventListener("beforeunload", (event) => {
    if (!work && !dirty.size) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => void refresh());
  setInterval(() => void refresh(), 5000);
  render();
})();
