"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const schema = require("./experiment_data.js");
const transfer = require("./board_transfer.js");

const record = () => ({
  version: 1, kind: "独立对照", question: "候选是否改善固定留出？",
  comparison: {
    title: "固定留出", cohort: "相同输入与评估口径", baseline: "base", primary: "candidate",
    metrics: [{ label: "R²", direction: "higher" }, { label: "RMSE", direction: "lower" }],
    arms: [
      { id: "base", label: "基线", values: [-0.3, null] },
      { id: "candidate", label: "候选", values: [-0.2, 0.5] },
    ],
  },
});
test("experiment evidence survives organization cleanup and portable export without changing its scope", () => {
  const item = { id: "E04", parentId: null, category: "main", title: "实验", summary: "原结论",
    attachments: [{ id: "a".repeat(32), name: "curve.png", size: 120 }], experiment: record() };
  const window = { ExperimentData: schema, BoardMemory: { cleanAttachments: value => value || [] } };
  vm.runInNewContext(fs.readFileSync("organization.js", "utf8"), { window });
  const current = window.BoardOrganization.clean({ title: "项目", items: [item] });
  assert.deepEqual(JSON.parse(JSON.stringify(current.items[0].experiment)), record());
  const portable = transfer.parse(JSON.stringify(transfer.create({
    title: "项目", memory: { project: {}, notes: [] }, organization: { current },
  })));
  assert.deepEqual(portable.organization.current.items[0].experiment, record());
  assert.equal(portable.organization.current.items[0].parentId, null);
  assert.deepEqual(portable.organization.current.items[0].attachments, item.attachments);
});
test("missing results remain null while invalid or misleading experiment records are rejected", () => {
  assert.equal(schema.validate(record()).comparison.arms[0].values[1], null);
  for (const mutate of [
    value => { value.comparison.arms[1].id = "base"; },
    value => { value.comparison.primary = "missing"; },
    value => { value.comparison.arms[1].values[0] = Infinity; },
    value => { value.comparison.arms[1].values = [0.5]; },
    value => { value.comparison.metrics[0].direction = "unknown"; },
  ]) {
    const value = record();
    mutate(value);
    assert.throws(() => schema.validate(value));
    assert.equal(schema.clean(value), null);
  }
});
