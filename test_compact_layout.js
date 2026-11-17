const assert = require("node:assert/strict");
const { test } = require("node:test");
const geometry = require("./geometry");

global.window = { BoardGeometry: geometry };
require("./organization");
const { branchVisibility, guideLayout } = window.BoardOrganization;

test("a short branch fits between the visible cards of a deeper sibling", () => {
  const nodes = [
    ["A", null, 72], ["A1", "A", 72], ["A11", "A1", 350],
    ["A2", "A", 72], ["A21", "A2", 350], ["B", null, 72], ["B1", "B", 36],
  ].map(([id, parent, height]) => ({ id, parentIds: parent ? [parent] : [], width: 280, height }));
  const rects = geometry.layoutBranches(nodes, { x: 0, y: 0, width: 420, height: 156 }, true,
    { twoSided: false });
  const first = rects.get("A");
  const second = rects.get("B");
  const detail = rects.get("B1");
  assert.equal(second.y - first.y - first.height, 22);
  assert.ok(rects.get("A1").y + rects.get("A1").height + 22 <= detail.y);
  assert.ok(detail.y + detail.height + 22 <= rects.get("A2").y);
});

test("a compact guide fills available neighboring space without waiting for a deep subtree", () => {
  const cards = [
    ["E01", null, 100], ["E02", "E01", 96], ["E03", "E01", 180],
    ["E04", "E02", 80], ["E05", "E02", 72], ["E06", "E02", 72], ["E07", "E02", 72],
    ["E08", "E04", 420], ["E09", "E03", 1000],
  ];
  const items = cards.map(([id, parentId]) => ({ id, parentId, category: "main" }));
  const sizes = new Map(cards.map(([id, , height]) => [id, { height }]));
  const { hidden } = branchVisibility(items, ["E03"]);
  const rects = guideLayout(items.filter(({ id }) => !hidden.has(id)), sizes,
    { rootId: "E01", x: 0, y: 0 }, { density: "compact" });
  const chapter = rects.get("E02");
  const neighbor = rects.get("E03");
  const first = rects.get("E04");
  const second = rects.get("E05");
  assert.equal(first.y - chapter.y - chapter.height, 20);
  assert.equal(second.y - neighbor.y - neighbor.height, 20);
  assert.ok(second.x > first.x + first.width);
  for (const [before, after] of [["E05", "E06"], ["E06", "E07"]]) {
    const upper = rects.get(before);
    const lower = rects.get(after);
    assert.equal(lower.x, upper.x);
    assert.equal(lower.y - upper.y - upper.height, 12);
  }
  assert.ok(rects.get("E07").y < rects.get("E08").y + rects.get("E08").height);
  assert.equal(rects.has("E09"), false);
});
