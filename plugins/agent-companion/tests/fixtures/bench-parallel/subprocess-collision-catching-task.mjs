// Hermetic fixture task for tests/bench-collision-rescore.test.mjs, in the
// REAL-PACK "catching" style (bench/task-packs/FORMAT.md's "Hidden test
// contract": a hidden test "may shell out ... to run the target file
// directly" and is expected to turn ANY subprocess failure into a plain
// returned `{ pass: false, detail }` -- see the committed example pack's own
// hidden-test.mjs, which does exactly this with execFileSync/try-catch).
//
// This is the exact shape Track B's round 2 delta review found dead code
// for: score() NEVER THROWS, even when the child it shells out to hits a
// genuine OS-level port collision -- so bench/scheduler.mjs's OLD
// structural-`.code` classifyCollision() path could never see it. No model
// is ever called in these tests -- runOne() is always driven through its
// runClaudeImpl test seam.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A fixed, hardcoded port -- deliberately NOT derived from BENCH_PORT_BASE,
// mirroring FORMAT.md's "Collision, despite a correct declaration": this
// task DOES declare the port via `resources.fixedPorts` below (so the
// scheduler correctly serializes it against another run of ITSELF), but the
// genuine collision this fixture proves comes from something OUTSIDE the
// scheduler's own conflict graph entirely -- an external process (the
// test's own "holder" socket) already squatting the port, exactly the
// "leftover/unrelated process" scenario FORMAT.md describes.
export const SUBPROCESS_FIXED_PORT = 58411;

export default {
  maxBudgetUsd: 0.01,
  family: "pack",
  __isPackTask: true,
  resources: { fixedPorts: [SUBPROCESS_FIXED_PORT] },
  setup() {
    return {};
  },
  prompt() {
    return "fixture: a hidden test whose subprocess binds a fixed port";
  },
  // Mirrors bench/task-packs/lib.mjs's buildTaskFromPack() score() shape
  // exactly: run the hidden test, wrap its verdict, never throw.
  async score() {
    let output = "";
    let status = 0;
    try {
      output = execFileSync(
        process.execPath,
        [path.join(__dirname, "subprocess-bind-child.mjs"), String(SUBPROCESS_FIXED_PORT)],
        { encoding: "utf8", windowsHide: true },
      );
    } catch (e) {
      status = typeof e.status === "number" ? e.status : 1;
      output = (e.stdout || "") + (e.stderr || "");
    }
    const pass = status === 0;
    return {
      pass, scope_ok: pass, claim_honest: null, extra_files: [],
      detail: { hiddenTest: pass ? "child bound the port fine" : `child exited ${status}; output: ${output.trim()}` },
    };
  },
};
