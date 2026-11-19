(() => {
  "use strict";

  const palette = [
    ["#388783", "#e3f1ed"], ["#5779ad", "#e8eef8"],
    ["#80659d", "#f1eaf7"], ["#9b685f", "#f6ebe7"],
    ["#8c7942", "#f5efdb"], ["#517e58", "#e7f0e3"],
  ];
  let callbacks = {};
  let initialized = false;
  let mode = false;
  let selectedIds = [];
  let lastItems = [];
  let lastElements = [];
  const positionCache = new Map();

  const byId = (id) => document.getElementById(id);
  const storageKey = () => `whiteboard.presentation.${window.BoardMemory?.activeBoard || "original"}.v1`;
  const isBusy = () => typeof callbacks.isBusy === "function" ? Boolean(callbacks.isBusy()) : Boolean(callbacks.isBusy);
  const arrayOf = (value) => value instanceof Map ? [...value.values()] : Array.from(value || []);
  const elementsOf = (value) => arrayOf(value).filter((entry) => entry?.dataset?.elementId);

  function savedMode() {
    try { return localStorage.getItem(storageKey()) === "mindmap"; }
    catch { return false; }
  }

  function cleanPositions(value) {
    const positions = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return positions;
    for (const [id, point] of Object.entries(value)) {
      if (!/^[EA]\d+$/.test(id) || !point || ![point.x, point.y].every(
        (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e6)) continue;
      positions[id] = { x: point.x, y: point.y };
    }
    return positions;
  }

  function loadPositions() {
    const key = `${storageKey()}.positions`;
    if (!positionCache.has(key)) {
      let saved = {};
      try { saved = cleanPositions(JSON.parse(localStorage.getItem(key) || "{}")); }
      catch { /* A malformed or unavailable preference must not hide the board. */ }
      positionCache.set(key, saved);
    }
    return cleanPositions(positionCache.get(key));
  }

  function savePositions(value) {
    const key = `${storageKey()}.positions`;
    const positions = cleanPositions(value);
    positionCache.set(key, positions);
    try { localStorage.setItem(key, JSON.stringify(positions)); return true; }
    catch { return false; }
  }

  function syncMode() {
    document.body.classList.toggle("mindmap-view", mode);
    byId("presentation-cards")?.setAttribute("aria-pressed", String(!mode));
    byId("presentation-mindmap")?.setAttribute("aria-pressed", String(mode));
    for (const id of ["mindmap-overview", "mindmap-expand-all"]) {
      const button = byId(id);
      if (button) button.hidden = !mode;
    }
    const toolbar = byId("mindmap-tools") || byId("mindmap-toolbar");
    if (toolbar) toolbar.hidden = !mode;
    const inspector = byId("mindmap-inspector");
    if (inspector) inspector.hidden = !mode;
  }

  function setActive(value) {
    const next = Boolean(value);
    if (mode === next || isBusy()) return false;
    mode = next;
    try { localStorage.setItem(storageKey(), mode ? "mindmap" : "cards"); }
    catch { /* The current view still works when browser storage is unavailable. */ }
    syncMode();
    callbacks.onChange?.(mode);
    inspect(selectedIds, lastItems, lastElements);
    return true;
  }

  function init(options = {}) {
    callbacks = options;
    mode = savedMode();
    if (!initialized) {
      byId("presentation-cards")?.addEventListener("click", () => setActive(false));
      byId("presentation-mindmap")?.addEventListener("click", () => setActive(true));
      byId("mindmap-overview")?.addEventListener("click", () => callbacks.onOverview?.());
      byId("mindmap-expand-all")?.addEventListener("click", () => callbacks.onExpandAll?.());
      initialized = true;
    }
    syncMode();
    inspect(selectedIds, lastItems, lastElements);
  }

  function hierarchy(items, elements) {
    const models = new Map(arrayOf(items).filter((item) => item?.id).map((item) => [item.id, item]));
    const dom = new Map(elementsOf(elements).map((element) => [element.dataset.elementId, element]));
    const ids = new Set([...models.keys(), ...dom.keys()]);
    const parents = new Map();
    for (const id of ids) {
      const item = models.get(id);
      const element = dom.get(id);
      const candidates = item && Object.hasOwn(item, "parentId") ? [item.parentId] :
        [element?.dataset.sectionOf, ...(element?.dataset.anchor || "").split(",")];
      parents.set(id, candidates.find((parent) => parent && parent !== id && ids.has(parent)) || null);
    }
    // Broken or cyclic imported links should not prevent reading the rest of the board.
    for (const id of ids) {
      const visited = new Set([id]);
      for (let parent = parents.get(id); parent; parent = parents.get(parent)) {
        if (visited.has(parent)) { parents.set(id, null); break; }
        visited.add(parent);
      }
    }
    const children = new Map();
    for (const [id, parent] of parents) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
    const path = (id) => {
      const result = [];
      const seen = new Set();
      for (let cursor = id; cursor && !seen.has(cursor); cursor = parents.get(cursor)) {
        seen.add(cursor);
        result.unshift(cursor);
      }
      return result;
    };
    return { models, dom, parents, children, path };
  }

  function branchColor(id) {
    let hash = 0;
    for (const character of id || "") hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    return palette[hash % palette.length];
  }

  function decorate(items, elements) {
    lastItems = arrayOf(items);
    lastElements = elementsOf(elements);
    const tree = hierarchy(lastItems, lastElements);
    for (const [id, element] of tree.dom) {
      const path = tree.path(id);
      const level = path.length - 1;
      const branch = path[1] || id;
      const [color, tint] = level ? branchColor(branch) : ["#23483f", "#23483f"];
      element.dataset.mapLevel = level === 0 ? "root" : level === 1 ? "module" : "detail";
      element.dataset.mapBranch = branch;
      element.style.setProperty("--map-color", color);
      element.style.setProperty("--map-tint", tint);
      const descendants = new Set();
      const pending = [...(tree.children.get(id) || [])];
      while (pending.length) {
        const child = pending.pop();
        if (descendants.has(child)) continue;
        descendants.add(child);
        pending.push(...(tree.children.get(child) || []));
      }
      const count = [...descendants].filter((child) => tree.models.get(child)?.category !== "archive").length;
      element.dataset.mapCount = String(count);
      const toggle = element.querySelector(".branch-toggle");
      if (toggle) toggle.dataset.mapCount = String(count);
    }
    return tree;
  }

  function measure(items, elements) {
    const ids = new Set(arrayOf(items).map((item) => item?.id).filter(Boolean));
    const measurements = new Map();
    for (const element of elementsOf(elements)) {
      const id = element.dataset.elementId;
      if (!ids.has(id) || element.hidden || !element.getClientRects().length) continue;
      measurements.set(id, { width: element.offsetWidth, height: element.offsetHeight });
    }
    return measurements;
  }

  function append(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    parent.append(element);
    return element;
  }

  function titleOf(id, tree) {
    if (id === "board") return "整个白板";
    return tree.models.get(id)?.title || tree.dom.get(id)?.querySelector(
      ".organized-title, .element-title, .thread-question")?.textContent?.trim() || id;
  }

  function contentClone(source) {
    const clone = source.cloneNode(true);
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name === "id" || attribute.name === "hidden" || attribute.name === "style" ||
            attribute.name === "tabindex" || attribute.name.startsWith("on") || attribute.name.startsWith("data-select")) {
          element.removeAttribute(attribute.name);
        }
      }
      for (const attribute of ["href", "src"]) {
        if (/^\s*(?:javascript:|vbscript:|data:(?!image\/(?:png|jpeg|gif|webp);))/i.test(element.getAttribute(attribute) || "")) element.removeAttribute(attribute);
      }
    }
    clone.querySelectorAll("script, style, iframe, object, embed, button, input, textarea, select").forEach((element) => element.remove());
    clone.classList.add("mindmap-detail-content");
    return clone;
  }

  function addList(parent, label, entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const section = append(parent, "section", "mindmap-detail-section");
    append(section, "h4", "", label);
    const list = append(section, "ul", "");
    for (const entry of entries) append(list, "li", "", entry);
  }

  function inspect(ids = [], items = lastItems, elements = lastElements) {
    selectedIds = [...new Set(arrayOf(ids).filter((id) => typeof id === "string"))];
    lastItems = arrayOf(items);
    lastElements = elementsOf(elements);
    const container = byId("mindmap-inspector");
    if (!container) return;
    container.hidden = !mode;
    if (!mode) return;
    container.replaceChildren();
    append(container, "p", "mindmap-detail-kicker", "节点说明");
    if (!selectedIds.length) {
      append(container, "h3", "mindmap-detail-title", "从主干开始，逐层读懂项目");
      append(container, "p", "mindmap-detail-hint", "点击节点查看完整说明、文件依据和附件。节点旁的 + / − 只展开或收起下级，提问和拆分仍作用于同一张白板。");
      return;
    }
    const tree = hierarchy(lastItems, lastElements);
    const id = selectedIds[0];
    if (selectedIds.length > 1) {
      append(container, "h3", "mindmap-detail-title", `已选 ${selectedIds.length} 个节点`);
      addList(container, "所选节点", selectedIds.map((entry) => `${entry} · ${titleOf(entry, tree)}`));
      append(container, "p", "mindmap-detail-hint", "可对当前选区提问；选择单个节点可查看完整说明和拆分下级。");
    } else {
      const item = tree.models.get(id);
      const original = tree.dom.get(id);
      const breadcrumb = append(container, "p", "mindmap-detail-breadcrumb");
      breadcrumb.textContent = tree.path(id).map((entry) => titleOf(entry, tree)).join(" › ");
      append(container, "h3", "mindmap-detail-title", titleOf(id, tree));
      append(container, "p", "mindmap-detail-id", `${id} · ${original?.dataset.mapCount || 0} 个下级`);
      const content = append(container, "div", "mindmap-detail-body");
      const originalBody = original?.querySelector(":scope > .organized-face > .organized-body");
      if (originalBody?.childElementCount) content.append(contentClone(originalBody));
      else {
        if (item?.taskDetails) {
          append(content, "p", "mindmap-detail-description", item.taskDetails.task);
          addList(content, "依赖", item.taskDetails.dependencies);
          addList(content, "验收标准", item.taskDetails.acceptance);
        } else if (original?.querySelector(":scope > .thread-answer")) {
          content.append(contentClone(original.querySelector(":scope > .thread-answer")));
        } else if (item?.summary) append(content, "p", "mindmap-detail-description", item.summary);
        else {
          const parts = original?.querySelectorAll(":scope > .element-content, :scope > .thread-answer") || [];
          for (const part of parts) content.append(contentClone(part));
        }
        const files = [...new Set([...(item?.repositoryFiles || []), ...(item?.sources || [])])];
        addList(content, "代码依据", files);
        if (item?.codePreview) {
          append(content, "p", "mindmap-detail-codepath", item.codePreview.path);
          append(content, "pre", "mindmap-detail-code", item.codePreview.text);
        }
        const attachments = original?.querySelector(".thread-attachments");
        if (attachments) content.append(contentClone(attachments));
      }
      if (!content.textContent.trim() && !content.querySelector("img, video")) {
        append(content, "p", "mindmap-detail-hint", "这个节点还没有正文。可以提问继续理解，或返回卡片编辑补充。");
      }
    }
    const actions = append(container, "div", "mindmap-detail-actions");
    function action(actionId, label, callback, disabled = false) {
      const button = append(actions, "button", "tool-button", label);
      button.id = actionId;
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", () => callback?.(id));
    }
    action("mindmap-ask", "问选中内容", callbacks.onAsk,
      isBusy() || Boolean(callbacks.canAsk && !callbacks.canAsk()));
    if (selectedIds.length === 1) {
      action("mindmap-split", "拆分节点", callbacks.onSplit,
        isBusy() || Boolean(callbacks.canSplit && !callbacks.canSplit()));
      action("mindmap-show-card", "查看卡片", callbacks.onShowCard);
    }
  }

  window.BoardMindmap = { init, setActive, decorate, measure, inspect, savePositions,
    get positions() { return loadPositions(); }, get active() { return mode; } };
})();
