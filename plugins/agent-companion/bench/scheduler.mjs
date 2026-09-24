// Parallel-safe scheduling for the model x effort benchmark.
//
// scripts/benchmark.mjs and bench/runner.mjs both funnel every planned run
// (a cell x task x rep triple, or a collision retry of one) through
// scheduleRuns() here rather than a bespoke loop, so --concurrency 1
// (the default) behaves exactly like the historical fully-sequential runner,
// and --concurrency N > 1 gets the SAME conflict/capacity/collision rules
// everywhere this benchmark is driven from.
//
// Three responsibilities, kept separate so each is independently testable
// with zero model calls and zero real child processes:
//   1. resourcesConflict()  -- pure function: may run A and run B share the
//      machine right now, given their declared `resources`?
//   2. makeCapacityGate()   -- wraps scripts/capacity.mjs's free-RAM budget
//      into a "can I afford one more concurrent run" check, re-evaluated
//      before every launch (RAM changes as runs start/stop).
//   3. scheduleRuns()       -- the actual async admission-control loop: pulls
//      runnable, non-conflicting, affordable runs off the queue up to
//      `concurrency`, and on a `collision` result auto-queues ONE solo retry
//      (forced `resources.exclusive`, so the scheduler itself guarantees it
//      runs alone -- no separate "retry" code path needed).
//
// See bench/task-packs/FORMAT.md ("Resource declarations") for the
// manifest.resources schema packs use to declare this, and
// docs/BENCHMARK.md ("Parallel runs") for the operator-facing picture.

import { collectSystemStats, computeHeadroomGB, computeConcurrencyBudget } from '../scripts/capacity.mjs';

// ---------------------------------------------------------------------------
// 1. Resource conflicts. Pure, synchronous, no I/O.
// ---------------------------------------------------------------------------

function normalizeLockPath(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

// A run descriptor is { id, taskId, resources? }. `resources` mirrors the
// pack/task manifest shape: { fixedPorts?: number[], lockFiles?: string[],
// exclusive?: boolean }. Absent `resources` (the field itself missing, not
// present-but-empty) means "this pack never said" -- FORMAT.md's default,
// "a pack with no declaration is exclusive with other runs of the SAME
// pack", is applied only in that case, not when a run explicitly declares an
// (even empty) resources object opting out of the default.
export function resourcesConflict(a, b) {
  if (!a || !b) return false;
  const ra = a.resources;
  const rb = b.resources;
  if (ra && ra.exclusive) return true;
  if (rb && rb.exclusive) return true;

  const portsA = new Set((ra && ra.fixedPorts) || []);
  const portsB = new Set((rb && rb.fixedPorts) || []);
  for (const p of portsA) if (portsB.has(p)) return true;

  const locksA = new Set(((ra && ra.lockFiles) || []).map(normalizeLockPath));
  const locksB = new Set(((rb && rb.lockFiles) || []).map(normalizeLockPath));
  for (const l of locksA) if (locksB.has(l)) return true;

  if (ra === undefined && rb === undefined && a.taskId != null && a.taskId === b.taskId) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 2. Capacity gate. Re-checked before every launch (RAM moves as runs start
//    and finish), never allowed to block a run over a probe failure -- the
//    same fail-open posture scripts/capacity.mjs itself takes.
// ---------------------------------------------------------------------------

export function makeCapacityGate({ perAgentMB = 350, headroomGB = null } = {}) {
  return function canAfford(wantedActiveCount) {
    try {
      const stats = collectSystemStats();
      const totalGB = stats.totalBytes / (1024 ** 3);
      const freeGB = stats.freeBytes / (1024 ** 3);
      if (!(totalGB > 0)) return true; // couldn't read memory at all -- fail open
      const headroom = headroomGB == null ? computeHeadroomGB(totalGB) : headroomGB;
      const budget = computeConcurrencyBudget(freeGB, headroom, perAgentMB / 1024);
      return wantedActiveCount <= budget;
    } catch {
      return true;
    }
  };
}

// ---------------------------------------------------------------------------
// Collision classification. A run failing this way never reached a genuine
// model/task verdict -- it collided with ANOTHER run's OS-level resource
// (a port still bound, a lock file still held). Same "carve this failure
// class out of pass-rate math" treatment bench/runner.mjs already gives
// auth_error; see rebuildSummary()'s COLLISION handling.
// ---------------------------------------------------------------------------

const COLLISION_RE = /EADDRINUSE|address already in use|EEXIST.*lock|lock\s*(file)?\s*(is\s+)?held|resource temporarily unavailable.*lock|ELOCKED/i;

export function classifyCollision({ err, stdout, stderr, detail } = {}) {
  const detailText = typeof detail === 'string' ? detail : (detail ? safeStringify(detail) : '');
  const haystack = [err, stdout, stderr, detailText].filter(Boolean).join('\n');
  return COLLISION_RE.test(haystack);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Port-base allocation. One reserved range per concurrency SLOT (not per
// run), so two runs that are simultaneously ACTIVE never share a base even
// though run identity changes over the batch's lifetime -- a slot is only
// ever held by one active run at a time (scheduleRuns() enforces this).
// ---------------------------------------------------------------------------

export function portBaseForSlot(slot, { base = 20000, rangeSize = 200 } = {}) {
  return base + Math.max(0, slot) * rangeSize;
}

// ---------------------------------------------------------------------------
// 3. The scheduler itself.
// ---------------------------------------------------------------------------
//
// runs: array of { id, taskId, resources?, ...anything else `launch` needs }.
// launch(run, ctx): ctx = { slot, concurrency, coScheduledRunIds }. Returns
//   (or resolves to) a row-shaped object; a `collision: true` row triggers
//   exactly one solo retry, requeued with resources.exclusive forced true.
// canAfford(wantedActiveCount): see makeCapacityGate() above. Defaults to
//   "always affordable" so pure scheduling logic can be tested without the
//   real machine's memory.
// onEvent({ type, ... }): optional instrumentation hook for tests/logging --
//   'start' | 'finish' | 'collision-retry-queued'.
//
// Returns the array of every row produced (including collision rows and
// their retries), in FINISH order -- not necessarily the same order as
// `runs` was given, since concurrent runs can finish out of order.
export async function scheduleRuns({
  runs, concurrency = 1, canAfford = () => true, launch, onEvent = () => {},
  // Checked before every admission pass. Once true, no NEW run is started
  // (auth_error/JUDGE_REFUSED abort semantics, and a batch-ceiling stop),
  // but every already-ACTIVE run is still awaited to completion -- an
  // in-flight `claude` process is never abandoned mid-run. The returned
  // array can then be shorter than `runs` when a stop was requested; that is
  // the caller's signal a stop happened, not a scheduler bug.
  shouldStop = () => false,
}) {
  const effectiveConcurrency = Math.max(1, concurrency);
  const queue = [...runs];
  const active = new Map(); // runId -> { run, promise, slot }
  const usedSlots = new Set();
  const results = [];

  const nextFreeSlot = () => {
    for (let s = 0; s < effectiveConcurrency; s += 1) if (!usedSlots.has(s)) return s;
    // Should not happen (active.size is always < effectiveConcurrency when
    // this is called), but never hand out a duplicate slot.
    let s = effectiveConcurrency;
    while (usedSlots.has(s)) s += 1;
    return s;
  };

  const conflictsWithActive = (run) => {
    for (const { run: activeRun } of active.values()) {
      if (resourcesConflict(run, activeRun)) return true;
    }
    return false;
  };

  while (queue.length > 0 || active.size > 0) {
    // Admit as many runnable, non-conflicting, affordable runs as possible
    // before waiting on anything -- re-scanning from the top of the queue
    // after each admission, since a newly-active run can make a
    // previously-runnable queued run conflict (or vice versa, never).
    let admittedThisPass = !shouldStop();
    while (admittedThisPass && active.size < effectiveConcurrency && queue.length > 0) {
      admittedThisPass = false;
      for (let i = 0; i < queue.length; i += 1) {
        const candidate = queue[i];
        if (conflictsWithActive(candidate)) continue;
        if (!canAfford(active.size + 1)) continue;
        queue.splice(i, 1);
        const slot = nextFreeSlot();
        usedSlots.add(slot);
        const coScheduledRunIds = [...active.keys()];
        const promise = Promise.resolve().then(() => launch(candidate, {
          slot, concurrency: effectiveConcurrency, coScheduledRunIds,
        }));
        active.set(candidate.id, { run: candidate, promise, slot });
        onEvent({ type: 'start', runId: candidate.id, slot, coScheduledRunIds, concurrency: effectiveConcurrency });
        admittedThisPass = true;
        break; // restart the scan against the updated active set
      }
    }

    if (active.size === 0) {
      if (queue.length > 0 && shouldStop()) {
        // An intentional stop (auth_error / JUDGE_REFUSED / batch ceiling)
        // with runs still queued -- not a deadlock. Leave them un-run; the
        // caller reads results.length < runs.length as the stop signal.
        onEvent({ type: 'stopped', remaining: queue.length });
        break;
      }
      if (queue.length > 0) {
        // Every remaining queued run conflicts with something, or nothing
        // is affordable, and nothing is active to eventually free either up
        // -- a genuinely unsatisfiable plan (e.g. capacity budget of 0).
        // Fail loudly rather than spin forever.
        throw new Error(
          `bench/scheduler.mjs: ${queue.length} run(s) left with nothing active -- unsatisfiable resource `
          + 'declarations or capacity budget (check --concurrency / capacity_per_agent_mb).',
        );
      }
      break;
    }

    const entries = [...active.entries()];
    const settled = await Promise.race(entries.map(([id, entry]) => entry.promise
      .then((row) => ({ id, row }))
      .catch((error) => ({ id, error }))));

    const finishedEntry = active.get(settled.id);
    active.delete(settled.id);
    usedSlots.delete(finishedEntry.slot);

    const row = settled.row || {
      id: settled.id,
      collision: false,
      is_error: true,
      exec_err: String((settled.error && settled.error.stack) || settled.error),
    };
    results.push(row);
    onEvent({ type: 'finish', runId: settled.id, row });

    if (row.collision && !finishedEntry.run.isRetry) {
      const retryRun = {
        ...finishedEntry.run,
        id: `${finishedEntry.run.id}::retry`,
        isRetry: true,
        retryOf: finishedEntry.run.id,
        // Forced exclusive -- resourcesConflict() then refuses to co-schedule
        // it with ANYTHING, so the scheduler itself guarantees "alone",
        // rather than a separate serial-retry code path.
        resources: { ...(finishedEntry.run.resources || {}), exclusive: true },
      };
      queue.push(retryRun);
      onEvent({ type: 'collision-retry-queued', runId: settled.id, retryId: retryRun.id });
    }
  }

  return results;
}
