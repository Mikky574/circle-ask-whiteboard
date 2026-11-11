"use strict";

const assert = require("assert");
const gate = require("./run_gate.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function testStopInvalidatesLateEventsBeforeCancelResponse() {
  const controller = new AbortController();
  const run = { controller, stopping: false };
  const delayedCancel = deferred();
  const applied = [];
  const stopping = gate.stop(run, () => delayedCancel.promise);

  assert.equal(run.stopping, true, "stop must invalidate locally before /api/cancel responds");
  assert.equal(controller.signal.aborted, false, "local stream aborts only after cancel request settles");
  for (const type of ["map", "done"]) {
    if (gate.accepts(run, run)) applied.push(type);
  }
  assert.deepEqual(applied, [], "late map/done must not apply while cancel is delayed");
  delayedCancel.resolve();
  await stopping;
  assert.equal(controller.signal.aborted, true, "local stream aborts in the cancellation finally path");
}

function testCurrentUnstoppedRunAcceptsEvents() {
  const run = { controller: new AbortController(), stopping: false };
  assert.equal(gate.accepts(run, run), true);
  assert.equal(gate.accepts(run, {}), false);
}

(async () => {
  await testStopInvalidatesLateEventsBeforeCancelResponse();
  testCurrentUnstoppedRunAcceptsEvents();
  console.log("run gate behavior: PASS");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
