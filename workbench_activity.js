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


  function mount(root, activity, { getCards, onOpenCard }) {
    const branches = new Map((activity?.branches || []).map(branch => [branch.id, branch]));
    const events = (activity?.events || []).filter(event => branches.has(event?.branch) && typeof event.id === "string");
    const ref = name => root.querySelector(`[data-activity="${name}"]`);
    const guidance = activity?.guidance;
    const instruction = ref("instruction");
    const draftKey = `whiteboard.workbench.activity.draft.v1.${activity?.id}`;
    const latestFirst = [...events].reverse();
    let selected = latestFirst.find(event => event.failed) || latestFirst[0];

    function element(tag, value, className) {
      const node = document.createElement(tag);
      if (value != null) node.textContent = value;
      if (className) node.className = className;
      return node;
    }

    function button(label, handler, className = "research-button") {
      const control = element("button", label, className);
      control.type = "button";
      control.addEventListener("click", handler);
      return control;
    }

    function render() {
      const timeline = ref("timeline");
      const detail = ref("detail");
      ref("guidance").hidden = !guidance || Boolean(selected && selected.branch !== guidance.branch);
      timeline.replaceChildren(...latestFirst.map(event => {
        const control = button("", () => {
          selected = event;
          render();
          timeline.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
        }, "activity-event");
        control.setAttribute("aria-pressed", String(event === selected));
        const text = element("span");
        text.append(element("strong", event.title), element("small", event.outcome));
        control.append(element("span", event.time, "activity-muted"), text, element("small", event.actor));
        return control;
      }));
      detail.hidden = !selected;
      if (!selected) {
        timeline.append(element("p", "该项目暂无 AI 动作记录。", "activity-muted"));
        return;
      }

      const fields = element("dl");
      for (const [label, text] of [["做了什么", selected.task], ["结果与影响", selected.impact], ["证据", selected.evidence]]) {
        if (label === "做了什么" && text === selected.title) continue;
        if (!text && (label !== "证据" || !selected.path)) continue;
        const row = element("div");
        row.append(element("dt", label), element("dd", text));
        if (label === "证据" && selected.path) row.append(element("code", selected.path));
        fields.append(row);
      }
      detail.replaceChildren(element("h3", selected.title), fields);
      const branch = branches.get(selected.branch);
      const cleanTitle = value => String(value || "").replace(/^【[^】]+】\s*/u, "");
      const cards = getCards();
      const sameTitle = cards.filter(card => cleanTitle(card.title) === cleanTitle(branch.title));
      const card = cards.find(card => card.id === branch.cardId) || (sameTitle.length === 1 ? sameTitle[0] : null);
      if (card) detail.append(button("查看相关卡片", () => onOpenCard(card.id)));
    }

    ref("captured").textContent = activity?.captured || "";
    ref("captured").hidden = !activity?.captured;
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

    render();
    return { hasUnsavedGuidance: () => instruction.value.trim() !== savedInstruction };
  }

  window.WorkbenchActivity = { load, mount };
})();
