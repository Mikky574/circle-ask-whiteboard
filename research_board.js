/* Focused, read-only projections of the same board and card identities. */
(() => {
  "use strict";
  const views = window.WorkspaceNavigation.PANELS;
  const format = value => value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 3, minimumFractionDigits: 3 });
  const title = node => node.id === "board" ? node.title : node.title.replace(/^【[^】]+】\s*/u, "");
  const status = node => node.id === "board" ? null : node.title.match(/^【([^】]+)】/u)?.[1] || null;
  const same = (a, b) => Boolean(a) && String(a).trim() === String(b || "").trim();
  const kickers = { home: "项目总览", feature: "功能", scene: "使用场景", detail: "细节" };
  const boardLabels = { home: "功能目录", feature: "功能说明", scene: "场景说明", detail: "细节说明" };
  let options = {};
  let workspace;
  let container;
  let currentEntry;
  const entries = new Map();
  let active = false;
  let rootId = null;
  let view = "board";
  let handoffCard = null;
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
    return (top && Boolean(capability(node))) || children(node.id, nodes).some(item => capability(item));
  }
  /* Functional reading is used only where capability marks the root and first level;
     unmarked boards and branches keep the original topic / experiment presentation. */
  function reading(path, nodes) {
    if (!path.length) return null;
    let start = -1;
    if (path[0].id === "board") {
      if (path[1] && isOverview(path[1], false, nodes)) start = 1;
      else if (children("board", nodes).some(item => capability(item) && !isOverview(item, false, nodes))) start = 0;
    } else if (isOverview(path[0], true, nodes)) start = 0;
    if (start < 0) return null;
    const [home, feature, scene] = path.slice(start);
    const depth = path.length - start - 1;
    if (!depth) return { kind: "home", home };
    if (!capability(feature) || feature.codePreview) return null;
    if (depth === 1) return { kind: "feature", home, feature };
    if (depth === 2 && !scene.codePreview) return { kind: "scene", home, feature, scene };
    return { kind: "detail", home, feature, scene };
  }
  const enter = id => options.onEnter?.(id);
  function placeProjectTools(host = document.getElementById("project-context")) {
    if (options.projectTools && host) host.append(options.projectTools);
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
  function currentArm(node) {
    const data = experiment(node).comparison;
    if (!data) return null;
    const candidates = data.arms.filter(arm => arm.id !== data.baseline);
    const selected = selectedArms.get(node.id);
    return {
      data, candidates,
      candidate: candidates.find(arm => arm.id === selected) || candidates.find(arm => arm.id === data.primary),
      baseline: data.arms.find(arm => arm.id === data.baseline),
    };
  }
  /* `opts.bare` (structure detail): the key metrics, finding and caveat live above the
     fold, so only the selector and the full table are drawn; `opts.onChange` refreshes them. */
  function renderComparison(parent, node, opts = {}) {
    const { data, candidates, candidate, baseline } = currentArm(node) || {};
    if (!data) return;
    const section = add(parent, "section", "research-comparison");
    section.setAttribute("aria-label", data.title || "实验对照");
    const heading = add(section, "div", "research-comparison-heading");
    if (!opts.bare || data.cohort) {
      const intro = add(heading, "div");
      if (!opts.bare) add(intro, "h3", "", data.title || "实验对照");
      if (data.cohort) add(intro, "p", "research-muted research-small", data.cohort);
    }
    const selector = add(heading, "label", "research-selector", "对照方法");
    const select = add(selector, "select");
    select.setAttribute("aria-label", "对照方法");
    for (const arm of candidates) {
      const option = new Option(`${arm.label} · ${arm.id === data.primary ? "主对照" : "次要对照"}`, arm.id);
      select.append(option);
    }
    select.value = candidate.id;
    select.addEventListener("change", () => {
      selectedArms.set(node.id, select.value);
      if (opts.bare) {
        data.arms.forEach((arm, index) => { body.rows[index].dataset.current = String(arm.id === select.value); });
        opts.onChange?.();
        return;
      }
      const index = [...parent.children].indexOf(section);
      section.remove();
      renderComparison(parent, node, opts);
      const updated = parent.lastElementChild;
      if (index < parent.children.length - 1) parent.insertBefore(updated, parent.children[index]);
      updated.querySelector("select").focus({ preventScroll: true });
    });
    if (!opts.bare) {
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
    }
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

  function flowCard(parent, item, nodes) {
    const main = add(parent, "div", "research-flow-main");
    labelled(button(main, "", () => enter(item.id), "research-card-title"), item);
    const description = firstSentence(capability(item)?.outcome || item.summary);
    if (description) add(main, "p", "research-muted", description);
    const support = children(item.id, nodes);
    if (!support.length) return;
    const list = add(parent, "ul", "research-flow-support");
    for (const detail of support) {
      const row = add(list, "li");
      labelled(button(row, "", () => enter(detail.id), "research-card-title"), detail);
    }
  }

  function editFlow(parent, node, topics, trigger) {
    trigger.hidden = true;
    const editor = add(parent, "section", "research-flow-editor");
    add(editor, "h3", "", "设置流程顺序");
    add(editor, "p", "research-muted", "按实际发生顺序添加步骤。至少两步才会显示连线。清空后恢复主题分组。");
    const choices = new Map(topics.map(topic => [topic.id, topic]));
    const previous = node.flowSteps || [];
    const order = previous.filter(id => choices.has(id));
    const list = add(editor, "ol", "research-flow-order");
    const addRow = add(editor, "div", "research-flow-add");
    const input = add(addRow, "select");
    input.setAttribute("aria-label", "选择下一步");
    const append = button(addRow, "加入流程", () => {
      if (!input.value || order.length >= 12) return;
      order.push(input.value);
      update();
      if (!input.disabled) input.focus();
      else save.focus();
    });
    const actions = add(editor, "div", "research-flow-add");
    const message = add(editor, "p", "research-muted");
    message.setAttribute("role", "status");
    const save = button(actions, "保存顺序", () => {
      const error = options.onSaveFlow(node.id, [...order], previous);
      if (error) { message.textContent = error; return; }
      render();
      container.querySelector(".research-diagram-tools > summary, .research-flow-edit")?.focus();
    });
    button(actions, "取消", () => { editor.remove(); trigger.hidden = false; trigger.focus(); });
    function update() {
      list.replaceChildren();
      order.forEach((id, index) => {
        const row = add(list, "li");
        const name = title(choices.get(id));
        add(row, "span", "", `${index + 1}. ${name}`);
        const controls = add(row, "div", "research-flow-add");
        function move(offset, target) {
          order.splice(index, 1);
          order.splice(index + offset, 0, id);
          update();
          const controls = list.children[index + offset].lastChild;
          const next = controls.children[target];
          (next.disabled ? controls.children[1 - target] : next).focus();
        }
        const up = button(controls, "上移", () => move(-1, 0));
        up.disabled = index === 0;
        up.setAttribute("aria-label", `上移 ${name}`);
        const down = button(controls, "下移", () => move(1, 1));
        down.disabled = index === order.length - 1;
        down.setAttribute("aria-label", `下移 ${name}`);
        button(controls, "移除", () => {
          order.splice(index, 1);
          update();
          input.focus();
        }).setAttribute("aria-label", `移除 ${name}`);
      });
      input.replaceChildren();
      add(input, "option", "", "选择下级卡片").value = "";
      for (const [id, topic] of choices) if (!order.includes(id)) add(input, "option", "", title(topic)).value = id;
      input.disabled = input.options.length === 1 || order.length >= 12;
      append.disabled = !input.value;
      save.disabled = order.length === 1;
      message.textContent = "";
    }
    input.addEventListener("change", () => { append.disabled = !input.value; });
    update();
    input.focus();
  }

  function renderFlow(parent, node, nodes) {
    const direct = children(node.id, nodes);
    const ordered = node.flowSteps || [];
    const byId = new Map(direct.map(item => [item.id, item]));
    // If an intermediate step moves away or is deleted, don't connect across the missing step.
    const steps = ordered.length >= 2 && ordered.every(id => byId.has(id)) ? ordered : [];
    const header = add(parent, "div", "research-flow-header");
    add(header, "h3", "", steps.length ? "主流程" : "主题分组");
    if (options.canEditFlow?.(node.id) && (direct.length >= 2 || ordered.length)) {
      const editor = add(parent, "div");
      const edit = button(header, "设置流程", () => editFlow(editor, node, direct, edit), "research-button research-flow-edit");
    }
    if (steps.length) {
      const flow = add(parent, "ol", "research-flow");
      flow.setAttribute("aria-label", "按发生顺序排列的流程");
      steps.forEach((id, index) => {
        const stage = add(flow, "li", "research-flow-stage");
        add(stage, "span", "research-flow-index", `${index + 1}`);
        flowCard(stage, byId.get(id), nodes);
        if (index < steps.length - 1) add(stage, "span", "research-flow-arrow", "→").setAttribute("aria-hidden", "true");
      });
    } else if (ordered.length) {
      add(parent, "p", "research-muted", "有流程步骤已移出当前分支。可重新指定顺序。");
    }
    const groups = direct.filter(item => !steps.includes(item.id));
    if (groups.length) {
      if (steps.length) add(parent, "h3", "research-section-heading", "相关主题");
      const layout = add(parent, "div", "research-flow-groups");
      for (const item of groups) flowCard(add(layout, "section", "research-flow-group"), item, nodes);
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
      gallery.setAttribute("role", "group");
      gallery.setAttribute("aria-label", "证据图片");
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
  /* ---- Project structure: author-confirmed zones, nodes and directed links ---- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const roleNames = { entry: "入口", capability: "能力", external: "外部资料", store: "存储", feedback: "反馈" };
  const kindNames = { main: "主路径", side: "旁路", back: "回写" };
  const narrowQuery = window.matchMedia?.("(max-width: 760px)");
  const touchTools = window.matchMedia?.("(hover: none), (pointer: coarse)");
  const autoOpened = new Set();
  function svgNode(parent, tag, attributes = {}, content) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (content != null) element.textContent = content;
    parent.append(element);
    return element;
  }
  /* Stored record + live cards. Stale card references are hidden here, never rewritten. */
  function structureFor(nodes) {
    const record = options.getStructure?.();
    const resolved = record && window.ProjectStructure?.resolve(record, new Set(nodes.map(node => node.id)));
    if (!resolved) return null;
    const known = new Set(nodes.map(node => node.id));
    const top = nodes.find(node => !known.has(node.parentId))?.id;
    return { ...resolved, rootId: resolved.rootId && known.has(resolved.rootId) ? resolved.rootId : top };
  }
  function structureRoot(nodes) {
    const authored = structureFor(nodes);
    if (authored || !options.canStructure?.()) return authored?.rootId || null;
    const ids = new Set(nodes.map(node => node.id));
    return nodes.find(node => !ids.has(node.parentId))?.id || null;
  }
  function diagramFor(scopeId, nodes) {
    const present = new Set(nodes.map(node => node.id));
    const local = options.getModuleDiagrams?.().find(diagram => diagram.rootId === scopeId);
    let saved = local && window.ProjectStructure.resolve(local, present);
    if (!saved) {
      const overview = structureFor(nodes);
      if (overview?.rootId === scopeId) saved = overview;
    }
    const base = saved || window.ModuleDiagram?.derive(nodes, scopeId);
    if (!base) return null;
    const usedCards = new Set(base.zones.flatMap(zone => zone.nodes.map(node => node.cardId)));
    const added = children(scopeId, nodes).filter(card => card.opinionChild && !usedCards.has(card.id));
    if (!added.length) return { diagram: base, base, authored: Boolean(saved) };
    const used = new Set(base.zones.flatMap(zone => [zone.id, ...zone.nodes.map(node => node.id)]));
    const unique = name => {
      while (used.has(name)) name += "-x";
      used.add(name);
      return name;
    };
    const lane = Math.max(...base.zones.map((zone, index) => zone.lane ?? Math.min(index, 5)));
    const zone = { id: unique("opinion-cards"), title: "AI 补充", role: "capability", size: "medium", lane, projection: true,
      nodes: added.map(card => ({ id: unique(`opinion-${card.id.toLowerCase()}`), cardId: card.id, note: firstSentence(card.summary) })) };
    return { diagram: { ...base, zones: [...base.zones, zone] }, base, authored: Boolean(saved) };
  }
  function structureModel(structure, nodes) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const zones = structure.zones.map((zone, index) => ({ ...zone, lane: zone.lane ?? Math.min(index, 5) }));
    const lanes = [...new Set(zones.map(zone => zone.lane))].sort((a, b) => a - b);
    const info = new Map();
    for (const zone of zones) for (const node of zone.nodes) {
      const card = byId.get(node.cardId);
      info.set(node.id, { node, zone, card, lane: lanes.indexOf(zone.lane), name: node.label || title(card) });
    }
    return { zones, lanes, info, links: structure.links || [], dropped: structure.dropped };
  }
  function labelLines(value, width = 7) {
    const chars = Array.from(value);
    const lines = [];
    for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
    return lines;
  }
  const textWidth = value => Array.from(value).reduce((sum, char) => sum + (/[\u0000-ÿ]/.test(char) ? 6.4 : 12), 0);
  function roundedPath(points, radius = 8) {
    const clean = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    if (clean.length < 2) return "";
    const toward = (from, to, distance) => {
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      return { x: from.x + (to.x - from.x) / length * distance, y: from.y + (to.y - from.y) / length * distance };
    };
    let path = `M${clean[0].x} ${clean[0].y}`;
    for (let index = 1; index < clean.length - 1; index++) {
      const [before, corner, after] = [clean[index - 1], clean[index], clean[index + 1]];
      const size = Math.min(radius, Math.hypot(corner.x - before.x, corner.y - before.y) / 2,
        Math.hypot(corner.x - after.x, corner.y - after.y) / 2);
      const from = toward(corner, before, size);
      const to = toward(corner, after, size);
      path += ` L${from.x} ${from.y} Q${corner.x} ${corner.y} ${to.x} ${to.y}`;
    }
    const last = clean.at(-1);
    return `${path} L${last.x} ${last.y}`;
  }
  /* Draws every stored link as routed SVG: forward links through the gutter, links that skip a
     lane over the top, links that return to an earlier lane or stay in one lane around the side. */
  let arrowSequence = 0;
  function drawStructure(stage, layer, model, buttons, scale) {
    const base = stage.getBoundingClientRect();
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { l: (box.left - base.left) / scale, r: (box.right - base.left) / scale,
        t: (box.top - base.top) / scale, b: (box.bottom - base.top) / scale,
        y: ((box.top + box.bottom) / 2 - base.top) / scale };
    };
    layer.replaceChildren();
    const width = stage.offsetWidth;
    const height = stage.offsetHeight;
    layer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    layer.setAttribute("width", width);
    layer.setAttribute("height", height);
    const defs = svgNode(layer, "defs");
    const markerPrefix = layer.dataset.markerPrefix ||= `research-arrow-${++arrowSequence}`;
    for (const kind of Object.keys(kindNames)) {
      const marker = svgNode(defs, "marker", { id: `${markerPrefix}-${kind}`, viewBox: "0 0 10 10", refX: 9, refY: 5,
        markerWidth: 7, markerHeight: 7, orient: "auto" });
      svgNode(marker, "path", { d: "M1 1L9 5L1 9z", class: `research-arrow research-arrow-${kind}` });
    }
    const laneRects = model.laneEls.map(rect);
    const count = laneRects.length;
    const gutter = index => index < count - 1 ? (laneRects[index].r + laneRects[index + 1].l) / 2
      : laneRects[count - 1].r + (model.inline ? 33 : 53);
    const edges = model.links.map(link => {
      const from = model.info.get(link.from);
      const to = model.info.get(link.to);
      const source = buttons.get(link.from);
      const target = buttons.get(link.to);
      const a = rect(source);
      const b = rect(target);
      const nodes = from.zone.nodes;
      const internal = !narrowQuery?.matches && !touchTools?.matches && from.zone === to.zone &&
        Math.abs(nodes.indexOf(from.node) - nodes.indexOf(to.node)) === 1;
      return { link, from, to, a, b, delta: to.lane - from.lane, internal };
    });
    // Spread ports along a node side and vertical runs inside a gutter so parallel links stay apart.
    const sides = new Map();
    const runs = new Map();
    const side = (edge, end) => end === "from" ? (edge.delta >= 0 ? "r" : "l") : (edge.delta >= 1 ? "l" : "r");
    const gutters = edge => edge.delta >= 2 ? [edge.from.lane, edge.to.lane - 1] : edge.delta >= 0 ? [edge.from.lane]
      : edge.delta === -1 ? [edge.to.lane] : [edge.from.lane - 1, edge.to.lane];
    for (const edge of edges) {
      if (edge.internal) continue;
      for (const end of ["from", "to"]) {
        const key = `${edge.link[end]}:${side(edge, end)}`;
        sides.set(key, [...(sides.get(key) || []), { edge, end }]);
      }
      gutters(edge).forEach((index, order) => runs.set(index, [...(runs.get(index) || []), { edge, order }]));
    }
    for (const list of sides.values()) {
      list.sort((x, y) => (x.end === "from" ? x.edge.b.y : x.edge.a.y) - (y.end === "from" ? y.edge.b.y : y.edge.a.y));
      list.forEach(({ edge, end }, index) => {
        const box = end === "from" ? edge.a : edge.b;
        const limit = Math.max(0, (box.b - box.t) / 2 - 8);
        edge[`${end}Y`] = box.y + Math.max(-limit, Math.min(limit, (index - (list.length - 1) / 2) * 7));
      });
    }
    for (const list of runs.values()) list.forEach(({ edge, order }, index) => {
      (edge.offsets ||= [])[order] = (index - (list.length - 1) / 2) * 10;
    });
    const top = edges.filter(edge => edge.delta >= 2);
    const bottom = edges.filter(edge => edge.delta < -1);
    const labels = [];
    const lines = svgNode(layer, "g", { class: "research-edge-lines" });
    for (const edge of edges) {
      const { a, b, delta } = edge;
      let points;
      if (edge.internal) {
        const down = a.y < b.y;
        const x = (a.l + a.r) / 2;
        points = [{ x, y: down ? a.b : a.t }, { x, y: down ? b.t : b.b }];
      } else {
        const [first, second] = gutters(edge).map((index, order) => gutter(index) + edge.offsets[order]);
        if (delta >= 2) {
          const channel = 14 + top.indexOf(edge) * 14;
          points = [{ x: a.r, y: edge.fromY }, { x: first, y: edge.fromY }, { x: first, y: channel }, { x: second, y: channel },
            { x: second, y: edge.toY }, { x: b.l, y: edge.toY }];
        } else if (delta >= 0) {
          points = [{ x: a.r, y: edge.fromY }, { x: first, y: edge.fromY }, { x: first, y: edge.toY },
            { x: delta ? b.l : b.r, y: edge.toY }];
        } else if (delta === -1) {
          points = [{ x: a.l, y: edge.fromY }, { x: first, y: edge.fromY }, { x: first, y: edge.toY }, { x: b.r, y: edge.toY }];
        } else {
          const channel = height - 14 - bottom.indexOf(edge) * 14;
          points = [{ x: a.l, y: edge.fromY }, { x: first, y: edge.fromY }, { x: first, y: channel }, { x: second, y: channel },
            { x: second, y: edge.toY }, { x: b.r, y: edge.toY }];
        }
      }
      const attributes = { "data-from": edge.link.from, "data-to": edge.link.to, "data-kind": edge.link.kind };
      svgNode(lines, "path", { ...attributes, class: `research-edge research-edge-${edge.link.kind}`,
        d: roundedPath(points), "marker-end": `url(#${markerPrefix}-${edge.link.kind})` });
      let longest = [points[0], points[1]];
      points.slice(1).forEach((point, index) => {
        const length = Math.hypot(point.x - points[index].x, point.y - points[index].y);
        if (length > Math.hypot(longest[1].x - longest[0].x, longest[1].y - longest[0].y)) longest = [points[index], point];
      });
      labels.push({ edge, attributes, longest });
    }
    const placed = [];
    const labelLayer = svgNode(layer, "g", { class: "research-edge-labels" });
    for (const { edge, attributes, longest } of labels) {
      const rows = model.inline ? labelLines(edge.link.label, 4) : edge.internal ? [edge.link.label] : labelLines(edge.link.label);
      const boxWidth = Math.max(...rows.map(textWidth)) + 12;
      const boxHeight = rows.length * 14 + 6;
      const vertical = longest[0].x === longest[1].x;
      let x = (longest[0].x + longest[1].x) / 2;
      let y = (longest[0].y + longest[1].y) / 2;
      const gutterLabel = !edge.internal && Math.abs(edge.delta) === 1;
      if (gutterLabel) {
        const [left, right] = edge.delta > 0 ? [edge.a.r, edge.b.l] : [edge.b.r, edge.a.l];
        const inset = boxWidth / 2 + 4;
        x = left + 2 * inset <= right ? Math.min(right - inset, Math.max(left + inset, x)) : (left + right) / 2;
      }
      if (edge.internal) {
        const right = Math.min(edge.a.r, edge.b.r);
        x = Math.min(x + boxWidth / 2 + 8, right - boxWidth / 2);
      }
      const hits = () => placed.some(other => Math.abs(other.x - x) < (other.w + boxWidth) / 2 &&
        Math.abs(other.y - y) < (other.h + boxHeight) / 2);
      for (let step = 1; step < 8 && hits(); step++) {
        if (vertical || gutterLabel) y += (step % 2 ? 1 : -1) * step * (boxHeight + 4);
        else x += (step % 2 ? 1 : -1) * step * (boxWidth + 4);
      }
      placed.push({ x, y, w: boxWidth, h: boxHeight });
      const group = svgNode(labelLayer, "g", { ...attributes, class: `research-edge-label research-edge-label-${edge.link.kind}` });
      group.dataset.hasEvidence = String(Boolean(edge.link.evidence));
      svgNode(group, "title", {}, `${kindNames[edge.link.kind]} · ${edge.from.name} → ${edge.to.name} · ` +
        (edge.link.evidence ? "来源：已登记关系，附证据卡" : "来源：已登记关系"));
      svgNode(group, "rect", { x: x - boxWidth / 2, y: y - boxHeight / 2, width: boxWidth, height: boxHeight, rx: 5 });
      const text = svgNode(group, "text", { x, "text-anchor": "middle" });
      rows.forEach((row, index) => svgNode(text, "tspan", { x, y: y - boxHeight / 2 + 14 + index * 14 - 2 }, row));
      group.addEventListener("click", () => model.select({ kind: "link", from: edge.link.from, to: edge.link.to }));
    }
  }
  /* A card is an experiment only through its structured record, never through attachments alone. */
  const briefLimit = 72;
  function brief(text) {
    if (text.length <= briefLimit) return text;
    const sentence = firstSentence(text);
    if (sentence.length <= briefLimit) return sentence;
    return `${Array.from(text).slice(0, briefLimit).join("").trimEnd()}…`;
  }
  /* Structure-board experiment detail: key numbers and evidence thumbnails first, long text on demand. */
  function renderExperimentFirst(parent, node, nodes, record, feature, diagramNote) {
    const data = record.comparison;
    const caveats = [record.caveat, data?.caveat].filter((text, index, list) => text && list.findIndex(other => same(other, text)) === index);
    const key = data || record.metricSummary ? add(parent, "section", "research-key") : null;
    key?.setAttribute("aria-label", data ? "关键对比" : "指标摘要");
    key?.setAttribute("aria-live", "polite");
    const pictures = images(node);
    if (pictures.length) {
      add(parent, "p", "research-proof-label", "证据图片");
      const strip = add(parent, "div", "research-thumbs");
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", `证据图片，共 ${pictures.length} 张`);
      for (const file of pictures) image(strip, file, true);
    }
    const findings = data || record.finding || caveats.length ? add(parent, "div", "research-key") : null;
    const paint = () => {
      key?.replaceChildren();
      findings?.replaceChildren();
      const arm = currentArm(node);
      let finding = record.finding;
      if (arm) {
        const { candidate, baseline } = arm;
        const primary = candidate.id === data.primary;
        add(key, "p", "research-muted research-small research-key-arm",
          `对照：${candidate.label}${primary ? "（主对照）" : "（次要对照）"} · 基线：${baseline.label}`);
        const grid = add(key, "div", "research-key-metrics");
        data.metrics.slice(0, 2).forEach((metric, index) => {
          const box = add(grid, "div", "research-key-metric");
          add(box, "span", "research-muted research-small", `${metric.label} · ${metric.direction === "higher" ? "越高越好" : "越低越好"}`);
          add(box, "strong", "", format(candidate.values[index]));
          add(box, "span", "research-muted research-small", `基线 ${format(baseline.values[index])}`);
        });
        finding = primary ? data.finding || record.finding : "";
      } else if (record.metricSummary) add(key, "p", "research-inline-metric", brief(record.metricSummary));
      if (finding) add(findings, "p", "research-finding", brief(finding));
      for (const text of caveats) add(findings, "p", "research-caveat", `限定：${brief(text)}`);
    };
    paint();
    const extra = [];
    const note = (label, text) => { if (text && !extra.some(item => same(item[1], text))) extra.push([label, text]); };
    const text = fullText(node);
    note("实验问题", record.question);
    if (text && !same(text, record.question)) note("", text);
    note("图上说明", diagramNote);
    if (data || record.metricSummary?.length > briefLimit) note("指标摘要", record.metricSummary);
    if (data || record.finding?.length > briefLimit) note("结论", record.finding);
    note("主对照结论", data?.finding);
    for (const item of caveats) if (item.length > briefLimit) note("限定全文", item);
    note("类型", record.kind);
    const files = attachments(node).filter(file => !pictures.some(picture => picture.id === file.id));
    if (extra.length || files.length || feature) {
      const details = add(parent, "details", "research-sources research-proof research-experiment-notes");
      add(details, "summary", "", `实验说明${files.length ? ` · ${files.length} 个附件` : ""}`);
      for (const [label, value] of extra) add(details, "p", "research-description", label ? `${label}：${value}` : value);
      if (feature) factRows(add(details, "section", "research-facts"), feature, factKeys);
      renderAttachments(details, node);
    }
    if (data) {
      const table = add(parent, "details", "research-sources research-proof research-experiment-table");
      add(table, "summary", "", `完整对照表 · ${data.metrics.length} 项指标 · ${data.arms.length} 种方法`);
      const body = add(table, "div");
      renderComparison(body, node, { bare: true, onChange: paint });
    }
    renderEvidence(parent, node, children(node.id, nodes).filter(item => item.codePreview));
  }
  function cardReading(parent, card, nodes, diagramNote) {
    const feature = capability(card);
    const record = experiment(card);
    if (record.comparison || ["kind", "question", "metricSummary", "finding", "caveat"].some(key => record[key])) {
      renderExperimentFirst(parent, card, nodes, record, feature, diagramNote);
      return;
    }
    const lead = feature?.outcome || "";
    const text = fullText(card);
    if (diagramNote) add(parent, "p", "research-muted", diagramNote);
    if (lead) add(parent, "p", "research-lead", lead);
    if (text && !same(text, lead)) add(parent, "p", "research-description", text);
    if (feature) factRows(add(parent, "section", "research-facts"), feature, factKeys);
    renderRecord(parent, card, lead);
    renderEvidence(parent, card, children(card.id, nodes).filter(item => item.codePreview));
  }
  function structureCardActions(parent, card, scope) {
    if (!card || card.id === "board") return;
    const row = add(parent, "div", "research-structure-actions");
    if (options.canEditCard?.(card.id)) {
      button(row, "提意见让 AI 改", () => options.onOpinion?.(card.id), "research-button research-opinion-button");
      button(row, "编辑原卡", () => options.onEditCard?.(card.id), "research-button research-edit-card");
    }
    if (!options.compactWorkspace?.() && typeof options.onAddChild === "function") {
      button(row, "手动新建子卡", () => options.onAddChild(card.id));
    }
    if (card.id !== scope) button(row, "打开模块图", () => options.onStructureBranch?.(card.id, scope), "research-button research-structure-enter");
  }
  let savedY = null;
  let restoreKey = null;
  const diagramViews = new Map();
  const expandedDiagrams = new Map();

  function structureCamera(frame, world, stage, tools, scope) {
    const controls = add(tools, "div", "research-camera-tools");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "画布缩放");
    let scale = diagramViews.get(scope)?.scale || 1;
    let marginX = 0, marginY = 0;
    let stageWidth = 0, stageHeight = 0;
    let drag = null;
    const read = () => ({ scale, x: (frame.scrollLeft - marginX) / scale, y: (frame.scrollTop - marginY) / scale });
    const clamp = value => Math.min(2.5, Math.max(0.1, value));
    const sync = view => {
      scale = clamp(view.scale);
      marginX = frame.clientWidth;
      marginY = frame.clientHeight;
      world.style.width = `${Math.ceil(stage.scrollWidth * scale) + 2 * marginX}px`;
      world.style.height = `${Math.ceil(stage.offsetHeight * scale) + 2 * marginY}px`;
      stage.style.left = `${marginX}px`;
      stage.style.top = `${marginY}px`;
      stage.style.transform = `scale(${scale})`;
      frame.scrollLeft = marginX + view.x * scale;
      frame.scrollTop = marginY + view.y * scale;
      reset.textContent = `${Math.round(100 * scale)}%`;
      smaller.disabled = scale <= 0.1;
      larger.disabled = scale >= 2.5;
    };
    const zoom = (value, x = frame.clientWidth / 2, y = frame.clientHeight / 2) => {
      const view = read();
      const next = clamp(value);
      if (next === scale) return;
      sync({ scale: next, x: view.x + x / scale - x / next, y: view.y + y / scale - y / next });
    };
    const smaller = button(controls, "−", () => zoom(scale / 1.2), "research-button");
    smaller.setAttribute("aria-label", "缩小画布");
    const reset = button(controls, "", () => sync({ scale: 1, x: 0, y: 0 }), "research-button");
    reset.title = "恢复到 100% 并回到起点";
    const larger = button(controls, "+", () => zoom(scale * 1.2), "research-button");
    larger.setAttribute("aria-label", "放大画布");
    button(controls, "适应", () => {
      const fitted = clamp(Math.min(frame.clientWidth / stage.scrollWidth, frame.clientHeight / stage.offsetHeight, 1));
      sync({ scale: fitted, x: (stage.scrollWidth - frame.clientWidth / fitted) / 2,
        y: (stage.offsetHeight - frame.clientHeight / fitted) / 2 });
    }, "research-button").title = "显示整张图";

    frame.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) {
        if (workspace.childElementCount > 1 && !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          event.preventDefault();
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
          window.scrollBy({ top: event.deltaY * unit, behavior: "instant" });
        }
        return;
      }
      event.preventDefault();
      const bounds = frame.getBoundingClientRect();
      zoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - bounds.left, event.clientY - bounds.top);
    }, { passive: false });
    frame.addEventListener("pointerdown", event => {
      if (event.pointerType === "touch" || drag || (event.button !== 1 &&
          (event.button !== 0 || event.target.closest("button, a, .research-edge-label")))) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop };
      frame.setPointerCapture(event.pointerId);
      frame.classList.add("is-panning");
    });
    frame.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      frame.scrollLeft = drag.left + drag.x - event.clientX;
      frame.scrollTop = drag.top + drag.y - event.clientY;
    });
    frame.addEventListener("lostpointercapture", () => { drag = null; frame.classList.remove("is-panning"); });
    frame.addEventListener("auxclick", event => { if (event.button === 1) event.preventDefault(); });

    const measure = (view = read()) => {
      if (frame.clientWidth !== marginX) stage.style.width = `${frame.clientWidth}px`;
      if (frame.clientWidth === marginX && frame.clientHeight === marginY &&
          stage.scrollWidth === stageWidth && stage.offsetHeight === stageHeight) return;
      stageWidth = stage.scrollWidth;
      stageHeight = stage.offsetHeight;
      frame.style.height = `${Math.min(720, Math.max(178, stageHeight + 2))}px`;
      sync(view);
    };
    measure(diagramViews.get(scope) || { scale: 1, x: 0, y: 0 });
    return { read, measure, scale: () => scale };
  }
  /* One shared node menu. It is appended to <body> with fixed positioning so the scrolling
     stage cannot clip it, and it always acts on the node it was opened for, never on the
     current selection. */
  let menu = null;
  function closeMenu(restore) {
    if (!menu) return;
    const { el, opener, trigger, target, off } = menu;
    menu = null;
    off();
    el.remove();
    target.classList.remove("is-context-target");
    trigger?.setAttribute("aria-expanded", "false");
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function cardActions(card, move, scope) {
    if (!card || card.id === "board") return [];
    const list = [];
    if (typeof options.onEditCard === "function" && options.canEditCard?.(card.id)) {
      list.push(["提意见让 AI 改", () => options.onOpinion?.(card.id)]);
      list.push(["AI 向下延伸", () => options.onOpinion?.(card.id, "children")]);
      list.push(["编辑原卡", () => options.onEditCard(card.id)]);
    }
    if (typeof options.onAddChild === "function") list.push(["手动新建子卡", () => options.onAddChild(card.id)]);
    if (move?.up) list.push(["在分区内上移", move.up]);
    if (move?.down) list.push(["在分区内下移", move.down]);
    if (card.id !== scope && typeof options.onStructureBranch === "function") {
      list.push(["打开模块图", () => options.onStructureBranch(card.id, scope)]);
    }
    return list;
  }
  /* spec: { key, name, target, trigger, selection, actions() } */
  function openMenu(model, spec, opener, point) {
    closeMenu(false);
    const actions = spec.actions();
    if (!actions.length) return;
    const { target, trigger } = spec;
    const el = document.createElement("div");
    el.className = "research-context-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", `${spec.name} 的操作`);
    const entries = actions.map(([label, run]) => {
      const item = button(el, label, () => {
        closeMenu(true);
        const selected = model.selection();
        const want = spec.selection;
        if (!(selected?.kind === "node" && selected.scope === model.key && selected.id === want.id && (selected.cardId || null) === (want.cardId || null) &&
          !(want.cardId == null && selected.cardId))) model.select(want, true, false);
        run();
      }, "research-context-item");
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      return item;
    });
    el.addEventListener("keydown", event => {
      const index = entries.indexOf(document.activeElement);
      let next = -1;
      if (event.key === "ArrowDown") next = (index + 1) % entries.length;
      else if (event.key === "ArrowUp") next = (index - 1 + entries.length) % entries.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = entries.length - 1;
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      else if (event.key === "Tab") { closeMenu(true); return; }
      else return;
      event.preventDefault();
      entries[next].focus({ preventScroll: true });
    });
    document.body.append(el);
    const margin = 8;
    const box = el.getBoundingClientRect();
    const view = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    el.style.maxHeight = `${view.h - margin * 2}px`;
    const height = Math.min(box.height, view.h - margin * 2);
    const anchor = opener.getBoundingClientRect();
    const place = (x, y) => {
      const left = Math.min(x, view.w - box.width - margin);
      const top = y + height + margin > view.h ? y - height : y;
      el.style.left = `${Math.max(margin, left)}px`;
      el.style.top = `${Math.max(margin, Math.min(top, view.h - height - margin))}px`;
    };
    place(point.x, point.y);
    const outside = event => { if (!el.contains(event.target) && event.target !== trigger) closeMenu(false); };
    const scrolled = event => {
      if (el.contains(event.target)) return;
      const current = opener.getBoundingClientRect();
      if (current.bottom <= 0 || current.top >= view.h || current.right <= 0 || current.left >= view.w) closeMenu(false);
      else place(point.x + current.x - anchor.x, point.y + current.y - anchor.y);
    };
    const away = event => { if (!el.contains(event.target) && event.target !== opener && event.target !== trigger) closeMenu(false); };
    const dismiss = () => closeMenu(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("focusin", away, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    menu = { el, id: spec.key, opener, target, trigger, off: () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("focusin", away, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    } };
    target.classList.add("is-context-target");
    trigger?.setAttribute("aria-expanded", "true");
    entries[0].focus({ preventScroll: true });
  }
  function renderStructureDetail(panel, model, nodes, selection, scope) {
    panel.replaceChildren();
    const select = value => model.select(value);
    if (selection?.kind === "link") {
      const link = model.links.find(entry => entry.from === selection.from && entry.to === selection.to);
      const [from, to] = [model.info.get(link.from), model.info.get(link.to)];
      add(panel, "span", "research-kicker", `${kindNames[link.kind]} · 连线`);
      const heading = add(panel, "h3");
      button(heading, from.name, () => select({ kind: "node", id: link.from }), "research-card-title");
      heading.append(document.createTextNode(` → ${link.label} → `));
      button(heading, to.name, () => select({ kind: "node", id: link.to }), "research-card-title");
      add(panel, "p", "research-muted research-small",
        model.authored ? "来源：模块图中登记的关系。" : "来源：卡片中明确设置的流程顺序。");
      const evidence = link.evidence && nodes.find(item => item.id === link.evidence);
      if (!evidence) {
        add(panel, "p", "research-muted", "这条连线没有关联证据卡片。");
        return;
      }
      add(panel, "p", "research-proof-label", "证据卡片");
      labelled(button(add(panel, "h3"), "", () => options.onStructureBranch?.(evidence.id, scope), "research-card-title"), evidence);
      structureCardActions(panel, evidence, scope);
      cardReading(panel, evidence, nodes);
      return;
    }
    const info = model.info.get(selection?.id);
    const card = nodes.find(node => node.id === selection?.cardId) || info?.card;
    if (!card) return;
    const exact = info?.card.id === card.id;
    if (exact) add(panel, "span", "research-kicker", `${info.zone.title} · ${roleNames[info.zone.role]}`);
    else if (info) add(panel, "span", "research-kicker", `${info.name} › 下级卡片`);
    labelled(add(panel, "h3"), card);
    structureCardActions(panel, card, scope);
    if (!exact) { cardReading(panel, card, nodes); return; }
    const diagramNote = model.authored && !same(info.node.note, fullText(card)) ? info.node.note : "";
    if (card.id !== "board") cardReading(panel, card, nodes, diagramNote);
    else if (diagramNote) add(panel, "p", "research-muted", diagramNote);
    const relations = [
      ...model.links.filter(link => link.to === info.node.id).map(link => ({ link, other: link.from, text: "来自" })),
      ...model.links.filter(link => link.from === info.node.id).map(link => ({ link, other: link.to, text: "去向" })),
    ];
    if (relations.length) {
      const list = add(panel, "ul", "research-structure-near");
      for (const { link, other, text } of relations) {
        const row = add(list, "li");
        add(row, "span", "research-muted", `${text} · ${link.label} · `);
        button(row, model.info.get(other).name, () => select({ kind: "node", id: other }), "research-card-title");
      }
    }
  }
  function chartSurface(host, model) {
    const chart = add(host, "div", "research-structure-chart");
    chart.classList.toggle("has-links", Boolean(model.links.length));
    chart.classList.toggle("is-single-lane", model.lanes.length === 1);
    chart.classList.toggle("research-inline-chart", Boolean(model.inline));
    const layer = svgNode(chart, "svg", { class: "research-structure-lines", "aria-hidden": "true", focusable: "false" });
    const top = model.links.filter(link => model.info.get(link.to).lane - model.info.get(link.from).lane >= 2).length;
    const bottom = model.links.filter(link => model.info.get(link.from).lane - model.info.get(link.to).lane >= 2).length;
    const room = model.inline ? 14 : 28;
    chart.style.setProperty("--structure-top", `${room + top * 14}px`);
    chart.style.setProperty("--structure-bottom", `${room + bottom * 14}px`);
    chart.style.setProperty("--structure-lanes", model.lanes.length);
    const grid = add(chart, "div", "research-structure-grid");
    const weight = { small: 1, medium: 1.3, large: 1.7 };
    const tracks = model.lanes.map(lane => `minmax(0, ${Math.max(
      ...model.zones.filter(zone => zone.lane === lane).map(zone => weight[zone.size])
    )}fr)`).join(" ");
    grid.style.gridTemplateColumns = tracks;
    return { chart, grid, layer, model, tracks, buttons: new Map(), expanded: new Map() };
  }

  function measureExpandedChart(surface) {
    const { chart, grid, model, tracks, expanded, original } = surface;
    const style = getComputedStyle(chart);
    const gap = parseFloat(getComputedStyle(grid).columnGap);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    if (!expanded.size) {
      chart.style.width = "";
      grid.style.gridTemplateColumns = tracks;
      for (const column of model.laneEls) {
        column.style.paddingTop = "";
        column.style.justifyContent = "";
      }
      surface.original = null;
      return padding + gap * (model.lanes.length - 1) + 136 * model.lanes.length;
    }
    const widths = original.map(lane => lane.width);
    for (const { child, lane, inset } of expanded.values()) {
      widths[lane] = Math.max(widths[lane], measureExpandedChart(child) + inset);
    }
    grid.style.gridTemplateColumns = widths.map(width => `${width}px`).join(" ");
    for (const [i, column] of model.laneEls.entries()) {
      column.style.justifyContent = "flex-start";
      column.style.paddingTop = `${original[i].top}px`;
    }
    const width = Math.ceil(padding + gap * (widths.length - 1) + widths.reduce((sum, track) => sum + track, 0));
    chart.style.width = `${width}px`;
    return width;
  }

  function renderStructure(parent, nodes, { diagram: structure, base, authored }) {
    const mounted = currentEntry;
    const model = structureModel(structure, nodes);
    let structureSelection = mounted.selection || null;
    model.selection = () => structureSelection;
    model.authored = authored;
    const compact = options.compactWorkspace?.();
    const section = add(parent, "section", "research-structure");
    section.dataset.diagramRoot = rootId;
    section.classList.toggle("has-links", Boolean(model.links.length));
    section.classList.toggle("is-single-lane", model.lanes.length === 1);
    section.setAttribute("aria-label", structure.title || "项目结构");
    const header = add(section, "div", "research-structure-header");
    const intro = add(header, "div");
    add(intro, "h3", "", structure.title || "模块关系");
    add(intro, "p", "research-muted research-small", narrowQuery?.matches
      ? "滑动画布，使用旁边的按钮缩放。" : "拖动空白处平移，Ctrl + 滚轮缩放。");
    const controls = add(header, "div", "research-structure-controls");
    if (model.links.length) {
      const legend = add(controls, "ul", "research-structure-legend");
      legend.setAttribute("aria-label", "连线类型");
      for (const kind of Object.keys(kindNames)) {
        if (!model.links.some(link => link.kind === kind)) continue;
        const entry = add(legend, "li");
        entry.dataset.kind = kind;
        add(entry, "i").setAttribute("aria-hidden", "true");
        entry.append(document.createTextNode(kindNames[kind]));
      }
    }
    if (options.onConfigureDiagram) {
      const settings = compact ? add(controls, "details", "research-diagram-tools") : controls;
      if (compact) add(settings, "summary", "research-button", "图设置");
      const actions = compact ? add(settings, "div", "project-tools-menu") : settings;
      button(actions, "编辑模块图", () => options.onConfigureDiagram(rootId, base), "research-button");
      const node = nodes.find(item => item.id === rootId);
      const direct = children(rootId, nodes);
      if (compact && !authored && options.canEditFlow?.(rootId) && (direct.length >= 2 || node?.flowSteps?.length)) {
        const editor = add(section, "div");
        const edit = button(actions, "设置流程", () => {
          settings.open = false;
          editFlow(editor, node, direct, settings.querySelector("summary"));
        }, "research-button research-flow-edit");
        edit.setAttribute("aria-label", "设置模块流程");
      }
    }
    if (model.dropped) add(section, "p", "research-caveat",
      `结构中有 ${model.dropped} 项引用的卡片已不存在，已暂时隐藏；卡片恢复后会再次出现。`);
    const live = add(section, "p", "research-structure-live");
    live.setAttribute("role", "status");
    const announce = text => { live.textContent = text; };
    const layout = add(section, "div", "research-structure-layout");
    const scroller = add(layout, "div", "research-structure-scroll");
    scroller.tabIndex = 0;
    scroller.setAttribute("aria-label", "模块关系图");
    scroller.setAttribute("role", "group");
    const world = add(scroller, "div", "research-camera-world");
    const stage = add(world, "div", "research-structure-stage");
    const surface = chartSurface(stage, model);
    const { grid, buttons } = surface;
    const wraps = new Map();
    const scope = rootId;
    model.key = scope;
    const remembered = expandedDiagrams.get(scope) || new Set();
    expandedDiagrams.set(scope, remembered);
    const restoreExpansions = [];
    const focusByKey = (root, key) => [...root.querySelectorAll("[data-focus-key]")].find(element => element.dataset.focusKey === key);
    let frame = 0;
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (stage.isConnected) redraw(); });
    };
    /* Persist a new order of one zone. Hidden (stale) nodes keep their slots. Resolves true when saved. */
    function saveOrder(zone, ids, focusId) {
      const raw = options.getStoredDiagram?.(scope)?.zones.find(item => item.id === zone.id);
      const shown = new Set(ids);
      let next = 0;
      const full = raw ? raw.nodes.map(item => shown.has(item.id) ? ids[next++] : item.id) : ids;
      return Promise.resolve().then(() => options.onReorderZone(scope, zone.id, full)).then(result => result === true, () => false).then(ok => {
        if (ok) {
          mounted.pendingFocus = focusId ? `h:${focusId}` : null;
          if (active) refresh(items());
        } else announce("未能保存新顺序，已恢复原位。");
        return ok;
      });
    }
    function makeMore(parent, spec, target = model) {
      const more = button(parent, "⋯", () => {
        if (menu?.id === spec.key) closeMenu(true);
        else {
          const box = more.getBoundingClientRect();
          openMenu(target, spec, more, { x: box.left, y: box.bottom + 4 });
        }
      }, "research-snode-more");
      more.dataset.focusKey = `m:${spec.key}`;
      more.setAttribute("aria-label", `${spec.name} 的更多操作`);
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      spec.trigger = more;
      return more;
    }
    function attachMenu(area, fallback, spec, target = model) {
      const open = (event, point) => {
        if (event.target.closest(".research-snode-wrap") !== area) return;
        event.preventDefault();
        const opener = event.target.closest("button") || fallback;
        const box = opener.getBoundingClientRect();
        openMenu(target, spec, opener, point || { x: box.left + 12, y: box.bottom - 6 });
        return true;
      };
      area.addEventListener("contextmenu", event => {
        open(event, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null);
      });
      area.addEventListener("keydown", event => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) open(event, null);
      });
    }

    function saveColumnAnchors(target, scale) {
      if (target.original) return;
      target.original = target.model.laneEls.map(column => {
        const box = column.getBoundingClientRect();
        return { width: box.width / scale, top: (column.firstElementChild.getBoundingClientRect().top - box.top) / scale };
      });
    }

    function inlineToggle(target, wrap, info, path, ancestors, restores = restoreExpansions) {
      const toggle = button(wrap, "+", () => change(!target.expanded.has(path)), "research-snode-expand");
      toggle.dataset.focusKey = `expand:${path}`;
      toggle.setAttribute("aria-expanded", "false");
      toggle.title = `展开「${info.name}」的下级`;
      toggle.setAttribute("aria-label", toggle.title);
      if (remembered.has(path)) restores.push(() => change(true, true));

      function change(open, restoring = false) {
        const origin = target.buttons.get(info.node.id);
        const anchor = origin.getBoundingClientRect();
        const scale = camera.scale();
        const previous = target.expanded.get(path);
        if (open) {
          const next = diagramFor(info.card.id, nodes);
          if (!next) return;
          // A visible branch frame already identifies the parent. Keep its card only when a line uses it.
          const endpoints = new Set((next.diagram.links || []).flatMap(link => [link.from, link.to]));
          const zones = next.diagram.zones.map(zone => ({ ...zone,
            nodes: zone.nodes.filter(entry => entry.cardId !== info.card.id || endpoints.has(entry.id)) })).filter(zone => zone.nodes.length);
          if (!zones.length) return;
          saveColumnAnchors(target, scale);
          const group = add(wrap, "section", "research-inline-module");
          group.dataset.diagramRoot = info.card.id;
          group.setAttribute("aria-label", `${info.name} 的下级模块`);
          add(group, "h5", "research-inline-heading", `${info.name} · 下级`);
          const lower = structureModel({ ...next.diagram, zones }, nodes);
          lower.inline = true;
          lower.authored = next.authored;
          lower.key = scope + path;
          const child = chartSurface(group, lower);
          if (!lower.links.length && options.onConfigureDiagram && zones.flatMap(zone => zone.nodes).length > 1) {
            const footer = add(group, "div", "research-inline-relations");
            add(footer, "span", "research-muted", "按卡片归属展开");
            button(footer, "登记连线", () => options.onConfigureDiagram(info.card.id, next.base), "research-path-button");
          }
          const pending = [];
          const branchAncestors = new Set([...ancestors, info.card.id]);
          populateInline(child, path, branchAncestors, pending);
          const zoneStyle = getComputedStyle(wrap.closest(".research-zone"));
          const groupStyle = getComputedStyle(group);
          const inset = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce(
            (sum, key) => sum + parseFloat(zoneStyle[key]) + parseFloat(groupStyle[key]), 0);
          target.expanded.set(path, { child, lane: info.lane, inset, group });
          remembered.add(path);
          measureExpandedChart(surface);
          for (const restore of pending) restore();
        } else if (previous) {
          if (previous.group.contains(document.activeElement)) toggle.focus({ preventScroll: true });
          const hiddenSelection = previous.group.contains(selectedSurface?.chart);
          previous.group.remove();
          target.expanded.delete(path);
          remembered.delete(path);
          if (hiddenSelection) target.model.select({ kind: "node", id: info.node.id }, true, false);
        }
        toggle.textContent = open ? "−" : "+";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.title = `${open ? "收起" : "展开"}「${info.name}」的下级`;
        toggle.setAttribute("aria-label", toggle.title);
        redraw();
        if (!restoring) {
          const moved = origin.getBoundingClientRect();
          scroller.scrollLeft += moved.left - anchor.left;
          scroller.scrollTop += moved.top - anchor.top;
          announce(open ? `已展开 ${info.name} 的下级。` : `已收起 ${info.name} 的下级。`);
        }
      }
    }

    function populateInline(target, path, ancestors, pending) {
      const { model: lower, grid, buttons } = target;
      lower.select = (value, emphasize, openDetails) => selectOn(target, value, emphasize, openDetails);
      lower.selection = model.selection;
      lower.laneEls = lower.lanes.map(lane => {
        const column = add(grid, "div", "research-structure-lane");
        for (const zone of lower.zones.filter(entry => entry.lane === lane)) {
          const area = add(column, "section", "research-zone");
          area.dataset.role = zone.role;
          area.dataset.size = zone.size;
          add(add(area, "header"), "h4", "", zone.title);
          const list = add(area, "div", "research-zone-nodes");
          for (const entry of zone.nodes) {
            const info = lower.info.get(entry.id);
            const wrap = add(list, "div", "research-snode-wrap");
            const value = { kind: "node", id: entry.id };
            const card = button(wrap, "", () => lower.select(value), "research-snode");
            add(card, "strong", "", info.name);
            if (entry.note) add(card, "span", "", entry.note);
            card.dataset.node = entry.id;
            card.dataset.cardId = info.card.id;
            card.dataset.focusKey = `n:${path}/${entry.id}`;
            card.setAttribute("aria-pressed", "false");
            buttons.set(entry.id, card);
            const spec = { key: `node:${path}/${entry.id}`, name: info.name, target: wrap,
              selection: value, actions: () => cardActions(info.card, null, scope) };
            if (spec.actions().length) {
              makeMore(add(wrap, "div", "research-snode-tools"), spec, lower);
              card.setAttribute("aria-keyshortcuts", "Shift+F10");
              attachMenu(wrap, card, spec, lower);
            }
            if (!ancestors.has(info.card.id) && (children(info.card.id, nodes).length || options.getStoredDiagram?.(info.card.id))) {
              const drill = button(wrap, "打开模块图 ↓", () => options.onStructureBranch?.(info.card.id, scope), "research-snode-drill");
              drill.dataset.openModule = info.card.id;
              drill.setAttribute("aria-label", `打开「${info.name}」的模块图`);
              inlineToggle(target, wrap, info, `${path}/${entry.id}`, ancestors, pending);
            }
          }
        }
        return column;
      });
    }

    model.laneEls = model.lanes.map(lane => {
      const column = add(grid, "div", "research-structure-lane");
      for (const zone of model.zones.filter(entry => entry.lane === lane)) {
        const area = add(column, "section", "research-zone");
        area.dataset.role = zone.role;
        area.dataset.size = zone.size;
        area.setAttribute("aria-label", `${zone.title}（${roleNames[zone.role]}）`);
        const head = add(area, "header");
        if (!compact) add(head, "span", "research-zone-role", roleNames[zone.role]);
        add(head, "h4", "", zone.title);
        if (zone.note) add(head, "p", "research-muted research-small", zone.note);
        const list = add(area, "div", "research-zone-nodes");
        for (const entry of zone.nodes) {
          const info = model.info.get(entry.id);
          const wrap = add(list, "div", "research-snode-wrap");
          wrap.dataset.nodeId = entry.id;
          wraps.set(entry.id, wrap);
          const control = button(wrap, "", () => model.select({ kind: "node", id: entry.id }), "research-snode");
          control.title = entry.label ? `${info.name} · ${title(info.card)}` : info.name;
          add(control, "strong", "", info.name);
          if (entry.note) add(control, "span", "", entry.note);
          const out = model.links.filter(link => link.from === entry.id).length;
          const incoming = model.links.filter(link => link.to === entry.id).length;
          control.setAttribute("aria-label", `${info.name}，${zone.title}，${incoming} 条入线，${out} 条出线`);
          control.dataset.node = entry.id;
          control.dataset.cardId = info.card.id;
          control.dataset.focusKey = `n:${entry.id}`;
          buttons.set(entry.id, control);
          const isCard = info.card.id !== "board";
          const hasModule = info.card.id !== scope && (children(info.card.id, nodes).length || options.getStoredDiagram?.(info.card.id));
          const canMove = authored && !zone.projection && typeof options.onReorderZone === "function" && zone.nodes.length > 1;
          const order = () => [...list.children].map(element => element.dataset.nodeId);
          const place = delta => {
            const ids = order();
            const at = ids.indexOf(entry.id);
            const to = at + delta;
            if (to < 0 || to >= ids.length) return;
            [ids[at], ids[to]] = [ids[to], ids[at]];
            saveOrder(zone, ids, entry.id);
          };
          const tools = add(wrap, "div", "research-snode-tools");
          if (isCard && typeof options.onEditCard === "function" && options.canEditCard?.(info.card.id)) {
            const edit = button(tools, "✎", () => { model.select({ kind: "node", id: entry.id }, true, false); options.onEditCard(info.card.id); },
              "research-snode-edit");
            edit.setAttribute("aria-label", `编辑「${info.name}」原卡`);
            edit.title = "编辑原卡";
            edit.dataset.focusKey = `e:${entry.id}`;
          }
          if (canMove) {
            const handle = button(tools, "⠿", event => {
              if (event.detail !== 0) return;
              if (drag) { drop(true); announce("已放下"); }
              else { lift("key"); announce(`已拿起 ${info.name}。用上下方向键移动，空格或回车放下，Esc 取消。`); }
            }, "research-snode-handle");
            handle.setAttribute("aria-label", `在「${zone.title}」内调整「${info.name}」的位置`);
            handle.setAttribute("aria-pressed", "false");
            handle.title = "拖动调整本分区内的顺序";
            handle.dataset.focusKey = `h:${entry.id}`;
            let drag = null;
            const restoreOrder = ids => {
              for (const id of ids) list.append(wraps.get(id));
              soon();
            };
            const lift = mode => {
              closeMenu(false);
              drag = { mode, before: order() };
              wrap.classList.add("is-lifted");
              handle.setAttribute("aria-pressed", "true");
            };
            const drop = keep => {
              if (!drag) return;
              const { before, mode, target } = drag;
              drag = null;
              list.querySelector(".is-drop-before")?.classList.remove("is-drop-before");
              list.classList.remove("is-drop-end");
              wrap.classList.remove("is-lifted");
              handle.setAttribute("aria-pressed", "false");
              if (keep && mode === "pointer" && target !== undefined) list.insertBefore(wrap, target);
              const after = order();
              if (keep && after.join("\n") !== before.join("\n")) {
                saveOrder(zone, after, entry.id).then(ok => { if (!ok) { restoreOrder(before); if (mode === "key") handle.focus({ preventScroll: true }); } });
              } else if (!keep) { restoreOrder(before); if (mode === "key") handle.focus({ preventScroll: true }); }
            };
            handle.addEventListener("pointerdown", event => {
              if (event.button > 0 || drag) return;
              event.preventDefault();
              handle.setPointerCapture?.(event.pointerId);
              lift("pointer");
            });
            handle.addEventListener("pointermove", event => {
              if (drag?.mode !== "pointer") return;
              const others = [...list.children].filter(element => element !== wrap);
              let index = 0;
              for (const other of others) {
                const box = other.getBoundingClientRect();
                if (event.clientY > box.top + box.height / 2) index++;
                else break;
              }
              const target = others[index] || null;
              if (drag.target === target) return;
              drag.target?.classList.remove("is-drop-before");
              drag.target = target;
              target?.classList.add("is-drop-before");
              list.classList.toggle("is-drop-end", !target);
            });
            handle.addEventListener("pointerup", () => { if (drag?.mode === "pointer") drop(true); });
            handle.addEventListener("pointercancel", () => { if (drag?.mode === "pointer") drop(false); });
            handle.addEventListener("keydown", event => {
              if (drag?.mode !== "key") return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); drop(false); announce("已取消"); }
              else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                const all = [...list.children];
                const at = all.indexOf(wrap);
                const to = at + (event.key === "ArrowUp" ? -1 : 1);
                if (to < 0 || to >= all.length) return;
                list.insertBefore(wrap, event.key === "ArrowUp" ? all[to] : all[to].nextElementSibling);
                handle.focus({ preventScroll: true });
                soon();
                announce(`第 ${to + 1} 位，共 ${all.length} 个`);
              }
            });
            handle.addEventListener("focusout", event => { if (drag?.mode === "key" && event.relatedTarget) drop(false); });
          }
          const spec = { key: `node:${entry.id}`, name: info.name, target: wrap, trigger: null, selection: { kind: "node", id: entry.id },
            actions: () => cardActions(info.card, canMove ? { up: order().indexOf(entry.id) > 0 ? () => place(-1) : null,
              down: order().indexOf(entry.id) < order().length - 1 ? () => place(1) : null } : null, scope) };
          if (spec.actions().length) {
            makeMore(tools, spec);
            control.setAttribute("aria-keyshortcuts", "Shift+F10");
            attachMenu(wrap, control, spec);
          }
          if (hasModule) {
            const open = button(wrap, "打开模块图 ↓", () => options.onStructureBranch?.(info.card.id, scope), "research-snode-drill");
            open.dataset.openModule = info.card.id;
            open.setAttribute("aria-label", `打开「${info.name}」的模块图`);
            open.dataset.focusKey = `d:${entry.id}`;
            inlineToggle(surface, wrap, info, `/${entry.id}`, new Set([scope]));
          }
          control.addEventListener("mouseenter", () => highlight(surface, entry.id));
          control.addEventListener("focus", () => highlight(surface, entry.id));
          control.addEventListener("mouseleave", () => highlight(surface));
          control.addEventListener("blur", () => highlight(surface));
          control.addEventListener("keydown", event => {
            const arrows = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];
            if (!arrows.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
            let target;
            if (event.key === "ArrowRight") target = model.links.find(link => link.from === entry.id)?.to;
            else if (event.key === "ArrowLeft") target = model.links.find(link => link.to === entry.id)?.from;
            else {
              const siblings = [...column.querySelectorAll(".research-snode")].filter(node =>
                node.closest(".research-structure-chart") === surface.chart);
              target = siblings[siblings.indexOf(control) + (event.key === "ArrowDown" ? 1 : -1)]?.dataset.node;
            }
            if (!target) return;
            event.preventDefault();
            buttons.get(target)?.focus();
          });
        }
      }
      return column;
    });
    /* Reading pane: a reserved right column on wide screens, a non-modal bottom sheet on narrow ones. */
    const aside = add(layout, "aside", "research-structure-pane");
    aside.setAttribute("role", "region");
    const bar = add(aside, "div", "research-structure-pane-bar");
    const barTitle = add(bar, "strong", "", "卡片详情");
    let opener = null;
    const setSheet = (open, restore) => {
      const was = aside.classList.contains("is-open");
      aside.classList.toggle("is-open", open);
      section.classList.toggle("has-sheet", open);
      mounted.sheetOpen = open;
      if (!open && was && restore) {
        const back = opener?.isConnected ? opener : buttons.get(structureSelection?.id);
        back?.focus({ preventScroll: true });
      }
    };
    mounted.closeSheet = () => setSheet(false, false);
    const closeSheet = button(bar, "✕", () => setSheet(false, true), "research-structure-pane-close");
    closeSheet.setAttribute("aria-label", "关闭卡片详情");
    closeSheet.title = "关闭详情（Esc）";
    const detail = add(aside, "div", "research-structure-detail");
    detail.setAttribute("aria-live", "polite");
    mounted.effects = new AbortController();
    const { signal } = mounted.effects;
    let fitting = false;
    const fitPane = () => {
      if (narrowQuery?.matches || !layout.isConnected) return;
      const stacked = workspace.childElementCount > 1;
      if (stacked && aside.style.getPropertyValue("--structure-pane-height")) return;
      const top = stacked ? 128 : Math.max(12, layout.getBoundingClientRect().top);
      aside.style.setProperty("--structure-pane-height", `${Math.max(148, Math.floor(window.innerHeight - top - 12))}px`);
    };
    const scheduleFit = () => {
      if (fitting || narrowQuery?.matches) return;
      fitting = true;
      requestAnimationFrame(() => { fitting = false; fitPane(); });
    };
    window.addEventListener("scroll", scheduleFit, { passive: true, signal });
    window.addEventListener("resize", scheduleFit, { signal });
    const onSheetKey = event => {
      if (event.key !== "Escape" || event.defaultPrevented || !aside.isConnected || !aside.classList.contains("is-open")) return;
      if (menu || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setSheet(false, true);
    };
    document.addEventListener("keydown", onSheetKey, { signal });
    let showSelection = false;
    let selectedSurface = surface;
    /* Hover or focus lights a node's links; otherwise the current selection stays lit. */
    function highlight(target, id) {
      const selected = showSelection && selectedSurface === target && structureSelection;
      const lit = id ? element => element.dataset.from === id || element.dataset.to === id
        : selected?.kind === "node" ? element => element.dataset.from === selected.id || element.dataset.to === selected.id
          : selected?.kind === "link" ? element => element.dataset.from === selected.from && element.dataset.to === selected.to
            : () => false;
      let any = false;
      for (const element of target.layer.querySelectorAll("[data-from]")) {
        const on = lit(element);
        any ||= on;
        element.classList.toggle("is-lit", on);
      }
      target.chart.classList.toggle("has-focus", any);
    }
    function selectOn(target, value, emphasize = true, openDetails = emphasize) {
      const { model, buttons } = target;
      const previousSurface = selectedSurface;
      if (previousSurface !== target) {
        for (const control of previousSurface.buttons.values()) control.setAttribute("aria-pressed", "false");
      }
      selectedSurface = target;
      showSelection = emphasize;
      mounted.selection = structureSelection = { ...value, scope: model.key };
      mounted.card = value.kind === "link" ? model.links.find(link => link.from === value.from && link.to === value.to)?.evidence || null
        : value.cardId || model.info.get(value.id)?.card.id || null;
      for (const [id, control] of buttons) {
        control.setAttribute("aria-pressed", String(value.kind === "node" && value.id === id));
      }
      renderStructureDetail(detail, model, nodes, structureSelection, scope);
      const name = detail.querySelector("h3")?.textContent.trim();
      barTitle.textContent = name ? `卡片详情 · ${name}` : "卡片详情";
      aside.setAttribute("aria-label", barTitle.textContent);
      if (openDetails && narrowQuery?.matches) {
        const active = document.activeElement;
        if (!aside.contains(active)) {
          opener = active && section.contains(active) ? active : buttons.get(value.id || value.from) || opener;
        }
        setSheet(true);
      }
      aside.scrollTop = 0;
      highlight(previousSurface);
      if (target !== previousSurface) highlight(target);
      if (emphasize) {
        if (mounted === currentEntry) handoffCard = mounted.card;
        options.onFocus?.(mounted.card, scope);
      }
    }
    model.select = (value, emphasize, openDetails) => selectOn(surface, value, emphasize, openDetails);
    const linkedSelection = structureSelection?.kind === "link" && structureSelection.scope === scope && model.links.find(link =>
      link.from === structureSelection.from && link.to === structureSelection.to && (link.evidence || null) === mounted.card);
    const selectedCard = nodes.find(node => node.id === (mounted.card || (compact ? scope : null)) && node.id !== "board");
    const ancestors = selectedCard ? pathFor(selectedCard.id, nodes).reverse() : [];
    const mapped = ancestors.map(ancestor => [...model.info.values()].find(info => info.card.id === ancestor.id)).find(Boolean);
    const relations = model.links.length && add(section, "details", "research-sources research-proof research-structure-relations");
    if (relations) {
      add(relations, "summary", "", `全部关系 · ${model.links.length} 条`);
      relations.open = Boolean(narrowQuery?.matches);
      const list = add(relations, "ol", "research-structure-relation-list");
      for (const link of model.links) {
        const row = add(list, "li");
        row.dataset.kind = link.kind;
        button(row, model.info.get(link.from).name, () => model.select({ kind: "node", id: link.from }), "research-card-title");
        row.append(document.createTextNode(` → `));
        button(row, model.info.get(link.to).name, () => model.select({ kind: "node", id: link.to }), "research-card-title");
        add(row, "span", "research-muted research-small", ` · ${link.label} · ${kindNames[link.kind]}`);
        if (link.evidence) button(row, "查看证据", () => model.select({ kind: "link", from: link.from, to: link.to }), "research-path-button");
      }
    }
    const shown = new Set([...model.info.values()].map(info => info.card.id));
    const other = children(scope, nodes).filter(item => !shown.has(item.id));
    if (other.length) {
      const details = add(section, "details", "research-sources research-proof");
      add(details, "summary", "", `其他资料 · ${other.length} 张`);
      const list = add(details, "ul", "research-structure-relation-list");
      for (const card of other) {
        labelled(button(add(list, "li"), "", () => options.onStructureBranch?.(card.id, scope), "research-card-title"), card);
      }
    }
    const selection = linkedSelection ? structureSelection : selectedCard
      ? { kind: "node", id: mapped?.node.id, cardId: selectedCard.id }
      : { kind: "node", id: model.zones[0].nodes[0].id };
    model.select(selection, false);
    if (narrowQuery?.matches && mounted.sheetOpen) {
      setSheet(true);
      aside.scrollTop = 0;
    }
    const camera = structureCamera(scroller, world, stage, controls, scope);
    mounted.camera = camera;
    const paint = target => {
      drawStructure(target.chart, target.layer, target.model, target.buttons, camera.scale());
      highlight(target);
      for (const { child } of target.expanded.values()) paint(child);
    };
    const redraw = () => {
      measureExpandedChart(surface);
      camera.measure();
      paint(surface);
      fitPane();
    };
    redraw();
    for (const restore of restoreExpansions) restore();
    if (!diagramViews.has(scope) && mounted.card && selectedCard?.opinionChild && mapped?.card.id === mounted.card) {
      revealDiagramCard(mounted.card, false);
    }
    if (typeof ResizeObserver === "function") {
      mounted.observer = new ResizeObserver(() => { if (stage.isConnected) redraw(); });
      mounted.observer.observe(stage);
      mounted.observer.observe(scroller);
    }
    document.fonts?.ready?.then(() => { if (stage.isConnected) redraw(); });
    // Keep the page position and keyboard focus when the current module is re-rendered.
    if (savedY != null && window.scrollY !== savedY) window.scrollTo(window.scrollX, savedY);
    fitPane();
    if (restoreKey) focusByKey(section, restoreKey)?.focus({ preventScroll: true });
    savedY = restoreKey = mounted.pendingFocus = null;
  }
  narrowQuery?.addEventListener?.("change", () => {
    if (!active) return;
    for (const entry of entries.values()) {
      entry.closeSheet?.();
      entry.signature = null;
    }
    options.onResize?.();
  });

  function render(preferStructure = false) {
    if (!container || !active) return;
    const mounted = currentEntry;
    closeMenu(false);
    mounted.observer?.disconnect();
    mounted.effects?.abort();
    const nodes = items();
    let node = nodes.find(item => item.id === rootId);
    let removed = false;
    if (!node) {
      removed = Boolean(rootId);
      node = [...lastPath].reverse().map(id => nodes.find(item => item.id === id)).find(Boolean) ||
        nodes.find(item => !nodes.some(parent => parent.id === item.parentId)) || nodes[0];
      rootId = node?.id || null;
    }
    const oldScroller = container.querySelector(".research-structure-scroll");
    const previousScope = oldScroller?.closest("[data-diagram-root]")?.dataset.diagramRoot;
    if (previousScope && mounted.camera) diagramViews.set(previousScope, mounted.camera.read());
    mounted.camera = null;
    mounted.closeSheet = null;
    savedY = previousScope === rootId ? window.scrollY : null;
    restoreKey = mounted.pendingFocus || (previousScope === rootId && container.contains(document.activeElement)
      ? document.activeElement.dataset?.focusKey || null : null);
    container.replaceChildren();
    const path = node ? pathFor(node.id, nodes) : [];
    lastPath = path.map(item => item.id);
    const structure = node ? diagramFor(node.id, nodes) : null;
    const compact = Boolean(structure && options.compactWorkspace?.());
    container.classList.toggle("research-compact", compact);
    if (compact) view = "structure";
    /* The path starts at the real or virtual root, so a single root is never listed twice. */
    if (path.length > 1 && mounted.first) {
      const breadcrumb = add(container, "nav", "research-breadcrumb");
      breadcrumb.setAttribute("aria-label", "阅读路径");
      const trail = !compact ? path : path.length > 3 ? [path[0], path.at(-2)] : path.slice(0, -1);
      trail.forEach((item, index) => {
        if (index) add(breadcrumb, "span", "research-muted", "›").setAttribute("aria-hidden", "true");
        const link = button(breadcrumb, title(item), () => {
          if (mounted.panel === "structure") options.onStructureNavigate?.(item.id);
          else enter(item.id);
        }, "research-path-button");
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
    if (mode && !compact) add(intro, "span", "research-kicker", kickers[mode.kind]);
    const name = add(intro, "h2");
    if (node) labelled(name, node);
    else name.textContent = options.title || "白板";
    name.tabIndex = -1;
    if (lead) add(intro, "p", mode ? "research-lead" : "research-muted", lead);
    if (mode && feature && !compact) add(intro, "p", "research-muted research-small", `适合：${feature.audience}`);
    const controls = add(heading, "div", "research-heading-actions");
    if (view !== "structure" && mode && typeof options.onAsk === "function" && (mode.kind === "feature" || mode.kind === "scene")) {
      button(controls, mode.kind === "feature" ? "问这项功能" : "问这个场景",
        () => options.onAsk(node.id), "research-button research-ask");
    }
    if (path.length > 1 && !compact && mounted.first) button(controls, "返回上一级", () => {
      if (mounted.panel === "structure") options.onStructureNavigate?.(path.at(-2).id);
      else enter(path.at(-2).id);
    });
    if (view !== "structure" && !options.getStructure?.()) button(controls, "编辑画布", () => options.onLocate?.(node?.id));
    if (!node) {
      add(container, "p", "research-description", "画布还没有卡片，先在编辑画布中写下第一张卡片。");
      return;
    }
    if (compact) {
      renderStructure(add(container, "div", "research-content-plain"), nodes, structure);
      signature = contentSignature(nodes);
      return;
    }
    const members = scope(node.id, nodes);
    const comparisons = members.filter(item => experiment(item).comparison);
    const hasPictures = members.some(item => images(item).length);
    const direct = children(node.id, nodes);
    // The structure belongs to one card (default: the project root). Only that card offers it.
    if (structure?.authored && !autoOpened.has(node.id)) {
      autoOpened.add(node.id);
      if (view === "board" && preferStructure) view = "structure";
    }
    const labels = { structure: "模块关系图", board: mode ? boardLabels[mode.kind] : feature ? "功能概览" : comparisons.length ? "实验板" : "主题概览",
      flow: "流程与分组", graph: "关系导图", comparison: "对比结果", evidence: "证据图片" };
    const available = views.filter(id => id === "board" || (id === "structure" && structure) || (id === "graph" && (!mode || direct.length)) ||
      (id === "flow" && (direct.length || node.flowSteps?.length)) ||
      (id === "comparison" && comparisons.length) || (id === "evidence" && hasPictures));
    if (!available.includes(view)) view = "board";
    const tabs = available.length > 1 ? add(container, "nav", "research-tabs") : null;
    tabs?.setAttribute("aria-label", "阅读视图");
    tabs?.setAttribute("role", "tablist");
    const suffix = mounted.first ? "" : "-" + node.id;
    for (const id of tabs ? available : []) {
      const tab = button(tabs, labels[id], () => {
        options.onPanel?.(id, mounted.root);
        mounted.body.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      }, "research-tab");
      tab.id = `research-tab-${id}${suffix}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(id === view));
      tab.setAttribute("aria-controls", `research-content${suffix}`);
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
    content.id = `research-content${suffix}`;
    if (tabs) {
      content.setAttribute("role", "tabpanel");
      content.setAttribute("aria-labelledby", `research-tab-${view}${suffix}`);
    } else content.classList.add("research-content-plain");
    if (view === "structure") renderStructure(content, nodes, structure);
    else if (view === "board" && mode) renderReading(content, node, nodes, mode, lead);
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
    } else if (view === "flow") renderFlow(content, node, nodes);
    else if (view === "graph") renderGraph(content, node, nodes);
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
    signature = contentSignature(nodes);
  }
  function init(settings) {
    options = settings;
    workspace = document.getElementById("research-workspace");
    if (!workspace) return;
    if (!initialized) {
      const dialog = add(document.body, "dialog", "research-image-dialog");
      dialog.id = "research-image-dialog";
      const heading = add(dialog, "header");
      add(heading, "h2");
      button(heading, "关闭原图", () => dialog.close());
      add(dialog, "img");
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      initialized = true;
    }
  }
  const projection = () => ({ readingRoot: rootId, panel: view, card: handoffCard });
  const contentSignature = nodes => JSON.stringify([nodes, options.getStructure?.(), options.getModuleDiagrams?.()]);
  function activate(id) {
    const entry = entries.get(id);
    if (!entry?.el.isConnected) return;
    if (currentEntry !== entry) {
      currentEntry?.closeSheet?.();
      currentEntry?.el.classList.remove("is-active");
    }
    currentEntry = entry;
    entry.el.classList.add("is-active");
    container = entry.body;
    rootId = entry.root;
    view = entry.panel;
    handoffCard = entry.card;
  }
  function moduleEntry(id) {
    let entry = entries.get(id);
    if (!entry) {
      const el = document.createElement("article");
      el.className = "research-module-board";
      el.dataset.moduleRoot = id || "";
      const bridge = add(el, "nav", "research-module-bridge");
      bridge.setAttribute("aria-label", "模块路径");
      const body = add(el, "div", "research-module-content");
      entry = { root: id, panel: "structure", card: null, el, bridge, body };
      entries.set(id, entry);
    }
    return entry;
  }
  function updateModuleGuides(ordered, byId) {
    ordered.forEach((entry, index) => {
      const { bridge, body } = entry;
      const above = ordered[index - 1];
      const below = ordered[index + 1];
      const name = byId.get(entry.root);
      if (name) entry.el.setAttribute("aria-label", `模块图 · ${title(name)}`);
      bridge.hidden = !above;
      bridge.replaceChildren();
      if (above) {
        const parent = byId.get(above.root);
        button(bridge, `↑ ${title(parent)}`, () => options.onStructureNavigate?.(above.root), "research-path-button");
        add(bridge, "span", "research-module-arrow", "↓").setAttribute("aria-hidden", "true");
        button(bridge, title(name), () => options.onStructureNavigate?.(entry.root), "research-path-button research-module-destination");
      }
      for (const control of body.querySelectorAll("[data-open-module]")) {
        const follows = below?.root === control.dataset.openModule;
        control.textContent = follows ? "跳到模块图 ↓" : "打开模块图 ↓";
        control.classList.toggle("is-followed", follows);
      }
    });
  }
  function show(reader, preferStructure, path = []) {
    active = true;
    const nodes = items();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const selected = byId.has(reader.readingRoot) ? reader.readingRoot
      : [...lastPath].reverse().find(id => byId.has(id)) || structureRoot(nodes) || nodes[0]?.id || null;
    const roots = path.includes(selected) ? path.filter(id => byId.has(id)) : [selected];
    const ordered = roots.map(moduleEntry);
    for (const el of [...workspace.children]) {
      if (!ordered.some(entry => entry.el === el)) el.remove();
    }
    ordered.forEach((entry, index) => {
      if (workspace.children[index] !== entry.el) workspace.insertBefore(entry.el, workspace.children[index] || null);
    });
    const nextSignature = contentSignature(nodes);
    for (const entry of ordered) {
      const isSelected = entry.root === selected;
      const panel = isSelected && views.includes(reader.panel) ? reader.panel : "structure";
      const card = isSelected && reader.card != null ? reader.card : entry.card;
      const first = entry === ordered[0];
      if (entry.signature === nextSignature && entry.panel === panel && entry.card === card && entry.first === first) continue;
      entry.panel = panel;
      entry.card = card;
      entry.first = first;
      activate(entry.root);
      render(preferStructure);
      entry.panel = view;
      entry.signature = nextSignature;
    }
    activate(selected);
    updateModuleGuides(ordered, byId);
    const first = ordered[0]?.body;
    placeProjectTools(first?.classList.contains("research-compact") ? first.querySelector(".research-heading-actions") : undefined);
    signature = nextSignature;
    return projection();
  }
  function hide() {
    active = false;
    closeMenu(false);
    placeProjectTools();
    for (const entry of entries.values()) {
      if (entry.camera && entry.el.isConnected) diagramViews.set(entry.root, entry.camera.read());
      entry.observer?.disconnect();
      entry.effects?.abort();
    }
    workspace.replaceChildren();
    entries.clear();
    currentEntry = container = null;
  }
  function refresh(nodes) {
    if (!active || (currentEntry?.signature != null && contentSignature(nodes) === signature)) return;
    return show(projection(), false, [...workspace.children].map(el => el.dataset.moduleRoot));
  }
  function openPath() { return [...workspace.children].map(el => el.dataset.moduleRoot).filter(Boolean); }
  function focusHeading(smooth = false) {
    container.querySelector("h2")?.focus({ preventScroll: true });
    currentEntry.el.scrollIntoView({ block: "start",
      behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
  }
  function revealDiagramCard(id, focus = true) {
    const frame = container.querySelector(".research-structure-scroll");
    const button = frame?.querySelector(`.research-snode[data-card-id="${CSS.escape(id)}"]`);
    if (!button) return;
    const view = frame.getBoundingClientRect();
    const card = button.getBoundingClientRect();
    if (card.left < view.left || card.right > view.right) frame.scrollLeft += (card.left + card.right - view.left - view.right) / 2;
    if (card.top < view.top || card.bottom > view.bottom) frame.scrollTop += (card.top + card.bottom - view.top - view.bottom) / 2;
    if (focus) button.focus({ preventScroll: true });
  }
  window.BoardResearch = { init, show, hide, refresh, items, focusHeading, revealDiagramCard, structureRoot, activate,
    cardAt: id => entries.get(id)?.card, openPath,
    get active() { return active; } };
})();
