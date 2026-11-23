/* Portable document data only. Provider settings and local project bindings are
 * deliberately outside this format. Attachments remain local references. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BoardTransfer = api;
})(typeof window === "object" ? window : null, () => {
  "use strict";
  const FORMAT = "circle-ask-whiteboard";
  const VERSION = 1;
  const MAX_BYTES = 24 * 1024 * 1024;
  const nodeId = /^[EA]\d+$/;
  const noteId = /^A\d+$/;
  const modes = new Set(["compact", "horizontal", "balanced", "adaptive"]);
  const categories = new Set(["main", "done", "optimize", "reference", "archive"]);
  const sourceFiles = new Set(["index.html", "styles.css", "app.js", "geometry.js", "memory.js", "organization.js", "run_gate.js",
    "experiment_data.js", "capability_data.js", "research_board.js", "research_board.css",
    "project_finder.js", "server.py", "zcode_backend.py", "zcode_workspace.py", "attachments.py", "backends.py", "api_backend.py",
    "board_tools.py", "local_projects.py", "board_transfer.js", "board_store.py", "board_sync.js", "board_versions.js"]);
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function fail(message) { throw new Error(`白板文件无效：${message}`); }
  function object(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field}应为对象。`);
    return value;
  }
  function array(value, field, maximum = Infinity, minimum = 0) {
    if (!Array.isArray(value)) fail(`${field}应为列表。`);
    if (value.length < minimum || value.length > maximum) fail(`${field}的数量应在 ${minimum} 至 ${maximum} 项之间。`);
    return value;
  }
  function string(value, field, limit = MAX_BYTES) {
    if (typeof value !== "string" || value.length > limit) fail(`${field}不是有效文本。`);
    return value;
  }
  function id(value, field, { board = false, note = false } = {}) {
    if (typeof value !== "string" || (!(note ? noteId : nodeId).test(value) && !(board && value === "board"))) {
      fail(`${field}的卡片编号无效。`);
    }
    return value;
  }
  function ids(value, field, options) {
    const values = array(value, field, options?.limit ?? Infinity).map(entry => id(entry, field, options));
    if (new Set(values).size !== values.length) fail(`${field}包含重复编号。`);
    return values;
  }
  function trimmed(value, field, limit, nonempty = false) {
    const result = string(value, field).trim();
    if (Array.from(result).length > limit) fail(`${field}最多 ${limit} 字，避免导入后内容被截断。`);
    if (nonempty && !result) fail(`${field}不能为空。`);
    return result;
  }
  function files(value, field) {
    const entries = strings(value, field);
    if (new Set(entries).size !== entries.length || entries.some(entry => !sourceFiles.has(entry))) fail(`${field}包含重复或不支持的文件。`);
    return entries;
  }
  function repositoryFile(value) {
    const result = string(value, "仓库文件路径", 300);
    if (!/^[\p{L}\p{N}\p{M}_ .()\[\]@+/-]+$/u.test(result) ||
        result.split("/").some(part => !part || part === "." || part === "..")) fail("仓库文件路径无效，请使用仓库内相对路径。");
    return result;
  }
  function optionalText(source, target, key, limit) {
    if (owns(source, key)) target[key] = string(source[key], key, limit);
  }
  function optionalBoolean(source, target, key) {
    if (!owns(source, key)) return;
    if (typeof source[key] !== "boolean") fail(`${key}应为布尔值。`);
    target[key] = source[key];
  }
  function rectangle(value, field) {
    object(value, field);
    const result = {};
    for (const key of ["x", "y", "width", "height"]) {
      const number = value[key];
      if (!Number.isFinite(number) || Math.abs(number) > 1e6 || (["width", "height"].includes(key) && number < 0)) {
        fail(`${field}的坐标或尺寸无效。`);
      }
      result[key] = number;
    }
    return result;
  }
  function positions(value = {}) {
    object(value, "卡片位置");
    return Object.fromEntries(Object.entries(value).map(([key, point]) => {
      id(key, "卡片位置");
      object(point, "卡片位置");
      if (![point.x, point.y].every(number => Number.isFinite(number) && Math.abs(number) <= 1e6)) {
        fail("卡片位置的坐标无效。");
      }
      const result = { x: point.x, y: point.y };
      if (owns(point, "width")) {
        if (!Number.isFinite(point.width) || point.width <= 0 || point.width > 10000) fail("卡片宽度无效。");
        result.width = point.width;
      }
      return [key, result];
    }));
  }
  function attachments(value = []) {
    const entries = array(value, "附件", 16).map(entry => {
      object(entry, "附件");
      if (typeof entry.id !== "string" || !/^[a-f0-9]{32}$/.test(entry.id) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > 10 * 1024 * 1024) {
        fail("附件编号或大小无效。");
      }
      const name = string(entry.name, "附件名称", 200);
      if (!name.trim()) fail("附件名称不能为空。");
      return { id: entry.id, name, size: entry.size };
    });
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail("附件包含重复编号。");
    return entries;
  }
  function strings(value, field) { return array(value, field).map(entry => string(entry, field)); }
  function card(value) {
    object(value, "卡片");
    const result = {
      id: id(value.id, "卡片"),
      parentId: value.parentId == null ? null : id(value.parentId, "父节点"),
      title: trimmed(value.title, "卡片标题", 100, true),
      summary: trimmed(value.summary, "卡片正文", 800),
      category: value.category,
    };
    if (!categories.has(result.category)) fail("卡片类型无效。");
    if (owns(value, "sources")) result.sources = files(value.sources, "来源文件");
    if (owns(value, "repositoryFiles")) {
      result.repositoryFiles = array(value.repositoryFiles, "仓库文件", 12).map(repositoryFile);
      if (new Set(result.repositoryFiles).size !== result.repositoryFiles.length) fail("仓库文件包含重复路径。");
    }
    if (owns(value, "attachments")) result.attachments = attachments(value.attachments);
    if (owns(value, "experiment")) {
      const schema = typeof module === "object" && module.exports
        ? require("./experiment_data.js") : window.ExperimentData;
      if (!schema) fail("缺少实验资料校验器。");
      result.experiment = schema.validate(value.experiment);
    }
    if (owns(value, "capability")) {
      const schema = typeof module === "object" && module.exports
        ? require("./capability_data.js") : window.CapabilityData;
      if (!schema) fail("缺少功能说明校验器。");
      result.capability = schema.validate(value.capability);
    }
    if (owns(value, "flowSteps")) {
      const steps = array(value.flowSteps, "流程步骤", 12, 2).map(step => id(step, "流程卡片"));
      if (steps.includes(result.id) || new Set(steps).size !== steps.length) fail("流程卡片必须互异且不能引用自身。");
      result.flowSteps = steps;
    }
    for (const key of ["draft", "explicitParent", "nativeFace", "localContent", "folded"]) optionalBoolean(value, result, key);
    if (owns(value, "side")) {
      if (!["auto", "left", "right"].includes(value.side)) fail("卡片展开方向无效。");
      result.side = value.side;
    }
    if (owns(value, "taskDetails")) {
      const task = object(value.taskDetails, "任务细节");
      result.taskDetails = { task: trimmed(task.task, "任务说明", 500, true),
        dependencies: array(task.dependencies, "任务依赖", 5).map(entry => trimmed(entry, "任务依赖", 180, true)),
        acceptance: array(task.acceptance, "验收标准", 5, 1).map(entry => trimmed(entry, "验收标准", 180, true)) };
    }
    if (owns(value, "spec")) {
      const spec = object(value.spec, "需求资料");
      if (!["requirement", "case", "constraint"].includes(spec.kind)) fail("需求资料类型无效。");
      result.spec = { kind: spec.kind, id: string(spec.id, "需求编号", 48) };
      if (!/^[A-Z][A-Z0-9-]{2,47}$/.test(result.spec.id)) fail("需求编号格式无效。");
      if (spec.kind === "case") {
        if (owns(spec, "status")) {
          if (!["pending", "mock-pass", "offline-pass"].includes(spec.status)) fail("测试状态无效。");
          result.spec.status = spec.status;
        }
        if (owns(spec, "runner")) result.spec.runner = trimmed(spec.runner, "测试入口", 220);
      }
    }
    if (owns(value, "codePreview")) {
      const preview = object(value.codePreview, "代码摘要");
      result.codePreview = { path: repositoryFile(preview.path), text: string(preview.text, "代码摘要", 1400) };
      if (!result.codePreview.text.trim()) fail("代码摘要不能为空。");
    }
    return result;
  }
  function cards(value, field) {
    const result = array(value, field).map(card);
    if (new Set(result.map(entry => entry.id)).size !== result.length) fail(`${field}包含重复卡片编号。`);
    return result;
  }
  function plan(value) {
    object(value, "白板结构");
    const layout = object(value.layout || { flow: "columns", density: "normal" }, "排布设置");
    if (!["columns", "vertical", "horizontal"].includes(layout.flow) || !["compact", "normal", "spacious"].includes(layout.density)) {
      fail("排布设置无效。");
    }
    const result = { title: trimmed(value.title ?? "白板整理", "结构标题", 120, true), summary: trimmed(value.summary ?? "", "结构摘要", 1600),
      layout: { flow: layout.flow, density: layout.density }, items: cards(value.items, "白板结构"),
      positions: positions(value.positions), collapsedBranches: ids(value.collapsedBranches || [], "收起节点") };
    if (owns(value, "projectGuide")) {
      const guide = object(value.projectGuide, "项目根节点");
      if (![guide.x, guide.y].every(number => Number.isFinite(number) && Math.abs(number) <= 1e6)) fail("项目根坐标无效。");
      result.projectGuide = { rootId: id(guide.rootId, "项目根节点"), x: guide.x, y: guide.y };
    }
    if (owns(value, "branchLayouts")) result.branchLayouts = ids(value.branchLayouts, "分支排布");
    return result;
  }
  function payload(value) {
    object(value, "提问记录");
    const anchor = object(value.anchor, "选区");
    const result = { boardId: string(value.boardId ?? "", "白板编号", 80), question: string(value.question, "问题", 1000).trim(),
      anchor: { elementIds: ids(anchor.elementIds, "选区", { board: true, limit: 24 }),
        box: rectangle(anchor.box, "选区"), quote: string(anchor.quote ?? "", "选区摘录", 600) } };
    if (!result.question) fail("问题不能为空。");
    if (!result.anchor.elementIds.length) fail("选区至少需要一个卡片或整板引用。");
    if (owns(anchor, "wholeCardIds")) result.anchor.wholeCardIds = ids(anchor.wholeCardIds, "完整卡片选区", { limit: 24 });
    if (owns(anchor, "sourceFiles")) result.anchor.sourceFiles = files(anchor.sourceFiles, "来源文件");
    if (owns(anchor, "formulaFragments")) result.anchor.formulaFragments = array(anchor.formulaFragments, "公式片段", 24).map(fragment => ({
      elementId: id(fragment.elementId, "公式片段"), quote: string(fragment.quote, "公式摘录", 600), source: string(fragment.source, "公式来源", 1000) }));
    if (owns(anchor, "noteContexts")) result.anchor.noteContexts = array(anchor.noteContexts, "引用讨论", 24).map(context => ({
      elementId: id(context.elementId, "引用讨论"), originalQuestion: string(context.originalQuestion, "原问题", 1000),
      sourceCardIds: ids(context.sourceCardIds || [], "原问题来源", { board: true, limit: 24 }) }));
    if (owns(value, "attachments")) result.attachments = attachments(value.attachments);
    if (owns(value, "mode")) {
      if (!["ask", "edit"].includes(value.mode)) fail("历史提问模式无效。");
      result.mode = value.mode;
    }
    if (owns(value, "scope")) {
      if (!["extend", "explain", "independent"].includes(value.scope)) fail("历史提问范围无效。");
      result.scope = value.scope;
    }
    if (owns(value, "minimumDepth")) {
      if (value.scope !== "explain" || value.minimumDepth !== 2) fail("多级拆分深度或范围无效。");
      result.minimumDepth = 2;
    }
    if (owns(value, "sourceAnswer")) {
      if (value.scope !== "explain") fail("原回答只可用于拆分记录。");
      result.sourceAnswer = { question: string(value.sourceAnswer.question, "原回答问题", 1000),
        answer: string(value.sourceAnswer.answer, "原回答", 16000) };
    }
    if (owns(value, "revisionContext")) result.revisionContext = {
      elementId: id(value.revisionContext.elementId, "修订引用", { board: true }), quote: string(value.revisionContext.quote, "修订摘录", 600) };
    return result;
  }
  function note(value) {
    object(value, "回答卡");
    if (!["note", "branch"].includes(value.kind ?? "note")) fail("回答卡类型无效。");
    const result = { id: id(value.id, "回答卡", { note: true }), kind: value.kind || "note",
      branchId: value.branchId == null ? null : id(value.branchId, "讨论分支", { note: true }),
      archived: value.archived === true, rect: rectangle(value.rect, "回答卡"), payload: payload(value.payload),
      sourceCardIds: ids(value.sourceCardIds || [], "回答来源", { board: true, limit: 24 }),
      answer: string(value.answer, "回答正文", 16000), anchors: array(value.anchors || [], "回答锚点", 24).map(entry => rectangle(entry, "回答锚点")) };
    if (owns(value, "delivery")) {
      if (!["pending", "failed", "stopped", "interrupted"].includes(value.delivery)) fail("回答发送状态无效。");
      result.delivery = value.delivery === "pending" ? "interrupted" : value.delivery;
      optionalText(value, result, "deliveryMessage", 1000);
    }
    if (owns(value, "retryPayload")) {
      if (!result.delivery) fail("重试记录缺少发送状态。");
      result.retryPayload = payload(value.retryPayload);
    }
    if (owns(value, "sectionOf")) {
      result.sectionOf = id(value.sectionOf, "回答总览", { note: true });
      if (result.sectionOf === result.id || !result.payload.anchor.elementIds.includes(result.sectionOf)) fail("回答下级缺少对应的总览引用。");
    }
    for (const key of ["outline", "outlineCollapsed"]) optionalBoolean(value, result, key);
    if ((owns(value, "originalAnswer") || owns(value, "outlineCollapsed")) && !result.outline) fail("原回答或折叠状态缺少回答总览标记。");
    optionalText(value, result, "originalAnswer", 16000);
    return result;
  }
  function normalizeMemory(value) {
    object(value, "白板记忆");
    const project = object(value.project || {}, "项目说明");
    const result = { project: { goal: string(project.goal ?? "", "项目目标", 800),
      constraints: array(project.constraints || [], "项目约束", 24).map(entry => {
        const text = string(entry, "项目约束", 300).trim();
        if (!text) fail("项目约束不能为空。");
        return text;
      }),
      decisions: array(project.decisions || [], "确认决定").map(decision => {
        const text = string(decision.text, "确认决定", 700).trim();
        if (!text) fail("确认决定不能为空。");
        return { text, sourceIds: ids(decision.sourceIds || [], "决定引用", { board: true, limit: 24 }) };
      }) },
      notes: array(value.notes || [], "回答记录").map(note), pinnedIds: ids(value.pinnedIds || [], "固定卡片"),
      deletedIds: ids(value.deletedIds || [], "已删除卡片"), pendingRepair: "" };
    if (new Set(result.notes.map(entry => entry.id)).size !== result.notes.length) fail("回答记录包含重复卡片编号。");
    return result;
  }
  function normalizeOrganization(value) {
    object(value, "白板排布");
    const result = { current: value.current == null ? null : plan(value.current), previous: null, undoAvailable: false,
      opinion: string(value.opinion ?? "", "整理意见", 1200), rawPositions: positions(value.rawPositions), rawCompact: value.rawCompact === true,
      quickUndo: null, appliedGuideId: "" };
    if (owns(value, "rawCards")) {
      result.rawCards = cards(value.rawCards, "原始卡片");
      if (result.rawCards.some(entry => !entry.id.startsWith("E"))) fail("原始卡片列表只支持模块卡，讨论卡请存入回答记录。");
    }
    if (owns(value, "rawCollapsedBranches")) result.rawCollapsedBranches = ids(value.rawCollapsedBranches, "原始收起节点");
    if (owns(value, "quickMode")) {
      if (!modes.has(value.quickMode)) fail("快速排布方式无效。");
      result.quickMode = value.quickMode;
    }
    if (owns(value, "branchQuickModes")) {
      object(value.branchQuickModes, "分支排布方式");
      result.branchQuickModes = Object.fromEntries(Object.entries(value.branchQuickModes).map(([key, mode]) => {
        if (!modes.has(mode)) fail("分支快速排布方式无效。");
        return [id(key, "分支排布方式"), mode];
      }));
    }
    if (owns(value, "rawLinks")) {
      object(value.rawLinks, "手动连接");
      result.rawLinks = Object.fromEntries(Object.entries(value.rawLinks).map(([key, parents]) =>
        [id(key, "手动连接"), ids(parents, "手动连接")]));
    }
    return result;
  }
  function validateGraph(memory, organization) {
    const primary = organization.current?.items || organization.rawCards || [];
    const noteIds = new Set(memory.notes.map(entry => entry.id));
    if (primary.some(entry => entry.id.startsWith("A") && !noteIds.has(entry.id))) {
      fail("讨论卡缺少对应的回答记录，导入后无法显示。");
    }
    const present = new Set([...primary.map(entry => entry.id), ...memory.notes.map(entry => entry.id)]);
    const historical = new Set([...present, ...memory.deletedIds, "board"]);
    const checkReference = (reference, field, past = false) => {
      if (reference != null && !(past ? historical : present).has(reference)) fail(`${field}引用了不存在的卡片 ${reference}。`);
    };
    const edges = new Map(primary.map(entry => [entry.id, entry.parentId ? [entry.parentId] : []]));
    for (const entry of primary) if (entry.parentId) checkReference(entry.parentId, "父节点");
    for (const entry of memory.notes) {
      if (!edges.has(entry.id)) edges.set(entry.id, entry.payload.anchor.elementIds.filter(reference => present.has(reference)));
      for (const question of [entry.payload, entry.retryPayload].filter(Boolean)) {
        question.anchor.elementIds.forEach(reference => checkReference(reference, "选区", true));
        question.anchor.wholeCardIds?.forEach(reference => {
          checkReference(reference, "完整卡片选区", true);
          if (!question.anchor.elementIds.includes(reference)) fail("完整卡片选区不属于当前选区。");
        });
        question.anchor.formulaFragments?.forEach(fragment => {
          if (!question.anchor.elementIds.includes(fragment.elementId)) fail("公式片段不属于当前选区。");
        });
        if (question.anchor.noteContexts) question.anchor.noteContexts = question.anchor.noteContexts
          .filter(context => historical.has(context.elementId) && question.anchor.elementIds.includes(context.elementId))
          .map(context => ({ ...context, sourceCardIds: context.sourceCardIds.filter(reference => historical.has(reference)) }));
      }
      entry.sourceCardIds.forEach(reference => checkReference(reference, "回答来源", true));
      if (entry.branchId) checkReference(entry.branchId, "讨论分支", true);
      if (entry.sectionOf) checkReference(entry.sectionOf, "回答总览", true);
    }
    for (const [child, parents] of Object.entries(organization.rawLinks || {})) {
      checkReference(child, "手动连接", true);
      parents.forEach(parent => checkReference(parent, "手动连接", true));
      if (!organization.current && present.has(child)) edges.set(child, parents.filter(parent => present.has(parent)));
    }
    // Iterative DFS avoids overflowing the stack for deeply expanded projects.
    const colors = new Map();
    for (const start of present) {
      if (colors.get(start) === 2) continue;
      const stack = [[start, false]];
      while (stack.length) {
        const [current, leaving] = stack.pop();
        if (leaving) { colors.set(current, 2); continue; }
        if (colors.get(current) === 1) fail("父子关系存在循环，请先修正连接。");
        if (colors.get(current) === 2) continue;
        colors.set(current, 1);
        stack.push([current, true]);
        for (const parent of edges.get(current) || []) stack.push([parent, false]);
      }
    }
    if (organization.current?.projectGuide) {
      checkReference(organization.current.projectGuide.rootId, "项目根节点");
      if (primary.find(entry => entry.id === organization.current.projectGuide.rootId)?.category === "archive") fail("项目根节点不能是归档卡片。");
    }
    for (const reference of organization.current?.branchLayouts || []) {
      if (!primary.some(entry => entry.id === reference)) fail(`分支排布引用了不存在的卡片 ${reference}。`);
    }
    const references = new Map();
    for (const item of [...primary, ...(organization.current ? organization.rawCards || [] : []),
      ...memory.notes.flatMap(entry => [entry.payload, entry.retryPayload].filter(Boolean))]) {
      for (const reference of item.attachments || []) references.set(reference.id, reference);
    }
    return { cards: [...present].filter(entry => !noteIds.has(entry)).length,
      notes: memory.notes.length, attachments: references.size };
  }
  function normalize(value) {
    object(value, "白板文件");
    if (value.format !== FORMAT) fail("请选择圈问白板导出的 JSON 文件。");
    if (value.version !== VERSION) fail("不支持这个文件版本，请升级白板后重试。");
    const title = string(value.title, "白板名称", 80).trim();
    if (!title || /[\u0000-\u001f]/.test(title)) fail("白板名称不能为空或包含控制字符。");
    const memory = normalizeMemory(value.memory);
    const organization = normalizeOrganization(value.organization);
    const sourceBoardId = string(value.sourceBoardId ?? "", "来源白板编号", 120);
    const exportedAt = string(value.exportedAt ?? "", "导出时间", 80);
    return { title, memory, organization, sourceBoardId, exportedAt, stats: validateGraph(memory, organization) };
  }
  function byteLength(value) { return new TextEncoder().encode(value).byteLength; }
  function create(value) {
    object(value, "白板快照");
    const normalized = normalize({ ...value, format: FORMAT, version: VERSION,
      exportedAt: new Date().toISOString() });
    const { stats, ...content } = normalized;
    const envelope = { format: FORMAT, version: VERSION, ...content };
    if (byteLength(JSON.stringify(envelope)) > MAX_BYTES) fail("单张白板文件不能超过 24 MiB。");
    return envelope;
  }
  function parse(jsonText) {
    if (typeof jsonText !== "string") fail("文件应为 JSON 文本。");
    if (byteLength(jsonText) > MAX_BYTES) fail("单张白板文件不能超过 24 MiB。");
    let value;
    try { value = JSON.parse(jsonText.replace(/^\uFEFF/, "")); }
    catch { fail("无法读取 JSON，请重新选择导出的白板文件。"); }
    return normalize(value);
  }
  return Object.freeze({ FORMAT, VERSION, MAX_BYTES, create, parse });
});
