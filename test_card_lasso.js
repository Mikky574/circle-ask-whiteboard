"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { cardLassoHits } = require("./geometry.js");

const polygon = points => points.map(([x, y]) => ({ x, y }));
const card = (id, x, y, width, height) => ({ id, rect: { x, y, width, height } });

test("a slightly missed edge selects the whole intentional card without selecting the neighboring card", () => {
  const points = polygon([[15, -10], [102, -10], [102, 92], [15, 92]]);
  const cards = [card("main", 0, 0, 100, 100), card("neighbor", 94, 0, 100, 100)];
  assert.deepEqual(cardLassoHits(points, cards), []);
  assert.deepEqual(cardLassoHits(points, cards, { allowLoose: true }), ["main"]);
  assert.deepEqual(cardLassoHits([...points].reverse(), cards, { allowLoose: true }), ["main"]);
});

test("loose selection does not turn a centered text region or a cutout into a whole card hit", () => {
  const points = polygon([[34, 33], [66, 33], [66, 67], [34, 67]]);
  const cards = [card("text-owner", 0, 0, 100, 100)];
  assert.deepEqual(cardLassoHits(points, cards, { allowLoose: true }), []);
  const cutout = polygon([[-4, -4], [104, -4], [104, 104], [64, 104], [64, 24], [36, 24], [36, 104], [-4, 104]]);
  assert.deepEqual(cardLassoHits(cutout, cards, { allowLoose: true }), []);
});
