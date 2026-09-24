#!/usr/bin/env node
// Model x effort benchmark — operator-facing entry point.
//
// bench/runner.mjs carries the proven mechanics (headless `claude -p
// --output-format json`, full model ids, effort proven from the transcript,
// spawn claude.exe never claude.cmd, --setting-sources "", --max-budget-usd).
// This script is the CLI layer on top: task-family expansion, a global
// runaway-budget ceiling, --dry-run (plan only, zero model calls), and
// --batch-by/--resume so a driving agent can check plan usage between
// batches instead of one process running the whole grid unattended. See
// docs/BENCHMARK.md before a real run and skills/model-benchmark/SKILL.md
// for the operating procedure.
//
// HOME/USERPROFILE: by DEFAULT this does NOT redirect them -- a live run
// uses your normal, already-authenticated OAuth session (`claude /login`),
// same as the proven pre-port harness. Pass --isolate-home to redirect to a
// throwaway HOME per run instead (only works with ANTHROPIC_API_KEY auth;
// refused otherwise). See docs/BENCHMARK.md "Preconditions" and "Sandbox
// isolation" before choosing.
//
// Usage:
//   node benchmark.mjs --dry-run --cells all --tasks all --reps 1
//   node benchmark.mjs --cells sonnet-medium,haiku --tasks easy --reps 1
//   node benchmark.mjs --cells all --tasks real --reps 1 --max-budget-usd 2.0
//   node benchmark.mjs --cells all --tasks all --reps 1 --batch-by cell
//   node benchmark.mjs --resume --out-dir <dir from the previous invocation>
//
// Exit codes: 0 on a completed (or paused-for-resume) run or a dry-run;
// 1 if a live run aborts on an auth error; 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CELLS, TASKS, TASK_FAMILIES, resolveList, runOne, rebuildSummary, defaultResultsRoot,
  checkIsolateHomePreflight, formatRunLine, authErrorAbortMessage, scaledMaxBudgetUsd,
  harnessErrorRow, cliJudgeCaller, taskFamilyOf,
} from '../bench/runner.mjs';
import { loadPack, buildTaskFromPack } from '../bench/task-packs/lib.mjs';
import {
  validateJudgeConfig, checkJudgeEligibility, taskJudgeKey, findTrustedCalibration, calibrateJudge,
} from '../bench/judge.mjs';
import { scheduleRuns, makeCapacityGate } from '../bench/scheduler.mjs';
import {
  loadSeed, loadLocalHistory, estimateRun, formatEstimate, shouldConfirm,
} from '../bench/estimate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Task families (easy / hard / real) live in bench/runner.mjs now -- the
// summary's confidence intervals are reported per cell x family, so the
// mechanics need them too. Imported above and re-exported below unchanged.

function usageError(msg) {
  console.error(msg);
  console.error('\nSee: node benchmark.mjs --help');
  process.exit(2);
}

function printHelp() {
  console.log(`node benchmark.mjs [options]

  --cells <id,id,...|all>       CELLS in bench/runner.mjs (full model ids + effort). Default: all.
  --tasks <id,id,...|family>    Task ids, or a family: easy | hard | real | all. Comma-separated
                                 families and ids may be mixed. Default: all.
  --reps <N>                    Repetitions per (cell, task). Default: 1.
  --rep-start <N>                First rep number (for resuming a specific rep range). Default: 1.
  --concurrency <N>              Run up to N (task, rep) runs of the SAME cell in parallel (default 1,
                                 fully sequential -- identical behavior to before this flag existed).
                                 Runs whose declared resources conflict (bench/task-packs/FORMAT.md
                                 "Resource declarations") are never co-scheduled; a free-RAM check
                                 (bench/scheduler.mjs's makeCapacityGate(), --per-agent-mb below) gates
                                 every launch. See docs/BENCHMARK.md "Parallel runs".
  --per-agent-mb <MB>             Per-run memory estimate for the --concurrency capacity gate.
                                 Default: 350 (scripts/capacity.mjs's own default). Ignored at
                                 --concurrency 1 (no gate is applied).
  --weekly-usage-pct <N>          Current weekly plan-usage %, as read by the orchestrating skill via
                                 get_usage (this script cannot read it itself). Shown in the pre-run
                                 estimate's "current -> projected" line; omit to show "unknown".
  --weekly-ceiling-pct <N>        A configured weekly-usage ceiling. Crossing it (current + estimated)
                                 requires --confirm to start, and --batch-by cell stops at the next
                                 cell boundary (prints a partial-results summary) once
                                 --weekly-usage-pct reaches it.
  --confirm-above-points <N>      Weekly-point threshold above which a live run requires --confirm.
                                 Default: 2.
  --confirm                      Acknowledges the pre-run estimate's confirmation gate (see
                                 "Confirmation gate" in docs/BENCHMARK.md) and lets a gated live run
                                 start. Has no effect on --dry-run, which never needs it.
  --out-dir <dir>                Results directory. Default: the plugin data dir's
                                 benchmarks/<phase>-<date>/ (see bench/runner.mjs's defaultResultsRoot()).
  --phase <name>                 Phase label used only when --out-dir is omitted (default "pilot"),
                                 e.g. --phase real -> benchmarks/real-<date>/.
  --max-budget-usd <amount>      Global per-run ceiling, applied on top of (never looser than) each
                                 task's own calibrated --max-budget-usd.
  --dry-run                      Print the plan (cell x task x rep counts, and the exact args each
                                 run would use) and exit. Makes ZERO model calls.
  --batch-by cell                Run ONE cell to completion (every task x every rep for it), write
                                 a batch-complete marker under --out-dir, then exit — so the driving
                                 agent can check plan usage before the next cell. Re-invoke with
                                 --resume to continue.
  --resume                       Skip cells already marked complete under --out-dir (requires
                                  --out-dir to point at a previous invocation's directory, or
                                  --batch-by cell + the same --cells/--tasks/--reps to recompute it).
  --task-pack <dir>[,<dir>...]    Merge task-pack task(s) (bench/task-packs/FORMAT.md) into the
                                 runnable set, selectable via --tasks by their own manifest id.
  --pack-repo <path>              Source repo for --task-pack's runtime git-show extraction.
                                 Required whenever --task-pack is given.
  --isolate-home                 Redirect HOME/USERPROFILE to a throwaway dir per run (opt-in;
                                 default is your normal OAuth session, unredirected). Requires
                                 ANTHROPIC_API_KEY -- refused otherwise. See docs/BENCHMARK.md.
  --judge-model <full id>        OPTIONAL rubric judge (bench/judge.mjs): grade each run's change
                                 against the task's rubric, as a SEPARATE score (never merged into
                                 pass/fail). Must differ from, and be at least as strong as, every
                                 selected cell's model. Only tasks with a rubric are judged.
  --judge-effort <low|medium|high>  Judge effort. Default: medium.
  --judge-budget-usd <amount>    Per-vote budget cap in Sonnet dollars (scaled by the judge's price).
                                 Default 0.3, hard cap 1.0.
  --judge-calibrations <file>    Calibration store. Default: <data dir>/benchmarks/judge-calibrations.json.
  --calibrate-judge              Calibrate the judge on every selected task that has a rubric (known-good
                                 must PASS, every known-bad must FAIL), write the store, and exit
                                 (0 = all trusted, 1 = any untrusted). Makes real judge calls
                                 (3 votes x (1 + known-bad count) per task). A live run refuses to
                                 start with an uncalibrated judge.
  --list                         Print available cells, task ids, and task families, then exit.
  --help                         Print this text and exit.
`);
}

function parseArgs(argv) {
  const out = {
    cells: 'all', tasks: 'all', reps: 1, repStart: 1, outDir: null, phase: 'pilot',
    maxBudgetUsd: null, dryRun: false, batchByCell: false, resume: false, list: false, help: false,
    taskPacks: [], packRepo: null, isolateHome: false,
    judgeModel: null, judgeEffort: null, judgeBudgetUsd: null, judgeCalibrations: null, calibrateJudge: false,
    concurrency: 1, perAgentMB: null,
    weeklyUsagePct: null, weeklyCeilingPct: null, confirmAbovePoints: 2, confirm: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cells') out.cells = argv[++i];
    else if (a === '--tasks') out.tasks = argv[++i];
    else if (a === '--reps') out.reps = Number(argv[++i]);
    else if (a === '--rep-start') out.repStart = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--per-agent-mb') out.perAgentMB = Number(argv[++i]);
    else if (a === '--weekly-usage-pct') out.weeklyUsagePct = Number(argv[++i]);
    else if (a === '--weekly-ceiling-pct') out.weeklyCeilingPct = Number(argv[++i]);
    else if (a === '--confirm-above-points') out.confirmAbovePoints = Number(argv[++i]);
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--phase') out.phase = argv[++i];
    else if (a === '--max-budget-usd') out.maxBudgetUsd = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--batch-by') { const v = argv[++i]; if (v !== 'cell') usageError(`--batch-by only supports "cell", got "${v}"`); out.batchByCell = true; }
    else if (a === '--resume') out.resume = true;
    else if (a === '--list') out.list = true;
    else if (a === '--task-pack') out.taskPacks.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--pack-repo') out.packRepo = argv[++i];
    else if (a === '--isolate-home') out.isolateHome = true;
    else if (a === '--judge-model') out.judgeModel = argv[++i];
    else if (a === '--judge-effort') out.judgeEffort = argv[++i];
    else if (a === '--judge-budget-usd') out.judgeBudgetUsd = Number(argv[++i]);
    else if (a === '--judge-calibrations') out.judgeCalibrations = argv[++i];
    else if (a === '--calibrate-judge') out.calibrateJudge = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else usageError(`unknown arg: ${a}`);
  }
  return out;
}

// Loads every --task-pack directory into runner.mjs-shaped tasks (see
// bench/task-packs/FORMAT.md) and merges them into a COPY of the built-in
// TASKS map -- the import stays untouched so re-running with no --task-pack
// behaves exactly as before. A pack id colliding with a built-in task id is
// a usage error, not a silent shadow.
function loadTaskMap(args) {
  const merged = { ...TASKS };
  if (args.taskPacks.length && !args.packRepo) usageError('--task-pack requires --pack-repo <path> (the source repo for git-show extraction at run time)');
  for (const dir of args.taskPacks) {
    const pack = loadPack(dir);
    if (merged[pack.id]) usageError(`task pack "${pack.id}" (${dir}) collides with an existing task id`);
    merged[pack.id] = buildTaskFromPack(pack, { repoPath: args.packRepo });
  }
  return merged;
}

// Expands a --tasks spec into a concrete, de-duplicated, ORDER-STABLE list of
// task ids. A spec may mix families ("easy", "hard", "real") and literal
// task ids ("lookup,hard-verify"), comma-separated; "all" means every task
// in `tasksMap` (built-ins plus any merged task packs), family membership or
// not. Family names only ever expand to the BUILT-IN sets in TASK_FAMILIES —
// a task-pack task is always selected by its own id.
function expandTasks(spec, tasksMap) {
  if (spec === 'all') return Object.keys(tasksMap);
  const seen = new Set();
  const ids = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const family = TASK_FAMILIES[part];
    const ones = family || [part];
    for (const id of ones) {
      if (!tasksMap[id]) usageError(`unknown task or family: "${part}"${family ? '' : ' (not a task id, not a family: easy | hard | real, and not a loaded task pack)'}`);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return ids;
}

// bench/runner.mjs's taskFamilyOf() returns the bare family names this
// benchmark's OWN grid uses ("easy" | "hard" | "real" | "pack" | "other").
// bench/estimate.mjs's seed/history are keyed by the GENERIC labels the
// public seed ships (bench/config/estimate-seed.json: "easy-synthetic" |
// "hard-synthetic" | "real-bugfix" | "architecture") -- this maps one to the
// other. A task pack ("pack") is bug-fix sized by convention (FORMAT.md), so
// it maps to "real-bugfix"; "architecture" has no built-in task family at
// all today (it is ADR 0003 slice 6 mining's own family, supplied directly
// by that caller, never derived from a built-in task id).
const FAMILY_TO_SEED_FAMILY = {
  easy: 'easy-synthetic', hard: 'hard-synthetic', real: 'real-bugfix', pack: 'real-bugfix',
};

// Flattens a cell x task x rep grid into bench/estimate.mjs's plan shape
// ({ cellId, model, effort, family, n }), one row per (cell, task) with
// n = reps -- estimateRun() treats n identical rows as equivalent to n
// separate ones, so this is exact, not an approximation.
export function buildEstimatePlan({ cellIds, taskIds, tasksMap, reps }) {
  const plan = [];
  for (const cellId of cellIds) {
    const cell = CELLS[cellId];
    if (!cell) continue;
    for (const taskId of taskIds) {
      const task = tasksMap[taskId];
      const rawFamily = taskFamilyOf(taskId, { task });
      plan.push({
        cellId, model: cell.model, effort: cell.effort,
        family: FAMILY_TO_SEED_FAMILY[rawFamily] || rawFamily, n: reps, taskId,
      });
    }
  }
  return plan;
}

export function defaultCalibrationStore() {
  return path.join(defaultResultsRoot(), 'judge-calibrations.json');
}

// Judge preflight, run before ANY model call (live, --dry-run, and
// --calibrate-judge alike). Returns null when no judge was asked for, else
// { config, storeFile, judgedTasks, problems[] }: config validation,
// judge-vs-cell eligibility for every selected cell, and (unless
// calibrating) a TRUSTED calibration record for every selected task that has
// a rubric. A live run refuses to start while problems[] is non-empty -- the
// runner never uses an uncalibrated judge.
export function judgePreflight({ args, cellIds, taskIds, tasksMap, calibrating = false }) {
  if (!args.judgeModel) {
    if (calibrating) return { config: null, judgedTasks: [], problems: ['--calibrate-judge requires --judge-model'] };
    return null;
  }
  const problems = [];
  let config = null;
  try {
    config = validateJudgeConfig({ model: args.judgeModel, effort: args.judgeEffort, maxBudgetUsd: args.judgeBudgetUsd });
  } catch (e) {
    return { config: null, judgedTasks: [], problems: [e.message] };
  }
  const storeFile = args.judgeCalibrations
    ? (path.isAbsolute(args.judgeCalibrations) ? args.judgeCalibrations : path.resolve(process.cwd(), args.judgeCalibrations))
    : defaultCalibrationStore();
  if (!calibrating) {
    for (const id of cellIds) {
      const elig = checkJudgeEligibility(config.model, CELLS[id].model);
      if (!elig.ok) problems.push(`cell ${id}: ${elig.reason}`);
    }
  }
  const judgedTasks = taskIds.filter((t) => tasksMap[t] && tasksMap[t].rubric);
  if (judgedTasks.length === 0) problems.push('none of the selected tasks has a rubric -- the judge would never run (add rubric.md to a task pack)');
  if (!calibrating) {
    for (const t of judgedTasks) {
      if (!findTrustedCalibration(storeFile, taskJudgeKey(t, tasksMap[t], config))) {
        problems.push(`task ${t}: judge ${config.model}/${config.effort ?? 'none'} is not calibrated (run --calibrate-judge first)`);
      }
    }
  }
  return { config, storeFile, judgedTasks, problems };
}

function batchStatePath(outDir) {
  return path.join(outDir, '.batch-state.json');
}

function readBatchState(outDir) {
  try {
    return JSON.parse(fs.readFileSync(batchStatePath(outDir), 'utf8'));
  } catch {
    return { completedCells: [] };
  }
}

function writeBatchState(outDir, state) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(batchStatePath(outDir), JSON.stringify(state, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (args.list) {
    console.log('Cells (bench/runner.mjs CELLS):');
    for (const [id, c] of Object.entries(CELLS)) console.log(`  ${id.padEnd(16)} ${c.model}${c.effort ? '/' + c.effort : ''}`);
    console.log('\nTask families:');
    for (const [fam, ids] of Object.entries(TASK_FAMILIES)) console.log(`  ${fam.padEnd(8)} ${ids.join(', ')}`);
    console.log('\nAll task ids: ' + Object.keys(TASKS).join(', '));
    process.exit(0);
  }

  try {
    checkIsolateHomePreflight(args.isolateHome);
  } catch (e) {
    usageError(e.message);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    usageError(`--concurrency must be a positive integer, got "${args.concurrency}"`);
  }

  const cellIds = resolveList(args.cells, CELLS);
  for (const id of cellIds) if (!CELLS[id]) usageError(`unknown cell: "${id}" (--list to see valid cells)`);
  const tasksMap = loadTaskMap(args);
  const taskIds = expandTasks(args.tasks, tasksMap);

  const judge = judgePreflight({ args, cellIds, taskIds, tasksMap, calibrating: args.calibrateJudge });

  if (args.calibrateJudge) {
    if (judge.problems.length) usageError('Cannot calibrate the judge:\n  - ' + judge.problems.join('\n  - '));
    if (args.dryRun) {
      console.log(`DRY RUN -- would calibrate judge ${judge.config.model}/${judge.config.effort ?? 'none'} on: ${judge.judgedTasks.join(', ')}`);
      console.log(`store: ${judge.storeFile}`);
      process.exit(0);
    }
    let allTrusted = true;
    for (const t of judge.judgedTasks) {
      // eslint-disable-next-line no-await-in-loop
      const rec = await calibrateJudge({
        taskId: t, task: tasksMap[t], config: judge.config,
        budgetUsd: scaledMaxBudgetUsd(judge.config.maxBudgetUsd, judge.config.model),
        callJudge: cliJudgeCaller, storeFile: judge.storeFile,
      });
      allTrusted = allTrusted && rec.trusted;
      console.log(`${t}: ${rec.trusted ? 'TRUSTED' : 'NOT TRUSTED'} -- known-good ${rec.knownGood.pass === true ? 'PASS' : 'did not pass'} (${rec.knownGood.votes.join('/')}); `
        + rec.knownBad.map((b) => `${b.label} ${b.pass === false ? 'FAIL' : 'did not fail'} (${b.votes.join('/')})`).join('; '));
    }
    console.log(`Calibration store: ${judge.storeFile}`);
    process.exit(allTrusted ? 0 : 1);
  }

  const outDir = args.outDir
    ? (path.isAbsolute(args.outDir) ? args.outDir : path.resolve(process.cwd(), args.outDir))
    : path.join(defaultResultsRoot(), `${args.phase}-${new Date().toISOString().slice(0, 10)}`);
  const answersDir = path.join(outDir, 'answers');

  const totalRuns = cellIds.length * taskIds.length * args.reps;

  // Resume filtering happens BEFORE the --dry-run branch (and before it
  // decides what to print) so `--dry-run --resume` shows only the plan for
  // what's actually left, not the full original grid re-printed as if
  // nothing had run yet. readBatchState() tolerates a missing/nonexistent
  // outDir (falls back to { completedCells: [] }), so this is safe to do
  // even before outDir is ever created.
  let cellsToRun = cellIds;
  let resumeNote = null;
  if (args.resume) {
    const state = readBatchState(outDir);
    const done = new Set(state.completedCells || []);
    cellsToRun = cellIds.filter((id) => !done.has(id));
    resumeNote = cellsToRun.length === 0
      ? 'Nothing to resume — every requested cell is already marked complete in ' + batchStatePath(outDir)
      : `Resuming: ${cellsToRun.length}/${cellIds.length} cell(s) remaining (${cellsToRun.join(', ')}).`;
  }

  if (args.dryRun) {
    console.log('DRY RUN — plan only, no model calls will be made.\n');
    console.log(`out dir:  ${outDir}`);
    console.log(`cells:    ${cellIds.length}  (${cellIds.join(', ')})`);
    console.log(`tasks:    ${taskIds.length}  (${taskIds.join(', ')})`);
    console.log(`reps:     ${args.reps} (starting at ${args.repStart})`);
    console.log(`total runs: ${totalRuns}`);
    if (args.maxBudgetUsd != null) console.log(`global --max-budget-usd ceiling: $${args.maxBudgetUsd}`);
    if (args.batchByCell) console.log('batching: one cell per invocation (--batch-by cell)');
    if (args.concurrency > 1) console.log(`concurrency: ${args.concurrency} parallel (task, rep) runs per cell (see docs/BENCHMARK.md "Parallel runs")`);
    if (args.isolateHome) console.log('--isolate-home: HOME/USERPROFILE will be redirected per run (requires ANTHROPIC_API_KEY)');
    if (judge) {
      console.log(`rubric judge: ${judge.config ? `${judge.config.model}/${judge.config.effort ?? 'none'}` : '(invalid)'}; judged tasks: ${(judge.judgedTasks || []).join(', ') || 'none'}`);
      if (judge.problems.length) console.log('JUDGE WOULD BE REFUSED -- a live run will not start:\n  - ' + judge.problems.join('\n  - '));
    }
    if (resumeNote) console.log(resumeNote);
    if (args.resume && cellsToRun.length === 0) process.exit(0);
    console.log('\nPlanned runs (cell / task / rep -> claude args)' + (args.resume ? ', remaining cells only' : '') + ':');
    for (const cellId of cellsToRun) {
      const cell = CELLS[cellId];
      for (const taskId of taskIds) {
        const task = tasksMap[taskId];
        // Mirrors runOne()'s own scaling (bench/runner.mjs, scaledMaxBudgetUsd)
        // so the dry-run preview shows the cap that will ACTUALLY run, not
        // the unscaled Sonnet-calibrated default for a pricier cell.
        const scaledTaskBudget = scaledMaxBudgetUsd(task.maxBudgetUsd, cell.model);
        const budget = args.maxBudgetUsd != null
          ? Math.min(scaledTaskBudget, scaledMaxBudgetUsd(args.maxBudgetUsd, cell.model))
          : scaledTaskBudget;
        for (let rep = args.repStart; rep < args.repStart + args.reps; rep += 1) {
          const claudeArgs = [
            '-p', '<task prompt>',
            '--model', cell.model,
            '--output-format', 'json',
            '--dangerously-skip-permissions',
            '--strict-mcp-config',
            '--setting-sources', '""',
            '--max-budget-usd', String(budget),
          ];
          if (cell.effort) claudeArgs.push('--effort', cell.effort);
          console.log(`  ${cellId} / ${taskId} / rep${rep}  ->  claude ${claudeArgs.join(' ')}`);
        }
      }
    }
    console.log('');
    const dryRunEstimate = estimateRun({
      plan: buildEstimatePlan({ cellIds: cellsToRun, taskIds, tasksMap, reps: args.reps }),
      concurrency: args.concurrency,
      seed: loadSeed(),
      history: loadLocalHistory(),
    });
    console.log(formatEstimate(dryRunEstimate, {
      currentWeeklyPct: args.weeklyUsagePct, weeklyCeilingPct: args.weeklyCeilingPct, confirmAbovePoints: args.confirmAbovePoints,
    }));
    process.exit(0);
  }

  if (judge && judge.problems.length) {
    usageError('Refusing to start: the rubric judge is not usable for this plan.\n  - ' + judge.problems.join('\n  - '));
  }
  const judgeOpt = judge ? {
    config: judge.config, storeFile: judge.storeFile, callJudge: cliJudgeCaller,
    scaledJudgeBudget: scaledMaxBudgetUsd(judge.config.maxBudgetUsd, judge.config.model),
  } : null;

  // Pre-run estimate + confirmation gate (ADR 0003 sec 3 "Cost controls
  // before any run") -- ALWAYS shown before a live run starts, not only on
  // --dry-run. This script cannot read plan usage itself (see
  // --weekly-usage-pct's help text); the orchestrating skill reads it via
  // get_usage and passes it in.
  const liveEstimate = estimateRun({
    plan: buildEstimatePlan({ cellIds: cellsToRun, taskIds, tasksMap, reps: args.reps }),
    concurrency: args.concurrency,
    seed: loadSeed(),
    history: loadLocalHistory(),
  });
  console.log(formatEstimate(liveEstimate, {
    currentWeeklyPct: args.weeklyUsagePct, weeklyCeilingPct: args.weeklyCeilingPct, confirmAbovePoints: args.confirmAbovePoints,
  }));
  const gate = shouldConfirm(liveEstimate, {
    confirmAbovePoints: args.confirmAbovePoints, weeklyCeilingPct: args.weeklyCeilingPct, currentWeeklyPct: args.weeklyUsagePct,
  });
  if (gate.required && !args.confirm) {
    usageError(
      '\nRefusing to start without confirmation (see the estimate above):\n  - ' + gate.reasons.join('\n  - ')
      + '\n\nReview the estimate, then re-invoke with --confirm to proceed (or narrow --cells/--tasks/--reps to bring it under the threshold).',
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(answersDir, { recursive: true });

  if (args.resume) {
    console.log(resumeNote);
    if (cellsToRun.length === 0) {
      rebuildSummary(outDir);
      process.exit(0);
    }
  }

  // Free-RAM capacity gate for --concurrency > 1 (bench/scheduler.mjs). At
  // the default --concurrency 1 the gate is never consulted at all -- this
  // keeps the historical fully-sequential path's behavior byte-for-byte
  // unchanged, rather than relying on the gate itself always saying yes.
  const capacityGate = args.concurrency > 1
    ? makeCapacityGate({ perAgentMB: args.perAgentMB ?? undefined })
    : null;

  for (const cellId of cellsToRun) {
    // Live stop: check the weekly ceiling BETWEEN batches (a "batch" here is
    // one cell, --batch-by cell's existing unit). --weekly-usage-pct is
    // whatever the orchestrating skill last read via get_usage; this script
    // cannot read it itself. Stopping BEFORE starting the next cell (rather
    // than mid-cell) means every already-written row stays a clean,
    // complete batch.
    if (args.weeklyCeilingPct != null && args.weeklyUsagePct != null && args.weeklyUsagePct >= args.weeklyCeilingPct) {
      rebuildSummary(outDir);
      console.log(`\nCEILING REACHED: weekly usage ${args.weeklyUsagePct}% >= configured ceiling ${args.weeklyCeilingPct}% -- `
        + `stopping before starting cell "${cellId}".`);
      console.log(`Partial results: ${path.join(outDir, 'summary.md')}`);
      process.exit(0);
    }

    const cell = CELLS[cellId];
    // Every (task, rep) for this cell, flattened into one schedulable plan.
    // --concurrency N runs up to N of these at once, subject to resource
    // conflicts (FORMAT.md) and the capacity gate above; --concurrency 1
    // (default) runs them one at a time, in the same order as before.
    const plan = [];
    for (const taskId of taskIds) {
      for (let rep = args.repStart; rep < args.repStart + args.reps; rep += 1) {
        plan.push({ id: `${cellId}__${taskId}__rep${rep}`, taskId, rep, resources: tasksMap[taskId].resources });
      }
    }

    let stopReason = null; // set by launch() on an auth_error or JUDGE_REFUSED -- stops admitting NEW runs
    const launch = async (run, ctx) => {
      const task = tasksMap[run.taskId];
      const t0 = Date.now();
      const tag = ctx.concurrency > 1 ? ` [slot ${ctx.slot}/${ctx.concurrency}]` : '';
      process.stdout.write(`[${new Date().toISOString()}] START ${cellId} / ${run.taskId} / rep${run.rep}${tag} ... `);
      try {
        const row = await runOne({
          cellId, cell, taskId: run.taskId, task, rep: run.rep, outDir, answersDir,
          maxBudgetUsdCeiling: args.maxBudgetUsd,
          isolateHome: args.isolateHome,
          judge: judgeOpt,
          runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
          isCollisionRetry: !!run.isRetry,
        });
        process.stdout.write(formatRunLine(row, Date.now() - t0) + '\n');
        if (row.auth_error && !stopReason) stopReason = { type: 'auth_error', row };
        return row;
      } catch (e) {
        if (e && e.code === 'JUDGE_REFUSED') {
          if (!stopReason) stopReason = { type: 'judge_refused', message: e.message };
          return {
            run_id: run.id, cell: cellId, task: run.taskId, rep: run.rep,
            pass: false, is_error: true, judge_refused: true, exec_err: e.message,
          };
        }
        process.stdout.write(`ERROR: ${(e && e.stack) || e}\n`);
        const errRow = harnessErrorRow({ cellId, cell, taskId: run.taskId, task, rep: run.rep, error: e });
        fs.appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify(errRow) + '\n');
        return errRow;
      }
    };

    // eslint-disable-next-line no-await-in-loop
    await scheduleRuns({
      runs: plan,
      concurrency: args.concurrency,
      canAfford: capacityGate || (() => true),
      launch,
      shouldStop: () => !!stopReason,
    });

    if (stopReason && stopReason.type === 'auth_error') {
      console.error(authErrorAbortMessage(stopReason.row));
      rebuildSummary(outDir);
      process.exit(1);
    }
    if (stopReason && stopReason.type === 'judge_refused') {
      console.error(`\nJUDGE REFUSED: ${stopReason.message}\nAborting the batch.`);
      rebuildSummary(outDir);
      process.exit(1);
    }

    if (args.batchByCell) {
      const state = readBatchState(outDir);
      const completed = new Set(state.completedCells || []);
      completed.add(cellId);
      writeBatchState(outDir, { completedCells: [...completed], lastCellAt: new Date().toISOString() });
      rebuildSummary(outDir);
      console.log(`\nBATCH COMPLETE: ${cellId}. ${completed.size}/${cellIds.length} of the requested cells done.`);
      console.log(`Check plan usage now (mcp__ccd_session_mgmt__get_usage), then re-invoke with --resume to continue, or stop here.`);
      console.log(`Marker: ${batchStatePath(outDir)}`);
      process.exit(0); // one cell per invocation, by design — see the module banner
    }
  }

  rebuildSummary(outDir);
  console.log('\nDone. Summary written to ' + path.join(outDir, 'summary.md'));
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { parseArgs, expandTasks, TASK_FAMILIES };
