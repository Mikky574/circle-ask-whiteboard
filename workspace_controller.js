/* Connects workspace navigation to the board's existing view and editing adapters. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const reader = window.BoardResearch;
  const navigation = window.WorkspaceNavigation;
  let adapters;
  let state;
  let applying = false;
  let trail = [];

  function historyUpdate(replace) {
    const href = new URL(navigation.write(location.href, state));
    if (adapters.readingOnly) href.searchParams.delete("canvasScope");
    if (state.presentation === "research" && trail.length > 1) href.searchParams.set("trail", trail.join("."));
    else href.searchParams.delete("trail");
    if (String(href) !== location.href) history[replace ? "replaceState" : "pushState"](history.state, "", href);
  }

  function structureRoot(nodes) {
    return adapters.canStructure() ? reader.structureRoot(nodes) : null;
  }

  function currentCard() {
    return navigation.currentCard(state, adapters.getCanvasCard());
  }

  function renderNavigation(nodes) {
    const bar = $("project-surface-nav");
    const root = structureRoot(nodes);
    bar.hidden = !root;
    if (bar.hidden) return;
    const structureButton = $("project-surface-structure");
    const showingStructure = state.presentation === "research" && state.panel === "structure";
    bar.classList.toggle("project-compact-navigation", showingStructure && adapters.compactWorkspace?.());
    structureButton.textContent = showingStructure && state.readingRoot !== root ? "返回结构总览" : "结构白板";
    structureButton.setAttribute("aria-pressed", String(showingStructure && state.readingRoot === root));
    const found = nodes.find(node => node.id === currentCard() && node.id !== "board");
    const label = $("project-surface-card");
    const ask = $("project-surface-opinion");
    label.hidden = !found;
    if (found) {
      label.textContent = found.title.replace(/^【[^】]+】\s*/u, "");
      label.title = label.textContent;
    }
    $("project-surface-edit").hidden = state.presentation !== "research" || !found || !adapters.canEditCard(found.id);
    ask.hidden = $("project-surface-edit").hidden || state.panel !== "structure";
  }

  function setPresentation() {
    const reading = state.presentation === "research";
    $("research-workspace").hidden = !reading;
    document.body.classList.toggle("research-view", reading);
    $("board-workspace").dataset.researchActive = String(reading);
    if (!adapters.readingOnly) for (const mode of ["cards", "mindmap", "research"]) {
      $("presentation-" + mode).setAttribute("aria-pressed", String(state.presentation === mode));
    }
  }

  function readingRoute(next) {
    if (!adapters.readingOnly) return next;
    const nodes = reader.items();
    const root = next.readingRoot || next.canvasBranch || structureRoot(nodes);
    const panel = next.presentation === "research" && next.readingRoot && next.panel !== "graph" ? next.panel : "structure";
    const target = root && navigation.transition(next, {
      type: "enterReading", root, panel, card: next.card,
    }, { nodes });
    return target?.presentation === "research" ? target : {
      ...next, presentation: "research", panel: "structure", readingRoot: null, canvasBranch: null,
    };
  }

  function apply(next, { historyMode, preferStructure = false, remember = false, focusCanvas = true, path } = {}) {
    state = next = readingRoute(next);
    applying = true;
    try {
      setPresentation();
      if (state.presentation === "research") {
        trail = path || (trail.includes(next.readingRoot) ? trail : [next.readingRoot].filter(Boolean));
        state = { ...state, ...reader.show(state, preferStructure, trail) };
        trail = reader.openPath();
      } else {
        trail = [];
        reader.hide();
        adapters.showCanvas(state.presentation, state.canvasBranch, { remember });
        if (focusCanvas && state.card) adapters.focusCanvas(state.card);
        setPresentation();
      }
    } finally { applying = false; }
    if (historyMode) historyUpdate(historyMode === "replace");
    renderNavigation(adapters.canStructure() ? reader.items() : []);
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
    if (adapters.readingOnly) {
      const nodes = reader.items();
      const card = nodes.find(item => item.id === id);
      if (!card) return false;
      const root = card.parentId || card.id;
      if (state.readingRoot === root && state.card === id && state.panel === "structure") {
        reader.focusHeading();
        reader.revealDiagramCard(id);
        reader.showCard(id);
        return true;
      }
      if (!enterStructure(root, id)) return false;
      reader.showCard(id);
      return true;
    }
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
  function enterStructure(id, card) {
    if (!move({ type: "enterReading", root: id, panel: "structure", card })) return false;
    reader.focusHeading();
    if (card) reader.revealDiagramCard(card);
    return true;
  }
  function jumpStructure(id) {
    if (!trail.includes(id)) return enterStructure(id);
    if (!adapters.canNavigate()) return false;
    const next = navigation.transition(state, { type: "enterReading", root: id, panel: "structure", card: reader.cardAt(id) },
      { nodes: reader.items() });
    apply(next, { historyMode: "replace", path: trail });
    reader.focusHeading(true);
    return true;
  }
  function openStructure(id, from) {
    if (trail.includes(id)) return jumpStructure(id);
    const parent = trail.indexOf(from || state.readingRoot);
    const path = parent >= 0 && state.presentation === "research" ? [...trail.slice(0, parent + 1), id] : [id];
    if (!move({ type: "enterReading", root: id, panel: "structure" }, { path })) return false;
    reader.focusHeading(true);
    return true;
  }
  function panel(id, scope) {
    if (adapters.readingOnly && id === "graph") return;
    if (scope && scope !== state.readingRoot) focus(reader.cardAt(scope), scope);
    move({ type: "setPanel", panel: id });
  }
  function focus(id, scope) {
    if (scope && scope !== state.readingRoot && trail.includes(scope)) {
      state = navigation.transition(state, { type: "enterReading", root: scope, panel: "structure", card: id },
        { nodes: reader.items() });
      reader.activate(scope);
    }
    const nodes = reader.items();
    state = navigation.transition(state, { type: "focusCard", card: id }, { nodes });
    historyUpdate(true);
    renderNavigation(nodes);
  }

  function restore(navigate = false) {
    const parsed = navigation.read(location.href, adapters.readingOnly ? "research" : adapters.defaultPresentation);
    const nodes = reader.items();
    let next = navigation.transition(parsed.state, { type: "reconcile" }, { nodes });
    if (!parsed.explicit && next.presentation === "research" && !next.readingRoot) {
      const card = next.card;
      next = navigation.transition(next, { type: "showStructure" }, { nodes, structureRoot: structureRoot(nodes) });
      if (card) next = navigation.transition(next, { type: "focusCard", card }, { nodes });
    }
    const params = new URLSearchParams(location.search);
    if (adapters.readingOnly && !params.has("panel")) next = { ...next, panel: "structure" };
    const requested = (params.get("trail") || "").split(".");
    const known = new Set(nodes.map(node => node.id));
    const path = requested.includes(next.readingRoot) && new Set(requested).size === requested.length &&
      requested.every(id => known.has(id)) ? requested : [];
    apply(next, { path, historyMode: adapters.readingOnly || next.presentation === "research" || next !== parsed.state ? "replace" : undefined,
      preferStructure: !new URLSearchParams(location.search).has("panel") });
    if ((navigate || path.length > 1) && next.presentation === "research" && next.panel === "structure") reader.focusHeading();
  }

  function init(settings) {
    adapters = settings;
    if (!adapters.readingOnly) {
      $("presentation-research").addEventListener("click", () => move({ type: "setPresentation", presentation: "research" }, { preferStructure: true }));
      $("presentation-cards").addEventListener("click", () => move({ type: "setPresentation", presentation: "cards" }, { remember: true }));
      $("presentation-mindmap").addEventListener("click", () => move({ type: "setPresentation", presentation: "mindmap" }, { remember: true }));
    }
    $("project-surface-structure").addEventListener("click", () => {
      const root = structureRoot(reader.items());
      if (state.presentation === "research" && trail.length > 1 && trail.includes(root)) { jumpStructure(root); return; }
      if (move({ type: "showStructure" })) $("project-surface-structure").focus({ preventScroll: true });
    });
    $("project-surface-edit").addEventListener("click", () => {
      const card = currentCard();
      if (state.presentation === "research" && card) adapters.editCard(card);
    });
    $("project-surface-opinion").addEventListener("click", () => {
      const card = currentCard();
      if (state.panel === "structure" && card) adapters.opinion(card);
    });
    window.addEventListener("popstate", () => {
      if (!adapters.canNavigate()) { historyUpdate(true); return; }
      restore(true);
    });
    restore();
  }

  function refresh() {
    if (!state || applying) return;
    const nodes = state.presentation === "research" || adapters.canStructure() ? reader.items() : [];
    const readerState = reader.refresh(nodes);
    if (readerState) {
      state = { ...state, ...readerState };
      trail = reader.openPath();
      historyUpdate(true);
    }
    renderNavigation(nodes);
  }

  window.BoardWorkspace = { init, refresh, openCanvas, locate, includeCanvasCard, enter, enterStructure, openStructure, jumpStructure, panel, focus };
})();
