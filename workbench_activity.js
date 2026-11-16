(() => {
  async function load(projectId) {
    let activity;
    try {
      const response = await fetch("/api/workbench-activity", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return null;
      ({ activity } = await response.json());
    } catch {
      return null;
    }
    if (!activity || activity.projectId !== projectId || activity.version !== 1 || typeof activity.id !== "string" ||
        !Array.isArray(activity.branches) || !Array.isArray(activity.events)) return null;
    return { ...activity, branches: activity.branches.filter((branch) => typeof branch?.id === "string" &&
      typeof branch.title === "string" && typeof branch.desc === "string") };
  }

  async function open(root, project, initialView, onViewChange) {
    const activity = await load(project.id);
    const branches = new Map((activity?.branches || []).map((branch) => [branch.id, branch]));
    const events = (activity?.events || []).filter((event) => branches.has(event?.branch) && typeof event.id === "string");
    const canvas = window.BoardOrganization.load(`board-${project.id}`);
    const canvasItems = canvas.current?.items ?? canvas.rawCards ?? [];
    const sourceCards = new Map([...branches.values()].map((branch) => [branch.title, branch.id]));
    const projectCards = new Map(canvasItems.map((item) => [item.id, sourceCards.get(item.title) ||
      (activity && !item.parentId && item.title === project.name ? "" : `canvas:${item.id}`)]));
    for (const item of canvasItems) {
      const id = projectCards.get(item.id);
      if (!id || branches.has(id)) continue;
      branches.set(id, { id, title: item.title, desc: item.summary, status: "画布卡片",
        parent: projectCards.get(canvas.current ? item.parentId : canvas.rawLinks?.[item.id]?.[0]) });
    }
    const ref = (name) => root.querySelector(`[data-activity="${name}"]`);
    const guidance = activity?.guidance;
    const instruction = ref("instruction");
    const draftKey = `whiteboard.workbench.activity.draft.v1.${activity?.id || project.id}`;
    let view = initialView;
    let selected = events.find((event) => event.failed) || events.at(-1);
    let branchId = selected?.branch || branches.keys().next().value;
    let filter = "";

    function element(tag, value, className) {
      const node = document.createElement(tag);
      if (value != null) node.textContent = value;
      if (className) node.className = className;
      return node;
    }

    function button(label, handler, className = "tool-button") {
      const control = element("button", label, className);
      control.type = "button";
      control.addEventListener("click", handler);
      return control;
    }

    function render() {
      const showingActions = view === "actions";
      ref("actions").hidden = !showingActions;
      ref("graph").hidden = showingActions;
      ref("guidance").hidden = !guidance || branchId !== guidance.branch;
      if (showingActions) drawActions();
      else drawGraph();
    }

    function changeView(next) {
      view = next;
      onViewChange(next);
      render();
      document.querySelector(`[data-project-view="${view}"]`)?.focus();
    }

    function drawActions() {
      ref("list-title").textContent = filter ? `${branches.get(filter).title}的动作` : "动作记录";
      ref("clear-filter").hidden = !filter;
      const timeline = ref("timeline");
      timeline.replaceChildren(...events.filter((event) => !filter || event.branch === filter).map((event) => {
        const control = button("", () => {
          selected = event;
          branchId = event.branch;
          render();
          timeline.querySelector('[aria-pressed="true"]')?.focus();
        }, "activity-event");
        control.setAttribute("aria-pressed", String(event === selected));
        const content = element("span");
        content.append(element("strong", event.title), element("small", event.outcome));
        control.append(element("span", event.time, "activity-muted"), content, element("small", event.actor));
        return control;
      }));
      if (!selected) {
        timeline.append(element("p", "该项目暂无 AI 动作记录。", "activity-muted"));
        ref("detail").replaceChildren(element("h3", "项目介绍"), element("p", project.description));
        return;
      }
      const fields = element("dl");
      for (const [title, text] of [["做了什么", selected.task], ["结果与影响", selected.impact], ["证据", selected.evidence]]) {
        const row = element("div");
        row.append(element("dt", title), element("dd", text));
        if (title === "证据") row.append(element("code", selected.path));
        fields.append(row);
      }
      ref("detail").replaceChildren(element("p", `${selected.time} · ${selected.actor}`, "activity-muted"),
        element("h3", selected.title), fields,
        button(`查看项目卡片 · ${branches.get(selected.branch).title}`, () => changeView("graph")));
    }

    function drawGraph() {
      const container = ref("branches");
      const children = new Map();
      for (const branch of branches.values()) {
        const parent = branches.has(branch.parent) ? branch.parent : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(branch);
      }
      const drawn = new Set();
      function drawBranch(branch, depth) {
        if (drawn.has(branch.id)) return [];
        drawn.add(branch.id);
        const control = button("", () => {
          branchId = branch.id;
          render();
          container.querySelector('[aria-pressed="true"]')?.focus();
        }, "activity-branch");
        control.setAttribute("aria-pressed", String(branch.id === branchId));
        control.append(element("strong", branch.title), element("small", branch.status, "activity-muted"));
        control.style.marginInlineStart = `${Math.min(depth, 6) * 12}px`;
        return [control, ...(children.get(branch.id) || []).flatMap((child) => drawBranch(child, depth + 1))];
      }
      container.replaceChildren(...(children.get(null) || []).flatMap((branch) => drawBranch(branch, 0)));
      for (const branch of branches.values()) container.append(...drawBranch(branch, 0));
      const branch = branches.get(branchId);
      if (!branch) {
        const canvasLink = element("a", "打开项目画布", "tool-button activity-canvas-link");
        canvasLink.href = document.querySelector('[data-project-view="canvas"]').href;
        container.append(element("p", "在项目画布上添加卡片和连线，它们会出现在这里。", "activity-muted"));
        ref("detail").replaceChildren(element("h3", "项目介绍"), element("p", project.description), canvasLink);
        return;
      }
      const related = events.filter((event) => event.branch === branchId);
      const list = element("ul");
      list.append(...related.map((event) => element("li", event.title)));
      const openActions = button(`查看 ${related.length} 条关联动作`, () => {
        filter = branchId;
        if (selected?.branch !== branchId) selected = related.at(-1);
        changeView("actions");
      });
      openActions.disabled = !related.length;
      ref("detail").replaceChildren(element("p", branch.status, "activity-muted"), element("h3", branch.title),
        element("p", branch.desc), list, openActions);
    }

    for (const key of ["category", "title", "status", "summary", "captured"]) ref(key).textContent = activity?.[key] || "";
    root.querySelector(".activity-header").hidden = !activity;
    ref("captured").hidden = !activity?.captured;
    ref("root").textContent = project.name;
    const options = Array.isArray(guidance?.options) ? guidance.options.filter((option) =>
      typeof option?.label === "string" && typeof option.text === "string") : [];
    let draft = "";
    try { draft = localStorage.getItem(draftKey) || ""; }
    catch { /* A blocked storage session can still display the source records. */ }
    instruction.value = draft || options[0]?.text || "";
    let savedInstruction = instruction.value.trim();
    if (draft) ref("save-status").textContent = "已载入本机指导草稿。";
    ref("options").replaceChildren(...options.map((option) => button(option.label, () => {
      instruction.value = option.text;
      ref("save-status").textContent = "";
      instruction.focus();
    })));
    instruction.addEventListener("input", () => { ref("save-status").textContent = ""; });
    ref("save").addEventListener("click", () => {
      try {
        if (instruction.value.trim()) localStorage.setItem(draftKey, instruction.value.trim());
        else localStorage.removeItem(draftKey);
        savedInstruction = instruction.value.trim();
        ref("save-status").textContent = instruction.value.trim() ? "指导草稿已保存在本机浏览器。" : "指导草稿已清除。";
      } catch {
        ref("save-status").textContent = "浏览器存储不可用，草稿未保存。";
      }
    });
    ref("clear-filter").addEventListener("click", () => { filter = ""; changeView("actions"); });
    render();
    root.hidden = false;
    return { hasUnsavedGuidance: () => instruction.value.trim() !== savedInstruction };
  }

  window.WorkbenchActivity = { load, open };
})();
