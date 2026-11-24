/* Module diagram: a pure projection from real cards to a project-structure record (version 1).
 * derive(nodes, rootId) shows ONE level: the root card plus its direct children, grouped only by
 * records the cards themselves carry. Arrows come only from the root's explicit flowSteps.
 * Parent/child, shared branch and card order never become arrows. Nothing is stored or mutated;
 * the result is meant for renderStructure and is recomputed from live cards each time.
 * Hand-authored structures are chosen before this by the caller; this file never overrides them. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ModuleDiagram = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const VERSION = 1;
  /* zones/nodesPerZone/nodes/links/lane mirror ProjectStructure.limits; steps is the flow editor's cap. */
  const limits = { zones: 8, nodesPerZone: 8, nodes: 40, links: 40, lane: 5, steps: 12, stepsPerZone: 6 };
  const cardId = /^(?:[EA]\d+|board)$/;
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/gu;
  const capabilityFields = ["audience", "input", "outcome", "boundary", "verification"];
  /* Support groups in reading order. role only picks the colour; topics stay neutral on purpose. */
  const groups = [
    { key: "cap", id: "cap", title: "使用能力", role: "capability" },
    { key: "exp", id: "exp", title: "实验结果", role: "feedback" },
    { key: "code", id: "code", title: "实现依据", role: "store" },
    { key: "topic", id: "topic", title: "相关主题", role: "capability" },
  ];

  const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const present = (value) => typeof value === "string" && value.trim() !== "";
  function clip(value, limit) {
    const text = typeof value === "string" ? value.replace(control, "").replace(/\s+/gu, " ").trim() : "";
    const chars = Array.from(text);
    return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
  }
  function firstSentence(value) {
    const text = clip(value, 400);
    return text.match(/^[\s\S]+?(?:[。！？]|[!?](?=\s|$))/u)?.[0] || text;
  }
  const heading = (card) => clip(String(card.title ?? "").replace(/^\s*【[^】]*】\s*/u, "") || card.title, 60);
  function capabilityOf(card) {
    const value = card.capability;
    if (!plain(value) || value.version !== 1 || Object.keys(value).some((key) => key !== "version" && !capabilityFields.includes(key))) return null;
    return capabilityFields.every((key) => present(value[key]) && Array.from(value[key]).length <= 200) ? value : null;
  }
  function experimentOf(card) {
    const value = card.experiment;
    if (!plain(value)) return null;
    return ["question", "metricSummary", "finding"].some((key) => present(value[key])) || plain(value.comparison) ? value : null;
  }
  /* The record a card carries decides its group. Code evidence wins, then capability, then experiment. */
  function kindOf(card) {
    if (plain(card.codePreview)) return "code";
    if (capabilityOf(card)) return "cap";
    if (experimentOf(card)) return "exp";
    return "topic";
  }
  function brief(card) {
    const record = experimentOf(card);
    const value = capabilityOf(card)?.outcome || record?.question || record?.metricSummary || record?.finding || firstSentence(card.summary);
    const text = clip(value, 80);
    return text && text.toLowerCase() !== heading(card).toLowerCase() ? text : "";
  }
  /* Balanced slices: 7 cards with a cap of 6 become 4 + 3, never 6 + 1. */
  function slices(list, max) {
    const per = Math.ceil(list.length / Math.ceil(list.length / max));
    const result = [];
    for (let index = 0; index < list.length; index += per) result.push(list.slice(index, index + per));
    return result;
  }
  const nodeId = (id) => `n-${id.toLowerCase()}`;

  function derive(nodes, rootId) {
    if (!Array.isArray(nodes) || typeof rootId !== "string") return null;
    const byId = new Map();
    for (const card of nodes) {
      if (plain(card) && typeof card.id === "string" && cardId.test(card.id) && !byId.has(card.id)) byId.set(card.id, card);
    }
    const home = byId.get(rootId);
    if (!home) return null;
    const cards = [...byId.values()];
    const below = new Map();
    for (const card of cards) {
      if (card.parentId !== card.id && typeof card.parentId === "string") below.set(card.parentId, (below.get(card.parentId) || 0) + 1);
    }
    const kids = cards.filter((card) => card.id !== rootId && card.id !== "board" && card.parentId === rootId);
    const diagnostics = [];

    /* flowSteps are trusted only as a whole: one bad entry drops the arrows, never reorders or bridges them. */
    function readSteps() {
      const raw = home.flowSteps;
      if (raw == null || (Array.isArray(raw) && !raw.length)) return [];
      const reject = (code, message) => { diagnostics.push({ code, message }); return []; };
      if (!Array.isArray(raw)) return reject("flow-shape", "flowSteps 不是列表。");
      if (raw.length < 2) return reject("flow-short", "flowSteps 少于两步。");
      if (raw.length > limits.steps) return reject("flow-long", `flowSteps 超过 ${limits.steps} 步。`);
      if (!raw.every((id) => typeof id === "string")) return reject("flow-shape", "flowSteps 含非卡号项。");
      if (new Set(raw).size !== raw.length) return reject("flow-duplicate", "flowSteps 含重复步骤。");
      const direct = new Set(kids.map((card) => card.id));
      if (!raw.every((id) => direct.has(id))) return reject("flow-orphan", "flowSteps 含不是直属下级的卡。");
      return raw.slice();
    }
    const steps = readSteps();
    const stepSet = new Set(steps);
    const rest = { cap: [], exp: [], code: [], topic: [] };
    for (const card of kids) if (!stepSet.has(card.id)) rest[kindOf(card)].push(card);

    const specs = [];
    const entryNote = !kids.length ? "没有下级卡片；可直接编辑本卡，或在这里新建下级。" : undefined;
    specs.push({ id: "entry", title: home.id === "board" ? "整个白板" : "本模块", role: "entry", size: "small", lane: 0, note: entryNote, cards: [home] });
    const flowParts = steps.length ? slices(steps.map((id) => byId.get(id)), limits.stepsPerZone) : [];
    flowParts.forEach((part, index) => specs.push({
      id: flowParts.length > 1 ? `flow-${index + 1}` : "flow",
      title: flowParts.length > 1 ? `主流程 ${index + 1}/${flowParts.length}` : "主流程",
      role: "capability", size: "medium", lane: 1 + index,
      note: index ? undefined : clip(`按「${heading(home)}」登记的步骤顺序`, 120), cards: part, flow: true,
    }));
    const firstFree = 1 + flowParts.length;
    const columns = Math.min(3, limits.lane + 1 - firstFree);
    let support = 0;
    for (const group of groups) {
      const parts = rest[group.key].length ? slices(rest[group.key], limits.nodesPerZone) : [];
      parts.forEach((part, index) => {
        specs.push({
          id: parts.length > 1 ? `${group.id}-${index + 1}` : group.id,
          title: parts.length > 1 ? `${group.title} ${index + 1}/${parts.length}` : group.title,
          role: group.role, size: part.length > 4 ? "large" : "medium", lane: firstFree + (support++ % columns), cards: part,
        });
      });
    }

    /* Hard limits: entry and flow always fit; support zones are cut at zone / node limits and counted. */
    const zones = [];
    let used = 0;
    let omitted = 0;
    for (const spec of specs) {
      const room = limits.nodes - used;
      const take = zones.length >= limits.zones ? 0 : Math.min(spec.cards.length, room);
      omitted += spec.cards.length - take;
      if (!take) continue;
      used += take;
      const zone = { id: spec.id, title: spec.title, role: spec.role, size: spec.size, lane: spec.lane };
      if (spec.note) zone.note = spec.note;
      zone.nodes = spec.cards.slice(0, take).map((card) => {
        const count = below.get(card.id) || 0;
        const note = clip([count ? `含 ${count} 张下级` : "", brief(card)].filter(Boolean).join(" · "), 80);
        return { id: nodeId(card.id), cardId: card.id, ...(note ? { note } : {}) };
      });
      zones.push(zone);
    }
    if (omitted) {
      zones[0].note = `本图显示 ${used - 1} 张下级卡，另有 ${omitted} 张未显示。`;
      diagnostics.push({ code: "omitted", message: `${omitted} 张下级卡超出 zone/node 上限，未显示。` });
    }

    const links = [];
    for (let index = 0; index + 1 < steps.length; index++) {
      links.push({
        from: nodeId(steps[index]), to: nodeId(steps[index + 1]), label: `第${index + 2}步`, kind: "main",
        /* The card that holds the order owns the arrow; the virtual board has no card to open, so use the target step. */
        evidence: home.id === "board" ? steps[index + 1] : home.id,
      });
    }
    return {
      version: VERSION,
      title: home.id === "board" ? "白板总览" : `${clip(heading(home), 28)} · 模块图`,
      rootId: home.id,
      zones,
      ...(links.length ? { links } : {}),
      derived: { leaf: !kids.length, flow: steps.length >= 2, omitted, diagnostics },
    };
  }
  return { VERSION, limits, derive };
});
