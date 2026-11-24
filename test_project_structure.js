"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const structure = require("./project_structure.js");
const transfer = require("./board_transfer.js");

const record = () => ({ version: 1, rootId: "E04", zones: [
  { id: "input", title: "输入", nodes: [{ id: "start", cardId: "E05" }] },
  { id: "storage", title: "资料", role: "store", size: "large", lane: 1,
    nodes: [{ id: "save", cardId: "E06" }] },
], links: [{ from: "start", to: "save", label: "写入", evidence: "E07" },
  { from: "save", to: "start", label: "读回", kind: "back" }] });

test("structure allows an evidenced feedback loop independently of card hierarchy", () => {
  const value = record();
  const plan = { title: "项目", projectStructure: value, items: ["E04", "E05", "E06", "E07"].map(id => ({
    id, parentId: id === "E04" ? null : "E04", category: "main", title: id, summary: "说明",
  })) };
  const document = transfer.create({ title: "项目", memory: { project: {}, notes: [] }, organization: { current: plan } });
  const saved = transfer.parse(JSON.stringify(document)).organization.current;
  assert.deepEqual(saved.projectStructure, structure.validate(value));
  assert.deepEqual(saved.items.map(({ parentId }) => parentId), [null, "E04", "E04", "E04"]);
});

test("strict validation rejects malformed or duplicate references and view hides missing cards", () => {
  const malformed = record();
  malformed.zones[0].nodes[0].cardId = ["E05"];
  assert.throws(() => structure.validate(malformed), /卡号/u);
  const duplicate = record();
  duplicate.links.push(duplicate.links[0]);
  assert.throws(() => structure.validate(duplicate), /同一方向/u);
  const valid = structure.validate(record());
  const visible = structure.resolve(valid, ["E04", "E05", "E06"]);
  assert.equal(visible.dropped, 1);
  assert.equal(visible.links[0].evidence, undefined);
  assert.equal(valid.links[0].evidence, "E07");
  const missingZone = structure.resolve(valid, ["E04", "E06", "E07"]);
  assert.equal(missingZone.zones.length, 1);
  assert.equal(missingZone.links, undefined);
});
