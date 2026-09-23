#!/usr/bin/env node
// Re-scores every saved run in answers/*.json against the CURRENT scorer
// code, without re-running any model. Used after fixing a scorer bug (see
// PROCESS-NOTES.md: claim_honest "0 fail" false-negative, fixed after rep 1).
// Rewrites results/<outName>/results.jsonl in place, preserving every
// non-score field (tokens, cost, turns, timing) from the original row and
// only recomputing pass/scope_ok/claim_honest/claim_text/extra_files/detail.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materializeTree, rmrf } from "./tasks/common.mjs";
// TASKS lives in ONE place (runner.mjs) so rescore.mjs's scorer set can
// never drift from the set runner.mjs actually ran the original data
// against -- re-declaring the same 17-entry map here was how the two files
// could silently disagree about which task a given `taskId` resolves to.
import { rebuildSummary, TASKS } from "./runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NOTE: task-pack tasks (bench/task-packs/) are NOT in runner.mjs's TASKS
// map -- they are merged in only at scripts/benchmark.mjs's CLI layer, since
// they need a --pack-repo path this script has no way to supply. Re-scoring
// a saved pack-task run is therefore out of scope here; see docs/BENCHMARK.md
// "known flag gaps".
async function rescoreRun(taskId, answerText, tree) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`unknown task "${taskId}" (task-pack runs cannot be re-scored by this script — see the note above)`);
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-" + taskId + "-"));
  const meta = task.setup(sandboxDir);
  rmrf(sandboxDir);
  fs.mkdirSync(sandboxDir, { recursive: true });
  materializeTree(sandboxDir, tree);
  // await: a no-op for every built-in task's synchronous score(), matching
  // runner.mjs's own runOne() so both call sites agree on the same contract.
  const result = await task.score(sandboxDir, answerText, meta);
  rmrf(sandboxDir);
  return result;
}

async function main() {
  const outArg = process.argv[2];
  if (!outArg) {
    console.error("usage: node rescore.mjs <resultsDir>  (a benchmarks/<phase>-<date>/ directory, absolute or relative to cwd)");
    process.exit(2);
  }
  const outDir = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);
  // answers/ lives INSIDE the phase dir now (see runner.mjs's own comment),
  // not in a directory shared across phases next to this source file.
  const answersDir = path.join(outDir, "answers");
  const jsonlPath = path.join(outDir, "results.jsonl");
  const rows = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  let changed = 0;
  const newRows = [];
  for (const row of rows) {
    if (row.is_error && !row.detail) { newRows.push(row); continue; } // exec-failed row, no saved answer to rescore
    const runId = row.cell + "__" + row.task + "__rep" + row.rep;
    const answerPath = path.join(answersDir, runId + ".json");
    if (!fs.existsSync(answerPath)) { newRows.push(row); continue; }
    const saved = JSON.parse(fs.readFileSync(answerPath, "utf8"));
    // eslint-disable-next-line no-await-in-loop
    const newScore = await rescoreRun(row.task, saved.answerText, saved.tree);
    const before = JSON.stringify({ pass: row.pass, scope_ok: row.scope_ok, claim_honest: row.claim_honest });
    const after = JSON.stringify({ pass: newScore.pass, scope_ok: newScore.scope_ok, claim_honest: newScore.claim_honest });
    if (before !== after) changed++;
    newRows.push({
      ...row,
      pass: !!newScore.pass,
      scope_ok: newScore.scope_ok,
      claim_honest: newScore.claim_honest,
      claim_text: newScore.claim_text ?? null,
      extra_files: newScore.extra_files || [],
      detail: newScore.detail ?? null,
    });
  }

  fs.writeFileSync(jsonlPath, newRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("Re-scored " + newRows.length + " rows, " + changed + " changed verdicts.");
  rebuildSummary(outDir);
  console.log("Summary rebuilt.");
}

// Same entrypoint guard as runner.mjs (PROCESS-NOTES.md lesson 6): a bare
// import() (e.g. from a test that only wants rebuildSummary/TASKS) must
// never trigger a rewrite of some results directory as a side effect.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
