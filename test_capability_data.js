"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const schema = require("./capability_data.js");
const transfer = require("./board_transfer.js");
const record = () => ({ version: 1, audience: "复核者", input: "图片",
  outcome: "识别或提示不确定", boundary: "不自动确认物种", verification: "低置信输入应提示复核，待验证" });

test("user-facing capability and separate evidence survive cleanup and portable round-trip", () => {
  const item = { id: "E04", parentId: null, category: "main", title: "识别图片", summary: "得到可复核结果",
    capability: record(), repositoryFiles: ["src/predict.py"] };
  const window = { CapabilityData: schema };
  vm.runInNewContext(fs.readFileSync("organization.js", "utf8"), { window });
  const current = window.BoardOrganization.clean({ title: "项目", items: [item] });
  assert.deepEqual(JSON.parse(JSON.stringify(current.items[0].capability)), record());
  const portable = transfer.parse(JSON.stringify(transfer.create({ title: "项目",
    memory: { project: {}, notes: [] }, organization: { current } })));
  assert.deepEqual(portable.organization.current.items[0].capability, record());
  assert.deepEqual(portable.organization.current.items[0].repositoryFiles, ["src/predict.py"]);
  assert.equal(portable.organization.current.items[0].summary, item.summary);
});

test("incomplete outcome records are rejected without banning useful domain vocabulary", () => {
  assert.equal(schema.validate({ ...record(), outcome: "导出 ONNX，供设备离线识别" }).outcome, "导出 ONNX，供设备离线识别");
  for (const change of [{ outcome: " " }, { verification: "x".repeat(201) }, { version: 2 }, { internalOnly: "value" }]) {
    const value = { ...record(), ...change };
    assert.throws(() => schema.validate(value));
    assert.equal(schema.clean(value), null);
  }
});
