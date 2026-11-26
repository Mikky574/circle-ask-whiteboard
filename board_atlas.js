/* The atlas projects the board's live card ids and recorded edges. */
(() => {
  "use strict";

  function build(items, diagrams, references, saved) {
    const cards = new Map(items.filter(card => card.id !== "board").map(card => [card.id, card]));
    const links = new Map();
    const connect = (from, to, label, kind, basis = "") => {
      if (from === to || !cards.has(from) || !cards.has(to)) return;
      const key = JSON.stringify([from, to, label]);
      if (!links.has(key)) links.set(key, { from, to, label, kind, basis });
    };
    for (const link of saved) connect(link.from, link.to, link.label, "knowledge", link.basis);
    for (const diagram of diagrams.filter(Boolean)) {
      const ids = new Map(diagram.zones.flatMap(zone => zone.nodes.map(node => [node.id, node.cardId])));
      for (const link of diagram.links || []) {
        const from = ids.get(link.from), to = ids.get(link.to);
        connect(from, to, link.label || "模块关系", "diagram", diagram.title);
        if (cards.has(from) && cards.has(to)) connect(from, link.evidence, "关系依据", "evidence");
      }
    }
    for (const card of cards.values()) {
      connect(card.parentId, card.id, "下级", "hierarchy");
      const steps = card.flowSteps || [];
      if (steps.every(id => cards.get(id)?.parentId === card.id)) {
        for (let i = 1; i < steps.length; i++) connect(steps[i - 1], steps[i], "流程下一步", "flow");
      }
    }
    for (const { id, parentIds } of references) {
      for (const parent of parentIds) if (cards.get(id)?.parentId !== parent) connect(parent, id, "引用关联", "reference");
    }
    const adjacency = new Map([...cards.keys()].map(id => [id, []]));
    for (const edge of links.values()) {
      adjacency.get(edge.from).push(edge);
      adjacency.get(edge.to).push(edge);
    }
    return { cards, links: [...links.values()], adjacency };
  }

  const opposite = (edge, id) => edge.from === id ? edge.to : edge.from;
  function hops(adjacency, root, depth = Infinity, maximum = Infinity) {
    const visited = new Map([[root, 0]]);
    for (const [id, distance] of visited) {
      if (distance >= depth || visited.size >= maximum) break;
      for (const edge of adjacency.get(id) || []) {
        const next = opposite(edge, id);
        if (!visited.has(next)) visited.set(next, distance + 1);
        if (visited.size >= maximum) break;
      }
    }
    return visited;
  }

  const title = card => card.title.replace(/^【[^】]+】\s*/u, "");
  const tone = card => card.experiment?.comparison || card.codePreview || card.spec?.kind === "case" ? "evidence"
    : card.category === "todo" || card.spec?.kind === "constraint" ? "review"
    : card.capability ? "capability" : card.category === "main" ? "topic" : "material";
  const toneLabels = { topic: "主题", capability: "能力", evidence: "证据", review: "待关注", material: "资料", draft: "候选" };
  const create = (parent, tag, className, copy) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (copy != null) el.textContent = copy;
    parent.append(el);
    return el;
  };
  function button(parent, label, action, css = "research-button") {
    const el = create(parent, "button", css, label);
    el.type = "button";
    el.addEventListener("click", action);
    return el;
  }
  function svg(parent, tag, props) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(props)) el.setAttribute(name, String(value));
    parent.append(el);
    return el;
  }

  function plot(rings, width, height) {
    const byLevel = new Map();
    for (const [id, level] of rings) {
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(id);
    }
    const total = Math.max(1, ...byLevel.keys());
    const result = new Map();
    for (const [level, cards] of byLevel) {
      const density = Math.max(1, Math.sqrt(cards.length / 12));
      const radius = Math.pow(level / total, .75);
      cards.forEach((id, index) => {
        const angle = -Math.PI * .63 + 2 * Math.PI * index / cards.length + level * .35;
        const spread = level ? (index % 3 - 1) * Math.min(.15, .055 * density) : 0;
        result.set(id, { x: width / 2 + Math.cos(angle) * (radius + spread) * Math.max(52, width / 2 - 68),
          y: height / 2 + Math.sin(angle) * (radius + spread) * Math.max(56, height / 2 - 57) });
      });
    }
    return result;
  }

  function mount(host, options) {
    const chrome = create(host, "div", "atlas-shell");
    const heading = create(chrome, "header", "atlas-heading research-heading");
    const headingText = create(heading, "div");
    create(headingText, "p", "atlas-overline", "项目知识图谱");
    const name = create(headingText, "h2", "", options.title);
    name.tabIndex = -1;
    const tools = create(heading, "div", "research-heading-actions");
    button(tools, "模块关系图", options.onStructure);

    const layout = create(chrome, "div", "atlas-layout");
    const side = create(layout, "aside", "atlas-search");
    side.setAttribute("aria-label", "搜索项目卡片");
    const label = create(side, "label", "atlas-search-label", "搜索项目");
    const input = create(label, "input");
    input.type = "search";
    input.placeholder = "卡片标题、正文或证据";
    input.autocomplete = "off";
    input.maxLength = 400;
    const resultStatus = create(side, "p", "atlas-search-status");
    resultStatus.setAttribute("aria-live", "polite");
    const resultList = create(side, "ul", "atlas-results");
    const more = button(side, "显示更多", () => { resultLimit += 30; renderSearch(); });
    more.hidden = true;

    const work = create(layout, "section", "atlas-work");
    const controls = create(work, "div", "atlas-tools");
    const ranges = create(controls, "div", "atlas-ranges");
    const local = button(ranges, "局部图谱", () => scope(false));
    const project = button(ranges, "项目全图", () => scope(true));
    const depths = create(controls, "div", "atlas-depths");
    depths.setAttribute("aria-label", "关系深度");
    const hopsButtons = [1, 2, 3].map(value => button(depths, value + " 跳", () => {
      depth = value; camera = reset(); rebuild();
    }));
    const counts = create(controls, "p", "atlas-counts");
    const graph = create(work, "div", "atlas-graph");
    graph.setAttribute("role", "group");
    graph.setAttribute("aria-label", "卡片关系图，可在空白处拖动平移");
    const edgesLayer = svg(graph, "svg", { class: "atlas-edges", "aria-hidden": "true" });
    const nodesLayer = create(graph, "div", "atlas-nodes");
    const graphBottom = create(work, "div", "atlas-map-bottom");
    const legend = create(graphBottom, "div", "atlas-legend");
    for (const type of Object.keys(toneLabels).slice(0, -1)) {
      const item = create(legend, "span", "", toneLabels[type]);
      item.dataset.tone = type;
    }
    const zoomButtons = create(graphBottom, "div", "atlas-zoom");
    const zoomOut = button(zoomButtons, "−", () => zoom(camera.scale / 1.2));
    zoomOut.setAttribute("aria-label", "缩小图谱");
    const fit = button(zoomButtons, "100%", () => { camera = reset(); paint(); });
    fit.setAttribute("aria-label", "适应图谱");
    const zoomIn = button(zoomButtons, "＋", () => zoom(camera.scale * 1.2));
    zoomIn.setAttribute("aria-label", "放大图谱");
    const details = create(work, "section", "atlas-details");
    details.setAttribute("aria-label", "当前卡片详情");
    const live = create(work, "p", "atlas-sr");
    live.setAttribute("role", "status");

    const reset = () => ({ x: 0, y: 0, scale: 1 });
    let data, docs = [], fallback, root, current, coords = new Map(), shown = new Map();
    let whole = false, depth = 2, camera = reset(), resultLimit = 30, drag, frame = 0;
    let proposal = { cards: [], links: [] };
    const buttons = new Map();

    function message(text) { live.textContent = text; counts.title = text; }
    function scope(value) {
      whole = value; camera = reset(); rebuild();
    }
    function projectRings() {
      const rings = new Map();
      const remaining = new Set(data.cards.keys());
      const roots = [root, ...remaining];
      for (const seed of roots) {
        if (!remaining.has(seed)) continue;
        const start = rings.size ? 1 : 0;
        for (const [id, steps] of hops(data.adjacency, seed)) {
          if (!remaining.delete(id)) continue;
          rings.set(id, Math.min(5, steps + start));
        }
      }
      return rings;
    }
    function rebuild() {
      shown = root ? whole ? projectRings() : hops(data.adjacency, root, depth) : new Map();
      const width = graph.clientWidth, height = graph.clientHeight;
      coords = width && height ? plot(shown, width, height) : new Map();
      local.setAttribute("aria-pressed", String(!whole));
      project.setAttribute("aria-pressed", String(whole));
      depths.hidden = whole;
      hopsButtons.forEach((el, index) => el.setAttribute("aria-pressed", String(depth === index + 1)));
      paint();
    }
    function panPoint(point) {
      const middleX = graph.clientWidth / 2, middleY = graph.clientHeight / 2;
      return { x: (point.x - middleX) * camera.scale + middleX + camera.x,
        y: (point.y - middleY) * camera.scale + middleY + camera.y };
    }
    function zoom(scale, x = graph.clientWidth / 2, y = graph.clientHeight / 2) {
      const next = Math.max(.35, Math.min(3.4, scale));
      const ratio = next / camera.scale;
      camera.x = (camera.x + graph.clientWidth / 2 - x) * ratio - graph.clientWidth / 2 + x;
      camera.y = (camera.y + graph.clientHeight / 2 - y) * ratio - graph.clientHeight / 2 + y;
      camera.scale = next;
      paint();
    }
    function paint() {
      if (!data || !graph.clientWidth) return;
      const points = new Map(coords);
      const out = new Map(proposal.cards.map(card => [card.id, card]));
      const origin = coords.get(current);
      if (origin) {
        const missing = [...out.keys(), ...proposal.links.flatMap(edge => [edge.from, edge.to])]
          .filter(id => !points.has(id));
        [...new Set(missing)].forEach((id, index) => {
          const angle = .75 + index * .83;
          points.set(id, { x: Math.min(graph.clientWidth - 30, Math.max(30, origin.x + 90 * Math.cos(angle))),
            y: Math.min(graph.clientHeight - 35, Math.max(35, origin.y + 90 * Math.sin(angle))) });
        });
      }
      const drafts = proposal.cards.map(card => ({ from: current, to: card.id, label: "建议新卡", draft: true }));
      const links = [...data.links, ...proposal.links.map(edge => ({ ...edge, draft: true })), ...drafts]
        .filter(edge => points.has(edge.from) && points.has(edge.to));
      const near = new Set((data.adjacency.get(current) || []).map(edge => opposite(edge, current)));
      const width = graph.clientWidth, height = graph.clientHeight;
      const positioned = new Map([...points].map(([id, point]) => [id, panPoint(point)]));
      edgesLayer.replaceChildren();
      edgesLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const labelled = new Set();
      const labelPoints = [];
      for (const edge of links) {
        const from = positioned.get(edge.from), to = positioned.get(edge.to);
        const direct = edge.from === current || edge.to === current;
        const bend = edge.kind === "hierarchy" ? 0 : 13;
        const mx = (from.x + to.x) / 2 - bend, my = (from.y + to.y) / 2 + bend;
        svg(edgesLayer, "path", { d: `M${from.x} ${from.y} Q${mx} ${my} ${to.x} ${to.y}`,
          class: edge.draft ? "is-draft" : direct ? "is-direct" : "" });
        const key = [edge.from, edge.to].sort().join(":");
        if (direct && (edge.draft || edge.kind !== "hierarchy") && width > 490 && Math.hypot(to.x - from.x, to.y - from.y) > 90 &&
            (!labelled.has(key) || edge.draft) &&
            !labelPoints.some(point => Math.abs(point.x - mx) < 85 && Math.abs(point.y - my) < 15)) {
          labelled.add(key);
          labelPoints.push({ x: mx, y: my });
          const mark = svg(edgesLayer, "text", { x: mx, y: my - 4, "text-anchor": "middle" });
          mark.textContent = edge.label;
        }
      }
      for (const [id, el] of buttons) if (!positioned.has(id)) { el.remove(); buttons.delete(id); }
      for (const [id, point] of positioned) {
        const card = data.cards.get(id) || out.get(id);
        let el = buttons.get(id);
        if (!el) {
          el = button(nodesLayer, "", () => select(id, false), "atlas-node");
          el.dataset.cardId = id;
          create(el, "span", "atlas-dot");
          create(el, "span", "atlas-node-label");
          buttons.set(id, el);
        }
        el.lastElementChild.textContent = title(card);
        el.disabled = out.has(id);
        el.dataset.tone = el.disabled ? "draft" : tone(card);
        el.dataset.label = current === id || el.disabled || near.has(id) && (shown.size < 20 || camera.scale > 1.15) ||
          shown.size < (width < 560 ? 8 : 18) ? "visible" : "quiet";
        el.dataset.side = point.x > width * .71 ? "left" : point.x < width * .26 ? "right" : "below";
        el.setAttribute("aria-label", title(card));
        el.setAttribute("aria-pressed", String(current === id));
        el.style.left = point.x + "px";
        el.style.top = point.y + "px";
        el.hidden = point.x < 6 || point.x > width - 6 || point.y < 6 || point.y > height - 6;
      }
      counts.textContent = `${shown.size} / ${data.cards.size} 张卡${drafts.length || proposal.links.length ? " · 虚线为预览" : ""}`;
      fit.textContent = Math.round(camera.scale * 100) + "%";
    }
    function select(id, center, notify = true) {
      if (!data.cards.has(id)) return;
      if (center || !shown.has(id) || buttons.get(id)?.hidden) {
        root = id; whole = false; camera = reset();
      }
      current = id;
      rebuild();
      renderDetails();
      if (center) buttons.get(id)?.focus({ preventScroll: true });
      if (notify) options.onSelect(id);
    }
    function renderDetails() {
      details.replaceChildren();
      const card = data.cards.get(current);
      if (!card) return;
      const header = create(details, "header", "atlas-card-heading");
      const heading = create(header, "div");
      create(heading, "p", "atlas-overline", toneLabels[tone(card)] + " · " + card.id);
      create(heading, "h3", "", title(card));
      const actions = create(header, "div", "research-structure-actions");
      button(actions, "以此为中心", () => select(current, true)).disabled = current === root && !whole;
      button(actions, "AI 沿图补资料", () => options.onRecommend(current), "research-button research-opinion-button");
      button(actions, "问这张卡", () => options.onAsk(current));
      if (options.canEdit(current)) button(actions, "编辑原卡", () => options.onEdit(current));
      const body = create(details, "div", "atlas-card-body");
      options.renderCard(create(body, "div", "atlas-card-text"), card);
      const neighbors = create(body, "section", "atlas-relations");
      const links = data.adjacency.get(current) || [];
      create(neighbors, "h4", "", `直接关系 · ${links.length}`);
      const list = create(neighbors, "ul");
      for (const edge of links) {
        const target = data.cards.get(opposite(edge, current));
        const row = create(list, "li");
        const jump = button(row, "", () => select(target.id, true), "atlas-neighbor");
        create(jump, "small", "", (edge.from === current ? "→ " : "← ") + edge.label);
        create(jump, "span", "", title(target));
        if (edge.basis && edge.kind === "knowledge") create(row, "p", "atlas-basis", edge.basis);
      }
    }
    function renderSearch() {
      resultList.replaceChildren();
      if (!data) return;
      const query = input.value.trim();
      const results = query ? options.rank(docs, query) : docs;
      resultStatus.textContent = query ? `${results.length} 张匹配卡片` : `${docs.length} 张项目卡片`;
      more.hidden = results.length <= resultLimit;
      for (const doc of results.slice(0, resultLimit)) {
        const row = create(resultList, "li");
        const hit = button(row, "", () => select(doc.id, true), "atlas-search-hit");
        create(hit, "strong", "", doc.title);
        if (doc.path) create(hit, "small", "", doc.path);
        if (query) {
          const norm = value => value.normalize("NFKC").toLowerCase();
          const words = [query, ...query.split(/\s+/u)].map(norm);
          const part = doc.parts.find(part => words.some(word => norm(part).includes(word)));
          if (part) {
            const at = Math.max(0, ...words.map(word => norm(part).indexOf(word)));
            const start = Math.max(0, at - 22);
            create(hit, "span", "", (start ? "…" : "") + part.slice(start, start + 122) + (part.length > start + 122 ? "…" : ""));
          }
        }
      }
    }
    input.addEventListener("input", () => { resultLimit = 30; renderSearch(); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); resultList.querySelector("button")?.click(); }
    });
    graph.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = graph.getBoundingClientRect();
      zoom(camera.scale * Math.exp(-event.deltaY * .002), event.clientX - bounds.left, event.clientY - bounds.top);
    }, { passive: false });
    graph.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      drag = { id: event.pointerId, x: event.clientX - camera.x, y: event.clientY - camera.y };
      graph.setPointerCapture(event.pointerId);
      graph.classList.add("is-panning");
    });
    graph.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      camera.x = event.clientX - drag.x; camera.y = event.clientY - drag.y;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
    });
    graph.addEventListener("lostpointercapture", () => {
      drag = null; graph.classList.remove("is-panning");
    });
    const resize = new ResizeObserver(() => { if (data) rebuild(); });
    resize.observe(graph);
    return {
      tools,
      update(next, search, selected, initial) {
        data = next; docs = search;
        fallback = data.cards.has(initial) ? initial : data.cards.keys().next().value;
        const selection = data.cards.has(selected) ? selected : data.cards.has(current) ? current : fallback;
        if (!data.cards.has(root) || selection !== current) {
          root = selection; camera = reset();
        }
        current = selection;
        rebuild(); renderSearch(); renderDetails();
        return current;
      },
      locate: id => { if (!data?.cards.has(id)) return false; select(id, true); return true; },
      preview(cards = [], links = []) { proposal = { cards, links }; paint(); },
      notify(text) { message(text); },
      destroy() { if (frame) cancelAnimationFrame(frame); resize.disconnect(); chrome.remove(); },
    };
  }

  window.BoardAtlas = { build, hops, mount };
})();
