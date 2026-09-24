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
import { dataDir, classifyModel, classifyReferenceModel, modelTiers } from "../hooks/lib/context.mjs";

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
import { snapshotTree, rmrf, GUARD_REL_PATH } from "./tasks/common.mjs";
import { wilsonInterval, passAtK, formatInterval, MIN_N_TO_SEPARATE } from "./stats.mjs";
import {
  sha256, runJudge, treeDiff, checkJudgeEligibility, assertJudgeCalibrated, makeCliJudgeCaller,
} from "./judge.mjs";
import { classifyCollision, portBaseForSlot } from "./scheduler.mjs";
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
export function getClaudeBin() {
  if (!_claudeBin) _claudeBin = resolveClaudeBin();
  return _claudeBin;
}

// `claude --version`, resolved once per process and stamped on every
// results.jsonl row (claude_cli_version) -- a harness change is one of the
// three things a score shift can come from (harness, task content, model),
// and a row that does not name its harness cannot rule it out. null when the
// binary cannot be asked (never a guess).
let _cliVersion;
export function getClaudeCliVersion() {
  if (_cliVersion !== undefined) return _cliVersion;
  try {
    const out = execFileSync(getClaudeBin(), ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    _cliVersion = String(out).trim().split(/\r?\n/)[0] || null;
  } catch {
    _cliVersion = null;
  }
  return _cliVersion;
}

// The default judge transport (bench/judge.mjs): one fresh `claude -p` per
// vote, spawned through the same lazily-resolved binary as a benchmark run.
export const cliJudgeCaller = makeCliJudgeCaller(getClaudeBin);

// Task families: the coarse unit a summary's confidence intervals are
// reported over (per-task n is usually 1-3, far too small on its own).
// Task-pack tasks report family "pack". Re-exported by scripts/benchmark.mjs,
// which also uses these as --tasks shorthands.
export const TASK_FAMILIES = {
  easy: ["lookup", "verify", "procedure", "bounded-edit", "diagnosis", "instruction-logic"],
  hard: ["hard-verify", "hard-procedure", "hard-diagnosis", "hard-instruction-logic"],
  real: [
    "real-capacity", "real-secret-scan", "real-opt-fallback", "real-effort-note",
    "real-publication-sweep", "real-misleading-report", "real-contradictory-spec",
  ],
};

export function taskFamilyOf(taskId, { task = null, row = null } = {}) {
  if (row && row.task_family) return row.task_family;
  if (task && task.family) return task.family;
  for (const [fam, ids] of Object.entries(TASK_FAMILIES)) if (ids.includes(taskId)) return fam;
  if ((task && task.__isPackTask) || (row && row.task_pack_sha256)) return "pack";
  return "other";
}

// Stable content hash of a sandbox tree ({ relPath: content }): sorted keys,
// so identical fixtures always hash identically regardless of walk order.
export function treeSha256(tree) {
  const keys = Object.keys(tree || {}).sort();
  return sha256(JSON.stringify(keys.map((k) => [k, tree[k]])));
}

// Reproducibility metadata stamped on every results.jsonl row (Gap 4 of the
// 2026-09 eval-practice review): enough to tell harness drift (CLI version)
// from task-content drift (prompt/fixture/pack hashes) from a genuine model
// snapshot change (requested vs resolved model id) when a score moves.
export function reproMetadata({ promptText, initialTree, task, cliVersion }) {
  const task_prompt_sha256 = sha256(promptText || "");
  const task_fixture_sha256 = treeSha256(initialTree || {});
  const task_pack_sha256 = task && task.packSha256 ? task.packSha256 : null;
  const task_rubric_sha256 = task && task.rubric ? sha256(task.rubric) : null;
  return {
    claude_cli_version: cliVersion ?? null,
    task_prompt_sha256,
    task_fixture_sha256,
    task_pack_sha256,
    task_rubric_sha256,
    task_content_sha256: sha256([task_prompt_sha256, task_fixture_sha256, task_pack_sha256 || "", task_rubric_sha256 || ""].join(":")),
  };
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
  // Fable 5.1 (claude-fable-5-1) -- the current Fable tier (config's
  // tiers.fable). Fable takes no "medium"/"none" no-op the way haiku does;
  // it always thinks (thinking: "adaptive, always on, cannot disable"), so
  // every effort level here is a genuine distinct setting.
  "fable51-low": { model: "claude-fable-5-1", effort: "low" },
  "fable51-medium": { model: "claude-fable-5-1", effort: "medium" },
  "fable51-high": { model: "claude-fable-5-1", effort: "high" },
  "fable51-xhigh": { model: "claude-fable-5-1", effort: "xhigh" },
  // Fable 5 (claude-fable-5, referenceModels["fable-5"]) -- superseded by
  // 5.1 but still a live, dated id some definitions may pin. high only:
  // this cell exists for a direct 5-vs-5.1 comparison at the same effort,
  // not a full grid -- add the other effort levels if that comparison needs
  // widening.
  "fable5-high": { model: "claude-fable-5", effort: "high" },
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

// Every per-task maxBudgetUsd below (and the --max-budget-usd CLI ceiling)
// was calibrated against SONNET 5's price. --max-budget-usd is the only
// working per-run runaway guard this CLI honours (see the turn-limit note
// at the top of this file) -- it kills the run once the ACTUAL API dollar
// cost crosses the cap, not once a token count does. A pricier model doing
// the exact same amount of real work therefore costs proportionally more
// real dollars for an identical token count, so a Sonnet-sized cap cuts it
// off before the task is actually done -- not a genuine budget overrun, a
// units mismatch between the cap (calibrated in Sonnet dollars) and the
// model actually spending them. Fable failed 7 real-task runs exactly this
// way (2026-09-23, budget-cap-fable-cutoff finding) -- the model was still
// working when the CLI killed it for "exceeding" a cap sized for a model at
// a fifth of its price.
//
// Fix: scale every cap by the cell's model price relative to Sonnet 5,
// read from config/model-tiers.json's own pricing table (never
// hard-coded -- see the "table as DATA, not code" note at that config's
// own top) so a future price change needs no code edit here. A dated id
// (e.g. claude-opus-5, claude-fable-5) is checked against
// classifyReferenceModel() FIRST for its own exact historical pricing
// (tiers.opus's current pricing would otherwise silently apply Opus 5.5's
// price to a claude-opus-5 cell); an id with no reference entry falls back
// to its current alias tier. Scaling only ever goes UP (floor of 1x): a
// cheaper model (haiku) is already comfortably inside a Sonnet-sized cap
// for the same token count, so there is no cutoff failure to compensate
// for on that side, and tightening it would risk a NEW one for no benefit.
function sonnetPricing() {
  return modelTiers().tiers?.sonnet?.resolvesTo?.pricing || null;
}

function modelPricing(fullModelId) {
  const ref = classifyReferenceModel(fullModelId);
  if (ref?.pricing) return ref.pricing;
  const alias = classifyModel(fullModelId).alias;
  return (modelTiers().tiers || {})[alias]?.resolvesTo?.pricing || null;
}

// Exported for tests. Returns 1 (no scaling) whenever either model's
// pricing is unreadable -- fail toward the EXISTING, already-shipped
// per-task defaults rather than guessing a ratio, same fail-open posture
// every other guard/table lookup in this plugin takes.
export function modelPriceRatioToSonnet(fullModelId) {
  const sonnet = sonnetPricing();
  const model = modelPricing(fullModelId);
  if (!sonnet || !model) return 1;
  if (typeof model.inputPerMTok !== "number" || typeof model.outputPerMTok !== "number"
    || typeof sonnet.inputPerMTok !== "number" || typeof sonnet.outputPerMTok !== "number"
    || sonnet.inputPerMTok <= 0 || sonnet.outputPerMTok <= 0) return 1;
  const inRatio = model.inputPerMTok / sonnet.inputPerMTok;
  const outRatio = model.outputPerMTok / sonnet.outputPerMTok;
  return (inRatio + outRatio) / 2;
}

// The scaled cap actually used for a run: the task's own calibrated
// maxBudgetUsd (or, for the global --max-budget-usd ceiling, that value),
// scaled by this cell's price relative to Sonnet 5, floored at 1x so a
// cheaper model's cap is never tightened.
export function scaledMaxBudgetUsd(baseMaxBudgetUsd, fullModelId) {
  const ratio = Math.max(1, modelPriceRatioToSonnet(fullModelId));
  return baseMaxBudgetUsd * ratio;
}

export function parseArgs(argv) {
  const out = { cells: "all", tasks: "all", reps: 3, repStart: 1, out: null, maxBudgetUsd: null, isolateHome: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cells") out.cells = argv[++i];
    else if (a === "--tasks") out.tasks = argv[++i];
    else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--rep-start") out.repStart = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-budget-usd") out.maxBudgetUsd = Number(argv[++i]);
    else if (a === "--isolate-home") out.isolateHome = true;
    else throw new Error("unknown arg: " + a);
  }
  return out;
}

// --isolate-home only works with env-var auth (ANTHROPIC_API_KEY), which
// survives the HOME/USERPROFILE redirect -- an OAuth credentials file does
// not (it lives under HOME). Refuse to even start rather than silently
// burning a whole batch on auth_error rows. Shared by both entry points
// (this module's own main() and scripts/benchmark.mjs).
export function checkIsolateHomePreflight(isolateHome) {
  if (isolateHome && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "--isolate-home requires ANTHROPIC_API_KEY to be set (OAuth login sessions live under HOME, " +
      "which --isolate-home redirects away from). Set ANTHROPIC_API_KEY, or drop --isolate-home to use " +
      "your normal OAuth session (the default, unredirected, path).",
    );
  }
}

// Distinct console status per run -- an auth_error or a genuine api-level
// error must never look like a plain pass=false task failure at a glance.
export function formatRunLine(row, elapsedMs) {
  const status = row.auth_error ? "auth_error" : (row.is_error ? `error(${row.terminal_reason || row.subtype || "unknown"})` : "ok");
  return `pass=${row.pass} cost=$${row.cost_usd} turns=${row.num_turns} status=${status} (${elapsedMs}ms)`;
}

// Printed once, immediately, when a run's row.auth_error is true -- the
// batch aborts right after this (see both main()s below).
export function authErrorAbortMessage(row) {
  return [
    "",
    `AUTH ERROR: ${row.cell} / ${row.task} / rep${row.rep} failed authentication (not logged in / 401), cost $0 -- the model was never reached.`,
    "Aborting the batch immediately. This run is excluded from pass-rate math (see rebuildSummary()).",
    row.isolate_home
      ? "Running with --isolate-home: check that ANTHROPIC_API_KEY is set and valid."
      : "Live runs need your normal OAuth session visible to the spawned process (`claude /login`), " +
        "or pass --isolate-home with ANTHROPIC_API_KEY set. See docs/BENCHMARK.md \"Preconditions\".",
  ].join("\n");
}

export function resolveList(spec, table) {
  if (spec === "all") return Object.keys(table);
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

// A fresh, throwaway HOME/USERPROFILE, used ONLY when the caller opts into
// --isolate-home. NOT the default -- see runClaude()'s banner below for why.
// Cleaned up alongside the sandbox in the run's `finally`.
export function makeFakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-home-"));
  return dir;
}

// Text/shape signatures of an auth/login failure, as distinct from a
// genuine model or task failure. Found empirically (2026-09-23): every run
// under a redirected HOME failed with `is_error:true`,
// `terminal_reason:"api_error"`, `cost_usd:0`, and an answer text of
// "Not logged in · Please run /login" -- because OAuth-login sessions
// store credentials under HOME (~/.claude/.credentials.json), which a
// redirected HOME strips. A $0-cost api_error with this shape is not the
// model failing the task; the model was never reached. Exported so tests
// can probe it directly against a fixture JSON blob, no process spawn
// required.
const AUTH_ERROR_TEXT_RE = /not logged in|please run \/login|invalid api key|authentication_error|\b401\b/i;

export function isAuthError({ json, answerText, stdout, err } = {}) {
  const haystack = [answerText, stdout, err].filter(Boolean).join("\n");
  if (AUTH_ERROR_TEXT_RE.test(haystack)) return true;
  const isError = json ? !!json.is_error : true;
  if (!isError) return false;
  const costUsd = json ? json.total_cost_usd : null;
  const terminalReason = (json && json.terminal_reason) || null;
  const subtype = (json && json.subtype) || null;
  // A zero/unknown-cost api_error on its own is a weaker signal than the
  // text match above (a genuine API outage could look like this too), but
  // it is exactly the shape the OAuth-stripped-by-HOME-redirect failure
  // takes when the answer text isn't captured (e.g. malformed stdout) --
  // still worth flagging as auth_error rather than a silent task failure.
  if ((terminalReason === "api_error" || subtype === "api_error") && (costUsd === 0 || costUsd == null)) return true;
  return false;
}

function runClaude({ cwd, prompt, model, effort, maxBudgetUsd, isolateHome, fakeHome, extraEnv }) {
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
    // DEFAULT: no HOME/USERPROFILE redirection -- matches the proven
    // pre-port harness (bench/effort-grid, 300+ live runs), which spawned
    // with only a sandboxed cwd + `--setting-sources ""` and the operator's
    // real, inherited env. `--setting-sources ""` already skips reading
    // this machine's hooks/CLAUDE.md/plugins/skills (the "setting sources"
    // this CLI knows about); it does NOT touch credential resolution. Most
    // operators authenticate via OAuth (`claude /login`), which stores its
    // session under the real HOME -- redirecting HOME strips that
    // credential and every live run fails with an auth error instead of
    // making a model call (see isAuthError() above; found 2026-09-23).
    //
    // OPT-IN: --isolate-home redirects HOME/USERPROFILE to a fresh
    // throwaway dir per run, same as this module did unconditionally
    // before this fix. It only works when the operator authenticates via
    // ANTHROPIC_API_KEY (an env var, which DOES survive the redirect via
    // `{...process.env}` below) rather than an OAuth credentials file --
    // callers MUST refuse to start with --isolate-home when no API key is
    // set (see scripts/benchmark.mjs's preflight check). Never copy
    // credential files into the fake home; only env-var auth is supported.
    // Per-run isolation for --concurrency > 1 (bench/scheduler.mjs): a
    // unique TMP/TEMP/TMPDIR and a unique BENCH_PORT_BASE, so two concurrent
    // runs' own tests/servers never collide on the machine's shared default
    // temp dir or a hardcoded port. Both are no-ops for a normal
    // --concurrency 1 run (extraEnv is then just the historical env with no
    // overrides). See docs/BENCHMARK.md "Parallel runs".
    const env = { ...process.env, ...(extraEnv || {}) };
    if (isolateHome) {
      env.HOME = fakeHome;
      env.USERPROFILE = fakeHome;
      env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
      // Windows resolves the user profile via HOMEDRIVE+HOMEPATH separately
      // from USERPROFILE in some code paths -- set both so nothing falls
      // through to the real profile. fakeHome is always an absolute
      // `<drive>:\...` path here (os.tmpdir()-derived), so a plain 2-char
      // slice for the drive and the remainder for the path is exact.
      if (process.platform === "win32") {
        env.HOMEDRIVE = fakeHome.slice(0, 2);
        env.HOMEPATH = fakeHome.slice(2);
      }
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

// `judge` (optional): { config, callJudge?, storeFile } -- see bench/judge.mjs.
// When set and the task carries a rubric, the run's change is graded by the
// rubric judge AFTER normal scoring, into separate judge_* columns; row.pass
// is never touched. Refuses (throws, before any model call) when the judge
// is not calibrated for this task or is not eligible to judge this cell's
// model. `runClaudeImpl` and `cliVersion` are test seams: production callers
// omit both.
export async function runOne({
  cellId, cell, taskId, task, rep, outDir, answersDir, maxBudgetUsdCeiling, isolateHome = false,
  judge = null, runClaudeImpl = runClaude, cliVersion,
  // Scheduling context (bench/scheduler.mjs's scheduleRuns() supplies these
  // for --concurrency > 1; a sequential/--concurrency 1 caller can omit all
  // of them and gets the historical single-slot behavior unchanged).
  runId: explicitRunId, slot = 0, concurrency = 1, coScheduledRunIds = [], isCollisionRetry = false,
}) {
  const judgeActive = !!(judge && task.rubric);
  if (judgeActive) {
    // A refusal is a CONFIGURATION error, not a run failure: it carries
    // code JUDGE_REFUSED so both main loops abort the batch instead of
    // logging a pass:false row that would drag the cell's pass rate down.
    const refuse = (msg) => Object.assign(new Error(msg), { code: "JUDGE_REFUSED" });
    const elig = checkJudgeEligibility(judge.config.model, cell.model);
    if (!elig.ok) throw refuse(`judge refused for cell ${cellId}: ${elig.reason}`);
    try {
      assertJudgeCalibrated({ taskId, task, config: judge.config, storeFile: judge.storeFile });
    } catch (e) {
      throw refuse(e.message);
    }
  }
  const runId = explicitRunId || (cellId + "__" + taskId + "__rep" + rep);
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-" + cellId + "-" + taskId + "-"));
  // Only made (and only cleaned up) when isolateHome is set -- the default
  // path spawns with the real, inherited HOME/USERPROFILE (see runClaude()).
  const fakeHome = isolateHome ? makeFakeHome() : null;
  // Per-run isolation for parallel runs (bench/scheduler.mjs): a dedicated
  // TMP/TEMP/TMPDIR sibling to the sandbox (never nested inside it -- a tool
  // scanning the sandbox for "files the model touched" must never see the
  // harness's own scratch dir), and a BENCH_PORT_BASE reserved per
  // concurrency SLOT (not per run), so two runs active at the same time
  // never share either. Both are harmless at the default --concurrency 1
  // (slot is always 0, and nothing but this run is ever active).
  const runTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-tmp-" + cellId + "-" + taskId + "-"));
  const portBase = portBaseForSlot(slot);
  const scheduleCtx = { slot, concurrency, coScheduledRunIds, portBase, tmpDir: runTmpDir };
  const extraEnv = { TMP: runTmpDir, TEMP: runTmpDir, TMPDIR: runTmpDir, BENCH_PORT_BASE: String(portBase) };
  let meta;
  try {
    meta = task.setup(sandboxDir, scheduleCtx);
  } catch (e) {
    rmrf(sandboxDir);
    rmrf(runTmpDir);
    if (fakeHome) rmrf(fakeHome);
    throw e;
  }
  const promptText = task.prompt(meta);
  // Snapshot BEFORE the model touches anything: the fixture half of the
  // reproducibility hash, and the "before" side of the judge's diff.
  const initialTree = (() => {
    try {
      return snapshotTree(sandboxDir);
    } catch {
      return {};
    }
  })();
  const repro = reproMetadata({
    promptText, initialTree, task,
    cliVersion: cliVersion !== undefined ? cliVersion : getClaudeCliVersion(),
  });

  // The per-run runaway guard is the TIGHTER of the task's own calibrated
  // budget and an optional global ceiling (scripts/benchmark.mjs's
  // --max-budget-usd) -- never looser than what the task itself declared.
  // Both are calibrated in SONNET dollars, so both are scaled by this
  // cell's price relative to Sonnet 5 before comparing them -- see
  // scaledMaxBudgetUsd()'s own note, above.
  const scaledTaskBudget = scaledMaxBudgetUsd(task.maxBudgetUsd, cell.model);
  const effectiveBudget = typeof maxBudgetUsdCeiling === "number"
    ? Math.min(scaledTaskBudget, scaledMaxBudgetUsd(maxBudgetUsdCeiling, cell.model))
    : scaledTaskBudget;

  const { json, stdout, stderr, err, wallMs } = await runClaudeImpl({
    cwd: sandboxDir,
    prompt: promptText,
    model: cell.model,
    effort: cell.effort,
    maxBudgetUsd: effectiveBudget,
    isolateHome,
    fakeHome,
    extraEnv,
  });

  const answerText = json ? (json.result ?? "") : "";
  let scoreResult;
  try {
    // `await` works identically whether task.score() is synchronous (every
    // built-in task) or returns a Promise (a task-pack task, whose scorer
    // runs a dynamically-imported hidden-test module) -- awaiting a plain
    // value is a no-op, so this is not a behavior change for existing tasks.
    // The 4th arg (scheduleCtx) is new and additive -- every existing task's
    // score(sandboxDir, answerText, meta) simply ignores it.
    scoreResult = await task.score(sandboxDir, answerText, meta, scheduleCtx);
  } catch (e) {
    // harnessErrorCode: the STRUCTURED `.code` Node itself attaches to a
    // genuine system error (net's EADDRINUSE, fs's EEXIST/EBUSY, ...) when
    // the task's own score()/setup() throws -- e.g.
    // tests/fixtures/bench-parallel/fixed-port-task.mjs's real net.Server
    // bind. This is the ONLY signal classifyCollision() is allowed to see
    // (bench/scheduler.mjs) -- never the exception's message text, which,
    // same as the model's answer text, can be authored prose (an assertion
    // message quoting an expected string) that coincidentally contains a
    // collision-shaped substring without any real OS collision happening.
    const harnessErrorCode = e && typeof e.code === "string" ? e.code : null;
    scoreResult = {
      pass: false, scope_ok: null, claim_honest: null, extra_files: [],
      detail: { scorerError: String((e && e.stack) || e), harnessErrorCode },
    };
  }

  // Collision classification: a run whose scorer/setup threw a STRUCTURED
  // OS-level "someone else already holds this resource" error (EADDRINUSE,
  // a lock file held, ...) never reached a genuine model/task verdict -- see
  // bench/scheduler.mjs's classifyCollision() (structural signal ONLY, never
  // free text -- see that function's own banner) and rebuildSummary()'s
  // exclusion below (the same treatment auth_error gets). Only meaningful
  // for a run that declared shared resources in the first place
  // (--concurrency 1's single active run can still "collide" with a
  // leftover process from a previous crashed run, so this is not gated on
  // concurrency > 1).
  const collision = classifyCollision({ harnessErrorCode: scoreResult && scoreResult.detail && scoreResult.detail.harnessErrorCode });

  const finalTree = (() => {
    try {
      return snapshotTree(sandboxDir);
    } catch {
      return {};
    }
  })();

  const usage = (json && json.usage) || {};
  const modelUsage = (json && json.modelUsage) || {};
  const modelKeys = Object.keys(modelUsage);
  const resolvedModel = modelKeys[0] || null;
  const mu = resolvedModel ? modelUsage[resolvedModel] : {};

  // Rubric judge: a SEPARATE score. Runs on the final tree regardless of the
  // hidden test's verdict (a passing hack and a failing-but-sound attempt are
  // both worth a design read), never on an auth failure (no model output
  // exists), and re-checks eligibility against the RESOLVED model, since an
  // alias can resolve to something the judge may not grade.
  let judgeFields = {};
  if (judgeActive) {
    const authFailed = isAuthError({ json, answerText, stdout, err });
    const eligResolved = resolvedModel ? checkJudgeEligibility(judge.config.model, resolvedModel) : { ok: true };
    const base = {
      judge_model: judge.config.model,
      judge_effort: judge.config.effort,
      judge_rubric_sha256: sha256(task.rubric),
    };
    if (authFailed) {
      judgeFields = { ...base, judge_pass: null, judge_votes: null, judge_skipped: "auth_error" };
    } else if (!eligResolved.ok) {
      judgeFields = { ...base, judge_pass: null, judge_votes: null, judge_skipped: "resolved-model: " + eligResolved.reason };
    } else {
      const { scaledJudgeBudget } = judge;
      const verdict = await runJudge({
        config: judge.config,
        budgetUsd: typeof scaledJudgeBudget === "number" ? scaledJudgeBudget : scaledMaxBudgetUsd(judge.config.maxBudgetUsd, judge.config.model),
        taskPrompt: promptText,
        rubric: task.rubric,
        diff: treeDiff(initialTree, finalTree, { exclude: [GUARD_REL_PATH] }),
        finalMessage: answerText,
        callJudge: judge.callJudge || cliJudgeCaller,
      });
      judgeFields = {
        ...base,
        judge_pass: verdict.pass,
        judge_votes: verdict.votes,
        judge_invalid_votes: verdict.invalid,
        judge_cost_usd: verdict.cost_usd,
        judge_input_truncated: verdict.truncated,
        judge_prompt_sha256: verdict.prompt_sha256,
      };
    }
  }

  fs.writeFileSync(
    path.join(answersDir, runId.replace(/[\\/:]/g, "_") + ".json"),
    JSON.stringify({ runId, answerText, tree: finalTree }, null, 2),
  );

  // Resolve BEFORE the sandbox is torn down, so a caller reading this row
  // straight off results.jsonl can go find the transcript without having
  // to re-derive the isolateHome decision: `<transcript_home>/.claude/
  // projects/<encoded(sandbox_cwd)>/<session_id>.jsonl` -- real HOME by
  // default, the fake one only when isolateHome was set. See
  // docs/BENCHMARK.md "Effort is proven via the transcript".
  const transcriptHome = isolateHome ? fakeHome : (process.env.HOME || process.env.USERPROFILE || os.homedir());

  rmrf(sandboxDir);
  rmrf(runTmpDir);
  if (fakeHome) rmrf(fakeHome);

  const row = {
    ts: new Date().toISOString(),
    run_id: runId,
    cell: cellId,
    task: taskId,
    task_family: taskFamilyOf(taskId, { task }),
    rep,
    // Concurrency level this run was launched under, and the OTHER run ids
    // active at the moment it started -- so a wall-time comparison against
    // an earlier --concurrency 1 batch can be read correctly (parallel runs
    // slow each other down; see docs/BENCHMARK.md "Parallel runs").
    concurrency,
    co_scheduled_run_ids: coScheduledRunIds,
    // A collision never reached a genuine model/task verdict (see
    // classifyCollision() above) -- excluded from pass-rate math by
    // rebuildSummary(), same treatment as auth_error. is_collision_retry
    // marks the solo re-run bench/scheduler.mjs automatically queues for it.
    collision,
    is_collision_retry: !!isCollisionRetry,
    requested_model: cell.model,
    resolved_model: resolvedModel,
    model_mismatch: resolvedModel !== null && resolvedModel !== cell.model,
    requested_effort: cell.effort,
    ...repro,
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
    // The ACTUAL cap passed to --max-budget-usd for this run, after
    // scaling task.maxBudgetUsd (and any --max-budget-usd ceiling) by this
    // cell's price relative to Sonnet 5 -- see scaledMaxBudgetUsd(). Logged
    // so a run cut off for exceeding budget is auditable against the cap
    // it actually ran under, not the unscaled task default.
    max_budget_usd: effectiveBudget,
    session_id: (json && json.session_id) || null,
    // Distinct from a genuine task/model failure -- see isAuthError() above
    // and scripts/benchmark.mjs's abort-on-first-auth_error handling.
    auth_error: isAuthError({ json, answerText, stdout, err }),
    isolate_home: isolateHome,
    transcript_home: transcriptHome,
    sandbox_cwd: sandboxDir,
    exec_err: err,
    detail: scoreResult.detail ?? null,
    // Rubric-judge columns (present only when a judge ran for this task).
    // A SEPARATE score: never merged into `pass` above.
    ...judgeFields,
  };

  fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

// The row written when runOne() itself throws (setup failure, a refused
// judge, ...). Carries the same identifying/reproducibility fields a normal
// row does where they are knowable without a run -- every results.jsonl row
// names its harness, requested model and effort.
export function harnessErrorRow({ cellId, cell, taskId, task, rep, error, cliVersion }) {
  let version = cliVersion;
  if (version === undefined) {
    try { version = getClaudeCliVersion(); } catch { version = null; }
  }
  return {
    ts: new Date().toISOString(), cell: cellId, task: taskId, task_family: taskFamilyOf(taskId, { task }), rep,
    requested_model: cell ? cell.model : null, resolved_model: null, requested_effort: cell ? cell.effort : null,
    claude_cli_version: version ?? null,
    task_pack_sha256: task && task.packSha256 ? task.packSha256 : null,
    pass: false, is_error: true, exec_err: String((error && error.message) || error),
  };
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

// Cache reads are the largest real cost bucket on this machine (see
// docs/BENCHMARK.md and config/model-tiers.json's costDrivers) -- reads =
// context size x number of requests, so turn count and context size drive
// spend more than output tokens do. cacheHitPerMTok comes from the SAME
// tiers.*.resolvesTo.pricing table planUsageMultiplier() reads next to,
// resolved by tier alias so a rate change in the config needs no code edit.
function cacheReadPricePerMTok(fullModelId) {
  const alias = classifyModel(fullModelId).alias;
  const tier = (modelTiers().tiers || {})[alias];
  const rate = tier?.resolvesTo?.pricing?.cacheHitPerMTok;
  return typeof rate === "number" ? rate : null;
}

// Read share of cost for ONE run: what fraction of that run's total API
// dollar cost was spent re-reading cached context, vs writing new context or
// generating output. null when the model's cache-read rate is unmeasured or
// the row lacks cost/token data to compute it -- never a guessed number.
function readCostShare(row) {
  const rate = cacheReadPricePerMTok(row.requested_model);
  if (rate == null) return null;
  const cacheRead = row.cache_read_tokens;
  const cost = row.cost_usd;
  if (typeof cacheRead !== "number" || typeof cost !== "number" || cost <= 0) return null;
  const readCostUsd = (cacheRead * rate) / 1e6;
  return readCostUsd / cost;
}

// Context re-reads for ONE run: cache_read_tokens / num_turns approximates
// the average context size re-sent to the model on every turn (a cache read
// resends the whole cached prefix each time). null when either figure is
// missing or turns is zero.
function contextRereads(row) {
  const cacheRead = row.cache_read_tokens;
  const turns = row.num_turns;
  if (typeof cacheRead !== "number" || typeof turns !== "number" || turns <= 0) return null;
  return cacheRead / turns;
}

// Cache HIT RATE for ONE run: reads / (reads + writes + uncached input).
// See docs/BENCHMARK.md "Caching" and the cache-read-weight-2026-09-23
// experiment (config/model-tiers.json costDrivers.planUsageWeighting) --
// separate claude -p processes (including --resume) do NOT reliably share
// prompt cache even with byte-identical content, so a low hit rate on a
// benchmark cell is a signal the HARNESS broke caching for that run, not
// necessarily that the model or task is unusual. cache_creation_tokens and
// input_tokens are treated as 0 when absent (an older results.jsonl row
// without those fields) rather than making the whole rate null, since a
// missing WRITE count is not the same uncertainty as a missing READ count.
// null only when cache_read_tokens itself is missing, or every term is 0.
export function cacheHitRate(row) {
  const read = row.cache_read_tokens;
  if (typeof read !== "number") return null;
  const write = typeof row.cache_creation_tokens === "number" ? row.cache_creation_tokens : 0;
  const uncached = typeof row.input_tokens === "number" ? row.input_tokens : 0;
  const denom = read + write + uncached;
  if (denom <= 0) return null;
  return read / denom;
}

// A cell's median hit rate below this is a harness caching problem worth
// checking BEFORE trusting that cell's cost numbers -- see the cross-process
// cache-sharing gotcha in docs/BENCHMARK.md. Threshold set from the
// 2026-09-23 experiment's clean runs (91-96% hit rate) vs its anomalous Opus
// arm (cache reads mostly failed to hit; base-prefix-only).
const CACHE_HIT_RATE_ANOMALY_THRESHOLD = 0.85;

export function rebuildSummary(outDir) {
  const jsonlPath = path.join(outDir, "results.jsonl");
  if (!fs.existsSync(jsonlPath)) return;
  const allRows = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // Auth/login failures never reached the model -- excluded from pass-rate
  // and every other quality/cost stat below, so one botched-auth batch
  // can't be misread as "the model failed every task" (0% pass, cost $0).
  // Still counted and called out in the summary header. See isAuthError()
  // and scripts/benchmark.mjs's abort-on-first-auth_error handling --
  // a batch aborts as soon as one appears, so this is normally 0 or 1 row,
  // but rebuildSummary() also replays historical results.jsonl files that
  // may carry more from before this fix.
  const authErrorRows = allRows.filter((r) => r.auth_error);
  // A collision (bench/scheduler.mjs's classifyCollision(): EADDRINUSE, a
  // lock file held, ...) never reached a genuine model/task verdict either
  // -- same exclusion as auth_error, so one unlucky port clash under
  // --concurrency > 1 can't be misread as a model failure. The scheduler
  // always queues exactly one solo retry for a collided run (recorded as
  // its own row, is_collision_retry:true).
  //
  // CONFIRMATION: a collision is only CONFIRMED (and therefore excluded)
  // when its solo retry does NOT reproduce the same structural signal. If
  // the retry ALSO collides while running completely alone (forced
  // resources.exclusive -- see bench/scheduler.mjs's scheduleRuns()), the
  // scheduler was never the cause -- something about the task/environment
  // itself always fails this way -- so the retry is reclassified as a REAL
  // failure and counted normally; the original row stays excluded (its own
  // execution genuinely was concurrent, so its individual verdict is still
  // ambiguous) but is labelled "suspected, not confirmed" rather than
  // silently dropped the same way a confirmed collision is. Pass-rate math
  // must never lose a failure that reproduces solo (2026-09 adversarial
  // review, Track B fix #1).
  const byRunId = new Map(allRows.map((r) => [r.run_id, r]));
  const reproducedRetryIds = new Set(); // retry run_ids that ALSO collided solo -- treat as real
  const unconfirmedOriginalIds = new Set(); // original run_ids whose retry reproduced
  for (const r of allRows) {
    if (!r.collision || r.is_collision_retry) continue; // originals only
    const retry = byRunId.get(r.run_id + "::retry");
    if (retry && retry.collision) {
      reproducedRetryIds.add(retry.run_id);
      unconfirmedOriginalIds.add(r.run_id);
    }
  }
  // CONFIRMED collisions only -- excludes both the reclassified retry (now a
  // real, counted row) AND the unconfirmed original (reported separately
  // below, under SUSPECTED COLLISION, NOT CONFIRMED, so the two categories
  // never overlap in the printed counts).
  const collisionRows = allRows.filter((r) => r.collision && !reproducedRetryIds.has(r.run_id) && !unconfirmedOriginalIds.has(r.run_id));
  const rows = allRows.filter((r) => !r.auth_error && (!r.collision || reproducedRetryIds.has(r.run_id)));

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
    const nPass = group.filter((r) => r.pass).length;
    // pass@1 = the mean single-trial pass rate across reps (the same number
    // pass_rate always was, now labelled the way SWE-bench-family reports
    // do); pass@k with k = the reps actually run = "passed at least once".
    const passCi = wilsonInterval(nPass, group.length);
    const passAtKValue = passAtK(group.length, nPass, group.length);
    // Rubric judge: its own rate over the rows it actually graded
    // (judge_pass true/false). null when no row in the group was judged.
    const judged = group.filter((r) => r.judge_pass === true || r.judge_pass === false);
    const judgePassRate = judged.length ? judged.filter((r) => r.judge_pass === true).length / judged.length : null;
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
    // HEADLINE cost-driver stats (see config/model-tiers.json's costDrivers):
    // cache reads are the largest real cost bucket on this machine, and reads
    // = context size x number of requests, so turn count and re-read size
    // matter more to spend than output tokens do. Computed per-run, then
    // medianed across the group like every other stat here -- null entries
    // (unmeasured cache-read price for this tier, or a row missing turns/
    // cost) are dropped before the median rather than treated as zero.
    const medContextRereads = median(group.map(contextRereads).filter((v) => v != null));
    const medReadShareOfCost = median(group.map(readCostShare).filter((v) => v != null));
    // Cache hit rate: reads / (reads + writes + uncached input), medianed
    // like every other per-run stat. null when no row in the group has a
    // usable cache_read_tokens figure. A cell below the anomaly threshold is
    // flagged so a reader checks the harness BEFORE trusting that cell's
    // cost numbers -- see cacheHitRate() above and docs/BENCHMARK.md.
    const medCacheHitRate = median(group.map(cacheHitRate).filter((v) => v != null));
    const cacheAnomaly = medCacheHitRate != null && medCacheHitRate < CACHE_HIT_RATE_ANOMALY_THRESHOLD;

    summaryRows.push({
      cell, task, task_family: taskFamilyOf(task, { row: group[0] }), n: group.length,
      pass_rate: passRate,
      pass_at_1: passRate,
      pass_ci95_low: passCi ? passCi.low : null,
      pass_ci95_high: passCi ? passCi.high : null,
      pass_at_k: passAtKValue,
      k: group.length,
      n_too_small: group.length < MIN_N_TO_SEPARATE,
      // SEPARATE score from pass/pass@1 -- see bench/judge.mjs.
      judge_n: judged.length,
      judge_pass_rate: judgePassRate,
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
      cache_hit_rate: medCacheHitRate,
      cache_anomaly: cacheAnomaly,
      median_output_tokens: medOut,
      median_num_turns: medTurns,
      median_context_rereads: medContextRereads,
      read_share_of_cost: medReadShareOfCost,
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

  // Cell x task-family rollup: the level at which confidence intervals are
  // actually informative (per-task n is usually 1-3). pass@1 = mean over the
  // family's tasks of each task's pass rate (equal to pooled passes/runs when
  // reps are balanced); the 95% Wilson interval is over the pooled runs;
  // pass@k uses k = the smallest rep count among the family's tasks, averaged
  // over tasks. Written to its own file so summary.json stays the bare array
  // it has always been.
  const familyRows = buildFamilySummary(rows);
  fs.writeFileSync(path.join(outDir, "summary-by-family.json"), JSON.stringify(familyRows, null, 2));

  // Cache-read tokens, turns, context re-reads, and read-share-of-cost are
  // HEADLINE columns (next to pass_rate and cost_per_correct) -- not buried
  // in the token breakdown -- because cache reads are the largest real cost
  // bucket on this machine and turn count / context size are the actual
  // spend levers (see config/model-tiers.json's costDrivers and
  // docs/BENCHMARK.md's reporting guidance).
  const header = [
    "cell", "task", "n", "pass@1", "95% CI", "pass@k",
    "med_cache_read_tok", "hit_rate", "med_turns", "ctx_rereads", "read_share_cost",
    "cost_per_correct",
    "claim_honest*", "scope_ok", "med_out_tok", "med_cost_usd", "rel_cost_idx", "plan_usage_idx",
  ];
  const lines = [
    "pass@1 = mean single-trial pass rate across reps (what earlier summaries called pass_rate). pass@k = probability at least one of k reps passes, with k = the reps actually run (the unbiased estimator; k = n here, so it reads \"passed at least once\"). 95% CI = Wilson score interval. Cells with n < " + MIN_N_TO_SEPARATE + " cannot be separated from their neighbours -- read the family table below and compare intervals, not point estimates. Use >= 3 reps before comparing adjacent efforts.",
    "",
    "* claim_honest is EXPERIMENTAL — a word-bag heuristic known to under-read on long/hedged answers. See docs/BENCHMARK.md before treating a low rate as a quality finding.",
    "ctx_rereads = median(cache_read_tokens / num_turns) per run, an estimate of the average context size re-sent every turn. read_share_cost = median share of that run's dollar cost spent on cache reads (cache_read_tokens x this tier's cache-hit rate, from config/model-tiers.json). hit_rate = median(cache_read_tokens / (cache_read_tokens + cache_creation_tokens + input_tokens)) per run -- a cell below " + Math.round(CACHE_HIT_RATE_ANOMALY_THRESHOLD * 100) + "% is flagged \"cache anomaly: check harness\" below, since separate claude -p processes do not reliably share prompt cache even with identical content (see docs/BENCHMARK.md \"Caching\"). All three are \"n/a\" when the underlying token figures are unmeasured.",
    "",
  ];
  if (authErrorRows.length > 0) {
    lines.push(
      `AUTH ERROR: ${authErrorRows.length} run(s) failed authentication (not logged in / 401) and were EXCLUDED from every stat below -- ` +
      "they never reached the model. See docs/BENCHMARK.md \"Preconditions\" before trusting this summary.",
      "",
    );
  }
  if (collisionRows.length > 0) {
    const retried = collisionRows.filter((r) => allRows.some((o) => o.run_id === r.run_id + "::retry"));
    lines.push(
      `COLLISION: ${collisionRows.length} run(s) hit an OS-level resource collision (EADDRINUSE, a lock file held, ...) ` +
      `under --concurrency and were EXCLUDED from every stat below -- ${retried.length} were automatically re-run alone. ` +
      "See docs/BENCHMARK.md \"Parallel runs\".",
      "",
    );
  }
  if (unconfirmedOriginalIds.size > 0) {
    lines.push(
      `SUSPECTED COLLISION, NOT CONFIRMED: ${unconfirmedOriginalIds.size} run(s) looked like a resource collision, but the ` +
      "automatic solo retry reproduced the SAME structural failure running completely alone -- the scheduler was never the " +
      "cause. The retry is treated as a REAL failure and counted in every stat below; the original run stays excluded " +
      "(its own execution was genuinely concurrent, so its individual verdict is still ambiguous). See docs/BENCHMARK.md " +
      "\"Parallel runs\".",
      "",
    );
  }
  const anomalies = summaryRows.filter((r) => r.cache_anomaly);
  if (anomalies.length > 0) {
    lines.push(
      "CACHE ANOMALY: check harness -- the following cells fell below " +
      Math.round(CACHE_HIT_RATE_ANOMALY_THRESHOLD * 100) + "% cache hit rate, which usually means the harness " +
      "(not the model) failed to share prompt cache across the run's requests:",
      ...anomalies.map((r) => `  - ${r.cell} / ${r.task}: ${(r.cache_hit_rate * 100).toFixed(0)}%`),
      "",
    );
  }
  lines.push(
    header.join(" | "),
    header.map(() => "---").join(" | "),
  );
  for (const r of summaryRows) {
    lines.push([
      r.cell, r.task, r.n,
      (r.pass_rate * 100).toFixed(0) + "%",
      formatInterval(r.pass_ci95_low != null ? { low: r.pass_ci95_low, high: r.pass_ci95_high } : null),
      r.pass_at_k != null ? (r.pass_at_k * 100).toFixed(0) + "% (k=" + r.k + ")" : "n/a",
      r.median_cache_read_tokens ?? "n/a",
      r.cache_hit_rate != null ? (r.cache_hit_rate * 100).toFixed(0) + "%" + (r.cache_anomaly ? " ⚠" : "") : "n/a",
      r.median_num_turns ?? "n/a",
      r.median_context_rereads != null ? Math.round(r.median_context_rereads) : "n/a",
      r.read_share_of_cost != null ? (r.read_share_of_cost * 100).toFixed(0) + "%" : "n/a",
      r.cost_per_correct_usd != null ? "$" + r.cost_per_correct_usd.toFixed(3) : "n/a",
      r.claim_honest_rate != null ? (r.claim_honest_rate * 100).toFixed(0) + "%" : "n/a",
      r.scope_ok_rate != null ? (r.scope_ok_rate * 100).toFixed(0) + "%" : "n/a",
      r.median_output_tokens ?? "n/a",
      r.median_cost_usd != null ? "$" + r.median_cost_usd.toFixed(3) : "n/a",
      r.relative_cost_index != null ? r.relative_cost_index.toFixed(2) + "x" : "n/a",
      r.plan_usage_index != null ? r.plan_usage_index.toFixed(2) + "x" : "n/a (unmeasured tier)",
    ].join(" | "));
  }

  if (familyRows.length > 0) {
    lines.push(
      "",
      "## By task family (cell x family)",
      "",
      "family | cell | tasks | runs | passes | pass@1 | 95% CI | pass@k | note",
      "--- | --- | --- | --- | --- | --- | --- | --- | ---",
    );
    for (const f of familyRows) {
      lines.push([
        f.family, f.cell, f.tasks, f.runs, f.passes,
        (f.pass_at_1 * 100).toFixed(0) + "%",
        formatInterval(f.pass_ci95_low != null ? { low: f.pass_ci95_low, high: f.pass_ci95_high } : null),
        f.pass_at_k != null ? (f.pass_at_k * 100).toFixed(0) + "% (k=" + f.k + ")" : "n/a",
        f.n_too_small ? "n too small to separate" : "",
      ].join(" | "));
    }
  }

  const judgedRows = summaryRows.filter((r) => r.judge_n > 0);
  if (judgedRows.length > 0) {
    lines.push(
      "",
      "## Rubric judge (separate score -- never merged into pass@1)",
      "",
      "Blind 3-vote rubric grade of each run's CHANGE for design/scope quality the hidden test cannot see (bench/judge.mjs, docs/BENCHMARK.md \"Rubric judge\"). Only calibrated judges run; a run the judge could not grade (unparseable votes, auth error, ineligible resolved model) is excluded from judge_n.",
      "",
      "cell | task | judge_n | judge_pass | 95% CI",
      "--- | --- | --- | --- | ---",
    );
    for (const r of judgedRows) {
      const k = Math.round(r.judge_pass_rate * r.judge_n);
      lines.push([
        r.cell, r.task, r.judge_n,
        (r.judge_pass_rate * 100).toFixed(0) + "%",
        formatInterval(wilsonInterval(k, r.judge_n)),
      ].join(" | "));
    }
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n") + "\n");
}

// Exported for tests. Groups non-auth-error rows by (cell, family) -- see the
// rollup note in rebuildSummary().
export function buildFamilySummary(rows) {
  const byCellFamily = new Map();
  for (const r of rows) {
    const fam = taskFamilyOf(r.task, { row: r });
    const key = r.cell + "::" + fam;
    if (!byCellFamily.has(key)) byCellFamily.set(key, { cell: r.cell, family: fam, byTask: new Map() });
    const g = byCellFamily.get(key);
    if (!g.byTask.has(r.task)) g.byTask.set(r.task, []);
    g.byTask.get(r.task).push(r);
  }
  const out = [];
  for (const g of byCellFamily.values()) {
    const perTask = [...g.byTask.values()].map((rs) => ({ n: rs.length, c: rs.filter((x) => x.pass).length }));
    const runs = perTask.reduce((s, t) => s + t.n, 0);
    const passes = perTask.reduce((s, t) => s + t.c, 0);
    const k = Math.min(...perTask.map((t) => t.n));
    const ci = wilsonInterval(passes, runs);
    const passAt1 = perTask.reduce((s, t) => s + t.c / t.n, 0) / perTask.length;
    const pk = perTask.map((t) => passAtK(t.n, t.c, k));
    out.push({
      cell: g.cell, family: g.family, tasks: perTask.length, runs, passes,
      pass_at_1: passAt1,
      pass_ci95_low: ci ? ci.low : null,
      pass_ci95_high: ci ? ci.high : null,
      pass_at_k: pk.every((v) => v != null) ? pk.reduce((s, v) => s + v, 0) / pk.length : null,
      k,
      n_too_small: runs < MIN_N_TO_SEPARATE,
    });
  }
  out.sort((a, b) => (a.family + a.cell).localeCompare(b.family + b.cell));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkIsolateHomePreflight(args.isolateHome);
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
          const row = await runOne({ cellId, cell, taskId, task, rep, outDir, answersDir, isolateHome: args.isolateHome });
          process.stdout.write(formatRunLine(row, Date.now() - t0) + "\n");
          if (row.auth_error) {
            console.error(authErrorAbortMessage(row));
            rebuildSummary(outDir);
            process.exit(1);
          }
        } catch (e) {
          if (e && e.code === "JUDGE_REFUSED") {
            console.error("\nJUDGE REFUSED: " + e.message + "\nAborting the batch (no row written).");
            rebuildSummary(outDir);
            process.exit(1);
          }
          process.stdout.write("ERROR: " + ((e && e.stack) || e) + "\n");
          fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(harnessErrorRow({ cellId, cell, taskId, task, rep, error: e })) + "\n");
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
