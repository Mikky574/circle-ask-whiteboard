"use strict";

// `stopping` synchronously invalidates local work while /api/cancel is pending.
(function (root) {
  function accepts(run, currentRun) {
    return currentRun === run && !run.stopping && !run.controller.signal.aborted;
  }

  async function stop(run, cancel) {
    if (!run || run.stopping) return;
    run.stopping = true;
    try {
      await cancel();
    } catch {
      // Local invalidation already prevents late events from being applied.
    } finally {
      run.controller.abort();
    }
  }

  const api = { accepts, stop };
  root.WhiteboardRunGate = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
