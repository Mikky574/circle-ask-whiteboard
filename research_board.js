/* Focused, read-only projections of the same board and card identities. */
(() => {
  "use strict";
  const views = ["board", "graph", "comparison", "evidence"];
  const format = value => value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 3, minimumFractionDigits: 3 });
  const title = node => node.title.replace(/^【[^】]+】\s*/u, "");
  let options = {};
  let container;
  let active = false;
  let rootId = null;
  let view = "board";
  let lastPath = [];
  let signature = "";
  let initialized = false;
  const selectedArms = new Map();

  function add(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    parent.append(element);
    return element;
  }
  function button(parent, label, callback, className = "research-button") {
    const element = add(parent, "button", className, label);
    element.type = "button";
    element.addEventListener("click", callback);
    return element;
  }
  function items() {
    const nodes = (options.getItems?.() || []).filter(node => node.category !== "archive");
    const identities = new Set(nodes.map(node => node.id));
    const roots = nodes.filter(node => !identities.has(node.parentId));
    if (roots.length < 2) return nodes;
    const rootIds = new Set(roots.map(node => node.id));
    return [
      { id: "board", parentId: null, category: "main", title: options.title || "整张白板", summary: "" },
      ...nodes.map(node => rootIds.has(node.id) ? { ...node, parentId: "board" } : node),
    ];
  }
  function pathFor(id, nodes) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const path = [];
    const seen = new Set();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      current = byId.get(current.parentId);
    }
    return path;
  }
  function children(id, nodes) {
    return nodes.filter(node => node.parentId === id);
  }
  function scope(id, nodes) {
    const reachable = new Set([id]);
    let previous;
    do {
      previous = reachable.size;
      for (const node of nodes) if (reachable.has(node.parentId)) reachable.add(node.id);
    } while (reachable.size !== previous);
    return nodes.filter(node => reachable.has(node.id));
  }
  function attachments(node) {
    const values = [...(node.attachments || []), ...(options.getAttachments?.(node.id) || [])];
    return [...new Map(values.filter(file => /^[a-f0-9]{32}$/.test(file.id) &&
      typeof file.name === "string").map(file => [file.id, file])).values()];
  }
  function images(node) {
    return attachments(node).filter(file => /\.(png|jpe?g|webp|gif|avif)$/iu.test(file.name));
  }
  function experiment(node) {
    return window.ExperimentData.clean(node.experiment) || {};
  }
  function writeRoute(replace = false) {
    const url = new URL(location.href);
    url.searchParams.set("presentation", active ? "research" : window.BoardMindmap?.active ? "mindmap" : "cards");
    if (rootId) url.searchParams.set("root", rootId);
    else url.searchParams.delete("root");
    if (active && view !== "board") url.searchParams.set("panel", view);
    else url.searchParams.delete("panel");
    url.hash = "";
    if (url.href !== location.href) history[replace ? "replaceState" : "pushState"](history.state, "", url);
  }
  function setActive(value, replace = false) {
    active = Boolean(value);
    container.hidden = !active;
    document.body.classList.toggle("research-view", active);
    document.getElementById("board-workspace").dataset.researchActive = String(active);
    document.getElementById("presentation-research").setAttribute("aria-pressed", String(active));
    if (active) {
      options.onChange?.(true);
      render();
    } else options.onChange?.(false);
    writeRoute(replace);
  }
  function enter(id, replace = false) {
    if (!items().some(node => node.id === id)) return false;
    if (options.canNavigate && !options.canNavigate()) return false;
    rootId = id;
    view = "board";
    setActive(true, replace);
    container.querySelector("h2")?.focus({ preventScroll: true });
    container.scrollIntoView({ block: "start", behavior: "instant" });
    return true;
  }
  function showImage(file) {
    const dialog = document.getElementById("research-image-dialog");
    const image = dialog.querySelector("img");
    image.src = `/api/attachments/${file.id}`;
    image.alt = file.name;
    dialog.querySelector("h2").textContent = file.name;
    dialog.showModal();
  }
  function image(parent, file, thumbnail = false) {
    const control = button(parent, "", () => showImage(file), "research-image-button");
    control.setAttribute("aria-label", `放大图片：${file.name}`);
    const picture = add(control, "img", thumbnail ? "research-thumbnail" : "", null);
    picture.src = `/api/attachments/${file.id}`;
    picture.alt = file.name;
    picture.loading = "lazy";
    picture.addEventListener("error", () => {
      picture.hidden = true;
      control.disabled = true;
      add(control, "span", "research-muted", `图片暂不可用 · ${file.name}`);
    }, { once: true });
  }
  function figure(parent, node, file) {
    const element = add(parent, "figure", "research-figure");
    image(element, file);
    add(element, "figcaption", "", `${node.id} · ${title(node)} · ${file.name}`);
  }
  function renderComparison(parent, node) {
    const data = experiment(node).comparison;
    if (!data) return;
    const section = add(parent, "section", "research-comparison");
    section.setAttribute("aria-label", data.title || "实验对照");
    const heading = add(section, "div", "research-comparison-heading");
    const intro = add(heading, "div");
    add(intro, "h3", "", data.title || "实验对照");
    if (data.cohort) add(intro, "p", "research-muted research-small", data.cohort);
    const selector = add(heading, "label", "research-selector", "对照方法");
    const select = add(selector, "select");
    select.setAttribute("aria-label", "对照方法");
    const candidates = data.arms.filter(arm => arm.id !== data.baseline);
    const selected = selectedArms.get(node.id);
    const candidate = candidates.find(arm => arm.id === selected) ||
      candidates.find(arm => arm.id === data.primary);
    const baseline = data.arms.find(arm => arm.id === data.baseline);
    for (const arm of candidates) {
      const option = new Option(`${arm.label} · ${arm.id === data.primary ? "主对照" : "次要对照"}`, arm.id);
      select.append(option);
    }
    select.value = candidate.id;
    select.addEventListener("change", () => {
      selectedArms.set(node.id, select.value);
      const index = [...parent.children].indexOf(section);
      section.remove();
      renderComparison(parent, node);
      const updated = parent.lastElementChild;
      if (index < parent.children.length - 1) parent.insertBefore(updated, parent.children[index]);
      updated.querySelector("select").focus({ preventScroll: true });
    });
    const metrics = add(section, "div", "research-metrics");
    metrics.setAttribute("aria-live", "polite");
    data.metrics.forEach((metric, index) => {
      const box = add(metrics, "div", "research-metric");
      add(box, "span", "research-muted research-small", `${metric.label} · ${metric.direction === "higher" ? "越高越好" : "越低越好"}`);
      add(box, "strong", "", format(candidate.values[index]));
      add(box, "p", "research-muted research-small", `基线 ${format(baseline.values[index])} → ${format(candidate.values[index])}`);
    });
    if (candidate.id === data.primary && data.finding) add(section, "p", "research-finding", data.finding);
    else if (candidate.id !== data.primary) add(section, "p", "research-finding",
      `当前查看次要对照「${candidate.label}」，本实验的主对照为「${data.arms.find(arm => arm.id === data.primary).label}」。`);
    if (data.caveat) add(section, "p", "research-caveat", data.caveat);
    const wrap = add(section, "div", "research-table-wrap");
    const table = add(wrap, "table");
    table.setAttribute("aria-label", "同一评估名单的实验对照数据");
    const header = add(add(table, "thead"), "tr");
    add(header, "th", "", "对照方法");
    for (const metric of data.metrics) add(header, "th", "", `${metric.label} ${metric.direction === "higher" ? "↑" : "↓"}`);
    const body = add(table, "tbody");
    for (const arm of data.arms) {
      const row = add(body, "tr");
      row.dataset.current = String(arm.id === candidate.id);
      add(row, "td", "", arm.label + (arm.id === data.primary ? " · 主对照" : ""));
      for (const value of arm.values) add(row, "td", "", format(value));
    }
    if (data.source) add(section, "p", "research-muted research-small research-source", `数据来源 · ${data.source}`);
  }
  function renderAttachments(parent, node) {
    const files = attachments(node).filter(file => !images(node).some(picture => picture.id === file.id));
    if (!files.length) return;
    const list = add(parent, "ul", "research-files");
    for (const file of files) {
      const link = add(add(list, "li"), "a", "", file.name);
      link.href = `/api/attachments/${file.id}`;
      link.target = "_blank";
      link.rel = "noopener";
    }
  }
  function card(parent, node, nodes) {
    const record = experiment(node);
    const article = add(parent, "article", "research-card");
    article.addEventListener("click", event => {
      if (!event.target.closest("button, a, input, select") && !window.getSelection()?.toString().trim()) enter(node.id);
    });
    const heading = add(article, "div", "research-card-meta");
    add(heading, "span", "", record.kind || (record.comparison ? "实验对照" : "项目主题"));
    const status = node.title.match(/^【([^】]+)】/u)?.[1];
    add(heading, "span", "", node.id + (status ? ` · ${status}` : ""));
    const content = add(article, "div", "research-card-content");
    const description = add(content, "div");
    button(add(description, "h3"), title(node), () => enter(node.id), "research-card-title");
    add(description, "p", "research-muted research-small", record.question || node.summary);
    const picture = images(node)[0];
    if (picture) image(content, picture, true);
    if (record.metricSummary) add(article, "p", "research-inline-metric", record.metricSummary);
    if (record.finding) add(article, "p", "research-result", record.finding);
    const footer = add(article, "div", "research-card-footer");
    const count = children(node.id, nodes).length;
    add(footer, "span", "research-muted research-small",
      count ? `${count} 个下级主题` : images(node).length ? `${images(node).length} 张证据图片` : "主题详情");
    button(footer, "进入子白板 ↗", () => enter(node.id));
  }
  function renderDetails(parent, node) {
    const record = experiment(node);
    if (node.summary && node.summary !== record.question) add(parent, "p", "research-description", options.getText?.(node.id) || node.summary);
    if (record.finding && !record.comparison) add(parent, "p", "research-finding", record.finding);
    if (record.caveat) add(parent, "p", "research-caveat", record.caveat);
    renderComparison(parent, node);
    const gallery = add(parent, "div", "research-evidence");
    for (const file of images(node)) figure(gallery, node, file);
    renderAttachments(parent, node);
    if (node.repositoryFiles?.length) {
      const details = add(parent, "details", "research-sources");
      add(details, "summary", "", "查看资料来源");
      const list = add(details, "ul");
      for (const file of node.repositoryFiles) add(list, "li", "", file);
    }
  }
  function renderGraph(parent, node, nodes) {
    button(parent, title(node), () => enter(node.id), "research-tree-root");
    const branches = add(parent, "div", "research-tree");
    for (const child of children(node.id, nodes)) {
      const branch = add(branches, "section", "research-tree-branch");
      button(branch, title(child), () => enter(child.id), "research-card-title");
      const descendants = children(child.id, nodes);
      if (descendants.length) {
        const list = add(branch, "ul");
        for (const descendant of descendants) button(add(list, "li"), title(descendant),
          () => enter(descendant.id), "research-card-title");
      }
    }
  }
  function render() {
    if (!container || !active) return;
    const nodes = items();
    let node = nodes.find(item => item.id === rootId);
    let removed = false;
    if (!node) {
      removed = Boolean(rootId);
      node = [...lastPath].reverse().map(id => nodes.find(item => item.id === id)).find(Boolean) ||
        nodes.find(item => !nodes.some(parent => parent.id === item.parentId)) || nodes[0];
      rootId = node?.id || null;
      writeRoute(true);
    }
    container.replaceChildren();
    const breadcrumb = add(container, "nav", "research-breadcrumb");
    breadcrumb.setAttribute("aria-label", "子白板路径");
    button(breadcrumb, "整张白板", () => { rootId = null; lastPath = []; enterRoot(); }, "research-path-button");
    const path = node ? pathFor(node.id, nodes) : [];
    lastPath = path.map(item => item.id);
    for (const item of path) {
      add(breadcrumb, "span", "research-muted", "/");
      const link = button(breadcrumb, title(item), () => enter(item.id), "research-path-button");
      if (item.id === rootId) link.setAttribute("aria-current", "page");
    }
    if (removed) add(container, "p", "research-caveat", "原节点已移除或暂不存在，已返回可用的上级主题。");
    const heading = add(container, "header", "research-heading");
    const intro = add(heading, "div");
    const name = add(intro, "h2", "", node ? title(node) : options.title || "白板");
    name.tabIndex = -1;
    if (node) add(intro, "p", "research-muted", experiment(node).question || node.summary);
    const controls = add(heading, "div", "research-heading-actions");
    if (path.length > 1) button(controls, "返回上一级", () => enter(path.at(-2).id));
    button(controls, "编辑画布", () => {
      setActive(false);
      if (node && node.id !== "board") options.onShowCard?.(node.id);
    });
    if (!node) {
      add(container, "p", "research-description", "画布还没有卡片，先在编辑画布中写下第一张卡片。");
      return;
    }
    const members = scope(node.id, nodes);
    const comparisons = members.filter(item => experiment(item).comparison);
    const hasPictures = members.some(item => images(item).length);
    const labels = { board: "实验板", graph: "关系导图", comparison: "对比结果", evidence: "证据图片" };
    if ((view === "comparison" && !comparisons.length) || (view === "evidence" && !hasPictures)) view = "board";
    const tabs = add(container, "nav", "research-tabs");
    tabs.setAttribute("aria-label", "子白板视图");
    tabs.setAttribute("role", "tablist");
    for (const id of views) {
      if ((id === "comparison" && !comparisons.length) || (id === "evidence" && !hasPictures)) continue;
      const tab = button(tabs, labels[id], () => {
        view = id; render(); writeRoute();
        container.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      }, "research-tab");
      tab.id = `research-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(id === view));
      tab.setAttribute("aria-controls", "research-content");
      tab.tabIndex = id === view ? 0 : -1;
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const available = [...tabs.children];
        const current = available.indexOf(tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
          (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
        available[next].click();
      });
    }
    const content = add(container, "div", "research-content");
    content.id = "research-content";
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `research-tab-${view}`);
    if (view === "board") {
      const direct = children(node.id, nodes);
      if (direct.length) {
        add(content, "h3", "research-section-heading", "下级主题");
        const grid = add(content, "div", "research-grid");
        for (const child of direct) card(grid, child, nodes);
      }
      renderDetails(content, node);
    } else if (view === "graph") renderGraph(content, node, nodes);
    else if (view === "comparison") {
      for (const item of comparisons) {
        if (item.id !== rootId) button(content, `进入 ${title(item)} ↗`, () => enter(item.id), "research-path-button");
        renderComparison(content, item);
      }
    } else {
      const gallery = add(content, "div", "research-evidence research-evidence-grid");
      for (const item of members) for (const file of images(item)) figure(gallery, item, file);
    }
    add(container, "footer", "research-footer", `当前根节点 ${node.id} · ${members.length - 1} 个下级 · 与项目画布共享同一份内容`);
    signature = JSON.stringify(nodes);
  }
  function enterRoot() {
    const nodes = items();
    const root = nodes.find(node => !nodes.some(item => item.id === node.parentId));
    if (root) enter(root.id);
    else setActive(true);
  }
  function readRoute() {
    const params = new URLSearchParams(location.search);
    rootId = params.get("root");
    view = views.includes(params.get("panel")) ? params.get("panel") : "board";
    active = params.get("presentation") === "research";
    container.hidden = !active;
    document.body.classList.toggle("research-view", active);
    document.getElementById("board-workspace").dataset.researchActive = String(active);
    options.onChange?.(active);
    if (!active) window.BoardMindmap?.setActive(params.get("presentation") === "mindmap");
    if (active) render();
  }
  function init(settings) {
    options = settings;
    container = document.getElementById("research-workspace");
    if (!container) return;
    if (!initialized) {
      document.getElementById("presentation-research").addEventListener("click", () => setActive(true));
      window.addEventListener("popstate", readRoute);
      for (const id of ["presentation-cards", "presentation-mindmap"]) {
        document.getElementById(id).addEventListener("click", () => setActive(false));
      }
      const dialog = add(document.body, "dialog", "research-image-dialog");
      dialog.id = "research-image-dialog";
      const heading = add(dialog, "header");
      add(heading, "h2");
      button(heading, "关闭原图", () => dialog.close());
      add(dialog, "img");
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      initialized = true;
    }
    const params = new URLSearchParams(location.search);
    rootId = params.get("root") || location.hash.match(/^#([EA]\d+)$/)?.[1] || null;
    view = views.includes(params.get("panel")) ? params.get("panel") : "board";
    if (params.get("presentation") === "research" || (options.defaultActive && !params.has("presentation") && items().length)) {
      setActive(true, true);
    }
  }
  window.BoardResearch = { init, enter, setActive, get active() { return active; },
    refresh() { if (active && JSON.stringify(items()) !== signature) render(); } };
})();
