(() => {
  const storageKey = "whiteboard.codex.organization.v1";
  const categories = new Set(["main", "done", "optimize", "reference", "archive"]);
  const sourceFiles = new Set(["index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py"]);
  const flows = new Set(["columns", "vertical", "horizontal"]);
  const sides = new Set(["auto", "left", "right"]);
  const spacing = { compact: [12, 26], normal: [18, 36], spacious: [26, 56] };
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
    return typeof value === "string" ? value.trim().slice(0, limit) : "";
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
      const { x, y } = point;
      if ([x, y].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e6)) {
        positions[id] = { x, y };
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

  function clean(value) {
    if (!Array.isArray(value?.items)) return null;
    const byId = new Map();
    for (const item of value.items) {
      const id = sourceId(item?.id);
      if (!id || byId.has(id)) continue;
      const sources = Array.isArray(item.sources)
        ? [...new Set(item.sources.filter((file) => sourceFiles.has(file)))] : null;
      const attachments = window.BoardMemory?.cleanAttachments(item.attachments) || [];
      byId.set(id, {
        id,
        category: categories.has(item.category) ? item.category : "reference",
        parentId: sourceId(item.parentId),
        title: text(item.title, 100) || id,
        summary: text(item.summary, 800),
        ...(sources ? { sources } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(sides.has(item.side) ? { side: item.side } : {}),
        ...(typeof item.folded === "boolean" ? { folded: item.folded } : {}),
      });
    }
    for (const item of byId.values()) {
      if (!byId.has(item.parentId) || wouldCycle(item.id, item.parentId, byId)) {
        item.parentId = null;
      }
    }
    return {
      title: text(value.title, 120) || "白板整理",
      summary: text(value.summary, 1600),
      layout: settings(value.layout),
      items: [...byId.values()],
      positions: cleanPositions(value.positions),
    };
  }

  function state(value) {
    const opinion = typeof value?.opinion === "string"
      ? value.opinion.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, "") : "";
    const current = clean(value?.current);
    const undo = value?.quickUndo;
    let quickUndo = null;
    if (current && typeof undo?.density === "string" && Object.hasOwn(spacing, undo.density)) {
      quickUndo = { density: undo.density, positions: cleanPositions(undo.positions) };
    } else if (!current && typeof undo?.rawCompact === "boolean") {
      quickUndo = { rawCompact: undo.rawCompact, positions: cleanPositions(undo.positions) };
    }
    return {
      current,
      previous: clean(value?.previous),
      opinion,
      rawPositions: cleanPositions(value?.rawPositions),
      rawCompact: value?.rawCompact === true,
      quickUndo,
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
      window.localStorage.setItem(storageKey, JSON.stringify(state(value)));
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

  window.BoardOrganization = { load, save, clean, layout, columnLanes, laneFor, parentOf, settings };
})();
