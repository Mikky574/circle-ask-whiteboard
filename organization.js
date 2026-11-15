(() => {
  const storageKey = window.BoardMemory?.storageKeys?.organization ?? "whiteboard.codex.organization.v1";
  const categories = new Set(["main", "done", "optimize", "reference", "archive"]);
  const sourceFiles = new Set([
    "index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "run_gate.js", "project_finder.js",
    "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py", "backends.py", "api_backend.py", "board_tools.py",
    "local_projects.py",
  ]);
  const flows = new Set(["columns", "vertical", "horizontal"]);
  const sides = new Set(["auto", "left", "right"]);
  const spacing = { compact: [12, 26], normal: [18, 36], spacious: [26, 56] };
  const quickLayouts = { compact: "紧凑树形", horizontal: "横向展开", balanced: "双侧展开" };
  const validQuickMode = (mode) => typeof mode === "string" && Object.hasOwn(quickLayouts, mode);

  function cleanBranchQuickModes(value) {
    return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
      .filter(([id, mode]) => sourceId(id) && validQuickMode(mode)));
  }
  const columnLanes = {
    main: { x: 36, width: 345, label: "主干" },
    optimize: { x: 418, width: 285, label: "待优化" },
    reference: { x: 740, width: 280, label: "参考批注" },
  };
  const lanes = {
    main: { x: 350, width: 350 },
    optimize: { x: 26, width: 275 },
    reference: { x: 749, width: 275 },
  };

  function sourceId(value) {
    return typeof value === "string" && /^[EA]\d+$/.test(value) ? value : null;
  }

  function text(value, limit) {
    return typeof value === "string" ? Array.from(value.trim()).slice(0, limit).join("") : "";
  }

  function settings(value) {
    return {
      flow: flows.has(value?.flow) ? value.flow : "columns",
      density: typeof value?.density === "string" && Object.hasOwn(spacing, value.density)
        ? value.density : "normal",
    };
  }

  function cleanPositions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const positions = {};
    for (const [id, point] of Object.entries(value)) {
      if (!sourceId(id) || !point) continue;
      const { x, y, width } = point;
      if ([x, y].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e6)) {
        positions[id] = { x, y, ...(Number.isFinite(width) && width > 0 && width <= 10000 ? { width } : {}) };
      }
    }
    return positions;
  }

  function wouldCycle(itemId, parentId, byId) {
    const seen = new Set([itemId]);
    for (let id = parentId; id; id = byId.get(id)?.parentId) {
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  }

  function cleanTaskDetails(value) {
    const shortText = (entry, limit) => {
      const trimmed = typeof entry === "string" ? entry.trim() : "";
      return trimmed && Array.from(trimmed).length <= limit ? trimmed : null;
    };
    const entries = (list, minimum) => {
      if (!Array.isArray(list) || list.length < minimum || list.length > 5) return null;
      const trimmed = list.map((entry) => shortText(entry, 180));
      return trimmed.every(Boolean) ? trimmed : null;
    };
    const task = shortText(value?.task, 500);
    const dependencies = entries(value?.dependencies, 0);
    const acceptance = entries(value?.acceptance, 1);
    return task && dependencies && acceptance ? { task, dependencies, acceptance } : null;
  }

  function cleanSpec(value) {
    if (!["requirement", "case", "constraint"].includes(value?.kind) || typeof value.id !== "string" ||
        !/^[A-Z][A-Z0-9-]{2,47}$/.test(value.id)) return null;
    const { kind, id } = value;
    if (kind !== "case") return { kind, id };
    const status = ["mock-pass", "offline-pass"].includes(value.status) ? value.status : "pending";
    const runner = text(value.runner, 220);
    return { kind, id, status, ...(runner ? { runner } : {}) };
  }

  function cleanCodePreview(value) {
    const path = text(value?.path, 300);
    if (!path || !/^[\p{L}\p{N}\p{M}_ .()\[\]@+/-]+$/u.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const code = typeof value?.text === "string" ? value.text.slice(0, 1400) : "";
    return code.trim() ? { path, text: code } : null;
  }

  function clean(value) {
    if (!Array.isArray(value?.items)) return null;
    const byId = new Map();
    for (const item of value.items) {
      const id = sourceId(item?.id);
      if (!id || byId.has(id)) continue;
      const sources = Array.isArray(item.sources)
        ? [...new Set(item.sources.filter((file) => sourceFiles.has(file)))] : null;
      const attachments = window.BoardMemory?.cleanAttachments(item.attachments) || [];
      const taskDetails = cleanTaskDetails(item.taskDetails);
      const spec = cleanSpec(item.spec);
      const codePreview = cleanCodePreview(item.codePreview);
      byId.set(id, {
        id,
        category: categories.has(item.category) ? item.category : "reference",
        parentId: sourceId(item.parentId),
        title: text(item.title, 100) || id,
        summary: text(item.summary, 800),
        ...(sources ? { sources } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(taskDetails ? { taskDetails } : {}),
        ...(spec ? { spec } : {}),
        ...(codePreview ? { codePreview } : {}),
        ...(item.draft === true ? { draft: true } : {}),
        ...(item.explicitParent === true ? { explicitParent: true } : {}),
        ...(item.nativeFace === true ? { nativeFace: true } : {}),
        ...(item.localContent === true && (item.nativeFace === true || id.startsWith("A")) ? { localContent: true } : {}),
        ...(sides.has(item.side) ? { side: item.side } : {}),
        ...(typeof item.folded === "boolean" ? { folded: item.folded } : {}),
      });
    }
    for (const item of byId.values()) {
      if (!byId.has(item.parentId) || wouldCycle(item.id, item.parentId, byId)) {
        item.parentId = null;
      }
    }
    const guide = value.projectGuide;
    const guideRoot = byId.get(sourceId(guide?.rootId));
    const projectGuide = guideRoot && guideRoot.category !== "archive" && [guide.x, guide.y].every((coordinate) =>
      Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e6)
      ? { rootId: guideRoot.id, x: guide.x, y: guide.y } : null;
    const branchLayouts = Array.isArray(value.branchLayouts)
      ? [...new Set(value.branchLayouts.filter((id) => byId.has(id)))] : [];
    return {
      title: text(value.title, 120) || "白板整理",
      summary: text(value.summary, 1600),
      layout: settings(value.layout),
      items: [...byId.values()],
      positions: cleanPositions(value.positions),
      collapsedBranches: Array.isArray(value.collapsedBranches)
        ? [...new Set(value.collapsedBranches.filter(sourceId))] : [],
      ...(projectGuide ? { projectGuide } : {}),
      ...(branchLayouts.length ? { branchLayouts } : {}),
    };
  }

  function state(value) {
    const opinion = typeof value?.opinion === "string"
      ? value.opinion.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, "") : "";
    const current = clean(value?.current);
    const rawCards = clean({ items: value?.rawCards })?.items.filter(({ id }) => /^E\d+$/.test(id) &&
      !["E01", "E02", "E03"].includes(id)) || [];
    const undo = value?.quickUndo;
    const rawLinks = {};
    for (const [child, parents] of Object.entries(value?.rawLinks || {})) {
      if (sourceId(child) && Array.isArray(parents)) {
        rawLinks[child] = [...new Set(parents.filter((id) => sourceId(id) && id !== child))];
      }
    }
    const linkUndo = value?.rawLinkUndo;
    const undoLinks = linkUndo?.links || (sourceId(linkUndo?.childId) ? { [linkUndo.childId]: linkUndo.parents } : {});
    const restoredLinks = Object.fromEntries(Object.entries(undoLinks)
      .filter(([child, parents]) => sourceId(child) && (parents === null || Array.isArray(parents)))
      .map(([child, parents]) => [child, parents?.filter((id) => sourceId(id) && id !== child) ?? null]));
    const rawLinkUndo = Object.keys(restoredLinks).length ? { links: restoredLinks } : null;
    let quickUndo = null;
    if (current && typeof undo?.density === "string" && Object.hasOwn(spacing, undo.density)) {
      quickUndo = { density: undo.density, positions: cleanPositions(undo.positions) };
    } else if (!current && typeof undo?.rawCompact === "boolean") {
      quickUndo = { rawCompact: undo.rawCompact, positions: cleanPositions(undo.positions) };
    }
    if (quickUndo && validQuickMode(undo.quickMode)) quickUndo.quickMode = undo.quickMode;
    if (quickUndo && current && Array.isArray(undo.branchLayouts)) {
      quickUndo.branchLayouts = [...new Set(undo.branchLayouts.filter(sourceId))];
    }
    if (quickUndo) {
      if (undo.branchQuickModes) quickUndo.branchQuickModes = cleanBranchQuickModes(undo.branchQuickModes);
      if (Array.isArray(undo.scopeRoots)) quickUndo.scopeRoots = [...new Set(undo.scopeRoots.filter(sourceId))];
    }
    const branchQuickModes = cleanBranchQuickModes(value?.branchQuickModes);
    const rawCollapsedBranches = Array.isArray(value?.rawCollapsedBranches)
      ? [...new Set(value.rawCollapsedBranches.filter(sourceId))] : [];
    return {
      current,
      previous: clean(value?.previous),
      undoAvailable: typeof value?.undoAvailable === "boolean" ? value.undoAvailable :
        Boolean(value?.previous || (current && !current.projectGuide &&
          current.items.some((item) => /^E0[1-3]$/.test(item.id)))),
      opinion,
      rawPositions: cleanPositions(value?.rawPositions),
      ...(rawCollapsedBranches.length ? { rawCollapsedBranches } : {}),
      ...(rawCards.length ? { rawCards } : {}),
      rawCompact: value?.rawCompact === true,
      ...(validQuickMode(value?.quickMode) ? { quickMode: value.quickMode } : {}),
      ...(Object.keys(branchQuickModes).length ? { branchQuickModes } : {}),
      ...(Object.keys(rawLinks).length ? { rawLinks } : {}),
      ...(rawLinkUndo ? { rawLinkUndo } : {}),
      quickUndo,
      appliedGuideId: typeof value?.appliedGuideId === "string" ? value.appliedGuideId.slice(0, 80) : "",
    };
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
      const serialized = JSON.stringify(state(value));
      if (window.BoardMemory?.writeStorage) return window.BoardMemory.writeStorage(storageKey, serialized);
      window.localStorage.setItem(storageKey, serialized);
      return true;
    } catch {
      return false;
    }
  }

  function sideOf(item) {
    return item?.side === "left" ? "optimize" : item?.side === "right" ? "reference" : null;
  }

  function laneFor(item, options) {
    if (item?.category === "archive") return null;
    if (item?.category === "done") {
      const branchFlow = options?.flow === "vertical" || options?.flow === "horizontal";
      return branchFlow && item.pinned !== true ? sideOf(item) || "main" : "main";
    }
    return Object.hasOwn(lanes, item?.category) ? item.category : "reference";
  }

  function parentOf(item, byId) {
    const seen = new Set([item?.id]);
    for (let id = item?.parentId; id && !seen.has(id);) {
      const parent = byId.get(id);
      if (!parent) break;
      if (laneFor(parent)) return id;
      seen.add(id);
      id = parent.parentId;
    }
    return null;
  }

  function guideChildren(items, rootId) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const root = byId.get(rootId);
    if (!root || root.category === "archive") return null;
    const children = new Map();
    for (const item of items) {
      if (item.id === rootId || item.category === "archive") continue;
      const parent = parentOf(item, byId);
      if (!parent) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item.id);
    }
    return children;
  }

  function guideLevels(items, rootId) {
    const children = guideChildren(items, rootId);
    if (!children) return new Map();
    const levels = new Map([[rootId, 0]]);
    for (const [id, depth] of levels) {
      for (const child of children.get(id) || []) {
        if (!levels.has(child)) levels.set(child, depth + 1);
      }
    }
    return levels;
  }

  function guideLayout(items, sizes, projectGuide, options) {
    const positions = new Map();
    if (!projectGuide) return positions;
    const { rootId, x, y } = projectGuide;
    const children = guideChildren(items, rootId);
    if (!children) return positions;
    const rootWidth = 420;
    const moduleWidth = 280;
    const compact = options?.density === "compact";
    const detailIndent = (depth) => Math.min(24 + (depth - 2) * 28, 80);
    const laneGap = compact ? 20 : 32;
    const rootGap = compact ? 36 : 56;
    const chapterGap = compact ? 20 : 30;
    const detailGap = compact ? 12 : 20;
    const modules = children.get(rootId) || [];
    const rowWidth = modules.length ? modules.length * (moduleWidth + laneGap) - laneGap : 0;
    const guideWidth = Math.max(rootWidth, rowWidth);
    const laneX = (index) => x + (guideWidth - rowWidth) / 2 + index * (moduleWidth + laneGap);
    const place = (id, left, top, width) => {
      const measured = (sizes?.get?.(id) ?? sizes?.[id])?.height;
      const height = Number.isFinite(measured) && measured > 0 ? measured : 156;
      positions.set(id, { x: left, y: top, width, height });
      return top + height;
    };
    function placeSubtree(id, depth, left, top) {
      if (positions.has(id)) return top;
      const indent = detailIndent(depth);
      let bottom = place(id, left + indent, top, moduleWidth - indent);
      for (const child of children.get(id) || []) {
        bottom = placeSubtree(child, depth + 1, left, bottom + detailGap);
      }
      return bottom;
    }
    const moduleY = place(rootId, x + (guideWidth - rootWidth) / 2, y, rootWidth) + rootGap;
    const moduleBottoms = modules.map((id, index) => place(id, laneX(index), moduleY, moduleWidth));
    const freeLanes = new Set(modules.flatMap((id, index) => children.has(id) ? [] : [index]));
    for (const [index, id] of modules.entries()) {
      const details = children.get(id) || [];
      const lanes = [index];
      if (compact && details.length >= 3) {
        // An expanded branch can borrow space below a folded neighbor.
        const neighbor = [index + 1, index - 1].find((lane) => freeLanes.has(lane));
        if (neighbor !== undefined) {
          freeLanes.delete(neighbor);
          lanes.push(neighbor);
        }
      }
      let rowY = Math.max(...lanes.map((lane) => moduleBottoms[lane])) + chapterGap;
      for (let start = 0; start < details.length; start += lanes.length) {
        let bottom = rowY;
        for (const [slot, child] of details.slice(start, start + lanes.length).entries()) {
          bottom = Math.max(bottom, placeSubtree(child, 2, laneX(lanes[slot]), rowY));
        }
        rowY = bottom + detailGap;
      }
    }
    return positions;
  }

  function directionalLayout(items, sizes, guide, mode) {
    const positions = new Map();
    const byId = new Map(items.map((item) => [item.id, item]));
    const children = new Map();
    for (const item of items) {
      if (!laneFor(item)) continue;
      const parent = parentOf(item, byId);
      const key = item.id === guide?.rootId || wouldCycle(item.id, parent, byId) ? null : parent;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(item.id);
    }
    const roots = children.get(null) || [];
    const guideIndex = roots.indexOf(guide?.rootId);
    if (guideIndex > 0) roots.unshift(roots.splice(guideIndex, 1)[0]);
    const sizeOf = (id) => sizes?.get(id) || { width: id === guide?.rootId ? 420 : 280, height: 156 };
    const balanced = mode === "balanced";
    const originX = guide?.x ?? 56;
    let x = originX;
    let y = guide?.y ?? 96;
    let rowHeight = 0;

    function collectBranches(id, ordered) {
      for (const child of children.get(id) || []) {
        ordered.push({
          id: child, parentIds: [id], sectionOf: byId.get(child)?.sectionOf === id ? id : undefined,
          ...sizeOf(child),
        });
        collectBranches(child, ordered);
      }
    }
    for (const [index, root] of roots.entries()) {
      const branches = [];
      collectBranches(root, branches);
      const core = { x: 0, y: 0, ...sizeOf(root) };
      const component = window.BoardGeometry.layoutBranches(branches, core, true, { twoSided: balanced, sectionColumns: true });
      component.set(root, core);
      const rects = [...component.values()];
      const left = Math.min(...rects.map((rect) => rect.x));
      const top = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.x + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
      for (const [id, rect] of component) positions.set(id, { ...rect, x: x + rect.x - left, y: y + rect.y - top });
      x += right - left + 128;
      rowHeight = Math.max(rowHeight, bottom - top);
      if ((index + 1) % (balanced ? 2 : 3) === 0) {
        x = originX;
        y += rowHeight + 56;
        rowHeight = 0;
      }
    }
    return positions;
  }

  function reflowBranch(items, rects, rootId, { columns = 2, fixedIds = [], below = true } = {}) {
    const positions = new Map();
    const root = rects.get(rootId);
    const children = guideChildren(items, rootId);
    if (!root || !children) return positions;

    const branch = new Set([rootId]);
    for (const id of branch) {
      for (const child of children.get(id) || []) branch.add(child);
    }
    const fixed = new Set([...fixedIds, ...items.filter(({ pinned }) => pinned).map(({ id }) => id), rootId]);
    const movable = (id) => branch.has(id) && !fixed.has(id);
    const occupied = [...rects].filter(([id]) => !movable(id)).map(([, rect]) => rect);
    const { placeNoteGroup } = window.BoardGeometry;
    const gap = 24;
    for (const id of branch) {
      const group = (children.get(id) || []).filter((child) => movable(child) && rects.has(child));
      if (!group.length) continue;
      const parent = positions.get(id) || rects.get(id) || root;
      const sizes = group.map((child) => {
        const { width, height } = rects.get(child);
        return { width, height };
      });
      const placed = placeNoteGroup(parent, occupied, sizes, null, gap, columns === 1 ? 1 : 2, { below });
      for (const [index, child] of group.entries()) positions.set(child, placed[index]);
      occupied.push(...placed);
    }
    return positions;
  }

  function reflowQuickBranch(items, rects, rootId, mode, { fixedIds = [], allowMirror = false } = {}) {
    const positions = new Map();
    const children = guideChildren(items, rootId);
    if (!rects.has(rootId) || !children) return positions;
    const byId = new Map(items.map((item) => [item.id, item]));
    const branch = new Set([rootId]);
    for (const id of branch) {
      for (const child of children.get(id) || []) branch.add(child);
    }
    const fixed = new Set([rootId, ...fixedIds, ...items.filter(({ pinned }) => pinned).map(({ id }) => id)]);
    const movable = (id) => branch.has(id) && rects.has(id) && !fixed.has(id);
    const occupied = [...rects].filter(([id]) => !movable(id)).map(([, rect]) => rect);
    const gap = 24;

    function avoidObstacles(group, direction) {
      const pending = [{ x: 0, y: 0, distance: 0 }];
      const visited = new Set(["0,0"]);
      const add = (x, y) => {
        if (direction ? direction * x < 0 : y < 0) return;
        const key = `${x},${y}`;
        if (visited.has(key)) return;
        visited.add(key);
        pending.push({ x, y, distance: x * x + y * y });
      };
      for (let attempt = 0; pending.length && attempt < 256; attempt++) {
        pending.sort((a, b) => a.distance - b.distance);
        const offset = pending.shift();
        let collision;
        for (const rect of group.values()) {
          const other = occupied.find((blocker) =>
            rect.x + offset.x < blocker.x + blocker.width + gap &&
            rect.x + rect.width + offset.x + gap > blocker.x &&
            rect.y + offset.y < blocker.y + blocker.height + gap &&
            rect.y + rect.height + offset.y + gap > blocker.y);
          if (other) {
            collision = { rect, other };
            break;
          }
        }
        if (!collision) return offset;
        const { rect, other } = collision;
        add(offset.x, Math.floor(other.y - gap - rect.y - rect.height));
        add(offset.x, Math.ceil(other.y + other.height + gap - rect.y));
        add(Math.floor(other.x - gap - rect.x - rect.width), offset.y);
        add(Math.ceil(other.x + other.width + gap - rect.x), offset.y);
      }
      const values = [...group.values()];
      if (direction > 0) return {
        x: Math.max(...occupied.map((rect) => rect.x + rect.width)) + gap -
          Math.min(...values.map((rect) => rect.x)),
        y: 0,
      };
      if (direction < 0) return {
        x: Math.min(...occupied.map((rect) => rect.x)) - gap -
          Math.max(...values.map((rect) => rect.x + rect.width)),
        y: 0,
      };
      return {
        x: 0,
        y: Math.max(...occupied.map((rect) => rect.y + rect.height)) + gap -
          Math.min(...values.map((rect) => rect.y)),
      };
    }

    function collect(id, nodes) {
      for (const child of children.get(id) || []) {
        if (!movable(child)) continue;
        const { width, height } = rects.get(child);
        nodes.push({ id: child, parentIds: [id], width, height, sectionOf: byId.get(child)?.sectionOf === id ? id : undefined });
        collect(child, nodes);
      }
    }
    for (const anchorId of branch) {
      if (!fixed.has(anchorId) || !rects.has(anchorId)) continue;
      const nodes = [];
      collect(anchorId, nodes);
      if (!nodes.length) continue;
      const anchor = rects.get(anchorId);
      const vertical = mode === "compact";
      const core = vertical
        ? { x: anchor.y, y: anchor.x, width: anchor.height, height: anchor.width } : anchor;
      const measured = vertical
        ? nodes.map((node) => ({ ...node, width: node.height, height: node.width })) : nodes;
      const { layoutBranches, sectionColumnThreshold } = window.BoardGeometry;
      const layout = layoutBranches(measured, core, true, {
        twoSided: mode === "balanced", sectionColumns: !vertical,
      });
      const sectionGrid = !vertical && nodes.length >= sectionColumnThreshold &&
        nodes.every(({ sectionOf }) => sectionOf === anchorId);
      const groups = new Map();
      for (const [id, rect] of layout) {
        const direction = vertical ? 0 : Math.sign(rect.x - anchor.x);
        const group = groups.get(direction) || new Map();
        group.set(id, vertical ? { x: rect.y, y: rect.x, width: rect.height, height: rect.width } : rect);
        groups.set(direction, group);
      }
      for (const [direction, group] of groups) {
        let placedGroup = group;
        let offset = avoidObstacles(group, direction);
        const distance = Math.hypot(offset.x, offset.y);
        if ((sectionGrid || (allowMirror && mode === "horizontal")) && distance > gap) {
          const center = anchor.x + anchor.width / 2;
          const mirrored = new Map([...group].map(([id, rect]) =>
            [id, { ...rect, x: 2 * center - rect.x - rect.width }]));
          const alternative = avoidObstacles(mirrored, -direction);
          if (Math.hypot(alternative.x, alternative.y) < distance) {
            placedGroup = mirrored;
            offset = alternative;
          }
        }
        for (const [id, rect] of placedGroup) {
          const placed = { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
          positions.set(id, placed);
          occupied.push(placed);
        }
      }
    }
    return positions;
  }

  function applyManualLayout(placements, items, positions, compact, guide) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const fixed = [];
    const offsets = new Map();
    for (const [id, rect] of placements) {
      const manual = positions[id];
      if (!manual) continue;
      if (byId.get(id)?.pinned) offsets.set(id, { x: manual.x - rect.x, y: manual.y - rect.y });
      Object.assign(rect, manual);
      fixed.push(rect);
    }
    if (!compact || !offsets.size) return;
    const automatic = [...placements].filter(([id]) => !positions[id]);
    for (const [id, rect] of automatic) {
      const seen = new Set([id]);
      for (let parent = parentOf(byId.get(id), byId); parent && !seen.has(parent); parent = parentOf(byId.get(parent), byId)) {
        seen.add(parent);
        const offset = offsets.get(parent);
        if (!offset) continue;
        rect.x += offset.x;
        rect.y += offset.y;
        break;
      }
    }

    // Keep manual rectangles fixed and move only an automatic card that hits an obstacle.
    const gap = 12;
    const placed = [...fixed];
    automatic.sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
    for (const [id, rect] of automatic) {
      const parent = guide?.has(id) ? guide.get(parentOf(byId.get(id), byId)) : null;
      if (parent) rect.y = Math.max(rect.y, parent.y + parent.height + gap);
      const blockers = placed.filter((other) =>
        rect.x < other.x + other.width + gap && rect.x + rect.width + gap > other.x);
      blockers.sort((a, b) => a.y - b.y);
      for (const other of blockers) {
        if (rect.y + rect.height + gap <= other.y) break;
        rect.y = Math.max(rect.y, other.y + other.height + gap);
      }
      placed.push(rect);
    }
  }

  function branchVisibility(items, collapsedBranches) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const parents = new Map(items.map((item) => [item.id, parentOf(item, byId)]));
    const structural = new Set(items.filter((item) => item.category !== "archive" && !item.inlineAnnotation).map(({ id }) => id));
    for (const id of structural) {
      const parent = parents.get(id);
      if (parent) structural.add(parent);
    }
    const collapsed = new Set(collapsedBranches);
    const counts = new Map();
    const hidden = new Set();
    for (const item of items) {
      if (item.category === "archive") continue;
      const seen = new Set([item.id]);
      let child = item;
      for (let id = parents.get(child.id); id && !seen.has(id); id = parents.get(child.id)) {
        seen.add(id);
        // Standalone remarks stay beside their source. A branch and its descendants follow the fold.
        if (structural.has(child.id) || byId.get(id)?.outline) {
          counts.set(id, (counts.get(id) || 0) + 1);
          if (collapsed.has(id)) hidden.add(item.id);
        }
        child = byId.get(id);
      }
    }
    return { counts, hidden };
  }

  function layout(items, sizes, options) {
    const normalized = clean({ items })?.items || [];
    const config = settings(options);
    const { flow, density } = config;
    const pinned = new Set((Array.isArray(items) ? items : [])
      .filter((item) => item?.pinned === true).map((item) => item.id));
    for (const item of normalized) {
      if (pinned.has(item.id)) item.pinned = true;
    }
    const laneOf = (item) => laneFor(item, config);
    const byId = new Map(normalized.map((item) => [item.id, item]));
    const positions = new Map();
    const trunk = new Map();
    const branches = new Map();
    const [branchGap, sectionGap] = spacing[density];
    const startY = 128;
    const branchSides = ["optimize", "reference"];

    function addChild(tree, parentId, item) {
      if (!tree.has(parentId)) tree.set(parentId, []);
      tree.get(parentId).push(item);
    }

    function sizeOf(item) {
      return sizes?.get?.(item.id) ?? sizes?.[item.id];
    }

    function heightOf(item) {
      const height = sizeOf(item)?.height;
      return Number.isFinite(height) && height > 0 ? height : 156;
    }

    function widthOf(item, available) {
      const width = sizeOf(item)?.width;
      return Number.isFinite(width) && width > 0 ? Math.min(width, available) : available;
    }

    if (flow === "columns") {
      const columnFor = (item) => {
        const lane = laneOf(item);
        return lane && lane !== "main" ? sideOf(item) || lane : lane;
      };
      for (const [laneId, lane] of Object.entries(columnLanes)) {
        const children = new Map();
        for (const item of normalized) {
          if (columnFor(item) !== laneId) continue;
          const parent = byId.get(item.parentId);
          addChild(children, parent && columnFor(parent) === laneId ? parent.id : null, item);
        }
        let y = startY;
        function placeColumn(parentId, depth) {
          const indent = Math.min(depth * 18, 54);
          for (const item of children.get(parentId) || []) {
            const width = widthOf(item, lane.width - indent);
            const height = heightOf(item);
            positions.set(item.id, { x: lane.x + indent, y, width, height });
            y += height + branchGap + 2;
            placeColumn(item.id, depth + 1);
          }
        }
        placeColumn(null, 0);
      }
      return positions;
    }

    for (const item of normalized) {
      const lane = laneOf(item);
      if (!lane) continue;
      const inTrunk = lane === "main";
      let parentId = parentOf(item, byId);
      while (inTrunk && parentId && laneOf(byId.get(parentId)) !== "main") {
        parentId = parentOf(byId.get(parentId), byId);
      }
      addChild(inTrunk ? trunk : branches, parentId, item);
    }

    const orderedTrunk = [];
    function visitTrunk(parentId) {
      for (const item of trunk.get(parentId) || []) {
        orderedTrunk.push(item);
        visitTrunk(item.id);
      }
    }
    visitTrunk(null);

    function groupBranches(ownerId) {
      const rows = { optimize: [], reference: [] };
      const heights = { optimize: 0, reference: 0 };
      function collect(root, side) {
        const group = { optimize: [], reference: [] };
        const span = { optimize: 0, reference: 0 };
        function visit(item, inheritedSide, depth) {
          const actual = sideOf(item) || inheritedSide;
          const height = heightOf(item);
          group[actual].push({ item, depth, height });
          span[actual] += height + branchGap;
          for (const child of branches.get(item.id) || []) visit(child, actual, depth + 1);
        }
        visit(root, side, 0);
        return { group, span };
      }

      for (const root of branches.get(ownerId) || []) {
        const fixedSide = sideOf(root);
        const preferred = fixedSide || laneOf(root);
        let chosen = collect(root, preferred);
        if (!fixedSide) {
          const alternate = collect(root, preferred === "optimize" ? "reference" : "optimize");
          const total = (candidate) => Math.max(...branchSides.map((side) => heights[side] + candidate.span[side]));
          if (total(chosen) > total(alternate) + sectionGap) chosen = alternate;
        }
        for (const side of branchSides) {
          rows[side].push(...chosen.group[side]);
          heights[side] += chosen.span[side];
        }
      }
      return { rows, heights };
    }

    const groups = orderedTrunk.map((item) => ({ item, ...groupBranches(item.id) }));
    groups.push({ item: null, ...groupBranches(null) });
    if (flow === "horizontal") {
      const trunkY = startY + Math.max(...groups.map((group) => group.heights.optimize));
      const trunkHeight = Math.max(0, ...orderedTrunk.map(heightOf));
      let bandX = columnLanes.main.x;
      for (const { item, rows } of groups) {
        if (item) {
          const width = widthOf(item, lanes.main.width);
          positions.set(item.id, {
            x: bandX + (lanes.main.width - width) / 2, y: trunkY, width, height: heightOf(item),
          });
        }
        let above = trunkY - branchGap;
        let below = trunkY + trunkHeight + branchGap;
        for (const side of branchSides) {
          for (const { item, depth, height } of rows[side]) {
            const width = widthOf(item, lanes[side].width - Math.min(depth * 18, 54));
            const y = side === "optimize" ? above - height : below;
            positions.set(item.id, { x: bandX + (lanes.main.width - width) / 2, y, width, height });
            if (side === "optimize") above = y - branchGap;
            else below += height + branchGap;
          }
        }
        bandX += lanes.main.width + sectionGap;
      }
      return positions;
    }

    if (density === "compact") {
      const trunkGap = 44;
      const stackGap = 36;
      const lanePitch = 325;
      const laneCost = 140;
      const occupied = { optimize: [[], [], []], reference: [[], [], []] };
      const placedLanes = new Map();
      const assignments = new Map(groups.flatMap(({ rows }) =>
        branchSides.flatMap((side) => rows[side].map((row) => [row.item.id, { ...row, side }])),
      ));

      let trunkY = startY;
      for (const item of orderedTrunk) {
        const width = widthOf(item, lanes.main.width);
        const height = heightOf(item);
        positions.set(item.id, {
          x: lanes.main.x + (lanes.main.width - width) / 2, y: trunkY, width, height,
        });
        trunkY += height + trunkGap;
      }

      function freeTop(rects, target, height) {
        let y = target;
        for (const rect of rects) {
          if (y + height + stackGap <= rect.y) break;
          y = Math.max(y, rect.y + rect.height + stackGap);
        }
        return y;
      }

      function placeBranches(parentId) {
        const parent = positions.get(parentId);
        const parentLane = placedLanes.get(parentId);
        for (const item of branches.get(parentId) || []) {
          const { side, depth, height } = assignments.get(item.id);
          const lane = lanes[side];
          const indent = Math.min(depth * 18, 54);
          const available = lane.width - indent;
          const width = widthOf(item, available);
          const target = parent ? parent.y + Math.max(0, Math.min(36, (parent.height - height) / 2)) : trunkY;
          const preferred = parentLane?.side === side ? parentLane.index : 0;
          let best;
          for (const [index, rects] of occupied[side].entries()) {
            const y = freeTop(rects, target, height);
            const cost = y - target + Math.abs(index - preferred) * laneCost;
            if (!best || cost < best.cost) best = { index, y, cost };
          }
          const offset = best.index * lanePitch;
          const x = side === "optimize"
            ? lane.x + available - width - offset : lane.x + indent + offset;
          const rect = { x, y: best.y, width, height };
          positions.set(item.id, rect);
          placedLanes.set(item.id, { side, index: best.index });
          const rects = occupied[side][best.index];
          rects.push(rect);
          rects.sort((a, b) => a.y - b.y);
          placeBranches(item.id);
        }
      }

      for (const item of orderedTrunk) placeBranches(item.id);
      placeBranches(null);
      return positions;
    }

    let y = startY;
    for (const { item, rows, heights } of groups) {
      const height = item ? heightOf(item) : 0;
      if (item) {
        const width = widthOf(item, lanes.main.width);
        positions.set(item.id, {
          x: lanes.main.x + (lanes.main.width - width) / 2, y, width, height,
        });
      }
      for (const side of branchSides) {
        const lane = lanes[side];
        let top = y;
        for (const { item, depth, height } of rows[side]) {
          const indent = Math.min(depth * 18, 54);
          const available = lane.width - indent;
          const width = widthOf(item, available);
          const x = side === "optimize" ? lane.x + available - width : lane.x + indent;
          positions.set(item.id, { x, y: top, width, height });
          top += height + branchGap;
        }
      }
      y += Math.max(height, heights.optimize - branchGap, heights.reference - branchGap) + sectionGap;
    }
    return positions;
  }

  window.BoardOrganization = { load, save, clean, cleanTaskDetails, layout, columnLanes, laneFor, parentOf, settings, branchVisibility,
    guideLevels, guideLayout, directionalLayout, quickLayouts, reflowBranch, reflowQuickBranch, applyManualLayout };
})();
