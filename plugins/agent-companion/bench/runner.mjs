#!/usr/bin/env node
// Model x effort benchmark runner.
//
// Usage:
//   node runner.mjs --cells <id,id,...|all> --tasks <id,id,...|all>
//                    --reps <N> [--rep-start <N>] --out <dir>
//
// Runs one fresh claude -p process per (cell, task, rep), scores the
// answer with that task's scorer, appends one JSONL row per run to
// <out>/results.jsonl, saves the run's full answer text + final sandbox
// tree to <out>/../../answers/<runId>.json (for re-scoring without
// re-running), and rewrites <out>/summary.json + <out>/summary.md from
// every row currently in results.jsonl (so it accumulates across separate
// invocations, e.g. one invocation per cell).
//
// Turn-limit note: this CLI (2.1.278) has no --max-turns flag and
// --settings maxTurns is not honored (verified empirically, see
// PROCESS-NOTES.md). The only working per-run cost lever is
// --max-budget-usd, sized per task below.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { dataDir, classifyModel, modelTiers } from "../hooks/lib/context.mjs";

import lookupTask from "./tasks/lookup.mjs";
import verifyTask from "./tasks/verify.mjs";
import procedureTask from "./tasks/procedure.mjs";
import boundedEditTask from "./tasks/bounded-edit.mjs";
import diagnosisTask from "./tasks/diagnosis.mjs";
import instructionLogicTask from "./tasks/instruction-logic.mjs";
import hardVerifyTask from "./tasks/hard-verify.mjs";
import hardProcedureTask from "./tasks/hard-procedure.mjs";
import hardDiagnosisTask from "./tasks/hard-diagnosis.mjs";
import hardInstructionLogicTask from "./tasks/hard-instruction-logic.mjs";
import realCapacityTask from "./tasks/real-capacity.mjs";
import realSecretScanTask from "./tasks/real-secret-scan.mjs";
import realOptFallbackTask from "./tasks/real-opt-fallback.mjs";
import realEffortNoteTask from "./tasks/real-effort-note.mjs";
import realPublicationSweepTask from "./tasks/real-publication-sweep.mjs";
import realMisleadingReportTask from "./tasks/real-misleading-report.mjs";
import realContradictorySpecTask from "./tasks/real-contradictory-spec.mjs";
import { snapshotTree, rmrf } from "./tasks/common.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve a real, directly-spawnable claude binary. On Windows, "claude"
// resolves to claude.cmd, and Node's execFile cannot spawn .cmd files
// without shell:true (spawn EINVAL) -- and shell:true risks cmd.exe
// mis-quoting long multi-line task prompts. So find the underlying .exe
// (or native binary on POSIX) once, up front, and spawn that directly.
export function resolveClaudeBin() {
  if (process.platform !== "win32") return "claude";
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    // claude.exe itself is not on PATH (only the claude.cmd shim is), so
    // locate claude.cmd via `where`, then derive the sibling .exe path
    // the same way the .cmd file itself does internally.
    const out = execFileSync("where", ["claude.cmd"], { encoding: "utf8", windowsHide: true });
    const cmdPath = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (cmdPath) {
      const dp0 = path.dirname(cmdPath);
      const exePath = path.join(dp0, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (fs.existsSync(exePath)) return exePath;
    }
  } catch {
    // fall through to the error below
  }
  throw new Error("Could not resolve claude.exe from claude.cmd's location. Set CLAUDE_BIN to its full path.");
}

// LAZY, not resolved at module load: this module (and TASKS/CELLS/parseArgs
// off it) must stay importable in a --dry-run or a test process that has no
// `claude` binary at all -- resolution only has to succeed on the path that
// actually spawns a model (runClaude()), never merely to inspect the plan.
let _claudeBin = null;
function getClaudeBin() {
  if (!_claudeBin) _claudeBin = resolveClaudeBin();
  return _claudeBin;
}


export const TASKS = {
  lookup: lookupTask,
  verify: verifyTask,
  procedure: procedureTask,
  "bounded-edit": boundedEditTask,
  diagnosis: diagnosisTask,
  "instruction-logic": instructionLogicTask,
  "hard-verify": hardVerifyTask,
  "hard-procedure": hardProcedureTask,
  "hard-diagnosis": hardDiagnosisTask,
  "hard-instruction-logic": hardInstructionLogicTask,
  "real-capacity": realCapacityTask,
  "real-secret-scan": realSecretScanTask,
  "real-opt-fallback": realOptFallbackTask,
  "real-effort-note": realEffortNoteTask,
  "real-publication-sweep": realPublicationSweepTask,
  "real-misleading-report": realMisleadingReportTask,
  "real-contradictory-spec": realContradictorySpecTask,
};

// Full model IDs only -- aliases are version-dependent (verified: on CLI
// 2.1.278 the opus alias still resolves to claude-opus-5, not 5.5).
export const CELLS = {
  haiku: { model: "claude-haiku-4-5", effort: null },
  "sonnet-low": { model: "claude-sonnet-5", effort: "low" },
  "sonnet-medium": { model: "claude-sonnet-5", effort: "medium" },
  "sonnet-high": { model: "claude-sonnet-5", effort: "high" },
  "sonnet-xhigh": { model: "claude-sonnet-5", effort: "xhigh" },
  "opus5-low": { model: "claude-opus-5", effort: "low" },
  "opus5-medium": { model: "claude-opus-5", effort: "medium" },
  "opus5-high": { model: "claude-opus-5", effort: "high" },
  "opus5-xhigh": { model: "claude-opus-5", effort: "xhigh" },
  "opus55-low": { model: "claude-opus-5-5", effort: "low" },
  "opus55-medium": { model: "claude-opus-5-5", effort: "medium" },
  "opus55-high": { model: "claude-opus-5-5", effort: "high" },
  "opus55-xhigh": { model: "claude-opus-5-5", effort: "xhigh" },
};

// Default output root: the plugin's own data dir, NEVER the repo -- a
// benchmark result carries per-run cost/token figures and full saved answer
// text, which is exactly the kind of local, ever-growing, never-reviewable
// data this plugin's own README (State) says does not belong under version
// control. dataDir() is the SAME shared resolver every other script here
// uses (hooks/lib/context.mjs), so a benchmark run lands next to telemetry/
// and state/ rather than inventing its own location.
export function defaultResultsRoot() {
  return path.join(dataDir(), "benchmarks");
}

export function parseArgs(argv) {
  const out = { cells: "all", tasks: "all", reps: 3, repStart: 1, out: null, maxBudgetUsd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cells") out.cells = argv[++i];
    else if (a === "--tasks") out.tasks = argv[++i];
    else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--rep-start") out.repStart = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-budget-usd") out.maxBudgetUsd = Number(argv[++i]);
    else throw new Error("unknown arg: " + a);
  }
  return out;
}

export function resolveList(spec, table) {
  if (spec === "all") return Object.keys(table);
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

// A fresh, throwaway HOME/USERPROFILE for EVERY run, never the operator's
// real one. `--setting-sources ""` (below) already skips reading this
// machine's hooks/CLAUDE.md/plugins/skills, but it does NOT stop the
// spawned process from WRITING a session transcript under
// <home>/.claude/projects/** -- that is core session logging, not a
// "setting source". Without this, a benchmark run (especially an
// unattended one, which is exactly what --batch-by/--resume enable) would
// silently accumulate real transcript files under the operator's actual
// ~/.claude. Cleaned up alongside the sandbox in the run's `finally`.
function makeFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-home-"));
  return dir;
}

function runClaude({ cwd, prompt, model, effort, maxBudgetUsd, fakeHome }) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--model", model,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--max-budget-usd", String(maxBudgetUsd),
    ];
    if (effort) args.push("--effort", effort);
    const startedAt = Date.now();
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
    };
    // Windows resolves the user profile via HOMEDRIVE+HOMEPATH separately
    // from USERPROFILE in some code paths -- set both so nothing falls
    // through to the real profile. fakeHome is always an absolute
    // `<drive>:\...` path here (os.tmpdir()-derived), so a plain 2-char
    // slice for the drive and the remainder for the path is exact.
    if (process.platform === "win32") {
      env.HOMEDRIVE = fakeHome.slice(0, 2);
      env.HOMEPATH = fakeHome.slice(2);
    }
    execFile(
      getClaudeBin(), args,
      {
        cwd, env, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, timeout: 15 * 60 * 1000,
        // No visible console window per spawned process on Windows -- a
        // batch of dozens of runs must never pop a window per run. See
        // docs/BENCHMARK.md's "Windows spawn fix" and the
        // no-visible-windows static test.
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const wallMs = Date.now() - startedAt;
        let json = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
        resolve({ json, stdout, stderr, err: err ? String(err.message || err) : null, wallMs });
      },
    );
  });
}

export async function runOne({ cellId, cell, taskId, task, rep, outDir, answersDir, maxBudgetUsdCeiling }) {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-" + cellId + "-" + taskId + "-"));
  const fakeHome = makeFakeHome();
  let meta;
  try {
    meta = task.setup(sandboxDir);
  } catch (e) {
    rmrf(sandboxDir);
    rmrf(fakeHome);
    throw e;
  }
  const promptText = task.prompt(meta);

  // The per-run runaway guard is the TIGHTER of the task's own calibrated
  // budget and an optional global ceiling (scripts/benchmark.mjs's
  // --max-budget-usd) -- never looser than what the task itself declared.
  const effectiveBudget = typeof maxBudgetUsdCeiling === "number"
    ? Math.min(task.maxBudgetUsd, maxBudgetUsdCeiling)
    : task.maxBudgetUsd;

  const { json, stdout, stderr, err, wallMs } = await runClaude({
    cwd: sandboxDir,
    prompt: promptText,
    model: cell.model,
    effort: cell.effort,
    maxBudgetUsd: effectiveBudget,
    fakeHome,
  });

  const answerText = json ? (json.result ?? "") : "";
  let scoreResult;
  try {
    // `await` works identically whether task.score() is synchronous (every
    // built-in task) or returns a Promise (a task-pack task, whose scorer
    // runs a dynamically-imported hidden-test module) -- awaiting a plain
    // value is a no-op, so this is not a behavior change for existing tasks.
    scoreResult = await task.score(sandboxDir, answerText, meta);
  } catch (e) {
    scoreResult = { pass: false, scope_ok: null, claim_honest: null, extra_files: [], detail: { scorerError: String((e && e.stack) || e) } };
  }

  const finalTree = (() => {
    try {
      return snapshotTree(sandboxDir);
    } catch {
      return {};
    }
  })();

  const runId = cellId + "__" + taskId + "__rep" + rep;
  fs.writeFileSync(
    path.join(answersDir, runId + ".json"),
    JSON.stringify({ runId, answerText, tree: finalTree }, null, 2),
  );

  rmrf(sandboxDir);
  rmrf(fakeHome);

  const usage = (json && json.usage) || {};
  const modelUsage = (json && json.modelUsage) || {};
  const modelKeys = Object.keys(modelUsage);
  const resolvedModel = modelKeys[0] || null;
  const mu = resolvedModel ? modelUsage[resolvedModel] : {};

  const row = {
    ts: new Date().toISOString(),
    cell: cellId,
    task: taskId,
    rep,
    requested_model: cell.model,
    resolved_model: resolvedModel,
    model_mismatch: resolvedModel !== null && resolvedModel !== cell.model,
    requested_effort: cell.effort,
    pass: !!scoreResult.pass,
    scope_ok: scoreResult.scope_ok,
    claim_honest: scoreResult.claim_honest,
    claim_text: scoreResult.claim_text ?? null,
    extra_files: scoreResult.extra_files || [],
    input_tokens: mu.inputTokens ?? usage.input_tokens ?? null,
    cache_read_tokens: mu.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? null,
    cache_creation_tokens: mu.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? null,
    output_tokens: mu.outputTokens ?? usage.output_tokens ?? null,
    thinking_tokens: mu.thinkingTokens ?? (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) ?? null,
    cost_usd: (json && json.total_cost_usd) ?? null,
    num_turns: (json && json.num_turns) ?? null,
    duration_ms: (json && json.duration_ms) ?? wallMs,
    duration_api_ms: (json && json.duration_api_ms) ?? null,
    is_error: json ? !!json.is_error : true,
    subtype: (json && json.subtype) || null,
    terminal_reason: (json && json.terminal_reason) || null,
    session_id: (json && json.session_id) || null,
    exec_err: err,
    detail: scoreResult.detail ?? null,
  };

  fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function priceWeightedTokens(row) {
  // Rough relative weighting: output/thinking tokens cost far more than
  // cached input reads. Used only for the RELATIVE COST INDEX, not for any
  // dollar figure (cost_usd is logged separately from the real API price).
  const inp = row.input_tokens || 0;
  const cacheRead = row.cache_read_tokens || 0;
  const cacheWrite = row.cache_creation_tokens || 0;
  const out = row.output_tokens || 0;
  return inp * 1 + cacheRead * 0.1 + cacheWrite * 1.25 + out * 5;
}

// bench/config/model-tiers.json's planUsageMultipliers table, resolved by
// TIER ALIAS (classifyModel() on the cell's full model id, e.g.
// "claude-opus-5-5" -> "opus"). A tier with no entry there (haiku, fable --
// never measured) returns null, not a guessed number -- an absent
// plan_usage_index in the summary means "not measured", not "1.0".
function planUsageMultiplier(fullModelId) {
  const alias = classifyModel(fullModelId).alias;
  const entry = (modelTiers().planUsageMultipliers || {})[alias];
  return typeof entry?.multiplier === "number" ? entry.multiplier : null;
}

export function rebuildSummary(outDir) {
  const jsonlPath = path.join(outDir, "results.jsonl");
  if (!fs.existsSync(jsonlPath)) return;
  const rows = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const byCellTask = new Map();
  for (const r of rows) {
    const key = r.cell + "::" + r.task;
    if (!byCellTask.has(key)) byCellTask.set(key, []);
    byCellTask.get(key).push(r);
  }

  const baseline = new Map();
  for (const [key, group] of byCellTask) {
    const parts = key.split("::");
    const cell = parts[0];
    const task = parts[1];
    if (cell === "sonnet-medium") {
      baseline.set(task, median(group.map(priceWeightedTokens)));
    }
  }

  const summaryRows = [];
  for (const [key, group] of byCellTask) {
    const parts = key.split("::");
    const cell = parts[0];
    const task = parts[1];
    const passRate = group.filter((r) => r.pass).length / group.length;
    const honestDenom = group.filter((r) => r.claim_honest !== null).length;
    const claimHonestRate = honestDenom ? group.filter((r) => r.claim_honest === true).length / honestDenom : null;
    const scopeDenom = group.filter((r) => r.scope_ok !== null).length;
    const scopeOkRate = scopeDenom ? group.filter((r) => r.scope_ok === true).length / scopeDenom : null;
    const medOut = median(group.map((r) => r.output_tokens));
    const medIn = median(group.map((r) => r.input_tokens));
    const medCacheRead = median(group.map((r) => r.cache_read_tokens));
    const medCacheWrite = median(group.map((r) => r.cache_creation_tokens));
    const medCost = median(group.map((r) => r.cost_usd));
    const medTurns = median(group.map((r) => r.num_turns));
    const medDuration = median(group.map((r) => r.duration_ms));
    const pwt = median(group.map(priceWeightedTokens));
    const base = baseline.get(task);
    const relIndex = base ? pwt / base : null;
    const nCorrect = group.filter((r) => r.pass).length;
    const costPerCorrect = nCorrect > 0 ? (group.reduce((s, r) => s + (r.cost_usd || 0), 0) / nCorrect) : null;
    // Plan-usage index: the token-cost ratio to the sonnet-medium baseline,
    // scaled by this cell's plan-usage multiplier relative to sonnet's
    // (sonnet's own multiplier is defined as 1.0, so this reduces to
    // relIndex when the cell IS sonnet). null whenever either side is
    // unmeasured -- see planUsageMultiplier() above.
    const cellMultiplier = planUsageMultiplier(group[0]?.requested_model);
    const planUsageIndex = (relIndex != null && cellMultiplier != null) ? relIndex * cellMultiplier : null;

    summaryRows.push({
      cell, task, n: group.length,
      pass_rate: passRate,
      // EXPERIMENTAL: a word-bag heuristic (bench/tasks/common.mjs), not a
      // verified signal -- known to under-read on long, hedged answers (see
      // docs/BENCHMARK.md). Never treat a low rate here as a quality
      // finding without reading the actual claim text.
      claim_honest_rate: claimHonestRate,
      claim_honest_experimental: true,
      scope_ok_rate: scopeOkRate,
      median_input_tokens: medIn,
      median_cache_read_tokens: medCacheRead,
      median_cache_write_tokens: medCacheWrite,
      median_output_tokens: medOut,
      median_num_turns: medTurns,
      median_duration_ms: medDuration,
      median_cost_usd: medCost,
      cost_per_correct_usd: costPerCorrect,
      relative_cost_index: relIndex,
      plan_usage_index: planUsageIndex,
    });
  }

  summaryRows.sort((a, b) => (a.task + a.cell).localeCompare(b.task + b.cell));
  // A bare array, same shape as before -- each row already self-documents
  // via claim_honest_experimental:true rather than requiring a reader to
  // also fetch a separate top-level note.
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summaryRows, null, 2));

  const header = ["cell", "task", "n", "pass_rate", "claim_honest*", "scope_ok", "med_out_tok", "med_turns", "med_cost_usd", "cost_per_correct", "rel_cost_idx", "plan_usage_idx"];
  const lines = [
    "* claim_honest is EXPERIMENTAL — a word-bag heuristic known to under-read on long/hedged answers. See docs/BENCHMARK.md before treating a low rate as a quality finding.",
    "",
    header.join(" | "),
    header.map(() => "---").join(" | "),
  ];
  for (const r of summaryRows) {
    lines.push([
      r.cell, r.task, r.n,
      (r.pass_rate * 100).toFixed(0) + "%",
      r.claim_honest_rate != null ? (r.claim_honest_rate * 100).toFixed(0) + "%" : "n/a",
      r.scope_ok_rate != null ? (r.scope_ok_rate * 100).toFixed(0) + "%" : "n/a",
      r.median_output_tokens ?? "n/a",
      r.median_num_turns ?? "n/a",
      r.median_cost_usd != null ? "$" + r.median_cost_usd.toFixed(3) : "n/a",
      r.cost_per_correct_usd != null ? "$" + r.cost_per_correct_usd.toFixed(3) : "n/a",
      r.relative_cost_index != null ? r.relative_cost_index.toFixed(2) + "x" : "n/a",
      r.plan_usage_index != null ? r.plan_usage_index.toFixed(2) + "x" : "n/a (unmeasured tier)",
    ].join(" | "));
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n") + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cellIds = resolveList(args.cells, CELLS);
  const taskIds = resolveList(args.tasks, TASKS);
  // RESULTS NEVER GO IN THE REPO. --out, when given, may be relative (to
  // the CURRENT working directory, not this file's directory -- a repo
  // checkout is exactly the wrong default root) or absolute. With no --out
  // at all, default to the plugin's data dir (defaultResultsRoot()), never
  // to anything under this source tree.
  const outDir = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.resolve(process.cwd(), args.out))
    : path.join(defaultResultsRoot(), "pilot-" + new Date().toISOString().slice(0, 10));
  // answers/ lives INSIDE the phase dir (outDir), not alongside it -- see
  // docs/BENCHMARK.md: every artifact for one benchmark phase (results.jsonl,
  // summary.json/md, answers/) stays together under one benchmarks/<phase>-
  // <date>/ directory rather than a shared answers/ pool across phases.
  const answersDir = path.join(outDir, "answers");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(answersDir, { recursive: true });

  for (const cellId of cellIds) {
    const cell = CELLS[cellId];
    if (!cell) throw new Error("unknown cell: " + cellId);
    for (const taskId of taskIds) {
      const task = TASKS[taskId];
      if (!task) throw new Error("unknown task: " + taskId);
      for (let rep = args.repStart; rep < args.repStart + args.reps; rep++) {
        const t0 = Date.now();
        process.stdout.write("[" + new Date().toISOString() + "] START " + cellId + " / " + taskId + " / rep" + rep + " ... ");
        try {
          const row = await runOne({ cellId, cell, taskId, task, rep, outDir, answersDir });
          process.stdout.write("pass=" + row.pass + " cost=$" + row.cost_usd + " turns=" + row.num_turns + " (" + (Date.now() - t0) + "ms)\n");
        } catch (e) {
          process.stdout.write("ERROR: " + ((e && e.stack) || e) + "\n");
          fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify({
            ts: new Date().toISOString(), cell: cellId, task: taskId, rep, pass: false, is_error: true, exec_err: String((e && e.message) || e),
          }) + "\n");
        }
      }
    }
  }

  rebuildSummary(outDir);
  console.log("Done. Summary written to " + path.join(outDir, "summary.md"));
}


const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
