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
  CELLS, TASKS, resolveList, runOne, rebuildSummary, defaultResultsRoot,
  checkIsolateHomePreflight, formatRunLine, authErrorAbortMessage, scaledMaxBudgetUsd,
} from '../bench/runner.mjs';
import { loadPack, buildTaskFromPack } from '../bench/task-packs/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Task families: a coarser unit than a single task id, matching the "easy /
// hard / real" tiers docs/BENCHMARK.md and PROCESS-NOTES.md describe. Kept
// here (not in runner.mjs) because it is a CLI convenience, not a mechanic —
// runner.mjs's own --tasks stays a plain id list or "all".
const TASK_FAMILIES = {
  easy: ['lookup', 'verify', 'procedure', 'bounded-edit', 'diagnosis', 'instruction-logic'],
  hard: ['hard-verify', 'hard-procedure', 'hard-diagnosis', 'hard-instruction-logic'],
  real: [
    'real-capacity', 'real-secret-scan', 'real-opt-fallback', 'real-effort-note',
    'real-publication-sweep', 'real-misleading-report', 'real-contradictory-spec',
  ],
};

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
  --list                         Print available cells, task ids, and task families, then exit.
  --help                         Print this text and exit.
`);
}

function parseArgs(argv) {
  const out = {
    cells: 'all', tasks: 'all', reps: 1, repStart: 1, outDir: null, phase: 'pilot',
    maxBudgetUsd: null, dryRun: false, batchByCell: false, resume: false, list: false, help: false,
    taskPacks: [], packRepo: null, isolateHome: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cells') out.cells = argv[++i];
    else if (a === '--tasks') out.tasks = argv[++i];
    else if (a === '--reps') out.reps = Number(argv[++i]);
    else if (a === '--rep-start') out.repStart = Number(argv[++i]);
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

  const cellIds = resolveList(args.cells, CELLS);
  for (const id of cellIds) if (!CELLS[id]) usageError(`unknown cell: "${id}" (--list to see valid cells)`);
  const tasksMap = loadTaskMap(args);
  const taskIds = expandTasks(args.tasks, tasksMap);

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
    if (args.isolateHome) console.log('--isolate-home: HOME/USERPROFILE will be redirected per run (requires ANTHROPIC_API_KEY)');
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
    process.exit(0);
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

  for (const cellId of cellsToRun) {
    const cell = CELLS[cellId];
    for (const taskId of taskIds) {
      const task = tasksMap[taskId];
      for (let rep = args.repStart; rep < args.repStart + args.reps; rep += 1) {
        const t0 = Date.now();
        process.stdout.write(`[${new Date().toISOString()}] START ${cellId} / ${taskId} / rep${rep} ... `);
        try {
          // eslint-disable-next-line no-await-in-loop
          const row = await runOne({
            cellId, cell, taskId, task, rep, outDir, answersDir,
            maxBudgetUsdCeiling: args.maxBudgetUsd,
            isolateHome: args.isolateHome,
          });
          process.stdout.write(formatRunLine(row, Date.now() - t0) + '\n');
          if (row.auth_error) {
            console.error(authErrorAbortMessage(row));
            rebuildSummary(outDir);
            process.exit(1);
          }
        } catch (e) {
          process.stdout.write(`ERROR: ${(e && e.stack) || e}\n`);
          fs.appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify({
            ts: new Date().toISOString(), cell: cellId, task: taskId, rep, pass: false, is_error: true,
            exec_err: String((e && e.message) || e),
          }) + '\n');
        }
      }
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
