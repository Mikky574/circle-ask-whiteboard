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
  let inspectorSelection = "";
  let inspectorSignature = "";
  let quoteSelection = null;
  let readingPointer = false;
  const positionCache = new Map();

  const byId = (id) => document.getElementById(id);
  const storageKey = () => `whiteboard.presentation.${window.BoardMemory?.activeBoard || "original"}.v1`;
  const isBusy = () => typeof callbacks.isBusy === "function" ? Boolean(callbacks.isBusy()) : Boolean(callbacks.isBusy);
  const arrayOf = (value) => value instanceof Map ? [...value.values()] : Array.from(value || []);
  const elementsOf = (value) => arrayOf(value).filter((entry) => entry?.dataset?.elementId);

  function canAskText() {
    return !isBusy() && typeof callbacks.onAskText === "function" &&
      !(typeof callbacks.canAskText === "function" ? !callbacks.canAskText() : callbacks.canAsk && !callbacks.canAsk());
  }

  function renderQuoteSelection() {
    const panel = byId("mindmap-selection-panel");
    if (!panel) return;
    const ask = byId("mindmap-ask-selection");
    if (ask) ask.disabled = !quoteSelection || !canAskText();
    // Showing or hiding a previous quote moves the text under a held pointer.
    // Keep the reader geometry fixed until the native drag has finished.
    if (readingPointer) return;
    panel.hidden = !quoteSelection || !mode;
    if (!quoteSelection) return;
    const label = byId("mindmap-selection-source");
    const preview = panel.querySelector(".mindmap-selection-quote");
    const hint = byId("mindmap-selection-hint");
    if (label) label.textContent = `选自 ${quoteSelection.id} · ${quoteSelection.length} 字`;
    if (preview && preview.textContent !== quoteSelection.quote) preview.textContent = quoteSelection.quote;
    if (hint) hint.textContent = quoteSelection.length > 600 ? "本次引用前 600 字，同时带上所属卡片的上下文。" : "只引用这段文字，同时带上所属卡片的上下文。";
  }

  function clearQuoteSelection(removeNative = false) {
    quoteSelection = null;
    if (removeNative) {
      const selection = window.getSelection();
      const container = byId("mindmap-inspector");
      if (selection?.rangeCount && container?.contains(selection.anchorNode) && container.contains(selection.focusNode)) selection.removeAllRanges();
    }
    renderQuoteSelection();
  }

  function readerOwner(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest("[data-reader-content][data-card-id]");
  }

  function captureReaderSelection() {
    if (!mode || selectedIds.length !== 1) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const owner = readerOwner(range.startContainer);
    const endOwner = readerOwner(range.endContainer);
    if (!owner || owner !== endOwner || !byId("mindmap-inspector")?.contains(owner)) {
      if (owner || endOwner) clearQuoteSelection();
      return;
    }
    const fragments = range.cloneContents();
    if ([...fragments.querySelectorAll("[data-reader-content][data-card-id]")]
      .some((element) => element.dataset.cardId !== owner.dataset.cardId && element.textContent.trim())) {
      clearQuoteSelection();
      return;
    }
    const text = Array.from(selection.toString().trim());
    if (!text.length || !/^[EA]\d+$/.test(owner.dataset.cardId || "")) return;
    quoteSelection = { id: owner.dataset.cardId, quote: text.slice(0, 600).join(""), length: text.length, board: storageKey() };
    if (!readingPointer) renderQuoteSelection();
  }

  function selectionPanel(actions) {
    const panel = append(actions, "section", "mindmap-selection-panel");
    panel.id = "mindmap-selection-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "当前引用的正文选段");
    const source = append(panel, "p", "mindmap-selection-source");
    source.id = "mindmap-selection-source";
    append(panel, "blockquote", "mindmap-selection-quote");
    const hint = append(panel, "p", "mindmap-selection-hint");
    hint.id = "mindmap-selection-hint";
    const controls = append(panel, "div", "mindmap-selection-actions");
    const ask = append(controls, "button", "tool-button mindmap-primary-action", "问这段");
    ask.id = "mindmap-ask-selection";
    ask.type = "button";
    ask.addEventListener("mousedown", (event) => event.preventDefault());
    ask.addEventListener("click", () => {
      if (!canAskText() || !quoteSelection || quoteSelection.board !== storageKey()) return;
      const { id, quote } = quoteSelection;
      callbacks.onAskText({ id, quote });
    });
    const clear = append(controls, "button", "tool-button", "取消选段");
    clear.type = "button";
    clear.id = "mindmap-selection-clear";
    clear.addEventListener("click", () => clearQuoteSelection(true));
  }

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

  function setActive(value, { remember = true } = {}) {
    const next = Boolean(value);
    if (mode === next || isBusy()) return false;
    clearQuoteSelection(true);
    readingPointer = false;
    mode = next;
    if (remember) {
      try { localStorage.setItem(storageKey(), mode ? "mindmap" : "cards"); }
      catch { /* The current view still works when browser storage is unavailable. */ }
    }
    syncMode();
    callbacks.onChange?.(mode);
    inspect(selectedIds, lastItems, lastElements);
    return true;
  }

  function init(options = {}) {
    clearQuoteSelection(true);
    readingPointer = false;
    callbacks = options;
    mode = savedMode();
    if (!initialized) {
      byId("mindmap-overview")?.addEventListener("click", () => callbacks.onOverview?.());
      byId("mindmap-expand-all")?.addEventListener("click", () => callbacks.onExpandAll?.());
      document.addEventListener("selectionchange", captureReaderSelection);
      byId("mindmap-inspector")?.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, a, input, textarea, select, summary") || !readerOwner(event.target)) return;
        readingPointer = true;
        // A press inside an old text range would otherwise start native HTML
        // drag-and-drop and cancel this selection gesture before pointerup.
        clearQuoteSelection(true);
      });
      document.addEventListener("pointerup", () => {
        if (!readingPointer) return;
        readingPointer = false;
        captureReaderSelection();
        renderQuoteSelection();
      });
      document.addEventListener("pointercancel", () => {
        readingPointer = false;
        captureReaderSelection();
        renderQuoteSelection();
      });
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

  function realDetails(id) {
    const details = callbacks.getDetails?.(id);
    return details && typeof details === "object" ? details : {};
  }

  function bodySource(id, tree) {
    const original = tree.dom.get(id);
    const organized = original?.querySelector(":scope > .organized-face > .organized-body");
    const answer = original?.querySelector(":scope > .thread-answer");
    if (tree.models.get(id)?.localContent) return null;
    if (tree.models.get(id)?.nativeFace && answer) return answer;
    return organized?.childElementCount ? organized : answer || original?.querySelector(":scope > .element-content");
  }

  function detailChildren(id, tree) {
    return (tree.children.get(id) || []).filter((child) => tree.dom.has(child) && tree.models.get(child)?.category !== "archive");
  }

  function containsText(parent, text) {
    const normalized = String(text || "").replace(/\s+/gu, "");
    return normalized && parent.textContent.replace(/\s+/gu, "").includes(normalized);
  }

  function renderRealContent(parent, id, tree, details, restore) {
    const item = tree.models.get(id);
    const original = tree.dom.get(id);
    const source = bodySource(id, tree);
    if (source) parent.append(contentClone(source));
    else if (details.answer || item?.summary) append(parent, "p", "mindmap-detail-description", details.answer || item.summary);
    if (item?.taskDetails) {
      if (item.taskDetails.task && !containsText(parent, item.taskDetails.task)) {
        const section = append(parent, "section", "mindmap-detail-section");
        append(section, "h4", "", "任务");
        append(section, "p", "mindmap-detail-description", item.taskDetails.task);
      }
      addList(parent, "依赖", arrayOf(item.taskDetails.dependencies).filter((entry) => !containsText(parent, entry)));
      addList(parent, "验收标准", arrayOf(item.taskDetails.acceptance).filter((entry) => !containsText(parent, entry)));
    }
    const requirement = details.requirement;
    if (requirement) {
      for (const [label, text] of [["需求", requirement.need], ["实现方法", requirement.method]]) {
        if (!text || containsText(parent, text)) continue;
        const section = append(parent, "section", "mindmap-detail-section");
        append(section, "h4", "", label);
        append(section, "p", "mindmap-detail-description", text);
      }
      const steps = arrayOf(requirement.methodDetails).filter((step) => step?.description && !containsText(parent, step.description));
      if (steps.length) {
        const section = append(parent, "section", "mindmap-detail-section mindmap-detail-methods");
        append(section, "h4", "", "实现细节");
        const list = append(section, "ol", "mindmap-method-steps");
        for (const step of steps) {
          const entry = append(list, "li", "");
          append(entry, "strong", "", step.title || "实现步骤");
          append(entry, "p", "mindmap-detail-description", step.description);
        }
      }
      const cases = arrayOf(requirement.validation).filter((test) => test?.condition && !containsText(parent, test.condition));
      if (cases.length) {
        const section = append(parent, "section", "mindmap-detail-section mindmap-detail-validation");
        append(section, "h4", "", "验收场景");
        const list = append(section, "ul", "");
        for (const test of cases) {
          const entry = append(list, "li", "");
          append(entry, "strong", "", [test.id, test.title].filter(Boolean).join(" · "));
          append(entry, "p", "mindmap-detail-description", test.condition);
        }
      }
    }
    const files = [...new Set([...(item?.repositoryFiles || []), ...(item?.sources || []), ...(details.sources || [])])]
      .filter((file) => typeof file === "string" && !containsText(parent, file));
    addList(parent, "代码依据", files);
    const code = details.codePreview || item?.codePreview;
    if (code?.text && !containsText(parent, code.text)) {
      append(parent, "p", "mindmap-detail-codepath", code.path);
      append(parent, "pre", "mindmap-detail-code", code.text);
    }
    const attachments = original?.querySelector(".thread-attachments");
    if (attachments && !parent.querySelector(".thread-attachments")) parent.append(contentClone(attachments));
    const references = arrayOf(details.attachments).filter((ref) => typeof ref?.id === "string" &&
      /^[a-zA-Z0-9_-]+$/u.test(ref.id) && typeof ref.name === "string" &&
      ![...parent.querySelectorAll("a[href]")].some((link) => link.getAttribute("href") === `/api/attachments/${ref.id}`));
    if (references.length) {
      const section = append(parent, "section", "mindmap-detail-section mindmap-detail-attachments");
      append(section, "h4", "", "附件与文档");
      const list = append(section, "ul", "");
      for (const ref of references) {
        const entry = append(list, "li", "");
        const link = append(entry, "a", "attachment-link", ref.name);
        link.href = `/api/attachments/${ref.id}`;
        link.target = "_blank";
        link.rel = "noopener";
      }
    }
    const originalAnswer = details.originalAnswer || original?.querySelector(":scope > .thread-original p")?.textContent;
    if (details.answer && details.answer !== originalAnswer && !containsText(parent, details.answer)) {
      const savedAnswer = append(parent, "details", "mindmap-saved-answer");
      savedAnswer.dataset.readerKey = `saved:${id}`;
      savedAnswer.open = !source || source.textContent.length <= 500;
      append(savedAnswer, "summary", "", "已保存的完整回答");
      append(savedAnswer, "p", "mindmap-detail-description", details.answer);
    }
    if (originalAnswer && !containsText(parent, originalAnswer)) {
      const history = append(parent, "details", "mindmap-original-answer");
      history.dataset.readerKey = `original:${id}`;
      append(history, "summary", "", "可追溯的原始回答");
      append(history, "p", "mindmap-detail-description", originalAnswer);
    }
    for (const [index, disclosure] of [...parent.querySelectorAll("details")].entries()) {
      disclosure.dataset.readerKey ||= `${id}:body:${index}`;
      restore(disclosure);
    }
    const substantive = Boolean(source && (source.textContent.trim() || source.querySelector("img, video")) ||
      details.answer || item?.summary || item?.taskDetails || requirement?.need || requirement?.method || code?.text || originalAnswer);
    if (!substantive) {
      append(parent, "p", "mindmap-detail-hint", "这个节点尚未记录详细正文。可阅读下面的已有子节点，或通过提问继续补充。");
    }
  }

  function renderChildDetails(parent, id, tree, restore, defaultOpen = false) {
    const disclosure = append(parent, "details", "mindmap-child-detail");
    disclosure.dataset.cardId = id;
    disclosure.dataset.readerKey = `child:${id}`;
    const heading = append(disclosure, "summary", "");
    append(heading, "span", "mindmap-child-title", titleOf(id, tree));
    append(heading, "span", "mindmap-child-id", id);
    let loaded = false;
    const load = () => {
      if (!disclosure.open || loaded) return;
      loaded = true;
      const content = append(disclosure, "div", "mindmap-child-content");
      content.dataset.readerContent = "true";
      content.dataset.cardId = id;
      const navigate = append(content, "button", "tool-button mindmap-child-navigate", "查看节点");
      navigate.type = "button";
      navigate.dataset.navigateId = id;
      navigate.disabled = !callbacks.onNavigate || isBusy();
      navigate.addEventListener("click", () => callbacks.onNavigate?.(id));
      renderRealContent(content, id, tree, realDetails(id), restore);
      const children = detailChildren(id, tree);
      if (children.length) {
        const nested = append(content, "section", "mindmap-nested-details");
        append(nested, "h4", "", `下级详解 · ${children.length}`);
        for (const child of children) renderChildDetails(nested, child, tree, restore);
      }
    };
    disclosure.addEventListener("toggle", load);
    disclosure.open = defaultOpen;
    restore(disclosure);
    load();
    return disclosure;
  }

  function semanticSignature(ids, tree) {
    const relevant = new Set(ids);
    for (const id of relevant) for (const child of detailChildren(id, tree)) relevant.add(child);
    return JSON.stringify([...relevant].map((id) => {
      const original = tree.dom.get(id);
      return [id, tree.parents.get(id), tree.models.get(id), realDetails(id), bodySource(id, tree)?.textContent,
        [...(original?.querySelectorAll(".thread-original, a[href], img[src], video[src]") || [])]
          .map((element) => [element.tagName, element.getAttribute("href"), element.getAttribute("src"), element.textContent])];
    }));
  }

  function updateDetailActions(container) {
    for (const navigate of container.querySelectorAll(".mindmap-child-navigate")) navigate.disabled = !callbacks.onNavigate || isBusy();
    const ask = container.querySelector("#mindmap-ask");
    if (ask) ask.disabled = isBusy() || !callbacks.onAsk || Boolean(callbacks.canAsk && !callbacks.canAsk());
    const extend = container.querySelector("#mindmap-extend");
    if (extend) extend.disabled = isBusy() || !callbacks.onExtend || Boolean(callbacks.canSplit && !callbacks.canSplit());
    const split = container.querySelector("#mindmap-split");
    if (split) split.disabled = isBusy() || !callbacks.onSplit || Boolean(callbacks.canSplit && !callbacks.canSplit());
    const show = container.querySelector("#mindmap-show-card");
    if (show) show.disabled = isBusy() || !callbacks.onShowCard;
    renderQuoteSelection();
  }

  function inspect(ids = [], items = lastItems, elements = lastElements) {
    selectedIds = [...new Set(arrayOf(ids).filter((id) => typeof id === "string"))];
    lastItems = arrayOf(items);
    lastElements = elementsOf(elements);
    const container = byId("mindmap-inspector");
    if (!container) return;
    container.hidden = !mode;
    if (!mode) { clearQuoteSelection(); return; }
    const tree = hierarchy(lastItems, lastElements);
    const selection = `${storageKey()}:${selectedIds.join(",")}`;
    const signature = semanticSignature(selectedIds, tree);
    if (selection === inspectorSelection && signature === inspectorSignature && container.childElementCount) {
      updateDetailActions(container);
      return;
    }
    const sameSelection = selection === inspectorSelection;
    if (sameSelection && readingPointer && container.childElementCount) {
      updateDetailActions(container);
      return;
    }
    clearQuoteSelection(!sameSelection);
    readingPointer = false;
    const disclosures = new Map(sameSelection ? [...container.querySelectorAll("details[data-reader-key]")]
      .map((element) => [element.dataset.readerKey, element.open]) : []);
    const scrollContainer = container.closest(".context-body") || container;
    const scrollTop = sameSelection ? scrollContainer.scrollTop : 0;
    const restore = (element) => {
      if (disclosures.has(element.dataset.readerKey)) element.open = disclosures.get(element.dataset.readerKey);
    };
    inspectorSelection = selection;
    inspectorSignature = signature;
    container.replaceChildren();
    append(container, "p", "mindmap-detail-kicker", "节点说明");
    if (!selectedIds.length) {
      append(container, "h3", "mindmap-detail-title", "从主干开始，逐层读懂项目");
      append(container, "p", "mindmap-detail-hint", "点击节点查看完整说明、文件依据和附件。节点旁的 + / − 只展开或收起下级，提问和拆分仍作用于同一张白板。");
      scrollContainer.scrollTop = scrollTop;
      return;
    }
    const id = selectedIds[0];
    if (selectedIds.length > 1) {
      append(container, "h3", "mindmap-detail-title", `已选 ${selectedIds.length} 个节点`);
      addList(container, "所选节点", selectedIds.map((entry) => `${entry} · ${titleOf(entry, tree)}`));
      append(container, "p", "mindmap-detail-hint", "可对当前选区提问；选择单个节点可查看完整说明和拆分下级。");
    } else {
      const original = tree.dom.get(id);
      const breadcrumb = append(container, "p", "mindmap-detail-breadcrumb");
      breadcrumb.textContent = tree.path(id).map((entry) => titleOf(entry, tree)).join(" › ");
      append(container, "h3", "mindmap-detail-title", titleOf(id, tree));
      append(container, "p", "mindmap-detail-id", `${id} · ${original?.dataset.mapCount || 0} 个下级`);
      renderActions();
      append(container, "p", "mindmap-detail-hint mindmap-question-hint", "问这张卡会带上卡片说明和分支上下文；也可以在下面拖选正文，再点「问这段」。向下延伸可以继续补充这条分支。");
      const content = append(container, "div", "mindmap-detail-body");
      content.dataset.readerContent = "true";
      content.dataset.cardId = id;
      append(content, "h4", "mindmap-detail-section-heading", "说明");
      renderRealContent(content, id, tree, realDetails(id), restore);
      const children = detailChildren(id, tree);
      if (children.length) {
        const section = append(container, "section", "mindmap-child-details");
        append(section, "h4", "", `下级详解 · ${children.length}`);
        append(section, "p", "mindmap-detail-hint", "以下是该节点下已有的真实内容。展开章节可继续阅读，查看节点可在图中定位。");
        const openCount = content.textContent.length < 550 ? Math.min(2, children.length) : 0;
        children.forEach((child, index) => renderChildDetails(section, child, tree, restore, index < openCount));
      }
    }
    if (selectedIds.length > 1) renderActions();
    scrollContainer.scrollTop = scrollTop;
    function renderActions() {
      const actions = append(container, "div", "mindmap-detail-actions");
      function action(actionId, label, callback, disabled = false) {
        const button = append(actions, "button", "tool-button", label);
        button.id = actionId;
        button.type = "button";
        button.disabled = disabled;
        button.addEventListener("click", () => callback?.(id));
      }
      action("mindmap-ask", selectedIds.length === 1 ? "问这张卡" : "问所选节点", callbacks.onAsk,
        isBusy() || !callbacks.onAsk || Boolean(callbacks.canAsk && !callbacks.canAsk()));
      if (selectedIds.length === 1) {
        if (callbacks.onExtend) action("mindmap-extend", "向下延伸", callbacks.onExtend,
          isBusy() || Boolean(callbacks.canSplit && !callbacks.canSplit()));
        action("mindmap-split", "拆成子节点", callbacks.onSplit,
          isBusy() || !callbacks.onSplit || Boolean(callbacks.canSplit && !callbacks.canSplit()));
        action("mindmap-show-card", "查看卡片", callbacks.onShowCard, isBusy() || !callbacks.onShowCard);
        if (callbacks.onEnter) action("mindmap-enter-board", "进入子白板 ↗", callbacks.onEnter, isBusy());
        selectionPanel(actions);
      }
    }
  }

  window.BoardMindmap = { init, setActive, decorate, measure, inspect, savePositions,
    get positions() { return loadPositions(); }, get active() { return mode; } };
})();
