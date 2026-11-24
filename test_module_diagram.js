/* Run with: node test_module_diagram.js (no dependencies). */
"use strict";
const assert = require("node:assert/strict");
const ModuleDiagram = require("./module_diagram.js");
const ProjectStructure = require("./project_structure.js");

const tests = [];
const test = (name, run) => tests.push([name, run]);
const card = (id, parentId, extra = {}) => ({ id, title: `卡 ${id}`, summary: `${id} 的说明。其余内容。`, parentId, ...extra });
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const capability = { version: 1, audience: "读者", input: "问题", outcome: "得到答案", boundary: "仅限本库", verification: "对照原文" };
const nodeCards = (diagram) => diagram.zones.flatMap((zone) => zone.nodes.map((node) => node.cardId));
const checked = (diagram) => { ProjectStructure.validate(diagram); return diagram; };

test("returns null for a missing root or bad input", () => {
  assert.equal(ModuleDiagram.derive([card("E1", null)], "E9"), null);
  assert.equal(ModuleDiagram.derive(null, "E1"), null);
  assert.equal(ModuleDiagram.derive([card("E1", null)], 1), null);
  assert.equal(ModuleDiagram.derive([], "E1"), null);
});

test("a leaf is one editable entry node with no arrows", () => {
  const diagram = checked(ModuleDiagram.derive(freeze([card("E1", null)]), "E1"));
  assert.equal(diagram.rootId, "E1");
  assert.deepEqual(nodeCards(diagram), ["E1"]);
  assert.equal(diagram.zones[0].role, "entry");
  assert.equal(diagram.links, undefined);
  assert.equal(diagram.derived.leaf, true);
});

test("explicit flowSteps become labelled main arrows backed by the owning card", () => {
  const nodes = freeze([card("E1", null, { flowSteps: ["E4", "E2", "E3"] }), card("E2", "E1"), card("E3", "E1"), card("E4", "E1")]);
  const diagram = checked(ModuleDiagram.derive(nodes, "E1"));
  const flow = diagram.zones.find((zone) => zone.id === "flow");
  assert.deepEqual(flow.nodes.map((node) => node.cardId), ["E4", "E2", "E3"]);
  assert.deepEqual(diagram.links.map((link) => [link.from, link.to, link.label, link.kind, link.evidence]), [
    ["n-e4", "n-e2", "第2步", "main", "E1"],
    ["n-e2", "n-e3", "第3步", "main", "E1"],
  ]);
  assert.equal(diagram.derived.flow, true);
});

test("on the virtual board the evidence is the target step, never board", () => {
  const nodes = [card("board", null, { flowSteps: ["E1", "E2"] }), card("E1", "board"), card("E2", "board")];
  const diagram = checked(ModuleDiagram.derive(nodes, "board"));
  assert.equal(diagram.rootId, "board");
  assert.equal(diagram.links[0].evidence, "E2");
  assert.equal(diagram.zones[0].title, "整个白板");
});

test("parallel topics get no arrows, even when they share a branch", () => {
  const nodes = [card("E1", null), card("E2", "E1"), card("E3", "E1"), card("E4", "E1")];
  const diagram = checked(ModuleDiagram.derive(nodes, "E1"));
  assert.equal(diagram.links, undefined);
  assert.equal(diagram.derived.flow, false);
  assert.deepEqual(diagram.zones.map((zone) => zone.id), ["entry", "topic"]);
  assert.deepEqual(nodeCards(diagram), ["E1", "E2", "E3", "E4"]);
});

test("bad flowSteps draw nothing and keep every card", () => {
  const nodes = [card("E1", null), card("E2", "E1"), card("E3", "E1"), card("E9", "E2")];
  const cases = {
    "flow-duplicate": ["E2", "E3", "E2"],
    "flow-orphan": ["E2", "E9"],
    "flow-short": ["E2"],
    "flow-shape": ["E2", 5],
    "flow-long": Array.from({ length: 13 }, (_, index) => `E${index + 20}`),
  };
  for (const [code, flowSteps] of Object.entries(cases)) {
    const diagram = checked(ModuleDiagram.derive(freeze(nodes.map((item) => (item.id === "E1" ? { ...item, flowSteps } : item))), "E1"));
    assert.equal(diagram.links, undefined, code);
    assert.deepEqual(nodeCards(diagram).sort(), ["E1", "E2", "E3"], code);
    assert.equal(diagram.derived.diagnostics[0].code, code);
  }
  const notList = ModuleDiagram.derive([card("E1", null, { flowSteps: "E2" }), card("E2", "E1")], "E1");
  assert.equal(notList.derived.diagnostics[0].code, "flow-shape");
});

test("records on the cards decide the zone; a step stays in the flow", () => {
  const nodes = freeze([
    card("E1", null, { flowSteps: ["E5", "E6"] }),
    card("E2", "E1", { capability }),
    card("E3", "E1", { experiment: { question: "是否更快？", finding: "更快。" } }),
    card("E4", "E1", { codePreview: { path: "a.js", text: "x" } }),
    card("E5", "E1", { codePreview: { path: "b.js", text: "y" } }),
    card("E6", "E1"),
    card("E7", "E1", { experiment: {} }),
  ]);
  const diagram = checked(ModuleDiagram.derive(freeze(nodes), "E1"));
  const zoneOf = (id) => diagram.zones.find((zone) => zone.nodes.some((node) => node.cardId === id)).id;
  assert.deepEqual(["E2", "E3", "E4", "E5", "E6", "E7"].map(zoneOf), ["cap", "exp", "code", "flow", "flow", "topic"]);
  assert.equal(diagram.zones.find((zone) => zone.id === "cap").nodes[0].note, "得到答案");
  assert.equal(diagram.zones.find((zone) => zone.id === "exp").role, "feedback");
});

test("only direct children appear; deeper cards are counted, not drawn", () => {
  const nodes = freeze([card("E1", null), card("E2", "E1"), card("E3", "E2"), card("E4", "E2"), card("E5", "E3")]);
  const diagram = checked(ModuleDiagram.derive(nodes, "E1"));
  assert.deepEqual(nodeCards(diagram), ["E1", "E2"]);
  assert.match(diagram.zones[1].nodes[0].note, /^含 2 张下级/u);
  const deeper = checked(ModuleDiagram.derive(nodes, "E2"));
  assert.equal(deeper.rootId, "E2");
  assert.deepEqual(nodeCards(deeper), ["E2", "E3", "E4"]);
});

test("duplicate ids, invalid ids, self parents and cycles do not break derive", () => {
  const nodes = freeze([
    card("E1", null), card("E2", "E1", { title: "第一张" }), card("E2", "E1", { title: "重复" }),
    { id: "x1", title: "非法", parentId: "E1" }, { id: 7, parentId: "E1" }, null, "text",
    card("E3", "E3"), card("E4", "E5"), card("E5", "E4"),
  ]);
  const diagram = checked(ModuleDiagram.derive(nodes, "E1"));
  assert.deepEqual(nodeCards(diagram), ["E1", "E2"]);
  checked(ModuleDiagram.derive(nodes, "E4"));
  assert.deepEqual(nodeCards(ModuleDiagram.derive(nodes, "E3")), ["E3"]);
});

test("12 steps split into two balanced flow zones with 11 unbroken arrows", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `E${index + 2}`);
  const nodes = [card("E1", null, { flowSteps: ids }), ...ids.map((id) => card(id, "E1"))];
  const diagram = checked(ModuleDiagram.derive(freeze(nodes), "E1"));
  const flows = diagram.zones.filter((zone) => zone.id.startsWith("flow"));
  assert.deepEqual(flows.map((zone) => [zone.id, zone.lane, zone.nodes.length]), [["flow-1", 1, 6], ["flow-2", 2, 6]]);
  assert.equal(diagram.links.length, 11);
  assert.ok(diagram.links.every((link, index) => link.from === `n-${ids[index].toLowerCase()}` && link.to === `n-${ids[index + 1].toLowerCase()}`));
});

test("many direct cards respect zone and node limits and report what is hidden", () => {
  const ids = Array.from({ length: 50 }, (_, index) => `E${index + 2}`);
  const diagram = checked(ModuleDiagram.derive(freeze([card("E1", null), ...ids.map((id) => card(id, "E1"))]), "E1"));
  const total = nodeCards(diagram).length;
  assert.equal(total, ModuleDiagram.limits.nodes);
  assert.ok(diagram.zones.length <= ModuleDiagram.limits.zones);
  assert.ok(diagram.zones.every((zone) => zone.nodes.length <= ModuleDiagram.limits.nodesPerZone && zone.lane <= ModuleDiagram.limits.lane));
  assert.equal(diagram.derived.omitted, 11);
  assert.match(diagram.zones[0].note, /另有 11 张/u);
  assert.equal(new Set(nodeCards(diagram)).size, total);
  assert.ok(diagram.derived.diagnostics.some((item) => item.code === "omitted"));
});

test("flow plus many support cards still fits and keeps every arrow", () => {
  const steps = ["E2", "E3", "E4", "E5", "E6", "E7", "E8"];
  const others = Array.from({ length: 45 }, (_, index) => `E${index + 20}`);
  const nodes = [card("E1", null, { flowSteps: steps }), ...[...steps, ...others].map((id) => card(id, "E1"))];
  const diagram = checked(ModuleDiagram.derive(freeze(nodes), "E1"));
  assert.equal(diagram.links.length, 6);
  assert.deepEqual(diagram.zones.filter((zone) => zone.id.startsWith("flow")).map((zone) => zone.nodes.length), [4, 3]);
  assert.ok(nodeCards(diagram).length <= ModuleDiagram.limits.nodes);
});

test("node ids come from card ids, so reordering cards keeps them stable", () => {
  const a = [card("E1", null), card("E2", "E1"), card("E3", "E1")];
  const first = ModuleDiagram.derive(a, "E1");
  const second = ModuleDiagram.derive([a[0], a[2], a[1]], "E1");
  const idOf = (diagram, cardId) => diagram.zones.flatMap((zone) => zone.nodes).find((node) => node.cardId === cardId).id;
  assert.equal(idOf(first, "E2"), idOf(second, "E2"));
  assert.equal(idOf(first, "E3"), "n-e3");
});

test("control characters and long text are cleaned to wire-format limits", () => {
  const long = "长".repeat(300);
  const nodes = [card("E1", null, { title: `【进行中】${long}` }), card("E2", "E1", { summary: `\u0007${long}` })];
  const diagram = checked(ModuleDiagram.derive(nodes, "E1"));
  assert.ok(Array.from(diagram.title).length <= 40);
  assert.ok(Array.from(diagram.zones[1].nodes[0].note).length <= 80);
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log(`ok - ${name}`); } catch (error) { failed++; console.log(`not ok - ${name}\n${error.stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
