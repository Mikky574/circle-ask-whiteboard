(() => {
  const originalPrefix = "whiteboard.codex";
  const catalogKey = `${originalPrefix}.boards.v1`;
  const projectBoard = "project-design";
  const repoManual = "repo-manual";
  const repoAtlas = "repo-atlas";
  const projectWorkbench = "project-workbench";
  const localProjectsBoard = "local-projects";
  const localProjectsInfo = { id: localProjectsBoard, title: "本机项目总览", custom: false };
  const builtInBoards = new Map([
    ["original", "原白板"],
    [projectBoard, "项目定义与交付"],
    [repoManual, "代码仓库详解手册"],
    [repoAtlas, "源码架构手册（Codex）"],
    [projectWorkbench, "项目工作台"],
  ]);
  const initialBoards = listBoards();
  const activeBoard = selectActiveBoard(initialBoards);
  const activeBoardInfo = activeBoard === localProjectsBoard ? localProjectsInfo : initialBoards.find(({ id }) => id === activeBoard);
  const prefix = boardPrefix(activeBoard);
  const storageKeys = Object.freeze(boardStorageKeys(activeBoard));
  const { memory: storageKey, organization: organizationKey } = storageKeys;
  let knownStorage = null;
  let storageConflicted = false;

  function storageSnapshot() {
    return [storageKey, organizationKey].map((key) => window.localStorage.getItem(key));
  }

  function storageIsCurrent() {
    if (window.BoardSync && !window.BoardSync.writable) return false;
    try {
      const current = storageSnapshot();
      if (!knownStorage) knownStorage = current;
      if (!storageConflicted) {
        if (listBoards().some(({ id }) => id === activeBoard) &&
            current.every((value, index) => value === knownStorage[index])) return true;
        storageConflicted = true;
        window.dispatchEvent(new Event("whiteboard-storage-conflict"));
      }
    } catch { /* Storage errors are reported by the caller as unsaved changes. */ }
    return false;
  }

  function writeStorage(key, value) {
    if (![storageKey, organizationKey].includes(key) || !storageIsCurrent()) return false;
    try {
      window.localStorage.setItem(key, value);
      knownStorage[[storageKey, organizationKey].indexOf(key)] = value;
      return true;
    } catch { return false; }
  }
  const templateBackupKey = `${prefix}.template-backup.v1`;
  const guideBackupKey = `${prefix}.project-guide-backup.v1`;
  const defaultGoal = "边体验、边改进这张白板，弄清圈选、分支记忆和 Codex 改码是怎么实现的。";
  const defaultConstraints = ["保留圈选和就地批注的交互", "项目主线只记录用户确认过的决定"];
  const sourceFiles = new Set(["index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "run_gate.js",
    "project_finder.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py", "backends.py", "api_backend.py",
    "board_tools.py", "local_projects.py", "board_transfer.js", "board_store.py", "board_sync.js", "board_versions.js"]);
  const branchLabels = {
    E01: "E01 · 圈选与坐标",
    E02: "E02 · 提问与批注定位",
    E03: "E03 · 分支与项目记忆",
    board: activeBoard === "original" ? "整板 · 白板实现" : activeBoardInfo && `整板 · ${activeBoardInfo.title}`,
  };

  function boardPrefix(id) {
    return id === "original" ? originalPrefix : `${originalPrefix}.${id}`;
  }

  function boardStorageKeys(id) {
    const prefix = boardPrefix(id);
    return { memory: `${prefix}.v1`, organization: `${prefix}.organization.v1` };
  }

  function savedRepositoryPath(value) {
    return typeof value === "string" && value.length <= 1024 ? value.trim() : "";
  }

  function listBoards() {
    try {
      const saved = window.localStorage.getItem(catalogKey);
      const entries = saved === null ? null : JSON.parse(saved);
      if (Array.isArray(entries)) {
        const unique = new Map();
        for (const entry of entries) {
          const id = entry?.id;
          if (typeof id !== "string" || unique.has(id)) continue;
          const custom = !builtInBoards.has(id);
          const title = custom ? text(entry.title, 80).trim() : builtInBoards.get(id);
          const repositoryPath = savedRepositoryPath(entry.repositoryPath);
          if (title && (!custom || /^board-[0-9a-f]{32}$/.test(id))) {
            const project = custom && typeof entry.projectId === "string" && id === `board-${entry.projectId}`;
            unique.set(id, { id, title, custom, ...(repositoryPath ? { repositoryPath } : {}),
              ...(project ? { projectId: entry.projectId } : {}) });
          }
        }
        return [...unique.values()];
      }
    } catch { /* Default boards still open if the catalog cannot be read. */ }
    return Array.from(builtInBoards, ([id, title]) => ({ id, title, custom: false }));
  }

  function selectActiveBoard(boards) {
    const search = window.location?.search;
    const params = search ? new URLSearchParams(search) : null;
    const requested = params?.get("board") ?? null;
    if (requested === localProjectsBoard) return localProjectsBoard;
    const exists = (boardId) => boards.some(({ id }) => id === boardId);
    if (exists(requested)) return requested;
    if (requested === null && (params?.has("project-guide") || params?.has("rebuild-project") ||
        window.location?.hash === "#project-template")) {
      return exists("original") ? "original" : boards[0]?.id ?? localProjectsBoard;
    }
    return localProjectsBoard;
  }

  function changeBoards(change) {
    const commit = async () => {
      if (window.BoardSync) await window.BoardSync.flush();
      const result = await change();
      if (window.BoardSync) await window.BoardSync.flush();
      return result;
    };
    return window.navigator?.locks
      ? window.navigator.locks.request(catalogKey, commit)
      : Promise.resolve().then(commit);
  }

  function saveBoardList(boards) {
    window.localStorage.setItem(catalogKey, JSON.stringify(boards.map(({ id, title, repositoryPath, projectId }) =>
      ({ id, title, ...(repositoryPath ? { repositoryPath } : {}), ...(projectId ? { projectId } : {}) }))));
  }

  function createBoard(title, repositoryPath = "") {
    return changeBoards(() => {
      const name = title.trim();
      if (!name || name.length > 80) throw new Error("请填写白板名称，最多 80 字。");
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      const id = `board-${token}`;
      saveBoardList([...listBoards(), { id, title: name, repositoryPath: savedRepositoryPath(repositoryPath) }]);
      return id;
    });
  }

  function importBoard(document, title, repositoryPath = "") {
    return changeBoards(() => {
      const name = typeof title === "string" ? title.trim() : "";
      if (!name || name.length > 80) throw new Error("请填写白板名称，最多 80 字。");
      // Revalidate at the persistence boundary; the catalog is published only
      // after both documents have been written successfully.
      const portable = window.BoardTransfer.parse(JSON.stringify(window.BoardTransfer.create(document)));
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      const id = `board-${token}`;
      const keys = boardStorageKeys(id);
      if (listBoards().some((entry) => entry.id === id) ||
          Object.values(keys).some((key) => localStorage.getItem(key) !== null)) {
        throw new Error("生成的白板编号已存在，请重试。");
      }
      const contents = state(portable.memory);
      for (const note of contents.notes) {
        note.payload.boardId = id;
        if (note.retryPayload) note.retryPayload.boardId = id;
      }
      const importedOrganization = { ...portable.organization };
      if (importedOrganization.current) importedOrganization.current.title = name;
      const storage = window.localStorage;
      try {
        storage.setItem(keys.memory, JSON.stringify(contents));
        storage.setItem(keys.organization, JSON.stringify(importedOrganization));
        saveBoardList([...listBoards(), { id, title: name, repositoryPath: savedRepositoryPath(repositoryPath) }]);
      } catch (error) {
        Object.values(keys).forEach((key) => storage.removeItem(key));
        throw error;
      }
      return id;
    });
  }

  function openLocalProject(projectId, title, repositoryPath) {
    return changeBoards(() => {
      const id = `board-${projectId}`;
      const name = text(title, 80).trim();
      const path = savedRepositoryPath(repositoryPath);
      if (!/^board-[0-9a-f]{32}$/.test(id) || !name || !path) throw new Error("无效的项目目录或项目名称。");
      const boards = listBoards();
      const existing = boards.find((entry) => entry.id === id);
      if (!existing) {
        saveBoardList([...boards, { id, title: name, repositoryPath: path, projectId }]);
      } else if (existing.repositoryPath !== path || existing.title !== name || existing.projectId !== projectId) {
        Object.assign(existing, { title: name, repositoryPath: path, projectId });
        saveBoardList(boards);
      }
      return id;
    });
  }

  function updateBoardRepository(id, repositoryPath, expectedPath) {
    return changeBoards(() => {
      if (id === localProjectsBoard) throw new Error("总览中的目录由本机项目清单提供。");
      const boards = listBoards();
      const board = boards.find((item) => item.id === id);
      if (!board) throw new Error("这张白板已删除。");
      if ((board.repositoryPath || "") !== expectedPath) {
        throw new Error("项目目录已在另一页面修改，请重新打开设置。");
      }
      const path = savedRepositoryPath(repositoryPath);
      if (path !== expectedPath) {
        board.repositoryPath = path;
        saveBoardList(boards);
      }
      return path;
    });
  }

  function deleteActiveBoard() {
    return changeBoards(() => {
      if (activeBoard === localProjectsBoard) throw new Error("本机项目总览是内置白板。");
      if (!activeBoard || !storageIsCurrent()) throw new Error("白板已在另一页面变更，请刷新后重试。");
      const storage = window.localStorage;
      const previousCatalog = storage.getItem(catalogKey);
      const remaining = listBoards().filter(({ id }) => id !== activeBoard);
      const keys = [storageKey, organizationKey, templateBackupKey, guideBackupKey];
      const previousValues = keys.map((key) => storage.getItem(key));
      saveBoardList(remaining);
      try {
        keys.forEach((key) => storage.removeItem(key));
      } catch (error) {
        for (const [index, key] of keys.entries()) {
          if (previousValues[index] !== null) storage.setItem(key, previousValues[index]);
        }
        if (previousCatalog === null) storage.removeItem(catalogKey);
        else storage.setItem(catalogKey, previousCatalog);
        throw error;
      }
    });
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function text(value, limit) {
    return typeof value === "string" ? value.slice(0, limit) : "";
  }

  function cleanAttachments(value) {
    const byId = new Map();
    for (const item of list(value)) {
      if (typeof item?.id !== "string" || !/^[a-f0-9]{32}$/.test(item.id) ||
          typeof item.name !== "string" || !item.name || !Number.isInteger(item.size) ||
          item.size < 0 || item.size > 10 * 1024 * 1024) continue;
      byId.set(item.id, { id: item.id, name: text(item.name, 200), size: item.size });
      if (byId.size === 16) break;
    }
    return [...byId.values()];
  }

  function ids(value) {
    return [...new Set(list(value).filter((id) =>
      typeof id === "string" && /^(?:[EA]\d+|board)$/.test(id),
    ))].slice(0, 24);
  }

  function noteId(value) {
    return typeof value === "string" && /^A\d+$/.test(value) ? value : null;
  }

  function rectangle(value) {
    if (!value) return null;
    const { x, y, width, height } = value;
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
    return { x, y, width, height };
  }

  function projectState(value) {
    return {
      goal: typeof value?.goal === "string" ? text(value.goal, 800) : activeBoardInfo?.custom ? "" : defaultGoal,
      constraints: Array.isArray(value?.constraints)
        ? value.constraints.map((entry) => text(entry, 300).trim()).filter(Boolean).slice(0, 24)
        : activeBoardInfo?.custom ? [] : [...defaultConstraints],
      decisions: list(value?.decisions).flatMap((entry) => {
        const decision = text(entry?.text, 700).trim();
        return decision ? [{ text: decision, sourceIds: ids(entry.sourceIds) }] : [];
      }),
    };
  }

  function notePayload(value) {
    const question = text(value?.question, 1000).trim();
    const elementIds = ids(value?.anchor?.elementIds);
    const box = rectangle(value?.anchor?.box);
    if (!question || !elementIds.length || !box) return null;
    const anchor = { elementIds, box, quote: text(value.anchor.quote, 600) };
    const wholeCardIds = ids(value.anchor.wholeCardIds).filter((id) => id !== "board" && elementIds.includes(id));
    if (wholeCardIds.length) anchor.wholeCardIds = wholeCardIds;
    if (Array.isArray(value.anchor.sourceFiles)) {
      anchor.sourceFiles = [...new Set(value.anchor.sourceFiles.filter((file) => sourceFiles.has(file)))];
    }
    const formulaFragments = list(value.anchor.formulaFragments).flatMap((fragment) => {
      if (!elementIds.includes(fragment?.elementId)) return [];
      return [{
        elementId: fragment.elementId,
        quote: text(fragment.quote, 600),
        source: text(fragment.source, 1000),
      }];
    }).slice(0, 24);
    const noteContexts = list(value.anchor.noteContexts).flatMap((context) => {
      if (!elementIds.includes(context?.elementId)) return [];
      return [{
        elementId: context.elementId,
        originalQuestion: text(context.originalQuestion, 1000),
        sourceCardIds: ids(context.sourceCardIds),
      }];
    }).slice(0, 24);
    if (formulaFragments.length) anchor.formulaFragments = formulaFragments;
    if (noteContexts.length) anchor.noteContexts = noteContexts;
    const payload = { boardId: text(value.boardId, 80), anchor, question };
    const attachments = cleanAttachments(value.attachments);
    if (attachments.length) payload.attachments = attachments;
    if (value.mode === "ask" || value.mode === "edit") payload.mode = value.mode;
    if (["extend", "explain", "independent"].includes(value.scope)) payload.scope = value.scope;
    if (value.scope === "explain" && value.minimumDepth === 2) payload.minimumDepth = 2;
    if (value.scope === "explain" && typeof value.sourceAnswer?.answer === "string") {
      payload.sourceAnswer = { question: text(value.sourceAnswer.question, 1000), answer: text(value.sourceAnswer.answer, 16000) };
    }
    const revision = value.revisionContext;
    if (ids([revision?.elementId]).length) {
      payload.revisionContext = { elementId: revision.elementId, quote: text(revision.quote, 600) };
    }
    return payload;
  }

  function state(value) {
    const notes = new Map();
    for (const entry of list(value?.notes)) {
      const id = noteId(entry?.id);
      if (!id || notes.has(id)) continue;
      const rect = rectangle(entry.rect);
      const payload = notePayload(entry.payload);
      if (!rect || !payload || typeof entry.answer !== "string") continue;
      const delivery = ["pending", "failed", "stopped", "interrupted"].includes(entry.delivery) ? entry.delivery : null;
      const retryPayload = delivery ? notePayload(entry.retryPayload) : null;
      const sectionOf = noteId(entry.sectionOf);
      const outline = entry.outline === true;
      const originalAnswer = outline ? text(entry.originalAnswer, 16000) : "";
      notes.set(id, {
        id,
        kind: entry.kind === "branch" ? "branch" : "note",
        branchId: noteId(entry.branchId),
        archived: entry.archived === true,
        rect,
        payload,
        sourceCardIds: ids(entry.sourceCardIds),
        answer: text(entry.answer, 16000),
        anchors: list(entry.anchors).map(rectangle).filter(Boolean).slice(0, 24),
        ...(delivery ? { delivery, deliveryMessage: text(entry.deliveryMessage, 1000) } : {}),
        ...(retryPayload ? { retryPayload } : {}),
        ...(sectionOf && sectionOf !== id && payload.anchor.elementIds.includes(sectionOf) ? { sectionOf } : {}),
        ...(outline ? { outline, outlineCollapsed: entry.outlineCollapsed === true } : {}),
        ...(originalAnswer ? { originalAnswer } : {}),
      });
    }
    const pinnedIds = [...new Set(list(value?.pinnedIds).filter((id) =>
      typeof id === "string" && /^[EA]\d+$/.test(id),
    ))];
    return { project: projectState(value?.project), notes: [...notes.values()], pinnedIds,
      deletedIds: list(value?.deletedIds).filter((id) => typeof id === "string" && /^[EA]\d+$/.test(id)),
      pendingRepair: text(value?.pendingRepair, 16000) };
  }

  function load() {
    try {
      if (!knownStorage) knownStorage = storageSnapshot();
      return state(JSON.parse(window.localStorage.getItem(storageKey)));
    } catch {
      return state(null);
    }
  }

  function save(value) {
    return writeStorage(storageKey, JSON.stringify(state(value)));
  }

  function exchangeBoard(next, backupKey, formatBackup = (previous) => previous) {
    if (!storageIsCurrent()) throw new Error("白板已在另一页面更新，请保留草稿后刷新。");
    const storage = window.localStorage;
    const keys = [storageKey, organizationKey];
    const previous = keys.map((key) => storage.getItem(key));
    const previousBackup = storage.getItem(backupKey);
    const write = (values) => keys.forEach((key, index) => {
      if (values[index] === null) storage.removeItem(key);
      else storage.setItem(key, values[index]);
    });
    storage.setItem(backupKey, JSON.stringify(formatBackup(previous)));
    try {
      write(next);
      knownStorage = storageSnapshot();
    } catch (error) {
      write(previous);
      if (previousBackup === null) storage.removeItem(backupKey);
      else storage.setItem(backupKey, previousBackup);
      throw error;
    }
  }

  function boardBackup(backupKey) {
    try {
      const saved = JSON.parse(window.localStorage.getItem(backupKey));
      const values = Array.isArray(saved) ? saved : saved?.values;
      return Array.isArray(values) && values.length === 2 && values.every((value) =>
        value === null || typeof value === "string") ? { values, guideId: saved.guideId || "" } : null;
    } catch {
      return null;
    }
  }

  function boardContents(value, sampleIds, appliedGuideId, initialProject) {
    const current = window.BoardOrganization.clean(value);
    const roots = current?.items.filter((item) => item.parentId === null);
    if (!current || roots.length !== 1 || current.items.length !== value.items.length ||
        current.items.length > 64 || current.items.some((item, index) => item.parentId !== value.items[index].parentId ||
          !/^E\d+$/.test(item.id) || sampleIds.includes(item.id))) {
      return null;
    }
    const project = initialProject ? projectState(initialProject) : load().project;
    if (project.goal === defaultGoal) project.goal = "把圈问白板做成可按粒度展开的项目管理与设计模板。";
    project.decisions.forEach((decision) => { decision.sourceIds = []; });
    const memory = state({ project, deletedIds: sampleIds, pinnedIds: [roots[0].id] });
    return [JSON.stringify(memory), JSON.stringify({ current, appliedGuideId, undoAvailable: false })];
  }

  function installBoard(value, sampleIds, backupKey, appliedGuideId = "") {
    const backup = boardBackup(backupKey);
    if (backup && (!appliedGuideId || backup.guideId === appliedGuideId)) return false;
    const contents = boardContents(value, sampleIds, appliedGuideId);
    if (!contents) return false;
    const active = appliedGuideId && window.BoardOrganization.load();
    const updatingGuide = backup && active?.current?.projectGuide &&
      (!backup.guideId || active.appliedGuideId === backup.guideId);
    exchangeBoard(contents, backupKey,
      appliedGuideId ? (previous) => ({ guideId: appliedGuideId, values: updatingGuide ? backup.values : previous }) : undefined);
    return true;
  }

  function legacyProjectContents(guideId, rootId) {
    const storage = window.localStorage;
    const memory = storage.getItem(`${originalPrefix}.v1`);
    const organization = storage.getItem(`${originalPrefix}.organization.v1`);
    if (!memory || !organization || !guideId || !rootId) return null;
    try {
      const plan = JSON.parse(organization);
      if (plan?.appliedGuideId !== guideId || window.BoardOrganization.clean(plan.current)?.projectGuide?.rootId !== rootId) return null;
      const saved = JSON.parse(memory);
      return Array.isArray(saved?.notes) && Array.isArray(saved?.deletedIds) ? [memory, organization] : null;
    } catch {
      return null;
    }
  }

  function initializeProjectBoard(value, sampleIds, guideId, initialProject) {
    if (activeBoard === "original") return false;
    const storage = window.localStorage;
    const keys = [storageKey, organizationKey];
    if (keys.some((key) => storage.getItem(key) !== null)) return false;
    const fresh = boardContents(value, sampleIds, guideId, initialProject);
    if (!fresh) return false;
    const contents = (activeBoard === projectBoard && legacyProjectContents(guideId, value.projectGuide?.rootId)) || fresh;
    if (keys.some((key) => storage.getItem(key) !== null)) return false;
    try {
      keys.forEach((key, index) => storage.setItem(key, contents[index]));
      knownStorage = storageSnapshot();
      return true;
    } catch (error) {
      keys.forEach((key, index) => {
        if (storage.getItem(key) === contents[index]) storage.removeItem(key);
      });
      throw error;
    }
  }

  function restoreBoard(backupKey) {
    const backup = boardBackup(backupKey);
    if (!backup) return false;
    exchangeBoard(backup.values, backupKey, backup.guideId ? (previous) => ({ guideId: backup.guideId, values: previous }) : undefined);
    return true;
  }

  function isRootId(id) {
    return id === "board" || (typeof id === "string" && /^E\d+$/.test(id));
  }

  function rootFor(note) {
    return [...list(note?.sourceCardIds), ...list(note?.payload?.anchor?.elementIds)]
      .find(isRootId) || "board";
  }

  function branchFor(anchorIds, notes, resolveMembership) {
    const history = list(notes).filter((note) => typeof note?.id === "string");
    const byId = new Map(history.map((note) => [note.id, note]));
    const membership = resolveMembership || ((id) => {
      const note = byId.get(id);
      const branchId = noteId(note?.branchId);
      const root = note ? rootFor(byId.get(branchId) || note) : isRootId(id) ? id : "board";
      return { root, branchId };
    });
    const anchors = list(anchorIds).map(membership);
    const { root, branchId } = anchors.find((anchor) => anchor.branchId) ||
      anchors.find((anchor) => anchor.root !== "board") || { root: "board" };
    const matches = history.filter((note) => {
      if (note.sectionOf || typeof note.answer !== "string" || !note.answer.trim() || (note.delivery && !note.retryPayload)) return false;
      const group = membership(note.id);
      return branchId ? group.branchId === branchId || note.id === branchId : !group.branchId && group.root === root;
    });
    const recent = matches.slice(-4).map((note) => ({
      question: text(note.payload?.question, 250),
      answer: text(note.answer, 900),
    }));
    const label = branchLabels[root] || `模块 ${root}`;
    return {
      label: branchId ? `分支 ${branchId} · ${label}` : label,
      summary: recent.length
        ? `本分支已有 ${matches.length} 条讨论。最近讨论的问题是「${text(recent.at(-1).question, 100)}」。`
        : "本分支暂时没有讨论记录。",
      recent,
    };
  }

  function deletionPlan(nodes, selectedIds) {
    const known = new Set(nodes.map((node) => node.id));
    const removed = new Set(selectedIds.filter((id) => known.has(id)));
    // Relationships describe context/order, not ownership. Only explicit selections are deleted.
    // The retained parent needs only a child-count update, which is local.
    const affected = nodes.filter((node) => !removed.has(node.id) &&
      removed.has(Object.hasOwn(node, "layoutParentId") ? node.layoutParentId : node.parentIds?.[0])).map((node) => node.id);
    return { removed: [...removed], affected };
  }

  function repairNodes(nodes) {
    const included = new Set(nodes.map((node) => node.id));
    return nodes.map((node) => ({ ...node,
      parentIds: (node.parentIds || []).filter((id) => id !== node.id && included.has(id)),
      ...(Object.hasOwn(node, "layoutParentId") ? {
        layoutParentId: included.has(node.layoutParentId) ? node.layoutParentId : null,
      } : {}),
    }));
  }

  window.BoardMemory = { load, save, branchFor, deletionPlan, repairNodes, cleanAttachments,
    activeBoard, activeBoardInfo, catalogKey, listBoards, createBoard, importBoard, updateBoardRepository, deleteActiveBoard,
    localProjectsBoard, openLocalProject,
    storageKeys, boardStorageKeys, initializeProjectBoard, storageIsCurrent, writeStorage,
    templateBackup: () => boardBackup(templateBackupKey),
    installTemplate: (value, sampleIds) => installBoard(value, sampleIds, templateBackupKey),
    restoreTemplate: () => restoreBoard(templateBackupKey),
    projectGuideBackup: () => boardBackup(guideBackupKey),
    projectGuideApplied: (id) => boardBackup(guideBackupKey)?.guideId === id,
    installProjectGuide: (value, sampleIds, guideId) => installBoard(value, sampleIds, guideBackupKey, guideId),
    restoreProjectGuide: () => restoreBoard(guideBackupKey),
  };
})();
