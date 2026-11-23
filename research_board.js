/* Focused, read-only projections of the same board and card identities. */
(() => {
  "use strict";
  const views = ["board", "graph", "comparison", "evidence"];
  const format = value => value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 3, minimumFractionDigits: 3 });
  const title = node => node.id === "board" ? node.title : node.title.replace(/^【[^】]+】\s*/u, "");
  const status = node => node.id === "board" ? null : node.title.match(/^【([^】]+)】/u)?.[1] || null;
  const same = (a, b) => Boolean(a) && String(a).trim() === String(b || "").trim();
  const kickers = { home: "项目总览", feature: "功能", scene: "使用场景", detail: "细节" };
  const boardLabels = { home: "功能目录", feature: "功能说明", scene: "场景说明", detail: "细节说明" };
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
  function capability(node) {
    return window.CapabilityData?.clean(node.capability);
  }
  /* Writes the original title: a leading 【status】 stays visible as a tag. */
  function labelled(parent, node) {
    const mark = status(node);
    if (mark) add(parent, "span", "research-status", mark);
    parent.append(document.createTextNode(title(node)));
    return parent;
  }
  function fullText(node) {
    if (node.id === "board") return "";
    return String(options.getText?.(node.id) || node.summary || "").trim();
  }
  function firstSentence(text) {
    const value = String(text || "").trim();
    return value.match(/^[\s\S]+?(?:[。！？]|[!?](?=\s|$))/u)?.[0] || value;
  }
  function isTest(path) {
    const name = String(path).split(/[\\/]/u).pop();
    return /^test_|_test\.|[.-](test|spec)\./iu.test(name) || /(^|[\\/])tests?[\\/]/iu.test(path);
  }
  function scenesOf(node, nodes) {
    return children(node.id, nodes).filter(item => !item.codePreview);
  }
  /* A top-level card with capability is an overview when it is the only root, or when
     it sits under the virtual whole-board root and has capability children itself. */
  function isOverview(node, top, nodes) {
    return Boolean(capability(node)) && (top || children(node.id, nodes).some(item => capability(item)));
  }
  /* Functional reading is used only where capability marks the root and first level;
     unmarked boards and branches keep the original topic / experiment presentation. */
  function reading(path, nodes) {
    if (!path.length) return null;
    let start = -1;
    if (path[0].id === "board") {
      if (path[1] && isOverview(path[1], false, nodes)) start = 1;
      else if (children("board", nodes).some(item => capability(item) && !isOverview(item, false, nodes))) start = 0;
    } else if (capability(path[0])) start = 0;
    if (start < 0) return null;
    const [home, feature, scene] = path.slice(start);
    const depth = path.length - start - 1;
    if (!depth) return { kind: "home", home };
    if (!capability(feature) || feature.codePreview) return null;
    if (depth === 1) return { kind: "feature", home, feature };
    if (depth === 2 && !scene.codePreview) return { kind: "scene", home, feature, scene };
    return { kind: "detail", home, feature, scene };
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
      options.onChange?.(true, rootId);
      render();
    } else options.onChange?.(false, rootId);
    writeRoute(replace);
  }
  function showCanvas(id) {
    rootId = id || null;
    view = "board";
    setActive(false);
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
    const feature = capability(node);
    const article = add(parent, "article", "research-card");
    article.addEventListener("click", event => {
      if (!event.target.closest("button, a, input, select") && !window.getSelection()?.toString().trim()) enter(node.id);
    });
    const heading = add(article, "div", "research-card-meta");
    add(heading, "span", "", feature ? "项目功能" : record.kind || (record.comparison ? "实验对照" : "项目主题"));
    const status = node.title.match(/^【([^】]+)】/u)?.[1];
    add(heading, "span", "", node.id + (status ? ` · ${status}` : ""));
    const content = add(article, "div", "research-card-content");
    const description = add(content, "div");
    button(add(description, "h3"), title(node), () => enter(node.id), "research-card-title");
    add(description, "p", "research-muted research-small", feature?.outcome || record.question || node.summary);
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
  function factRows(parent, feature, keys) {
    const rows = feature ? keys.filter(([key]) => feature[key]) : [];
    if (!rows.length) return;
    const fields = add(parent, "dl", "research-capability-fields");
    for (const [key, label] of rows) {
      add(fields, "dt", "", label);
      add(fields, "dd", "", feature[key]);
    }
  }
  const factKeys = [["input", "需要什么"], ["boundary", "适用边界"]];
  const verificationKey = ["verification", "怎样核对"];
  function fileList(parent, files) {
    if (!files?.length) return;
    const list = add(parent, "ul", "research-file-list");
    for (const file of files) {
      const item = add(list, "li");
      add(item, "code", "", file);
      if (isTest(file)) add(item, "span", "research-file-tag", "测试");
    }
  }
  function fileSummary(files) {
    const tests = files.filter(isTest).length;
    return `${files.length} 个文件${tests ? `（含 ${tests} 个测试）` : ""}`;
  }
  /* Legacy topic / experiment details. `lead` is what the heading already shows. */
  function renderDetails(parent, node, lead) {
    const record = experiment(node);
    const feature = capability(node);
    if (feature) {
      const section = add(parent, "section", "research-capability");
      section.setAttribute("aria-label", "功能说明");
      add(section, "h3", "", "功能说明");
      factRows(section, feature, [["audience", "适合"], ...factKeys, verificationKey]);
    }
    const text = fullText(node);
    if (node.summary && node.summary !== record.question && !same(text, lead)) add(parent, "p", "research-description", text);
    if (record.finding && !record.comparison) add(parent, "p", "research-finding", record.finding);
    if (record.caveat) add(parent, "p", "research-caveat", record.caveat);
    renderComparison(parent, node);
    const gallery = add(parent, "div", "research-evidence");
    for (const file of images(node)) figure(gallery, node, file);
    renderAttachments(parent, node);
    if (node.codePreview) {
      const details = add(parent, "details", "research-sources");
      add(details, "summary", "", `源码片段 · ${node.codePreview.path}`);
      add(add(details, "pre", "research-code"), "code", "", node.codePreview.text);
    }
    if (node.repositoryFiles?.length) {
      const details = add(parent, "details", "research-sources");
      add(details, "summary", "", `实现依据 · ${fileSummary(node.repositoryFiles)}`);
      fileList(details, node.repositoryFiles);
    }
  }
  function renderGraph(parent, node, nodes) {
    labelled(button(parent, "", () => enter(node.id), "research-tree-root"), node);
    const branches = add(parent, "div", "research-tree");
    for (const child of children(node.id, nodes)) {
      const branch = add(branches, "section", "research-tree-branch");
      labelled(button(branch, "", () => enter(child.id), "research-card-title"), child);
      const descendants = children(child.id, nodes);
      if (descendants.length) {
        const list = add(branch, "ul");
        for (const descendant of descendants) labelled(button(add(list, "li"), "",
          () => enter(descendant.id), "research-card-title"), descendant);
      }
    }
  }

  /* ---- Functional reading: overview → feature → scene → detail / evidence ---- */
  function renderRecord(parent, node, lead) {
    const record = experiment(node);
    if (record.question && !same(record.question, lead)) add(parent, "p", "research-question", `实验问题：${record.question}`);
    if (record.metricSummary) add(parent, "p", "research-inline-metric", record.metricSummary);
    if (record.finding && !record.comparison) add(parent, "p", "research-finding", record.finding);
    if (record.caveat) add(parent, "p", "research-caveat", record.caveat);
    renderComparison(parent, node);
    const pictures = images(node);
    if (pictures.length) {
      const gallery = add(parent, "div", "research-evidence");
      for (const file of pictures) figure(gallery, node, file);
    }
    renderAttachments(parent, node);
  }
  function renderSnippets(parent, node, code) {
    if (node.codePreview) {
      add(parent, "p", "research-proof-label", `源码片段 · ${node.codePreview.path}`);
      add(add(parent, "pre", "research-code"), "code", "", node.codePreview.text);
    }
    if (!code.length) return;
    const list = add(parent, "ul", "research-snippet-list");
    for (const item of code) {
      const entry = add(list, "li");
      labelled(button(entry, "", () => enter(item.id), "research-card-title"), item);
      add(entry, "code", "research-muted", item.codePreview.path);
    }
  }
  function proofParts(node, code) {
    const files = node.repositoryFiles || [];
    const snippets = code.length + (node.codePreview ? 1 : 0);
    return [files.length ? fileSummary(files) : "", snippets ? `${snippets} 个源码片段` : ""].filter(Boolean);
  }
  /* Files and code are evidence, collapsed by default. */
  function renderEvidence(parent, node, code) {
    const parts = proofParts(node, code);
    const feature = capability(node);
    if (!parts.length && !feature) return;
    const details = add(parent, "details", "research-sources research-proof");
    add(details, "summary", "", parts.length ? `实现依据 · ${parts.join(" · ")}` : "怎样核对");
    factRows(details, feature, [verificationKey]);
    fileList(details, node.repositoryFiles);
    renderSnippets(details, node, code);
  }
  function renderList(parent, items, nodes) {
    const list = add(parent, "ol", "research-scene-list");
    for (const item of items) {
      const entry = add(list, "li");
      labelled(button(entry, "", () => enter(item.id), "research-card-title research-scene-title"), item);
      const brief = capability(item)?.outcome || experiment(item).question || firstSentence(item.summary);
      if (brief) add(entry, "p", "research-muted research-small", brief);
      const record = experiment(item);
      if (record.metricSummary) add(entry, "p", "research-inline-metric research-small", record.metricSummary);
      const more = scenesOf(item, nodes).length;
      if (more) add(entry, "span", "research-muted research-small", `${more} 条细节`);
    }
  }
  function featureCard(parent, node, nodes) {
    const record = experiment(node);
    const article = add(parent, "article", "research-feature");
    article.addEventListener("click", event => {
      if (!event.target.closest("button") && !window.getSelection()?.toString().trim()) enter(node.id);
    });
    labelled(button(add(article, "h3"), "", () => enter(node.id), "research-card-title"), node);
    add(article, "p", "research-feature-outcome", capability(node).outcome);
    if (record.metricSummary) add(article, "p", "research-inline-metric research-small", record.metricSummary);
    const scenes = scenesOf(node, nodes);
    if (!scenes.length) return;
    add(article, "p", "research-feature-label", "使用场景").setAttribute("aria-hidden", "true");
    const list = add(article, "ul", "research-scene-links");
    list.setAttribute("aria-label", `${title(node)}：使用场景`);
    for (const scene of scenes) labelled(button(add(list, "li"), "", () => enter(scene.id), "research-scene-link"), scene);
  }
  function renderReading(parent, node, nodes, mode, lead) {
    const text = fullText(node);
    const fresh = text && !same(text, lead) ? text : "";
    const direct = children(node.id, nodes);
    const topics = direct.filter(item => !item.codePreview);
    const code = direct.filter(item => item.codePreview);
    const feature = capability(node);
    if (mode.kind === "home") {
      if (fresh && !lead) add(parent, "p", "research-description", fresh);
      const features = topics.filter(item => capability(item) && !(node.id === "board" && isOverview(item, false, nodes)));
      const others = topics.filter(item => !features.includes(item));
      if (features.length) {
        add(parent, "h3", "research-section-heading", `${features.length} 项功能`);
        const grid = add(parent, "div", "research-directory");
        for (const item of features) featureCard(grid, item, nodes);
      }
      if (others.length) {
        add(parent, "h3", "research-section-heading", "其他内容");
        const grid = add(parent, "div", "research-grid");
        for (const item of others) card(grid, item, nodes);
      }
      renderRecord(parent, node, lead);
      const parts = [lead && fresh ? "完整说明" : "", feature ? "条件与边界" : "", ...proofParts(node, code)].filter(Boolean);
      if (!parts.length) return;
      const about = add(parent, "details", "research-sources research-proof research-about");
      add(about, "summary", "", `项目说明与依据 · ${parts.join(" · ")}`);
      if (lead && fresh) add(about, "p", "research-description", fresh);
      factRows(about, feature, [...factKeys, verificationKey]);
      fileList(about, node.repositoryFiles);
      renderSnippets(about, node, code);
      return;
    }
    if (mode.kind === "feature") {
      if (topics.length) {
        add(parent, "h3", "research-section-heading", "使用场景");
        renderList(parent, topics, nodes);
      }
      if (fresh || feature) {
        const section = add(parent, "section", "research-facts");
        add(section, "h3", "research-section-heading", "功能说明");
        if (fresh) add(section, "p", "research-description", fresh);
        factRows(section, feature, factKeys);
      }
      renderRecord(parent, node, lead);
      renderEvidence(parent, node, code);
      return;
    }
    /* Scene or deeper detail: the main description appears once, at the top. */
    if (fresh) add(parent, "p", "research-description", fresh);
    if (feature) factRows(add(parent, "section", "research-facts"), feature, factKeys);
    renderRecord(parent, node, lead);
    if (topics.length) {
      add(parent, "h3", "research-section-heading", "细节");
      renderList(parent, topics, nodes);
    }
    const siblings = mode.kind === "scene" ? scenesOf(mode.feature, nodes) : [];
    if (siblings.length > 1) {
      const nav = add(parent, "nav", "research-siblings");
      nav.setAttribute("aria-label", "同一功能下的场景");
      add(nav, "h3", "research-section-heading", `「${title(mode.feature)}」下的场景`);
      const list = add(nav, "ol", "research-sibling-list");
      for (const item of siblings) {
        const entry = add(list, "li");
        if (item.id === node.id) labelled(add(entry, "span", "research-sibling-current"), item).setAttribute("aria-current", "page");
        else labelled(button(entry, "", () => enter(item.id), "research-card-title"), item);
      }
    }
    renderEvidence(parent, node, code);
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
    const path = node ? pathFor(node.id, nodes) : [];
    lastPath = path.map(item => item.id);
    /* The path starts at the real or virtual root, so a single root is never listed twice. */
    if (path.length > 1) {
      const breadcrumb = add(container, "nav", "research-breadcrumb");
      breadcrumb.setAttribute("aria-label", "阅读路径");
      path.forEach((item, index) => {
        if (index) add(breadcrumb, "span", "research-muted", "›").setAttribute("aria-hidden", "true");
        const link = button(breadcrumb, title(item), () => enter(item.id), "research-path-button");
        if (item.id === rootId) link.setAttribute("aria-current", "page");
      });
    }
    if (removed) add(container, "p", "research-caveat", "原节点已移除或暂不存在，已返回可用的上级主题。");
    const mode = node ? reading(path, nodes) : null;
    const feature = node ? capability(node) : null;
    const record = node ? experiment(node) : {};
    const lead = feature?.outcome || record.question || (mode ? "" : node?.summary || "");
    const heading = add(container, "header", "research-heading");
    const intro = add(heading, "div");
    if (mode) add(intro, "span", "research-kicker", kickers[mode.kind]);
    const name = add(intro, "h2");
    if (node) labelled(name, node);
    else name.textContent = options.title || "白板";
    name.tabIndex = -1;
    if (lead) add(intro, "p", mode ? "research-lead" : "research-muted", lead);
    if (mode && feature) add(intro, "p", "research-muted research-small", `适合：${feature.audience}`);
    const controls = add(heading, "div", "research-heading-actions");
    if (mode && typeof options.onAsk === "function" && (mode.kind === "feature" || mode.kind === "scene")) {
      button(controls, mode.kind === "feature" ? "问这项功能" : "问这个场景",
        () => options.onAsk(node.id), "research-button research-ask");
    }
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
    const direct = children(node.id, nodes);
    const labels = { board: mode ? boardLabels[mode.kind] : feature ? "功能概览" : comparisons.length ? "实验板" : "主题概览",
      graph: "关系导图", comparison: "对比结果", evidence: "证据图片" };
    const available = views.filter(id => id === "board" || (id === "graph" && (!mode || direct.length)) ||
      (id === "comparison" && comparisons.length) || (id === "evidence" && hasPictures));
    if (!available.includes(view)) view = "board";
    const tabs = available.length > 1 ? add(container, "nav", "research-tabs") : null;
    tabs?.setAttribute("aria-label", "阅读视图");
    tabs?.setAttribute("role", "tablist");
    for (const id of tabs ? available : []) {
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
    if (tabs) {
      content.setAttribute("role", "tabpanel");
      content.setAttribute("aria-labelledby", `research-tab-${view}`);
    } else content.classList.add("research-content-plain");
    if (view === "board" && mode) renderReading(content, node, nodes, mode, lead);
    else if (view === "board") {
      const topics = direct.filter(item => !item.codePreview);
      if (topics.length) {
        add(content, "h3", "research-section-heading", capability(node)
          ? node.parentId ? "使用场景与相关说明" : "可以完成的功能" : "下级主题");
        const grid = add(content, "div", "research-grid");
        for (const child of topics) card(grid, child, nodes);
      }
      const implementation = direct.filter(item => item.codePreview);
      if (implementation.length) {
        const details = add(content, "details", "research-sources");
        add(details, "summary", "", `实现细节 · ${implementation.length} 个源码片段`);
        const grid = add(details, "div", "research-grid");
        for (const child of implementation) card(grid, child, nodes);
      }
      renderDetails(content, node, lead);
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
    if (!mode) add(container, "footer", "research-footer", `${node.id === "board" ? "整张白板" : `卡号 ${node.id}`} · ` +
      `${members.length - 1} 张下级卡 · 与项目画布共享同一份内容`);
    signature = JSON.stringify(nodes);
  }
  function readRoute() {
    const params = new URLSearchParams(location.search);
    rootId = params.get("root");
    view = views.includes(params.get("panel")) ? params.get("panel") : "board";
    active = params.get("presentation") === "research";
    container.hidden = !active;
    document.body.classList.toggle("research-view", active);
    document.getElementById("board-workspace").dataset.researchActive = String(active);
    document.getElementById("presentation-research").setAttribute("aria-pressed", String(active));
    if (!active) window.BoardMindmap?.setActive(params.get("presentation") === "mindmap");
    options.onChange?.(active, rootId);
    if (active) render();
  }
  function init(settings) {
    options = settings;
    container = document.getElementById("research-workspace");
    if (!container) return;
    if (!initialized) {
      document.getElementById("presentation-research").addEventListener("click", () => {
        if (!options.canNavigate || options.canNavigate()) setActive(true);
      });
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
  window.BoardResearch = { init, enter, showCanvas, setActive, get active() { return active; },
    refresh() { if (active && JSON.stringify(items()) !== signature) render(); } };
})();
