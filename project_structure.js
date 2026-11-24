/* Optional project structure: author-confirmed zones, nodes and directed links.
 * Zones and nodes only reference existing cards by card id; card text stays in the cards.
 * validate() is strict (import / authoring). clean() salvages what is valid (stored data).
 * resolve() hides references to cards that no longer exist without rewriting the stored record. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ProjectStructure = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const VERSION = 1;
  const roles = ["entry", "capability", "external", "store", "feedback"];
  const sizes = ["small", "medium", "large"];
  const kinds = ["main", "side", "back"];
  const limits = { zones: 8, nodesPerZone: 8, nodes: 40, links: 40, lane: 5 };
  const localId = /^[a-z][a-z0-9-]{0,23}$/;
  const cardId = /^(?:[EA]\d+|board)$/;
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u;
  const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

  function fail(message) { throw new Error(`项目结构无效：${message}`); }
  function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function text(value, limit, required, field) {
    const result = typeof value === "string" ? value.trim() : "";
    if (!result ? required : Array.from(result).length > limit || control.test(result)) {
      fail(`${field}${required && !result ? "不能为空" : `最多 ${limit} 字且不能含控制字符`}。`);
    }
    return result;
  }
  function choice(value, allowed, fallback, field) {
    if (value == null) return fallback;
    if (!allowed.includes(value)) fail(`${field}无效。`);
    return value;
  }

  /* One pass for both modes. In lenient mode an invalid piece is skipped instead of throwing. */
  function build(value, lenient) {
    const guard = (action) => {
      try { return action(); } catch (error) { if (!lenient) throw error; return undefined; }
    };
    if (!plain(value) || value.version !== VERSION) fail("需要 version: 1 的对象。");
    const result = { version: VERSION };
    if (value.rootId != null) {
      const rootId = guard(() => { if (!matches(cardId, value.rootId)) fail("rootId 应为卡号或 board。"); return value.rootId; });
      if (rootId) result.rootId = rootId;
    }
    const title = guard(() => text(value.title, 40, false, "结构标题"));
    if (title) result.title = title;
    if (!Array.isArray(value.zones)) fail("zones 应为列表。");
    const used = new Set();
    let nodeCount = 0;
    const zones = [];
    for (const raw of value.zones) {
      if (zones.length >= limits.zones) { if (lenient) break; fail(`职责区最多 ${limits.zones} 个。`); }
      const zone = guard(() => {
        if (!plain(raw) || !matches(localId, raw.id) || used.has(raw.id)) fail("职责区编号无效或重复。");
        const entry = { id: raw.id, title: text(raw.title, 24, true, "职责区名称"),
          role: choice(raw.role, roles, "capability", "职责区类型"), size: choice(raw.size, sizes, "medium", "职责区大小") };
        if (raw.lane != null) {
          if (!Number.isInteger(raw.lane) || raw.lane < 0 || raw.lane > limits.lane) fail(`lane 应为 0 至 ${limits.lane} 的整数。`);
          entry.lane = raw.lane;
        }
        const note = text(raw.note, 120, false, "职责区说明");
        if (note) entry.note = note;
        if (!Array.isArray(raw.nodes)) fail("职责区的 nodes 应为列表。");
        entry.nodes = [];
        return entry;
      });
      if (!zone) continue;
      used.add(zone.id);
      for (const node of raw.nodes) {
        if (zone.nodes.length >= limits.nodesPerZone || nodeCount >= limits.nodes) {
          if (lenient) break;
          fail(`每区最多 ${limits.nodesPerZone} 个、总计最多 ${limits.nodes} 个节点。`);
        }
        const entry = guard(() => {
          if (!plain(node) || !matches(localId, node.id) || used.has(node.id)) fail("节点编号无效或重复。");
          if (!matches(cardId, node.cardId)) fail("节点必须用卡号引用卡片。");
          const item = { id: node.id, cardId: node.cardId };
          for (const [key, limit, name] of [["label", 24, "节点名称"], ["note", 80, "节点说明"]]) {
            const entryText = text(node[key], limit, false, name);
            if (entryText) item[key] = entryText;
          }
          return item;
        });
        if (!entry) continue;
        used.add(entry.id);
        zone.nodes.push(entry);
        nodeCount++;
      }
      if (zone.nodes.length || !lenient) zones.push(zone);
    }
    if (!lenient && !zones.length) fail("至少需要一个职责区。");
    if (lenient) zones.splice(0, zones.length, ...zones.filter((zone) => zone.nodes.length));
    result.zones = zones;
    const nodeIds = new Set(zones.flatMap((zone) => zone.nodes.map((node) => node.id)));
    if (!lenient && !nodeIds.size) fail("至少需要一个节点。");
    const links = [];
    const pairs = new Set();
    for (const raw of Array.isArray(value.links) ? value.links : (value.links == null ? [] : fail("links 应为列表。"))) {
      if (links.length >= limits.links) { if (lenient) break; fail(`连线最多 ${limits.links} 条。`); }
      const link = guard(() => {
        if (!plain(raw) || !nodeIds.has(raw.from) || !nodeIds.has(raw.to) || raw.from === raw.to) fail("连线两端必须是不同的已有节点。");
        if (pairs.has(`${raw.from}>${raw.to}`)) fail("同一方向的两个节点只能有一条连线。");
        const entry = { from: raw.from, to: raw.to, label: text(raw.label, 16, true, "连线文字"),
          kind: choice(raw.kind, kinds, "main", "连线类型") };
        if (raw.evidence != null) {
          if (!matches(cardId, raw.evidence) || raw.evidence === "board") fail("evidence 应为卡号。");
          entry.evidence = raw.evidence;
        }
        return entry;
      });
      if (!link) continue;
      pairs.add(`${link.from}>${link.to}`);
      links.push(link);
    }
    if (links.length) result.links = links;
    return result;
  }
  function validate(value) { return build(value, false); }
  function clean(value) {
    if (value == null) return null;
    try {
      const result = build(value, true);
      return result.zones.length ? result : null;
    } catch { return null; }
  }

  /* Keeps only nodes whose card exists. Links, evidence and empty zones follow.
   * `dropped` counts hidden node and evidence references so the reader can say so. */
  function resolve(structure, liveIds) {
    if (!structure?.zones) return null;
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    let dropped = 0;
    const zones = structure.zones.map((zone) => {
      const nodes = zone.nodes.filter((node) => live.has(node.cardId));
      dropped += zone.nodes.length - nodes.length;
      return { ...zone, nodes };
    }).filter((zone) => zone.nodes.length);
    const present = new Set(zones.flatMap((zone) => zone.nodes.map((node) => node.id)));
    const links = (structure.links || []).filter((link) => present.has(link.from) && present.has(link.to))
      .map((link) => {
        if (link.evidence && !live.has(link.evidence)) {
          dropped++;
          const { evidence, ...rest } = link;
          return rest;
        }
        return link;
      });
    if (!zones.length) return null;
    const { zones: _zones, links: _links, ...rest } = structure;
    return { ...rest, zones, ...(links.length ? { links } : {}), dropped };
  }

  /* Cards the record points at, for import checks. */
  function cardIds(structure) {
    return [...new Set([...(structure?.zones || []).flatMap((zone) => zone.nodes.map((node) => node.cardId)),
      ...(structure?.links || []).map((link) => link.evidence).filter(Boolean)])];
  }
  function moduleDiagrams(value, strict = false) {
    if (!Array.isArray(value)) {
      if (strict) fail("模块关系图应为列表。");
      return [];
    }
    const seen = new Set();
    const diagrams = [];
    for (const raw of value) {
      const diagram = strict ? validate(raw) : clean(raw);
      if (!diagram?.rootId || seen.has(diagram.rootId)) {
        if (strict) fail("每幅模块图都需要不同的根卡编号。");
        continue;
      }
      seen.add(diagram.rootId);
      diagrams.push(diagram);
    }
    return diagrams;
  }
  return { VERSION, roles, sizes, kinds, limits, validate, clean, resolve, cardIds, moduleDiagrams };
});
