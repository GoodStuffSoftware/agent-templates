// Hermetic fixture task for tests/bench-scheduler.test.mjs. Stands in for a
// real benchmark task whose model-run work starts a real listener on a
// hardcoded port (the exact shape docs/BENCHMARK.md's "Parallel runs"
// section calls out as unsafe to co-schedule). No model is ever called --
// runOne() is always driven with a stubbed runClaudeImpl in these tests --
// this fixture's `score()` does the real, in-process net.Server bind so the
// test proves genuine EADDRINUSE behavior, not a mocked approximation.
//
// The port is fixed for the task's whole life (that is the point: it is
// declared in resources.fixedPorts, never derived from BENCH_PORT_BASE), but
// it is chosen by the calling test from an OS-assigned port (see ports.mjs)
// rather than baked in here. A baked-in number is shared by every test
// process on the machine, so concurrent suite runs collided on it.
// `beforeBind`, if given, is awaited right before each bind -- a test that
// reserved the port (ports.mjs reservePort) releases it there.

import net from "node:net";

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function makeFixedPortTask(port, { beforeBind } = {}) {
  return {
    maxBudgetUsd: 0.01,
    family: "fixture",
    // Declares the fixed port -- see bench/task-packs/FORMAT.md "Resource
    // declarations". The scheduler must never co-schedule two runs of this
    // task (or any other run declaring the same fixedPorts entry).
    resources: { fixedPorts: [port] },
    setup() {
      return {};
    },
    prompt() {
      return "fixture: bind a fixed port";
    },
    async score(_sandboxDir, _answerText, _meta, _ctx) {
      // Real bind/hold/release, mimicking a test suite the model's own work
      // would have started. A genuine EADDRINUSE here (another run already
      // holding the port) propagates as a thrown error, which runOne()
      // captures into scoreResult.detail.scorerError -- exactly what
      // bench/scheduler.mjs's classifyCollision() is built to recognize.
      if (beforeBind) await beforeBind();
      const server = await listenOn(port);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await closeServer(server);
      return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] };
    },
  };
}
