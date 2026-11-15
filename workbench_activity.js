(() => {
  async function open(root) {
    let activity;
    try {
      const response = await fetch("/api/workbench-activity", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return false;
      ({ activity } = await response.json());
    } catch {
      return false;
    }
    if (!activity || activity.version !== 1 || typeof activity.id !== "string" ||
        !Array.isArray(activity.branches) || !Array.isArray(activity.events) || !activity.events.length) return false;
    const branches = new Map(activity.branches.filter((branch) => typeof branch?.id === "string")
      .map((branch) => [branch.id, branch]));
    const events = activity.events.filter((event) => branches.has(event?.branch) && typeof event.id === "string");
    if (!events.length) return false;
    const ref = (name) => root.querySelector(`[data-activity="${name}"]`);
    const nav = [...root.querySelectorAll("[data-activity-view]")];
    const guidance = activity.guidance;
    const instruction = ref("instruction");
    const draftKey = `whiteboard.workbench.activity.draft.v1.${activity.id}`;
    let view = "actions";
    let selected = events.find((event) => event.failed) || events.at(-1);
    let branchId = selected.branch;
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
      for (const control of nav) control.setAttribute("aria-pressed", String(control.dataset.activityView === view));
      ref("guidance").hidden = branchId !== guidance?.branch;
      if (showingActions) drawActions();
      else drawGraph();
    }

    function changeView(next) {
      view = next;
      render();
      nav.find((control) => control.dataset.activityView === view)?.focus();
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
      container.replaceChildren(...[...branches.values()].map((branch) => {
        const control = button("", () => {
          branchId = branch.id;
          render();
          container.querySelector('[aria-pressed="true"]')?.focus();
        }, "activity-branch");
        control.setAttribute("aria-pressed", String(branch.id === branchId));
        control.append(element("strong", branch.title), element("small", branch.status, "activity-muted"));
        return control;
      }));
      const branch = branches.get(branchId);
      const related = events.filter((event) => event.branch === branchId);
      const list = element("ul");
      list.append(...related.map((event) => element("li", event.title)));
      const openActions = button(`查看 ${related.length} 条关联动作`, () => {
        filter = branchId;
        if (selected.branch !== branchId) selected = related.at(-1);
        changeView("actions");
      });
      openActions.disabled = !related.length;
      ref("detail").replaceChildren(element("p", branch.status, "activity-muted"), element("h3", branch.title),
        element("p", branch.desc), list, openActions);
    }

    for (const key of ["category", "title", "status", "summary", "captured"]) ref(key).textContent = activity[key];
    ref("root").textContent = activity.title;
    const options = Array.isArray(guidance?.options) ? guidance.options.filter((option) =>
      typeof option?.label === "string" && typeof option.text === "string") : [];
    let draft = "";
    try { draft = localStorage.getItem(draftKey) || ""; }
    catch { /* A blocked storage session can still display the source records. */ }
    instruction.value = draft || options[0]?.text || "";
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
        ref("save-status").textContent = instruction.value.trim() ? "指导草稿已保存在本机浏览器。" : "指导草稿已清除。";
      } catch {
        ref("save-status").textContent = "浏览器存储不可用，草稿未保存。";
      }
    });
    ref("clear-filter").addEventListener("click", () => { filter = ""; changeView("actions"); });
    for (const control of nav) control.addEventListener("click", () => {
      if (control.dataset.activityView === "actions") {
        filter = "";
        branchId = selected.branch;
      }
      changeView(control.dataset.activityView);
    });
    render();
    root.hidden = false;
    return true;
  }

  window.WorkbenchActivity = { open };
})();
