const assert = require("node:assert/strict");
const { test } = require("node:test");
const { roundedOrthogonalPath, sharedBranchRoutes } = require("./geometry");

test("rounds an open corner and keeps both original card ports", () => {
  const points = [[-40, 0], [-25, 0], [-25, 0], [0, 0], [0, 40]];
  assert.equal(roundedOrthogonalPath(points, []), "M-40,0 L-18,0 Q0,0 0,18 L0,40");
});

test("keeps a right angle when a rounded corner would enter a narrow clearance", () => {
  const points = [[-40, 0], [0, 0], [0, 40]];
  const obstacle = { x: -9, y: 3, width: 6, height: 6 };
  assert.equal(roundedOrthogonalPath(points, [obstacle]), "M-40,0 L0,0 L0,40");
});

test("rounded shared paths align with the child-specific paths and selectable tails", () => {
  const parent = { x: 0, y: 0, width: 70, height: 40 };
  const children = [{ id: "above", rect: { x: 160, y: -40, width: 70, height: 40 } },
    { id: "below", rect: { x: 160, y: 80, width: 70, height: 40 } }];
  const [bundle] = sharedBranchRoutes(parent, children, [parent, ...children.map(({ rect }) => rect)], "x");
  assert.match(bundle.d, / Q/);
  assert.deepEqual(bundle.edges.map(({ id, hit }) => [id, hit]), [
    ["above", "M115,-20 L160,-20"], ["below", "M115,100 L160,100"],
  ]);
  for (const { d } of bundle.edges) assert.ok(bundle.d.includes(d));
});
