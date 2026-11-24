"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const nav = require("./workspace_navigation.js");

const node = (id, parentId = null, extra = {}) => ({ id, parentId, category: "main", ...extra });
// E04 ─ E40 ─ E41, E42   (a canvas branch with a structure-visible child and an evidence card)
//     └ E50 ─ E51
const nodes = [node("E04"), node("E40", "E04"), node("E41", "E40"), node("E42", "E40"), node("E50", "E04"), node("E51", "E50")];
const forest = [...nodes, node("E70")];
const ctx = { nodes };
const base = "http://127.0.0.1:8765/?board=board-0123&project=0123&view=canvas";
const defaults = { presentation: "cards", panel: "board", canvasBranch: null, readingRoot: null, card: null, returnBranch: undefined };
const expectState = (actual, expected) => assert.deepEqual({ ...actual }, { ...defaults, ...expected });
const view = (query, fallback) => nav.read(`${base}&${query}`, fallback).state;
const go = (state, action, context = ctx) => nav.transition(state, action, context);
const deepFreeze = value => {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

test("read keeps outer identity apart from the view state", () => {
  const result = nav.read(`${base}&presentation=research&root=E04&panel=structure&focusCard=E41&canvasScope=E40`);
  assert.deepEqual(result.identity, { board: "board-0123", project: "0123", view: "canvas" });
  assert.equal(result.explicit, true);
  expectState(result.state, { presentation: "research", panel: "structure", readingRoot: "E04", card: "E41", returnBranch: "E40" });
  // In a canvas presentation root is the canvas branch; reading root and return branch do not exist.
  expectState(view("presentation=mindmap&root=E40&focusCard=E42&canvasScope=E50&panel=flow"),
    { presentation: "mindmap", canvasBranch: "E40", card: "E42" });
  // canvasScope=board is the whole board, distinct from an absent canvasScope.
  expectState(view("presentation=research&root=board&canvasScope=board"),
    { presentation: "research", readingRoot: "board", returnBranch: null });
});

test("old links without presentation, with a #E27 hash, or with bad values still read", () => {
  const plain = nav.read(`${base}`);
  assert.equal(plain.explicit, false);
  expectState(plain.state, {});
  assert.equal(nav.read(base, "mindmap").state.presentation, "mindmap");
  assert.equal(nav.read(`${base}&presentation=bogus`, "mindmap").explicit, false);
  expectState(nav.read("http://h/?board=original#E27").state, { card: "E27" });
  assert.deepEqual(nav.read("http://h/?board=original#E27").identity, { board: "original", project: null, view: null });
  expectState(nav.read("?presentation=research#E27").state, { presentation: "research", readingRoot: "E27", card: "E27" });
  expectState(nav.read("?presentation=research&root=E04&focusCard=E41#E27").state,
    { presentation: "research", readingRoot: "E04", card: "E41" });
  expectState(nav.read("?board=x#project-template").state, {});
  expectState(nav.read("?presentation=cards&panel=nope&root=bad%20id!&focusCard=").state, {});
  expectState(nav.read("").state, {});
});

test("write only replaces route keys and round-trips every presentation", () => {
  const source = `${base}&x=1&revision=7&collapsed=E1%2CE2#project-template`;
  for (const query of [
    "presentation=cards&root=E40&focusCard=E42",
    "presentation=mindmap",
    "presentation=research&root=E04&panel=structure&focusCard=E41&canvasScope=E40",
    "presentation=research&root=board&canvasScope=board",
    "presentation=research&root=E40&panel=flow",
  ]) {
    const state = view(query);
    const out = new URL(nav.write(source, state));
    assert.deepEqual(nav.read(out).state, state, query);
    assert.deepEqual(nav.read(out).identity, { board: "board-0123", project: "0123", view: "canvas" });
    assert.equal(out.searchParams.get("x"), "1");
    assert.equal(out.searchParams.get("revision"), "7");
    assert.equal(out.searchParams.get("collapsed"), "E1,E2");
    assert.equal(out.hash, "#project-template", "identity hashes are not route state");
  }
  // Stale keys and duplicates are replaced; panel and canvasScope exist only in research.
  assert.equal(nav.write("?root=E1&root=E2&presentation=research&panel=flow&focusCard=E9&canvasScope=E3&board=b", view("presentation=mindmap")),
    "?board=b&presentation=mindmap");
  assert.equal(new URL(nav.write(base, view("presentation=cards&panel=flow&canvasScope=E40"))).search.includes("panel"), false);
  // A legacy card hash is consumed into focusCard.
  const migrated = new URL(nav.write("http://h/?board=original#E27", nav.read("http://h/?board=original#E27").state));
  assert.equal(migrated.hash, "");
  assert.equal(migrated.searchParams.get("focusCard"), "E27");
  assert.equal(migrated.searchParams.get("presentation"), "cards");
});

test("showCanvas returns the same branch only when it contains the card, otherwise the nearest ancestor", () => {
  const show = (query, action = { type: "showCanvas" }, context = ctx) => go(view(query), action, context);
  const structure = "presentation=research&root=E04&panel=structure&focusCard=E41";
  expectState(show(`${structure}&canvasScope=E40`), { canvasBranch: "E40", card: "E41" });
  expectState(show(`${structure}&canvasScope=board`), { card: "E41" });
  expectState(show(`${structure}&canvasScope=E50`), { canvasBranch: "E04", card: "E41" });
  // A deleted return branch falls back to the reading root while that still contains the card (old showCanvasAt behaviour).
  expectState(show(`${structure}&canvasScope=E99`), { canvasBranch: "E04", card: "E41" });
  expectState(show("presentation=research&root=E70&panel=structure&focusCard=E41&canvasScope=E99", undefined, { nodes: forest }),
    { card: "E41" });
  // No canvasScope: the reading root is the branch while it contains the card.
  expectState(show("presentation=research&root=E40"), { canvasBranch: "E40", card: "E40" });
  expectState(show("presentation=research&root=E40", { type: "showCanvas", card: "E42" }), { canvasBranch: "E40", card: "E42" });
  expectState(show("presentation=research&root=E50", { type: "showCanvas", card: "E41" }), { canvasBranch: "E04", card: "E41" });
  expectState(show("presentation=research&root=E40", { type: "showCanvas", card: "E99" }), { canvasBranch: "E40" });
  // The virtual whole-board root is never a canvas branch.
  expectState(show("presentation=research&root=board", { type: "showCanvas" }, { nodes: forest }), {});
  // From a canvas presentation the canvas card comes from the context and also leaves mindmap.
  expectState(show("presentation=mindmap&root=E40", undefined, { nodes, canvasCard: "E42" }), { canvasBranch: "E40", card: "E42" });
  expectState(show("presentation=mindmap&root=E40", undefined, { nodes, canvasCard: "E51" }), { canvasBranch: "E04", card: "E51" });
});

test("showStructure and showCanvas reproduce the structure round trip and keep the originating branch", () => {
  const canvas = view("presentation=cards&root=E40&focusCard=E42");
  const structure = go(canvas, { type: "showStructure" }, { nodes, structureRoot: "E04", canvasCard: "E42" });
  expectState(structure, { presentation: "research", panel: "structure", readingRoot: "E04", card: "E42", returnBranch: "E40" });
  assert.equal(go(structure, { type: "showStructure" }, { nodes, structureRoot: "E04" }), structure, "already in structure");
  assert.equal(go(canvas, { type: "showStructure" }), canvas, "no structure for this board");
  // A reload in structure keeps the return branch through the URL.
  const reloaded = nav.read(nav.write(base, structure)).state;
  assert.deepEqual(reloaded, structure);
  assert.equal(new URL(nav.write(base, structure)).searchParams.get("canvasScope"), "E40");
  expectState(go(reloaded, { type: "showCanvas" }), { canvasBranch: "E40", card: "E42" });
  // The canvas card from the context wins over the old focus card.
  expectState(go(canvas, { type: "showStructure" }, { nodes, structureRoot: "E04", canvasCard: "E41" }),
    { presentation: "research", panel: "structure", readingRoot: "E04", card: "E41", returnBranch: "E40" });
  expectState(go(canvas, { type: "showStructure" }, { nodes, structureRoot: "E04" }),
    { presentation: "research", panel: "structure", readingRoot: "E04", card: "E42", returnBranch: "E40" });
  // From another reading panel the reading root becomes the structure's current card.
  expectState(go(view("presentation=research&root=E40"), { type: "showStructure" }, { nodes, structureRoot: "E04" }),
    { presentation: "research", panel: "structure", readingRoot: "E04", card: "E40" });
});

test("switching presentation keeps branch, card and return context and writes nothing else", () => {
  const canvas = view("presentation=cards&root=E40&focusCard=E42");
  const mind = go(canvas, { type: "setPresentation", presentation: "mindmap" });
  expectState(mind, { presentation: "mindmap", canvasBranch: "E40", card: "E42" });
  assert.equal(go(mind, { type: "setPresentation", presentation: "mindmap" }), mind);
  assert.equal(go(mind, { type: "setPresentation", presentation: "nope" }), mind);
  expectState(go(mind, { type: "setPresentation", presentation: "cards" }), { canvasBranch: "E40", card: "E42" });
  const reading = go(mind, { type: "setPresentation", presentation: "research" });
  expectState(reading, { presentation: "research", readingRoot: "E40", card: "E42", returnBranch: "E40" });
  expectState(go(reading, { type: "setPresentation", presentation: "cards" }), { canvasBranch: "E40", card: "E42" });
  // Moving deeper inside reading does not move the branch the canvas returns to.
  const deeper = go(reading, { type: "enterReading", root: "E41" });
  expectState(deeper, { presentation: "research", readingRoot: "E41", returnBranch: "E40" });
  expectState(go(deeper, { type: "setPresentation", presentation: "mindmap" }), { presentation: "mindmap", canvasBranch: "E40" });
  // Entering reading from the whole board returns to the whole board.
  const whole = go(view("presentation=cards&focusCard=E51"), { type: "setPresentation", presentation: "research" });
  expectState(whole, { presentation: "research", card: "E51", returnBranch: null });
  expectState(go(whole, { type: "setPresentation", presentation: "cards" }), { card: "E51" });
  for (const state of [canvas, mind, reading, deeper, whole]) {
    assert.deepEqual(Object.keys(state).sort(), Object.keys(defaults).sort());
    assert.equal(Object.isFrozen(state), true);
  }
});

test("enterReading, openBranch, focusCard and setPanel", () => {
  const canvas = view("presentation=cards&root=E40&focusCard=E42");
  assert.equal(go(canvas, { type: "enterReading", root: "E99" }), canvas);
  assert.equal(go(canvas, { type: "enterReading", root: "board" }), canvas, "single root has no virtual board");
  expectState(go(canvas, { type: "enterReading", root: "board" }, { nodes: forest }),
    { presentation: "research", readingRoot: "board", returnBranch: "E40" });
  expectState(go(canvas, { type: "enterReading", root: "E41", panel: "flow" }),
    { presentation: "research", panel: "flow", readingRoot: "E41", returnBranch: "E40" });

  const reading = view("presentation=research&root=E04&panel=structure&focusCard=E41&canvasScope=E40");
  expectState(go(reading, { type: "openBranch", branch: "E50" }), { canvasBranch: "E50" });
  expectState(go(view("presentation=mindmap&root=E40"), { type: "openBranch", branch: "E50" }), { canvasBranch: "E50" });
  for (const branch of [null, "board", "E99"]) expectState(go(reading, { type: "openBranch", branch }), {});

  expectState(go(canvas, { type: "focusCard", card: "E41" }), { canvasBranch: "E40", card: "E41" });
  expectState(go(canvas, { type: "focusCard", card: "E51" }), { canvasBranch: "E04", card: "E51" });
  expectState(go(view("presentation=mindmap"), { type: "focusCard", card: "E51" }), { presentation: "mindmap", card: "E51" });
  assert.equal(go(canvas, { type: "focusCard", card: "E99" }), canvas);
  assert.equal(go(canvas, { type: "focusCard", card: "board" }), canvas);
  expectState(go(reading, { type: "focusCard", card: "E42" }), { ...reading, card: "E42" });

  expectState(go(reading, { type: "setPanel", panel: "flow" }), { ...reading, panel: "flow" });
  assert.equal(go(reading, { type: "setPanel", panel: "nope" }), reading);
  assert.equal(go(canvas, { type: "setPanel", panel: "flow" }), canvas);
  assert.throws(() => go(canvas, { type: "unknown" }), TypeError);
});

test("reconcile drops missing ids without inventing a view", () => {
  const stale = view("presentation=research&root=E99&panel=flow&focusCard=E98&canvasScope=E97");
  expectState(go(stale, { type: "reconcile" }, { nodes, lastPath: ["E04", "E40", "E99"], availablePanels: ["board", "structure"] }),
    { presentation: "research", readingRoot: "E40" });
  expectState(go(stale, { type: "reconcile" }), { presentation: "research", panel: "flow" });
  expectState(go(view("presentation=cards&root=E99&focusCard=E42"), { type: "reconcile" }, { nodes, lastPath: ["E04", "E40", "E99"] }),
    { canvasBranch: "E40", card: "E42" });
  const valid = view("presentation=research&root=E40&panel=flow&focusCard=E41&canvasScope=board");
  assert.equal(go(valid, { type: "reconcile" }), valid);
  expectState(go(view("presentation=research&root=board"), { type: "reconcile" }), { presentation: "research" });
  assert.equal(go(view("presentation=research&root=board"), { type: "reconcile" }, { nodes: forest }).readingRoot, "board");
});

test("deep, cyclic and archived trees are handled without recursion or loops", () => {
  const chain = Array.from({ length: 5000 }, (_, i) => node(`N${i}`, i ? `N${i - 1}` : null));
  const context = { nodes: chain };
  expectState(go(view("presentation=research&root=N4000&panel=structure&focusCard=N10&canvasScope=N4000"), { type: "showCanvas" }, context),
    { canvasBranch: "N10", card: "N10" });
  expectState(go(view("presentation=research&root=N4000&panel=structure&focusCard=N4999&canvasScope=N4000"), { type: "showCanvas" }, context),
    { canvasBranch: "N4000", card: "N4999" });
  expectState(go(view("presentation=cards&root=N10"), { type: "focusCard", card: "N4999" }, context), { canvasBranch: "N10", card: "N4999" });
  const cyclic = { nodes: [node("C1", "C2"), node("C2", "C1"), node("E1")] };
  expectState(go(view("presentation=cards&root=C2"), { type: "focusCard", card: "C1" }, cyclic), { canvasBranch: "C2", card: "C1" });
  const archived = { nodes: [...nodes, node("E43", "E40", { category: "archive" })] };
  const canvas = view("presentation=cards&root=E40");
  assert.equal(go(canvas, { type: "focusCard", card: "E43" }, archived), canvas);
});

test("structure can start at a virtual root and a relation can clear the card", () => {
  const forest = [...nodes, node("E99")];
  const from = view("presentation=cards&root=E40&focusCard=E42");
  const graph = go(from, { type: "showStructure" }, { nodes: forest, structureRoot: "board" });
  expectState(graph, { presentation: "research", panel: "structure", readingRoot: "board", card: "E42", returnBranch: "E40" });
  assert.equal(go(graph, { type: "focusCard", card: null }, { nodes: forest }).card, null);
});

test("transitions never touch board data, folds, positions or revisions", () => {
  const frozen = deepFreeze({ nodes: nodes.map(item => ({ ...item, x: 10, y: 20, collapsed: true, revision: 9 })),
    collapsedBranches: ["E40"], positions: { E40: { x: 1, y: 2 } }, revision: 12, structureRoot: "E04", canvasCard: "E42" });
  const before = JSON.stringify(frozen);
  let state = view("presentation=cards&root=E40&focusCard=E42");
  const seen = [state];
  for (const action of [{ type: "showStructure" }, { type: "setPanel", panel: "flow" }, { type: "showCanvas" },
    { type: "setPresentation", presentation: "mindmap" }, { type: "enterReading", root: "E50" }, { type: "reconcile" },
    { type: "focusCard", card: "E41" }, { type: "openBranch", branch: "E40" }]) {
    state = go(state, action, frozen);
    seen.push(state);
  }
  assert.equal(JSON.stringify(frozen), before);
  for (const value of seen) {
    assert.deepEqual(Object.keys(value).sort(), Object.keys(defaults).sort());
    const written = new URL(nav.write(`${base}&revision=12&collapsed=E40`, value));
    assert.equal(written.searchParams.get("revision"), "12");
    assert.equal(written.searchParams.get("collapsed"), "E40");
  }
  // Plain objects are normalized, not trusted.
  expectState(go({ presentation: "research", canvasBranch: "E40", panel: "zzz" }, { type: "setPanel", panel: "flow" }),
    { presentation: "research", panel: "flow" });
});
