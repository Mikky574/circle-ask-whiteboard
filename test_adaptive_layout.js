const assert = require("node:assert/strict");
const { test } = require("node:test");
const { layoutAdaptive: layout, layoutBranches } = require("./geometry");

function assertNoOverlap(rects, moved) {
  const cards = [...new Map([...rects, ...moved])];
  for (const [index, [id, a]] of cards.entries()) {
    for (const [otherId, b] of cards.slice(index + 1)) {
      if (!moved.has(id) && !moved.has(otherId)) continue;
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x ||
        a.y + a.height <= b.y || b.y + b.height <= a.y, `${id} overlaps ${otherId}`);
    }
  }
}

function fittedScale(rects, viewport) {
  const cards = [...rects.values()];
  const width = Math.max(...cards.map(({ x, width }) => x + width)) - Math.min(...cards.map(({ x }) => x));
  const height = Math.max(...cards.map(({ y, height }) => y + height)) - Math.min(...cards.map(({ y }) => y));
  return Math.min(viewport.width / width, viewport.height / height);
}

test("fits an unbalanced tree of measured cards using more than one direction", () => {
  const root = { x: 0, y: 0, width: 388, height: 165 };
  const chapters = Array.from({ length: 6 }, (_, index) => ({
    id: `C${index}`, parentId: "R", width: 254, height: 106 + index * 11,
  }));
  const details = Array.from({ length: 22 }, (_, index) => ({
    id: `D${index}`, parentId: "C2", width: 244 + (index * 7) % 36, height: 90 + (index * 59) % 210,
  }));
  const descendants = [...chapters, ...details];
  const rects = layoutBranches(descendants.map(({ parentId, ...node }) => ({
    ...node, parentIds: parentId === "R" ? [] : [parentId],
  })), root, true, { twoSided: true, sectionColumns: true });
  rects.set("R", root);
  const nodes = [{ id: "R" }, ...descendants];
  const viewport = { width: 1668, height: 930 };
  const options = { fixedIds: ["R"], viewport };
  const result = layout(nodes, rects, ["R"], options);
  assert.equal(result.size, descendants.length);
  assertNoOverlap(rects, result);
  assert.ok(fittedScale(new Map([...rects, ...result]), viewport) > fittedScale(rects, viewport) * 1.5);
  assert.deepEqual(result, layout(nodes, rects, ["R"], options));
  for (const { id, width, height } of descendants) {
    assert.equal(result.get(id).width, width);
    assert.equal(result.get(id).height, height);
  }
});

test("keeps scoped roots, pinned descendants and surrounding cards fixed around obstacles", () => {
  const rects = new Map([
    ["R", { x: 0, y: 0, width: 200, height: 100 }],
    ["A", { x: 800, y: 100, width: 180, height: 80 }],
    ["B", { x: 800, y: 400, width: 220, height: 140 }],
    ["K", { x: 1000, y: 0, width: 180, height: 70 }],
    ["L", { x: 1000, y: 300, width: 250, height: 100 }],
    ["C", { x: 2000, y: 0, width: 150, height: 100 }],
    ["N", { x: -250, y: -400, width: 700, height: 340 }],
    ["W", { x: -500, y: -50, width: 440, height: 200 }],
    ["S", { x: -250, y: 160, width: 700, height: 340 }],
    ["E", { x: 260, y: -50, width: 440, height: 200 }],
  ]);
  const before = structuredClone(rects);
  const nodes = [{ id: "R" }, { id: "A", parentId: "R" }, { id: "B", parentId: "A" },
    { id: "K", parentId: "R" }, { id: "L", parentId: "K" }, { id: "C" },
    { id: "H", parentId: "R" }];
  const result = layout(nodes, rects, ["R"], { fixedIds: ["R", "K"] });
  assert.deepEqual(new Set(result.keys()), new Set(["A", "B", "L"]));
  assert.deepEqual(rects, before);
  assertNoOverlap(rects, result);
});

test("uses staggered columns when a dense scoped branch can only expand on one side", () => {
  const leaves = [318, 305, 318, 371, 340, 318, 281].map((height, index) => ({
    id: `L${index}`, parentId: "R", height,
  }));
  const rects = new Map([
    ["R", { x: 0, y: 0, width: 280, height: 550 }],
    ["N", { x: -300, y: -950, width: 600, height: 900 }],
    ["W", { x: -1000, y: -450, width: 940, height: 1400 }],
    ["S", { x: -300, y: 600, width: 600, height: 900 }],
    ...leaves.map(({ id, height }, index) => [id, { x: 332, y: index * 400, width: 280, height }]),
  ]);
  const result = layout([{ id: "R" }, ...leaves], rects, ["R"], { fixedIds: ["R"] });
  assert.equal(result.size, leaves.length);
  assert.deepEqual(new Set([...result.values()].map(({ x }) => x)), new Set([332, 638]));
  assertNoOverlap(rects, result);
});

test("keeps a short ordered chain straight with consistent edge gaps", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const nodes = ids.map((id, index) => ({ id, parentId: ids[index - 1] }));
  const rects = new Map(ids.map((id, index) => [id, {
    x: 0, y: 0, width: 240 + index * 7, height: 120 + (index * 57) % 260,
  }]));
  const result = layout(nodes, rects, ["a"], { fixedIds: ["a"] });
  const cards = ids.map((id) => result.get(id) || rects.get(id));
  const directions = cards.slice(1).map((card, index) => {
    const previous = cards[index];
    if (card.x === previous.x + previous.width + 52 &&
      card.y + card.height / 2 === previous.y + previous.height / 2) return "east";
    if (card.y === previous.y + previous.height + 52 &&
      card.x + card.width / 2 === previous.x + previous.width / 2) return "south";
    return null;
  });
  assert.ok(directions[0]);
  assert.equal(new Set(directions).size, 1);
  assertNoOverlap(rects, result);
});
