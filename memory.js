(() => {
  const storageKey = "whiteboard.codex.v1";
  const defaultGoal = "边体验、边改进这张白板，弄清圈选、分支记忆和 Codex 改码是怎么实现的。";
  const defaultConstraints = ["保留圈选和就地批注的交互", "项目主线只记录用户确认过的决定"];
  const sourceFiles = new Set(["index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py"]);
  const branchLabels = {
    E01: "E01 · 圈选与坐标",
    E02: "E02 · 提问与批注定位",
    E03: "E03 · 分支与项目记忆",
    board: "整板 · 白板实现",
  };

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
      goal: typeof value?.goal === "string" ? text(value.goal, 800) : defaultGoal,
      constraints: Array.isArray(value?.constraints)
        ? value.constraints.map((entry) => text(entry, 300).trim()).filter(Boolean).slice(0, 24)
        : [...defaultConstraints],
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
    if (value.scope === "extend") payload.scope = value.scope;
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
      return state(JSON.parse(window.localStorage.getItem(storageKey)));
    } catch {
      return state(null);
    }
  }

  function save(value) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state(value)));
      return true;
    } catch {
      return false;
    }
  }

  function isRootId(id) {
    return id === "board" || (typeof id === "string" && /^E\d+$/.test(id));
  }

  function rootFor(note) {
    return [...list(note?.sourceCardIds), ...list(note?.payload?.anchor?.elementIds)]
      .find(isRootId) || "board";
  }

  function branchFor(anchorIds, notes) {
    const history = list(notes).filter((note) => typeof note?.id === "string");
    const byId = new Map(history.map((note) => [note.id, note]));
    const selectedIds = list(anchorIds);
    const branchAnchor = selectedIds.map((id) => byId.get(id)).find((note) => noteId(note?.branchId));
    const branchId = noteId(branchAnchor?.branchId);
    const root = branchId ? rootFor(byId.get(branchId) || branchAnchor) : selectedIds.map((id) => {
      const note = byId.get(id);
      return note ? rootFor(note) : isRootId(id) ? id : null;
    }).find(Boolean) || "board";
    const matches = history.filter((note) => {
      if (typeof note.answer !== "string" || !note.answer.trim()) return false;
      const noteBranch = noteId(note.branchId);
      return branchId ? noteBranch === branchId || note.id === branchId : !noteBranch && rootFor(note) === root;
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
    const parents = new Set(nodes.filter((node) => removed.has(node.id)).flatMap((node) => node.parentIds || []));
    const affected = nodes.filter((node) => !removed.has(node.id) &&
      (parents.has(node.id) || (node.parentIds || []).some((id) => removed.has(id)))).map((node) => node.id);
    return { removed: [...removed], affected };
  }

  function repairNodes(nodes) {
    const included = new Set(nodes.map((node) => node.id));
    return nodes.map((node) => ({ ...node,
      parentIds: (node.parentIds || []).filter((id) => id !== node.id && included.has(id)),
    }));
  }

  window.BoardMemory = { load, save, branchFor, deletionPlan, repairNodes, cleanAttachments };
})();
