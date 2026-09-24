// Hermetic fixture task, the counterpart to fixed-port-task.mjs: instead of
// a hardcoded port, it binds whatever runOne() assigned this run's slot via
// BENCH_PORT_BASE (bench/runner.mjs's scheduleCtx, passed as score()'s 4th
// arg) -- exactly the pattern docs/BENCHMARK.md tells a real pack to use so
// it can run concurrently. No model is ever called in these tests.

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

export default {
  maxBudgetUsd: 0.01,
  family: "fixture",
  // An EXPLICIT (even empty) resources declaration opts this task OUT of
  // FORMAT.md's "no declaration = exclusive with the same pack" default --
  // it is telling the scheduler "I do not need exclusivity; I bind via
  // BENCH_PORT_BASE instead", which is exactly what makes it safe to
  // co-schedule with another run of ITSELF, unlike fixed-port-task.mjs.
  resources: {},
  setup() {
    return {};
  },
  prompt() {
    return "fixture: bind BENCH_PORT_BASE";
  },
  async score(_sandboxDir, _answerText, _meta, ctx) {
    const port = (ctx && ctx.portBase) || Number(process.env.BENCH_PORT_BASE);
    const server = await listenOn(port);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await closeServer(server);
    return { pass: true, scope_ok: true, claim_honest: null, extra_files: [], detail: { boundPort: port } };
  },
};
