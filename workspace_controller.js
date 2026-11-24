/* Connects workspace navigation to the board's existing view and editing adapters. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const reader = window.BoardResearch;
  const navigation = window.WorkspaceNavigation;
  let adapters;
  let state;
  let applying = false;

  function historyUpdate(replace) {
    const href = navigation.write(location.href, state);
    if (String(href) !== location.href) history[replace ? "replaceState" : "pushState"](history.state, "", href);
  }

  function structureRoot(nodes) {
    return adapters.hasStructure() ? reader.structureFor(nodes)?.rootId : null;
  }

  function currentCard() {
    return navigation.currentCard(state, adapters.getCanvasCard());
  }

  function renderNavigation(nodes) {
    const bar = $("project-surface-nav");
    bar.hidden = !structureRoot(nodes);
    if (bar.hidden) return;
    $("project-surface-structure").setAttribute("aria-pressed", String(state.presentation === "research"));
    $("project-surface-canvas").setAttribute("aria-pressed", String(state.presentation === "cards"));
    const found = nodes.find(node => node.id === currentCard() && node.id !== "board");
    const label = $("project-surface-card");
    label.hidden = !found;
    if (found) {
      label.textContent = found.title.replace(/^【[^】]+】\s*/u, "");
      label.title = label.textContent;
    }
    $("project-surface-edit").hidden = state.presentation !== "research" || !found || !adapters.canEditCard(found.id);
  }

  function setPresentation() {
    const reading = state.presentation === "research";
    $("research-workspace").hidden = !reading;
    document.body.classList.toggle("research-view", reading);
    $("board-workspace").dataset.researchActive = String(reading);
    for (const mode of ["cards", "mindmap", "research"]) {
      $("presentation-" + mode).setAttribute("aria-pressed", String(state.presentation === mode));
    }
  }

  function apply(next, { historyMode, preferStructure = false, remember = false, focusCanvas = true } = {}) {
    state = next;
    applying = true;
    try {
      setPresentation();
      if (state.presentation === "research") state = { ...state, ...reader.show(state, preferStructure) };
      else {
        reader.hide();
        adapters.showCanvas(state.presentation, state.canvasBranch, { remember });
        if (focusCanvas && state.card) adapters.focusCanvas(state.card);
        setPresentation();
      }
    } finally { applying = false; }
    if (historyMode) historyUpdate(historyMode === "replace");
    renderNavigation(adapters.hasStructure() ? reader.items() : []);
  }

  function move(action, settings) {
    if (!adapters.canNavigate()) return false;
    const nodes = reader.items();
    const next = navigation.transition(state, action, { nodes, structureRoot: structureRoot(nodes),
      canvasCard: adapters.getCanvasCard() });
    if (next === state) return false;
    apply(next, { historyMode: "push", ...settings });
    return true;
  }

  function openCanvas(id, { focus = false } = {}) {
    return move({ type: "openBranch", branch: id, focus }, { remember: true });
  }
  function locate(id) {
    return move({ type: "showCanvas", card: id }, { remember: true });
  }
  function includeCanvasCard(id) {
    const next = navigation.transition(state, { type: "focusCard", card: id }, { nodes: reader.items() });
    if (next.canvasBranch === state.canvasBranch) return true;
    if (!adapters.canNavigate()) return false;
    apply(next, { historyMode: "push", focusCanvas: false });
    return true;
  }
  function enter(id) {
    if (!move({ type: "enterReading", root: id }, { preferStructure: true })) return false;
    reader.focusHeading();
    return true;
  }
  function panel(id) { move({ type: "setPanel", panel: id }); }
  function focus(id) {
    const nodes = reader.items();
    state = navigation.transition(state, { type: "focusCard", card: id }, { nodes });
    historyUpdate(true);
    renderNavigation(nodes);
  }

  function restore() {
    const parsed = navigation.read(location.href, adapters.defaultPresentation);
    const next = navigation.transition(parsed.state, { type: "reconcile" }, { nodes: reader.items() });
    apply(next, { historyMode: next.presentation === "research" || next !== parsed.state ? "replace" : undefined,
      preferStructure: !new URLSearchParams(location.search).has("panel") });
  }

  function init(settings) {
    adapters = settings;
    $("presentation-research").addEventListener("click", () => move({ type: "setPresentation", presentation: "research" }, { preferStructure: true }));
    $("presentation-cards").addEventListener("click", () => move({ type: "setPresentation", presentation: "cards" }, { remember: true }));
    $("presentation-mindmap").addEventListener("click", () => move({ type: "setPresentation", presentation: "mindmap" }, { remember: true }));
    $("project-surface-structure").addEventListener("click", () => {
      if (move({ type: "showStructure" })) $("project-surface-structure").focus({ preventScroll: true });
    });
    $("project-surface-canvas").addEventListener("click", () => {
      if (state.presentation !== "cards" && locate(currentCard())) $("project-surface-canvas").focus({ preventScroll: true });
    });
    $("project-surface-edit").addEventListener("click", () => {
      const card = currentCard();
      if (state.presentation === "research" && card) adapters.editCard(card);
    });
    window.addEventListener("popstate", () => {
      if (!adapters.canNavigate()) { historyUpdate(true); return; }
      restore();
    });
    restore();
  }

  function refresh() {
    if (!state || applying) return;
    const nodes = state.presentation === "research" || adapters.hasStructure() ? reader.items() : [];
    const readerState = reader.refresh(nodes);
    if (readerState) { state = { ...state, ...readerState }; historyUpdate(true); }
    renderNavigation(nodes);
  }

  window.BoardWorkspace = { init, refresh, openCanvas, locate, includeCanvasCard, enter, panel, focus };
})();
