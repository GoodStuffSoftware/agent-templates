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
import { dataDir, classifyModel, classifyReferenceModel, modelTiers, configDir } from "../hooks/lib/context.mjs";

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
import { snapshotTree, removeDirWithRetry, GUARD_REL_PATH } from "./tasks/common.mjs";
import { wilsonInterval, passAtK, formatInterval, MIN_N_TO_SEPARATE } from "./stats.mjs";
import {
  sha256, runJudge, treeDiff, checkJudgeEligibility, assertJudgeCalibrated, makeCliJudgeCaller, validateJudgeConfig,
} from "./judge.mjs";
import { classifyCollision, portBaseForSlot } from "./scheduler.mjs";
import { evidenceFamilyOf, assertComparableEvidence, FINE_FAMILIES } from "./evidence-family.mjs";
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

// FS2 fix (2026-09-24 family-split review, CRITICAL): the LOCAL,
// user-authored evidence-family mapping file -- `<stateRoot>/config/
// evidence-families.json` (configDir() = stateRoot()/config, honouring
// AGENT_COMPANION_STATE_DIR the same way every other local-state read in
// this plugin does). Classifies rows at SUMMARY time (rebuildSummary()/
// buildFamilySummary() below), including LEGACY rows no task/pack builder
// ever labelled. NEVER shipped with this repo, and NEVER containing real
// private task ids or pack names -- see docs/BENCHMARK.md "Evidence
// families" for the file's shape and an operator's own worked example (with
// placeholder patterns only). Missing/malformed file -> no mapping at all
// (fail open, same as every other optional local config this plugin reads)
// -- never thrown, since a summary rebuild must never abort over a file the
// operator has not created yet.
export function loadLocalEvidenceFamilyMapping() {
  try {
    const raw = fs.readFileSync(path.join(configDir(), "evidence-families.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
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

// Args this direct CLI deliberately REFUSES rather than silently
// mishandling -- each has a real implementation one layer up, in
// scripts/benchmark.mjs, that this bare-bones loop does not (and, for
// --concurrency, should not: see the message below for why "route it
// through the scheduler here too" was rejected in favor of refusing).
const REFUSED_ARGS = {
  "--concurrency": "runs multiple (task, rep) attempts in parallel through bench/scheduler.mjs's "
    + "scheduleRuns()/makeCapacityGate() (the free-RAM gate) and is gated behind bench/estimate.mjs's "
    + "pre-run cost/time estimate + confirmation gate -- none of which this direct, single-process CLI "
    + "wires up. Silently accepting --concurrency here would run everything sequentially anyway while "
    + "printing no estimate and consulting no RAM gate, which is worse than refusing outright.",
  "--per-agent-mb": "only means anything alongside --concurrency (bench/scheduler.mjs's capacity gate).",
  "--weekly-usage-pct": "the pre-run estimate/confirmation gate is scripts/benchmark.mjs-only.",
  "--weekly-ceiling-pct": "the pre-run estimate/confirmation gate is scripts/benchmark.mjs-only.",
  "--confirm-above-points": "the pre-run estimate/confirmation gate is scripts/benchmark.mjs-only.",
  "--confirm": "there is no confirmation gate here to acknowledge.",
};

export function parseArgs(argv) {
  const out = {
    cells: "all", tasks: "all", reps: 3, repStart: 1, out: null, maxBudgetUsd: null, isolateHome: false,
    // FS2 fix (2026-09-24 family-split review, CRITICAL): a whole-run
    // evidence-family default, for an external harness (e.g. the operator's
    // local architecture-pack harness, which builds its own task objects
    // and sets no family at all) that cannot label every task it builds
    // individually. null until parsed below (CLI) or read from the env
    // (see the fallback after the loop) -- see withEvidenceFamilyOverride().
    evidenceFamily: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cells") out.cells = argv[++i];
    else if (a === "--tasks") out.tasks = argv[++i];
    else if (a === "--reps") out.reps = Number(argv[++i]);
    else if (a === "--rep-start") out.repStart = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-budget-usd") out.maxBudgetUsd = Number(argv[++i]);
    else if (a === "--isolate-home") out.isolateHome = true;
    else if (a === "--evidence-family") out.evidenceFamily = argv[++i];
    else if (REFUSED_ARGS[a]) {
      throw new Error(
        `bench/runner.mjs's direct CLI does not support ${a} -- it ${REFUSED_ARGS[a]} `
        + "Use scripts/benchmark.mjs instead (same bench/runner.mjs runOne() underneath, with the "
        + `scheduler and gates wired up). See docs/BENCHMARK.md "Parallel runs".`,
      );
    } else throw new Error("unknown arg: " + a);
  }
  // Env fallback: only when --evidence-family was not given explicitly --
  // lets an external harness set one env var once instead of threading a
  // CLI flag through every invocation.
  if (out.evidenceFamily == null && process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY) {
    out.evidenceFamily = process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY;
  }
  return out;
}

// Validates a run-wide `--evidence-family`/`AGENT_COMPANION_BENCH_EVIDENCE_FAMILY`
// override against the known-label registry BEFORE any cell/task loop runs
// -- a typo here would otherwise misclassify (or, post-FS3, throw partway
// through) every single row in the batch. Returns the value unchanged (or
// null) for convenience at the call site.
export function checkEvidenceFamilyOverridePreflight(fine) {
  if (fine == null) return null;
  if (!(fine in FINE_FAMILIES)) {
    throw new Error(
      `--evidence-family "${fine}" is not a recognized fine label -- known labels: `
      + `${Object.keys(FINE_FAMILIES).join(', ')} (bench/evidence-family.mjs).`,
    );
  }
  return fine;
}

// FS2 fix: applies the run-wide evidence-family override to a task that
// does not already declare its own -- an explicit task.evidenceFamily
// always wins (same precedence evidenceFamilyOf() gives a task's own
// declaration over anything coarser). Used ONLY to resolve evidenceFamilyOf()
// for row-stamping; never mutates the real task object passed to
// task.setup()/prompt()/score().
export function withEvidenceFamilyOverride(task, override) {
  if (!override) return task;
  if (task && typeof task.evidenceFamily === "string" && task.evidenceFamily) return task;
  return { ...task, evidenceFamily: override };
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
  // Test seam, in the same style as `runClaudeImpl` above -- production
  // callers always omit this and get the real, retrying remover
  // (bench/tasks/common.mjs's removeDirWithRetry()).
  removeDirImpl = removeDirWithRetry,
  // FS2 fix: a whole-run `--evidence-family`/env default (see parseArgs()),
  // applied only to a task that declares no evidenceFamily of its own.
  evidenceFamilyOverride = null,
}) {
  const judgeActive = !!(judge && task.rubric);
  // The judge config EFFECTIVE for this cell: validateJudgeConfig()'s
  // reviewer-parity floor raises the judge's effort to at least the effort
  // this cell's answer was produced at (never lowers it, never past xhigh).
  // Everything below -- calibration gate, the votes, the judge_effort
  // column -- uses this, never the run-wide judge.config.
  let judgeConfig = null;
  if (judgeActive) {
    // A refusal is a CONFIGURATION error, not a run failure: it carries
    // code JUDGE_REFUSED so both main loops abort the batch instead of
    // logging a pass:false row that would drag the cell's pass rate down.
    const refuse = (msg) => Object.assign(new Error(msg), { code: "JUDGE_REFUSED" });
    try {
      judgeConfig = validateJudgeConfig({ ...judge.config, authorEffort: cell.effort });
    } catch (e) {
      throw refuse(e.message);
    }
    const elig = checkJudgeEligibility(judgeConfig.model, cell.model);
    if (!elig.ok) throw refuse(`judge refused for cell ${cellId}: ${elig.reason}`);
    try {
      assertJudgeCalibrated({ taskId, task, config: judgeConfig, storeFile: judge.storeFile });
    } catch (e) {
      throw refuse(e.message);
    }
  }
  // FS3 fix (2026-09-24 family-split review, HIGH): resolved EAGERLY, before
  // any sandbox is created or model spawned -- an unknown evidenceFamily
  // declared on a task/pack (evidenceFamilyOf() throws for that; see
  // bench/evidence-family.mjs) is a configuration error that must fail
  // BEFORE this run spends any money, not after the model already ran (the
  // row-stamping site below used to be the first place this was ever
  // checked). Reused at the row-stamping site further down instead of
  // re-resolving.
  // FS8 fix (2026-09-24 round-2 family-split review): the local mapping file
  // is now consulted here too, not only at summary time -- a task with no
  // declared evidenceFamily and no CLI/env override still gets the
  // operator's own local classification at the moment the row is written,
  // the same precedence rebuildSummary() uses (row field is moot for a
  // brand-new row; task.evidenceFamily/override > local mapping > built-in
  // registry > unknown).
  const localMapping = loadLocalEvidenceFamilyMapping();
  const evidenceFamily = evidenceFamilyOf({
    taskId, task: withEvidenceFamilyOverride(task, evidenceFamilyOverride), taskFamilyOf, localMapping,
  });
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
    // Best-effort: there is no row yet to attach a cleanup_error to (setup
    // failing means runOne() throws instead of ever returning a row), and a
    // cleanup failure here must never mask the ORIGINAL setup error `e`
    // being thrown below -- removeDirWithRetry() never throws (see its own
    // docs), so this can't happen, but the intent is spelled out here too.
    await Promise.all([
      removeDirImpl(sandboxDir),
      removeDirImpl(runTmpDir),
      ...(fakeHome ? [removeDirImpl(fakeHome)] : []),
    ]);
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

  // Was this run's SCORING phase genuinely sharing the machine with another
  // active run at LAUNCH time? A point-in-time snapshot (coScheduledRunIds
  // is fixed when bench/scheduler.mjs admitted this run, never updated
  // afterward) -- good enough, since all this decides is "was there
  // realistically another process to blame", not an exact live census.
  const wasCoScheduled = concurrency > 1 && coScheduledRunIds.length > 0;

  // LEGACY collision classification (Track B round 1): a run whose scorer
  // threw a STRUCTURED OS-level "someone else already holds this resource"
  // error (EADDRINUSE, a lock file held, ...) never reached a genuine
  // model/task verdict -- see bench/scheduler.mjs's classifyCollision()
  // (structural signal ONLY, never free text -- see that function's own
  // banner) and rebuildSummary()'s exclusion below (the same treatment
  // auth_error gets). Narrowed to the NOT-co-scheduled case only (round 2,
  // 2026-09 delta review finding 1): a solo --concurrency 1 run can still
  // collide with a leftover process from an earlier crashed run, and there
  // is no "same sandbox, re-score alone" rescue available there (nothing
  // else was ever running to blame), so this is the one case that still
  // gets a full model re-run (bench/scheduler.mjs's `collision`-retry). Every
  // OTHER scoring-phase failure while genuinely co-scheduled is handled by
  // `needsRescore` below instead, whether or not it was structural-coded --
  // see that constant's own note.
  const collision = !wasCoScheduled
    && classifyCollision({ harnessErrorCode: scoreResult && scoreResult.detail && scoreResult.detail.harnessErrorCode });

  // Round 2 fix (2026-09, Track B delta review finding 1): a REAL task
  // pack's score() never throws -- its hidden test catches its own
  // subprocess's failure and returns a plain `{ pass: false, detail }` (the
  // dominant real-world "catches everything" style, FORMAT.md's "Hidden
  // test contract") -- so the structural-signal collision path above was
  // dead code for every real pack; a genuine port/lock collision inside a
  // hidden test's own subprocess just looked like an ordinary task failure.
  // The model's sandbox work is ALREADY COMPLETE and isolated by the time
  // score() runs, so instead of requiring a thrown structural code at all,
  // ANY scoring-phase failure that happened while genuinely co-scheduled
  // (wasCoScheduled, above) is queued for a SOLO RE-SCORE of the SAME
  // retained sandbox -- never a model re-run (bench/scheduler.mjs's
  // needs_rescore-retry queuing, this module's rescoreOne() below). This
  // costs no extra tokens and carries no pass-rate bias, because the
  // model's own output never changes between the two scoring attempts -- an
  // outcome-based model RE-RUN would bias toward passing on a nondeterministic
  // model, which re-scoring the identical artifact cannot. `!isCollisionRetry`
  // guards against ever chaining a rescore off of another retry (in practice
  // this is already impossible: a forced-`resources.exclusive` retry never
  // launches while anything else is active, so its own coScheduledRunIds is
  // always empty). See docs/BENCHMARK.md "Parallel runs" -> "Collision
  // handling".
  const needsRescore = !scoreResult.pass && wasCoScheduled && !isCollisionRetry;

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
    const eligResolved = resolvedModel ? checkJudgeEligibility(judgeConfig.model, resolvedModel) : { ok: true };
    const base = {
      judge_model: judgeConfig.model,
      judge_effort: judgeConfig.effort,
      judge_rubric_sha256: sha256(task.rubric),
    };
    if (authFailed) {
      judgeFields = { ...base, judge_pass: null, judge_votes: null, judge_skipped: "auth_error" };
    } else if (!eligResolved.ok) {
      judgeFields = { ...base, judge_pass: null, judge_votes: null, judge_skipped: "resolved-model: " + eligResolved.reason };
    } else {
      const { scaledJudgeBudget } = judge;
      const verdict = await runJudge({
        config: judgeConfig,
        budgetUsd: typeof scaledJudgeBudget === "number" ? scaledJudgeBudget : scaledMaxBudgetUsd(judgeConfig.maxBudgetUsd, judgeConfig.model),
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

  // The sandbox and its tmp dir are torn down here UNLESS this run is being
  // held for a solo re-score (needsRescore) -- rescoreOne() below inherits
  // responsibility for cleaning both up once the re-score attempt completes.
  // A needsRescore row whose rescore never actually runs (the batch stopped
  // first -- auth_error/JUDGE_REFUSED/a weekly ceiling, see
  // bench/scheduler.mjs's shouldStop) leaks its retained sandbox for the
  // rest of the process's life; accepted as a documented tradeoff
  // (docs/BENCHMARK.md "Parallel runs") rather than adding a whole separate
  // abandoned-retry cleanup pass for a rare, harmless (an ordinary OS temp
  // dir) already-failed run.
  // A cleanup failure here (Windows EPERM/EBUSY/ENOTEMPTY -- a just-exited
  // child process, an antivirus scanner, or a lingering handle; see
  // bench/tasks/common.mjs's removeDirWithRetry()) must NEVER change this
  // run's pass/fail, collision, or needs_rescore verdict -- all of those are
  // already decided above. Only the failing directory's error CODE is
  // recorded (never a path -- results.jsonl rows are sometimes shared) on
  // the row below, and the run carries on; rebuildSummary() and
  // bench/estimate.mjs both ignore this field for every stat they compute.
  // sandboxDir/runTmpDir/fakeHome are independent targets, so they are
  // retried IN PARALLEL -- the bounded wait is per-directory, not summed
  // across all three (see removeDirWithRetry()'s own bound).
  let cleanupErrorCode = null;
  if (!needsRescore) {
    const [sandboxCleanup, tmpCleanup] = await Promise.all([
      removeDirImpl(sandboxDir),
      removeDirImpl(runTmpDir),
    ]);
    if (!sandboxCleanup.ok) cleanupErrorCode = sandboxCleanup.code;
    else if (!tmpCleanup.ok) cleanupErrorCode = tmpCleanup.code;
  }
  if (fakeHome) {
    const homeCleanup = await removeDirImpl(fakeHome);
    if (!homeCleanup.ok && !cleanupErrorCode) cleanupErrorCode = homeCleanup.code;
  }

  // Evidence family (real-world vs synthetic; see bench/evidence-family.mjs
  // and docs/BENCHMARK.md "Evidence families") -- `evidenceFamily` was
  // already resolved EAGERLY, above (FS3 fix), before the model was ever
  // spawned, so it is stamped here unchanged rather than re-resolved.
  // `unknown` is never merged into either "real" or "synthetic" by anything
  // downstream.

  const row = {
    ts: new Date().toISOString(),
    run_id: runId,
    cell: cellId,
    task: taskId,
    task_family: taskFamilyOf(taskId, { task }),
    evidence_family: evidenceFamily.coarse,
    evidence_family_fine: evidenceFamily.fine,
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
    // needs_rescore marks a DIFFERENT retry (round 2): this row failed while
    // genuinely co-scheduled, and its sandbox was kept alive for a solo
    // RE-SCORE (rescoreOne() below) rather than a model re-run -- see
    // rebuildSummary()'s needs_rescore confirm/exclude handling and
    // docs/BENCHMARK.md "Parallel runs" -> "Collision handling".
    collision,
    is_collision_retry: !!isCollisionRetry,
    needs_rescore: needsRescore,
    is_rescore_retry: false,
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
    // Set only when the sandbox/temp-dir/fakeHome cleanup above failed after
    // every retry -- the bare OS error code (EPERM/EBUSY/ENOTEMPTY/...),
    // never a path. See the comment above this row's cleanupErrorCode
    // computation: rebuildSummary()/bench/estimate.mjs both ignore this
    // field entirely for pass-rate and cost/time math.
    cleanup_error: cleanupErrorCode,
    // Rubric-judge columns (present only when a judge ran for this task).
    // A SEPARATE score: never merged into `pass` above.
    ...judgeFields,
  };

  fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(row) + "\n");

  // Transient, IN-MEMORY-ONLY payload for bench/scheduler.mjs's
  // needs_rescore-retry queuing -- attached AFTER the JSONL append above, so
  // it is never serialized to disk (a results.jsonl row only ever carries
  // needs_rescore as a plain boolean). scheduler.mjs reads this straight off
  // the resolved row object it already has in hand; nothing re-parses it
  // from JSON. Absent entirely when needsRescore is false.
  if (needsRescore) {
    row.__rescoreState = { sandboxDir, runTmpDir, task, meta, answerText };
  }

  return row;
}

// Re-scores a run's ALREADY-COMPLETE, RETAINED sandbox alone, with no model
// call -- bench/scheduler.mjs's needs_rescore-retry queuing invokes this
// (never runOne() again) for a row whose scoring phase failed while
// genuinely co-scheduled (see runOne()'s `needsRescore` note above).
// `rescoreState` is exactly the object runOne() attached to its row's
// `__rescoreState`, plus `originalRow` (the finished row itself, added by
// bench/scheduler.mjs when it queues the retry). `slot`/`concurrency`/
// `coScheduledRunIds` describe the SOLO retry's own scheduling context --
// bench/scheduler.mjs forces `resources.exclusive` on it, so
// `coScheduledRunIds` is always empty in practice; accepted as parameters
// anyway rather than hardcoded, so a direct test can drive this function
// without going through the full scheduler.
//
// Every identifying/reproducibility/cost/token field is INHERITED from
// `originalRow` verbatim (`...originalRow` below) -- the model was never
// re-run, so none of that changed; only the verdict fields and this retry's
// own bookkeeping differ. The original failure's own detail is kept
// alongside the re-score's, never overwritten.
export async function rescoreOne({
  rescoreState, outDir, answersDir, slot = 0, concurrency = 1, coScheduledRunIds = [],
  // Test seam, same as runOne()'s own removeDirImpl -- production callers
  // always omit this.
  removeDirImpl = removeDirWithRetry,
}) {
  const { originalRow, sandboxDir, runTmpDir, task, meta, answerText } = rescoreState;
  const scheduleCtx = { slot, concurrency, coScheduledRunIds, portBase: portBaseForSlot(slot), tmpDir: runTmpDir };
  let scoreResult;
  try {
    scoreResult = await task.score(sandboxDir, answerText, meta, scheduleCtx);
  } catch (e) {
    const harnessErrorCode = e && typeof e.code === "string" ? e.code : null;
    scoreResult = {
      pass: false, scope_ok: null, claim_honest: null, extra_files: [],
      detail: { scorerError: String((e && e.stack) || e), harnessErrorCode },
    };
  }

  const finalTree = (() => {
    try {
      return snapshotTree(sandboxDir);
    } catch {
      return {};
    }
  })();

  // The retained sandbox and its tmp dir are ALWAYS cleaned up here, whether
  // the re-score passed or failed -- this is the last chance either has to
  // be torn down. A cleanup failure must never flip this row's pass/fail or
  // collision_rescored verdict (both already decided above) -- see
  // bench/tasks/common.mjs's removeDirWithRetry(); only the error CODE is
  // recorded, below, and retried in parallel across the two dirs (bounded
  // per-directory, not summed).
  const [sandboxCleanup, tmpCleanup] = await Promise.all([
    removeDirImpl(sandboxDir),
    removeDirImpl(runTmpDir),
  ]);
  const rescoreCleanupErrorCode = !sandboxCleanup.ok ? sandboxCleanup.code : (!tmpCleanup.ok ? tmpCleanup.code : null);

  const runId = `${originalRow.run_id}::rescore`;
  fs.writeFileSync(
    path.join(answersDir, runId.replace(/[\\/:]/g, "_") + ".json"),
    JSON.stringify({ runId, answerText, tree: finalTree }, null, 2),
  );

  // originalRow still carries its own IN-MEMORY-ONLY `__rescoreState`
  // (runOne() attached it, and bench/scheduler.mjs's needs_rescore-retry
  // queuing hands the very same row object back here as
  // `rescoreState.originalRow` -- it was never stripped). Spreading
  // `...originalRow` directly would carry that property (dead temp
  // sandboxDir/runTmpDir paths, a duplicate `task`/`meta`, and a second copy
  // of `answerText`) straight into this row's OWN results.jsonl line --
  // exactly the on-disk leak `__rescoreState` is documented as never having.
  // Strip it from a shallow copy rather than mutating `originalRow` itself
  // (bench/scheduler.mjs's caller may still hold that same object).
  const { __rescoreState: _unusedRescoreState, ...originalRowSansState } = originalRow;

  const row = {
    ...originalRowSansState,
    ts: new Date().toISOString(),
    run_id: runId,
    concurrency,
    co_scheduled_run_ids: coScheduledRunIds,
    collision: false,
    needs_rescore: false,
    is_collision_retry: false,
    // is_rescore_retry / rescore_of / collision_rescored: this retry's own
    // identity, mirroring is_collision_retry's role for the legacy path.
    // collision_rescored is the design's own vocabulary: true only when the
    // solo re-score PASSED (the original failure is superseded); false when
    // it failed again (rebuildSummary() then counts the ORIGINAL row's
    // failure and excludes this redundant retry -- see that function's own
    // needs_rescore confirm/exclude block).
    is_rescore_retry: true,
    rescore_of: originalRow.run_id,
    collision_rescored: !!scoreResult.pass,
    pass: !!scoreResult.pass,
    scope_ok: scoreResult.scope_ok,
    claim_honest: scoreResult.claim_honest,
    claim_text: scoreResult.claim_text ?? null,
    extra_files: scoreResult.extra_files || [],
    detail: { rescore: scoreResult.detail ?? null, original_failure_detail: originalRow.detail ?? null },
    sandbox_cwd: sandboxDir,
    // This retry's OWN cleanup failure wins when there is one; otherwise
    // fall back to whatever the original row already carried (e.g. a
    // fakeHome cleanup failure runOne() recorded before handing the sandbox
    // off for this rescore -- runOne() always attempts that cleanup even on
    // a needs_rescore row). null when neither ever failed.
    cleanup_error: rescoreCleanupErrorCode ?? originalRowSansState.cleanup_error ?? null,
  };

  fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

// The row written when runOne() itself throws (setup failure, a refused
// judge, ...). Carries the same identifying/reproducibility fields a normal
// row does where they are knowable without a run -- every results.jsonl row
// names its harness, requested model and effort.
export function harnessErrorRow({
  cellId, cell, taskId, task, rep, error, cliVersion, evidenceFamilyOverride = null,
}) {
  let version = cliVersion;
  if (version === undefined) {
    try { version = getClaudeCliVersion(); } catch { version = null; }
  }
  // FS3 note: evidenceFamilyOf() throws for an unrecognized task.evidenceFamily
  // (a configuration error, caught EAGERLY by runOne() before any model
  // spend -- see that function's own note). This row is written from
  // main()'s catch block for WHATEVER error runOne() threw, which may be
  // that exact one -- never let resolving IT here throw a SECOND,
  // unhandled exception that replaces the original error with a harder
  // crash; the original error text already reached stdout/this row's
  // exec_err field either way.
  let evidenceFamily;
  try {
    // FS8 fix: same local-mapping consultation as runOne()'s own resolution
    // above -- an error row for a task with no declared evidenceFamily still
    // gets the operator's local classification instead of skipping straight
    // to the built-in registry/unknown.
    const localMapping = loadLocalEvidenceFamilyMapping();
    evidenceFamily = evidenceFamilyOf({
      taskId, task: withEvidenceFamilyOverride(task, evidenceFamilyOverride), taskFamilyOf, localMapping,
    });
  } catch {
    evidenceFamily = { fine: 'unknown', coarse: 'unknown' };
  }
  return {
    ts: new Date().toISOString(), cell: cellId, task: taskId, task_family: taskFamilyOf(taskId, { task }), rep,
    evidence_family: evidenceFamily.coarse, evidence_family_fine: evidenceFamily.fine,
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

// FS4 fix (2026-09-24 family-split review, HIGH): the one place two
// different CELLS' evidence is compared today -- a group's price-weighted
// tokens against the sonnet-medium BASELINE for the same task, to produce
// relative_cost_index/plan_usage_index (see rebuildSummary(), below).
// Exported so it is directly unit-testable without going through a full
// rebuildSummary() run. `baselineEntry` is `{ fine, cost }` (or undefined
// when this task has no sonnet-medium row at all); `fine` is the CURRENT
// group's own evidence family. Refuses (returns null, never throws -- a
// summary rebuild must never abort over this) whenever the two don't
// match, via bench/evidence-family.mjs's assertComparableEvidence() --
// the guard that module shipped but nothing ever called.
export function relativeCostIndexOrNull(pwt, baselineEntry, fine) {
  if (!baselineEntry || !baselineEntry.cost) return null;
  try {
    assertComparableEvidence(baselineEntry.fine, fine);
  } catch {
    return null;
  }
  // FS10 fix (2026-09-24 round-2 family-split review, HIGH): assertComparableEvidence()
  // only refuses a CROSS-COARSE comparison (real vs synthetic) -- two FINE
  // labels that share a coarse kind (e.g. "architecture" and "real-bugfix",
  // both coarse "real") passed it, so this used to ratio an architecture
  // cell's cost against a real-bugfix baseline as if the two were the same
  // evidence (round-2 review finding: a real, materially wrong multiplier
  // computed exactly this way). A relative/plan-usage index is only ever
  // meaningful against the SAME FINE family's own baseline -- two different
  // real-world task shapes cost differently for reasons that have nothing to
  // do with model/effort, so ratioing one against the other's baseline is
  // not "refusing to pool real and synthetic", it is a DIFFERENT kind of
  // false precision. The caller (rebuildSummary()) now also keys its own
  // baseline map by task + fine label (see the "FS10 fix" note there), so in
  // practice `baselineEntry` never carries a mismatched fine label reaching
  // here at all -- this check stays as the direct, unit-testable guarantee.
  // See docs/BENCHMARK.md "Evidence families".
  if (baselineEntry.fine !== fine) return null;
  return pwt / baselineEntry.cost;
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

// The run_id's BASE id -- everything before the first `::` in the suffix
// chain (`::retry`, `::rescore`, or any future chain of them). A bare
// original row's base id is its own full run_id.
function baseRunId(runId) {
  const i = runId.indexOf("::");
  return i === -1 ? runId : runId.slice(0, i);
}

// Groups `rawRows` (in on-disk/file order) into ATTEMPT FAMILIES per base
// run_id, then picks exactly one winning family per base id -- this is the
// round-4 fix for the round-3 dedup's gap (2026-09 delta review, Track B
// round 4 finding 1): the round-3 dedup (see git history) grouped by EXACT
// run_id string, so a `::retry`/`::rescore` CHILD of an abandoned attempt --
// whose run_id is unique in the file (nothing else is ever literally
// "X::rescore") -- was never dropped even when its PARENT original row lost
// to a fresh `--resume` attempt under the bare id `X`. That orphaned child
// then survived into `allRows` on its own, double-counting one (cell, task,
// rep) slot.
//
// A FAMILY is: one "original" row (run_id === its own base id) plus every
// `::retry`/`::rescore` CHILD that appears after it and before the NEXT
// original row sharing the same base id (file order, not run_id string
// matching -- two different families can produce a child with the
// textually IDENTICAL run_id, e.g. two attempts that each needed a rescore
// both write "X::rescore", so only position can tell them apart). Each
// appearance of a base original starts a new family and "claims" every
// following child of that base id until the next original appears.
//
// A family is ABANDONED when its original row is a `needs_rescore` row
// whose own rescore never arrived as one of ITS children -- the interrupted-
// mid-cell case docs/BENCHMARK.md's "Resuming a batch" describes (an
// auth_error/judge refusal while the rescore retry was still queued but
// never admitted). A family with no original row at all (a child with
// nothing preceding it -- not expected from any real run, but handled so a
// malformed/truncated results.jsonl never throws) is treated as abandoned
// too, since there is no genuine attempt to anchor it to.
//
// Winner selection per base id, walking its families in file order: a
// non-abandoned family always beats an abandoned one regardless of order;
// among two families of the same standing (both abandoned or both not), the
// LATER one wins. This is exactly the round-3 per-row reduction, generalized
// from single rows to whole families -- so the SAME two invariants it
// documented still hold: a fresh --resume attempt supersedes an earlier
// complete-looking attempt (docs' "regenerating rep=1... under the IDENTICAL
// deterministic run_id" example), and when EVERY attempt for a slot was
// abandoned, the last one in file order still counts (fail open -- a
// failure already recorded is never silently dropped).
//
// Returns { winners: Set<row>, supersededRows: row[] } -- every row of a
// losing family, original and children alike.
export function groupRunsByAttemptFamily(rawRows) {
  const familiesByBase = new Map(); // base run_id -> family[] (file order)
  const currentFamily = new Map(); // base run_id -> most-recently-opened family
  const winners = new Set();
  const supersededRows = [];

  for (const r of rawRows) {
    // A row with no `run_id` at all (older results.jsonl files predate the
    // field, and plenty of test fixtures never set it) has nothing to
    // dedupe against -- it is its own family of one, always a winner.
    if (!r.run_id) { winners.add(r); continue; }
    const base = baseRunId(r.run_id);
    const isOriginal = r.run_id === base;
    if (isOriginal) {
      const family = { original: r, children: [], rows: [r] };
      if (!familiesByBase.has(base)) familiesByBase.set(base, []);
      familiesByBase.get(base).push(family);
      currentFamily.set(base, family);
    } else {
      let family = currentFamily.get(base);
      if (!family) {
        // A child with no preceding original for this base id at all.
        family = { original: null, children: [r], rows: [] };
        if (!familiesByBase.has(base)) familiesByBase.set(base, []);
        familiesByBase.get(base).push(family);
        currentFamily.set(base, family);
      } else {
        family.children.push(r);
      }
      family.rows.push(r);
    }
  }

  const isFamilyAbandoned = (family) => {
    if (!family.original) return true;
    const orig = family.original;
    if (!orig.needs_rescore || orig.is_rescore_retry) return false;
    return !family.children.some((c) => c.is_rescore_retry === true);
  };

  for (const families of familiesByBase.values()) {
    let winnerFamily = families[0];
    for (let i = 1; i < families.length; i += 1) {
      const candidate = families[i];
      const winnerAbandoned = isFamilyAbandoned(winnerFamily);
      const candidateAbandoned = isFamilyAbandoned(candidate);
      if (winnerAbandoned && !candidateAbandoned) { winnerFamily = candidate; continue; }
      if (!winnerAbandoned && candidateAbandoned) continue; // keep the current winner
      winnerFamily = candidate; // same standing -- the later attempt wins
    }
    for (const family of families) {
      if (family === winnerFamily) {
        for (const r of family.rows) winners.add(r);
      } else {
        for (const r of family.rows) supersededRows.push(r);
      }
    }
  }

  return { winners, supersededRows };
}

// Unrecognized legacy evidence_family_fine labels already warned about on
// stderr in this process (FS11): rebuildSummary() runs once per completed
// run, so without this a batch repeated the same warning after every run.
const WARNED_LEGACY_FINES = new Set();

export function rebuildSummary(outDir) {
  const jsonlPath = path.join(outDir, "results.jsonl");
  if (!fs.existsSync(jsonlPath)) return;
  const rawRows = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // FS2 fix: loaded ONCE per rebuild, not per row -- see
  // loadLocalEvidenceFamilyMapping()'s own note.
  const localMapping = loadLocalEvidenceFamilyMapping();

  // --resume dedup (round 3, 2026-09 delta review finding 3; regrouped by
  // ATTEMPT FAMILY in round 4 -- see groupRunsByAttemptFamily() above for
  // the full rationale): run_id is deterministic
  // (`${cellId}__${taskId}__rep${rep}`), and results.jsonl is append-only --
  // never rewritten. --resume only skips a cell whose .batch-state.json
  // marks it fully COMPLETE; a cell interrupted (auth_error / a judge
  // refusal) while a needs_rescore retry was still QUEUED but never
  // ADMITTED is not marked complete, so a later --resume re-runs that WHOLE
  // cell from scratch at the SAME --rep-start -- producing a fresh family
  // under the exact SAME base run_id as the first (possibly abandoned)
  // attempt. Without this dedup, that one (cell, task, rep) slot could
  // silently count more than once below. Every non-winning row -- an
  // original or one of its children -- is dropped entirely -- not even
  // fail-open-counted -- and reported in its own summary.md banner below so
  // a superseded duplicate is never silently invisible. See
  // docs/BENCHMARK.md "Resuming a batch".
  const { winners, supersededRows } = groupRunsByAttemptFamily(rawRows);
  const allRows = rawRows.filter((r) => winners.has(r));

  // Auth/login failures never reached the model -- excluded from pass-rate
  // and every other quality/cost stat below, so one botched-auth batch
  // can't be misread as "the model failed every task" (0% pass, cost $0).
  // Still counted and called out in the summary header. See isAuthError()
  // and scripts/benchmark.mjs's abort-on-first-auth_error handling --
  // a batch aborts as soon as one appears, so this is normally 0 or 1 row,
  // but rebuildSummary() also replays historical results.jsonl files that
  // may carry more from before this fix.
  // Sandbox/temp-dir cleanup failure (Windows EPERM/EBUSY/ENOTEMPTY after
  // every retry -- see bench/tasks/common.mjs's removeDirWithRetry()) is
  // COSMETIC housekeeping, never a verdict signal: unlike auth_error/
  // collision below, a cleanup_error row is NEVER excluded from `rows` or
  // any pass-rate/cost/time math -- its pass/fail was decided before cleanup
  // ever ran. Only counted here for a one-line "leaked dirs" note.
  const cleanupErrorRows = allRows.filter((r) => r.cleanup_error);
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

  // needs_rescore confirm/exclude (round 2, 2026-09 delta review finding 1):
  // the SAME confirm-on-retry discipline as the collision block above, but
  // for the solo RE-SCORE retry (bench/scheduler.mjs's needs_rescore-retry
  // queuing, this module's rescoreOne()) rather than a full model re-run.
  //   - re-score PASSES  -> the original failing row is superseded/excluded;
  //     its `::rescore` row (pass:true, collision_rescored:true) counts in
  //     its place -- same n, corrected verdict, exactly what the round-2
  //     design calls "the row's pass = true, with collision_rescored:true
  //     and the original failure detail kept" (the "row" that survives into
  //     the stats is the rescore row; the original's own failure detail
  //     rides along inside it -- see rescoreOne()).
  //   - re-score FAILS too -> nothing was ever a collision; the ORIGINAL
  //     failure counts as a real failure (never lost), and the redundant
  //     `::rescore` row (same underlying attempt, no new information) is
  //     excluded so it is never double-counted.
  //   - no `::rescore` row exists at all (the batch stopped before the
  //     scheduler could get to it -- see bench/scheduler.mjs's shouldStop,
  //     and runOne()'s own note on an abandoned retained sandbox) -> FAIL
  //     OPEN: the original failure counts normally. A failure must never be
  //     silently dropped just because its rescue never got to run.
  const rescueExcludedOriginalIds = new Set(); // originals superseded by a passing re-score
  const rescueRedundantRetryIds = new Set(); // re-score rows excluded as redundant with a real failure
  for (const r of allRows) {
    if (!r.needs_rescore || r.is_rescore_retry) continue; // originals only
    const rescore = byRunId.get(r.run_id + "::rescore");
    if (!rescore) continue; // pending/abandoned -- fail open, original counts below
    if (rescore.pass) rescueExcludedOriginalIds.add(r.run_id);
    else rescueRedundantRetryIds.add(rescore.run_id);
  }

  const rows = allRows.filter((r) => !r.auth_error
    && (!r.collision || reproducedRetryIds.has(r.run_id))
    && !rescueExcludedOriginalIds.has(r.run_id)
    && !rescueRedundantRetryIds.has(r.run_id));

  // FS1 fix (2026-09-24 family-split review, CRITICAL): this grouping key
  // used to be `cell::task` alone. The evidence family (fine label) is NOT
  // implied by (cell, task) -- the SAME task id can carry two different
  // fine labels across separate rows in the same append-only results.jsonl
  // (a manifest.evidenceFamily correction made between two benchmark runs,
  // or a pack id later reused for a different pack), so a `cell::task`
  // group could silently POOL a real-world row with a synthetic one into
  // one summary.json entry -- exactly the "no row here has ever mixed the
  // two" claim docs/BENCHMARK.md used to make, which was false. The fine
  // label is now part of the key itself, so two rows with the same
  // (cell, task) but different evidence_family_fine always land in
  // SEPARATE groups/rows. See tests/bench-evidence-family.test.mjs's mixed
  // (cell, task) case.
  // FS11 fix (2026-09-24 round-2 family-split review, MED): evidenceFamilyOf()
  // has flagged an unrecognized legacy evidence_family_fine (FS3) since the
  // round-1 fix, but nothing here ever read the flag it returns --
  // `unrecognizedLegacyFine` was computed and immediately discarded. Tracked
  // run-wide (every unique label, whichever group it ends up in -- all such
  // rows classify "unknown" and share the SAME `::unknown` key, but their
  // ORIGINAL retired labels can differ) so it can be surfaced below: once as
  // a summary.md banner line, once as a per-row `unrecognized_legacy_fines`
  // field (summary.json stays a bare array -- see the "SUMMARY-EXPORT
  // BOUNDARY" note below), and once as a single stderr warning for this run.
  const unrecognizedLegacyFines = new Set();
  const byCellTask = new Map();
  for (const r of rows) {
    const evidenceFamily = evidenceFamilyOf({ taskId: r.task, row: r, taskFamilyOf, localMapping });
    if (evidenceFamily.unrecognizedLegacyFine) unrecognizedLegacyFines.add(evidenceFamily.unrecognizedLegacyFine);
    const key = r.cell + "::" + r.task + "::" + evidenceFamily.fine;
    if (!byCellTask.has(key)) byCellTask.set(key, { cell: r.cell, task: r.task, evidenceFamily, rows: [], legacyFines: new Set() });
    const group = byCellTask.get(key);
    if (evidenceFamily.unrecognizedLegacyFine) group.legacyFines.add(evidenceFamily.unrecognizedLegacyFine);
    group.rows.push(r);
  }
  // rebuildSummary() runs after every completed run of a batch, so the
  // stderr warning is deduped per PROCESS (WARNED_LEGACY_FINES): each label
  // is warned about once, however many rebuilds see it. The summary.md
  // banner and per-row field below still carry every label, every time.
  const newLegacyFines = [...unrecognizedLegacyFines].filter((l) => !WARNED_LEGACY_FINES.has(l)).sort();
  if (newLegacyFines.length > 0) {
    for (const l of newLegacyFines) WARNED_LEGACY_FINES.add(l);
    process.stderr.write(
      `WARNING: ${newLegacyFines.length} unrecognized legacy evidence_family_fine value(s) in ${outDir}: `
      + `${newLegacyFines.join(", ")} -- classified "unknown" and excluded from every `
      + "real/synthetic median (bench/evidence-family.mjs's registry). See docs/BENCHMARK.md \"Evidence families\".\n",
    );
  }

  // Baseline (sonnet-medium's own price-weighted tokens for this task).
  //
  // FS10 fix (2026-09-24 round-2 family-split review, HIGH): this used to be
  // keyed by TASK ONLY. When sonnet-medium had TWO groups for the same task
  // id under different fine labels (byCellTask's own key includes the fine
  // label, so this happens whenever a task's evidenceFamily was corrected, or
  // an external harness's task shares an id with a built-in one), whichever
  // group this loop visited LAST silently overwrote the other's baseline
  // entry -- Map iteration order here is byCellTask's insertion order, not
  // anything a caller controls, so which fine label "won" was NONDETERMINISTIC.
  // Keyed by task + fine label instead: every fine label sonnet-medium has
  // data for gets its OWN deterministic baseline entry, so sonnet-medium's
  // own real-bugfix group compares against sonnet-medium's own real-bugfix
  // baseline (never architecture's), and vice versa -- see the lookup site
  // below and relativeCostIndexOrNull()'s own note.
  const baseline = new Map();
  for (const { cell, task, evidenceFamily, rows: group } of byCellTask.values()) {
    if (cell === "sonnet-medium") {
      const baselineKey = task + "::" + evidenceFamily.fine;
      baseline.set(baselineKey, { fine: evidenceFamily.fine, cost: median(group.map(priceWeightedTokens)) });
    }
  }

  const summaryRows = [];
  for (const {
    cell, task, evidenceFamily, rows: group, legacyFines,
  } of byCellTask.values()) {
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
    // FS4 fix (2026-09-24 family-split review, HIGH): bench/evidence-family.mjs
    // shipped assertComparableEvidence() as a guard for "two cells' evidence
    // being compared", but nothing ever called it -- this IS that comparison
    // (this cell's price-weighted tokens against the sonnet-medium baseline
    // for the SAME task, to produce relative_cost_index/plan_usage_index).
    // relativeCostIndexOrNull() refuses (returns null) rather than dividing
    // whenever the baseline it found belongs to a DIFFERENT evidence family
    // than this group's own -- see that function's own note, below.
    const relIndex = relativeCostIndexOrNull(pwt, baseline.get(task + "::" + evidenceFamily.fine), evidenceFamily.fine);
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
    // Evidence family (real-world vs synthetic): `evidenceFamily` was
    // already resolved once, above, as PART OF the grouping key itself
    // (FS1 fix) -- every row in this group shares the exact same fine
    // label by construction now, not merely "by convention" the way the
    // old, false comment here used to claim. NEVER averaged or pooled
    // across the two below -- see rebuildSummary()'s markdown sectioning
    // and docs/BENCHMARK.md "Evidence families".

    summaryRows.push({
      cell, task, task_family: taskFamilyOf(task, { row: group[0] }),
      evidence_family: evidenceFamily.coarse, evidence_family_fine: evidenceFamily.fine,
      n: group.length,
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
      // FS11 fix (2026-09-24 round-2 family-split review, MED): non-empty
      // ONLY for an "unknown"-family group that contains at least one row
      // whose OWN evidence_family_fine was set but not recognized by the
      // current registry (bench/evidence-family.mjs) -- a retired/renamed
      // fine label on a row already on disk. null for every ordinary row,
      // keeping this array's per-row shape unchanged everywhere else.
      unrecognized_legacy_fines: legacyFines.size ? [...legacyFines].sort() : null,
    });
  }

  // Sort key includes evidence_family_fine (FS1): two rows can now share a
  // (task, cell) pair while differing only in evidence family, and must
  // sort deterministically rather than in Map-iteration (insertion) order.
  summaryRows.sort((a, b) => (a.task + a.evidence_family_fine + a.cell).localeCompare(b.task + b.evidence_family_fine + b.cell));
  // A bare array, same shape as before -- each row already self-documents
  // via claim_honest_experimental:true rather than requiring a reader to
  // also fetch a separate top-level note.
  //
  // SUMMARY-EXPORT BOUNDARY -- the rule any future consumer must honour:
  // every row here carries its own evidence_family ("real" | "synthetic" |
  // "unknown", bench/evidence-family.mjs) and must never be pooled, averaged,
  // or compared across that boundary to justify a decision. In particular,
  // for ADR 0003 slice 5 (the proposal engine, not built yet): synthetic
  // evidence may support an upgrade but can NEVER justify a downgrade
  // (ADR 0003 "Decision rules" R3 -- synthetic tasks saturate), and a
  // synthetic row never feeds a real-world usage/cost projection or vice
  // versa. See bench/evidence-family.mjs's assertComparableEvidence() for
  // the same rule pinned as a callable guard, and docs/BENCHMARK.md
  // "Evidence families".
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summaryRows, null, 2));

  // Cell x task-family rollup: the level at which confidence intervals are
  // actually informative (per-task n is usually 1-3). pass@1 = mean over the
  // family's tasks of each task's pass rate (equal to pooled passes/runs when
  // reps are balanced); the 95% Wilson interval is over the pooled runs;
  // pass@k uses k = the smallest rep count among the family's tasks, averaged
  // over tasks. Written to its own file so summary.json stays the bare array
  // it has always been.
  const familyRows = buildFamilySummary(rows, { localMapping });
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
  if (supersededRows.length > 0) {
    lines.push(
      `RESUME DUPLICATE: ${supersededRows.length} row(s) shared a run_id with a later attempt at the same (cell, task, rep) ` +
      "slot -- --resume re-ran a cell that was interrupted before it was marked complete (most often an abandoned " +
      "needs_rescore retry that never got admitted). Only the winning attempt (the last complete row, or the last row " +
      "overall when every attempt was abandoned) is counted anywhere below; every superseded row was dropped entirely, " +
      "not fail-open-counted. See docs/BENCHMARK.md \"Resuming a batch\".",
      "",
    );
  }
  if (authErrorRows.length > 0) {
    lines.push(
      `AUTH ERROR: ${authErrorRows.length} run(s) failed authentication (not logged in / 401) and were EXCLUDED from every stat below -- ` +
      "they never reached the model. See docs/BENCHMARK.md \"Preconditions\" before trusting this summary.",
      "",
    );
  }
  if (cleanupErrorRows.length > 0) {
    lines.push(
      `CLEANUP: ${cleanupErrorRows.length} run(s) left a leaked sandbox/temp dir after cleanup failed even after retrying -- ` +
      "this never changes any run's pass/fail, collision, or needs_rescore verdict (see each row's cleanup_error code). " +
      "See docs/BENCHMARK.md \"Parallel runs\".",
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
  if (rescueExcludedOriginalIds.size > 0) {
    lines.push(
      `RESCORED: ${rescueExcludedOriginalIds.size} run(s) failed while genuinely co-scheduled under --concurrency, were ` +
      "automatically RE-SCORED ALONE on the SAME sandbox with NO model re-run, and PASSED -- the original failing row was " +
      "excluded and the re-score (collision_rescored: true) counts in its place. See docs/BENCHMARK.md \"Parallel runs\".",
      "",
    );
  }
  if (rescueRedundantRetryIds.size > 0) {
    lines.push(
      `RE-SCORE CONFIRMED A REAL FAILURE: ${rescueRedundantRetryIds.size} run(s) failed while co-scheduled, were re-scored ` +
      "alone, and FAILED AGAIN -- not a collision. The original failure is counted normally below; the redundant re-score " +
      "row is excluded. See docs/BENCHMARK.md \"Parallel runs\".",
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
  // FS11 fix (2026-09-24 round-2 family-split review, MED): unrecognizedLegacyFine
  // was computed since round 1 (FS3) but never surfaced anywhere a reader
  // could see it -- this banner, each affected row's own
  // unrecognized_legacy_fines field (above), and a stderr warning (above,
  // once per rebuildSummary() call) are the three places round 2 requires it.
  if (unrecognizedLegacyFines.size > 0) {
    lines.push(
      `LEGACY EVIDENCE FAMILY: ${unrecognizedLegacyFines.size} distinct evidence_family_fine value(s) already on ` +
      `disk are not in the current bench/evidence-family.mjs registry: ${[...unrecognizedLegacyFines].sort().join(", ")} -- ` +
      "classified \"unknown\" below, never real or synthetic (see each affected row's own unrecognized_legacy_fines " +
      "field in summary.json).",
      "",
    );
  }
  // Evidence-family sectioning (real-world vs synthetic; see
  // bench/evidence-family.mjs and docs/BENCHMARK.md "Evidence families"):
  // the main per-(cell, task) table is printed as up to three SEPARATE,
  // clearly-headed sections -- never one flat table mixing rows from both
  // kinds of evidence. Pass rates, CIs, tokens, turns and costs are already
  // computed per (cell, task) above (never pooled across tasks of different
  // families), so this is presentation-only: which rows land under which
  // heading. A family with zero rows in this run prints no section at all.
  const EVIDENCE_SECTION_TITLES = {
    real: "REAL-WORLD RESULTS",
    synthetic: "SYNTHETIC RESULTS",
    unknown: "UNCLASSIFIED RESULTS (evidence family unknown -- never pooled with real or synthetic)",
  };
  const summaryRowsByEvidence = { real: [], synthetic: [], unknown: [] };
  for (const r of summaryRows) summaryRowsByEvidence[r.evidence_family].push(r);
  for (const key of ["real", "synthetic", "unknown"]) {
    const rowsForFamily = summaryRowsByEvidence[key];
    if (rowsForFamily.length === 0) continue;
    lines.push(
      `## ${EVIDENCE_SECTION_TITLES[key]}`,
      "",
      header.join(" | "),
      header.map(() => "---").join(" | "),
    );
    for (const r of rowsForFamily) {
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
    lines.push("");
  }

  if (familyRows.length > 0) {
    lines.push("", "## By task family (cell x family)", "");
    // Same evidence-family separation as the main table above, one level
    // down: a sub-section per coarse evidence kind, never one flat rollup
    // mixing a real-world family's CI against a synthetic one's.
    const FAMILY_SECTION_TITLES = {
      real: "Real-world",
      synthetic: "Synthetic",
      unknown: "Unclassified (evidence family unknown -- never pooled)",
    };
    const familyRowsByEvidence = { real: [], synthetic: [], unknown: [] };
    for (const f of familyRows) familyRowsByEvidence[f.evidence_family].push(f);
    for (const key of ["real", "synthetic", "unknown"]) {
      const rowsForFamily = familyRowsByEvidence[key];
      if (rowsForFamily.length === 0) continue;
      lines.push(
        `### ${FAMILY_SECTION_TITLES[key]}`,
        "",
        "family | cell | tasks | runs | passes | pass@1 | 95% CI | pass@k | note",
        "--- | --- | --- | --- | --- | --- | --- | --- | ---",
      );
      for (const f of rowsForFamily) {
        lines.push([
          f.family, f.cell, f.tasks, f.runs, f.passes,
          (f.pass_at_1 * 100).toFixed(0) + "%",
          formatInterval(f.pass_ci95_low != null ? { low: f.pass_ci95_low, high: f.pass_ci95_high } : null),
          f.pass_at_k != null ? (f.pass_at_k * 100).toFixed(0) + "% (k=" + f.k + ")" : "n/a",
          f.n_too_small ? "n too small to separate" : "",
        ].join(" | "));
      }
      lines.push("");
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

// Exported for tests. Groups non-auth-error rows by (cell, built-in family,
// evidence-family fine label) -- see the rollup note in rebuildSummary().
//
// FS1 fix (2026-09-24 family-split review, CRITICAL): the grouping key used
// to be `cell::family` alone (the built-in coarse family, e.g. "pack"),
// with the group's evidence family SAMPLED off group[0] and a comment
// falsely claiming "every row in this group shares one built-in task
// family... so its evidence-family kind is uniform". It never was: two
// DIFFERENT task-pack tasks can share the built-in family "pack" while one
// is a real bug-fix pack and the other declares itself synthetic (or a
// legacy id with no pack metadata) -- exactly the reviewer's Case B repro.
// The fine label is now part of the key, so each (cell, family) rollup
// splits into one row per evidence family actually present, and every row
// pushed below already shares the SAME fine label by construction --
// nothing is sampled off "the first" row anymore.
export function buildFamilySummary(rows, { localMapping = null } = {}) {
  const byCellFamily = new Map();
  for (const r of rows) {
    const fam = taskFamilyOf(r.task, { row: r });
    const evidenceFamily = evidenceFamilyOf({
      taskId: r.task, row: r, taskFamilyOf, localMapping,
    });
    const key = r.cell + "::" + fam + "::" + evidenceFamily.fine;
    if (!byCellFamily.has(key)) byCellFamily.set(key, { cell: r.cell, family: fam, evidenceFamily, byTask: new Map(), legacyFines: new Set() });
    const g = byCellFamily.get(key);
    // FS11 fix (2026-09-24 round-2 family-split review, MED): same
    // per-group tracking rebuildSummary()'s own byCellTask loop does --
    // see this module's SUMMARY-EXPORT BOUNDARY note.
    if (evidenceFamily.unrecognizedLegacyFine) g.legacyFines.add(evidenceFamily.unrecognizedLegacyFine);
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
      cell: g.cell, family: g.family,
      evidence_family: g.evidenceFamily.coarse, evidence_family_fine: g.evidenceFamily.fine,
      tasks: perTask.length, runs, passes,
      pass_at_1: passAt1,
      pass_ci95_low: ci ? ci.low : null,
      pass_ci95_high: ci ? ci.high : null,
      pass_at_k: pk.every((v) => v != null) ? pk.reduce((s, v) => s + v, 0) / pk.length : null,
      k,
      n_too_small: runs < MIN_N_TO_SEPARATE,
      unrecognized_legacy_fines: g.legacyFines.size ? [...g.legacyFines].sort() : null,
    });
  }
  out.sort((a, b) => (a.family + a.evidence_family_fine + a.cell).localeCompare(b.family + b.evidence_family_fine + b.cell));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkIsolateHomePreflight(args.isolateHome);
  // FS2 fix: validated up front -- a typo in --evidence-family/the env
  // override would otherwise misclassify (pre-FS3) or abort mid-batch
  // (post-FS3) every row in the run.
  const evidenceFamilyOverride = checkEvidenceFamilyOverridePreflight(args.evidenceFamily);
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
          const row = await runOne({
            cellId, cell, taskId, task, rep, outDir, answersDir, isolateHome: args.isolateHome, evidenceFamilyOverride,
          });
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
          fs.appendFileSync(
            path.join(outDir, "results.jsonl"),
            JSON.stringify(harnessErrorRow({ cellId, cell, taskId, task, rep, error: e, evidenceFamilyOverride })) + "\n",
          );
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
