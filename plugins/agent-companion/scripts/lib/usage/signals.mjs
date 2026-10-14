// usage/signals.mjs: the scout's signals from the daily usage analysis (design section 5, batch 7).
//
// Pure reads of three files the runner leaves under the state root, no model, no network, no writes:
//   state/usage-analysis-latest.json            the newest computed day: regression ids and rows
//   state/usage-analysis-status.json            the last run and the per-day state map
//   state/usage-analysis-config-invalid.json    written by the config loader while a layer is invalid
//
// Signals returned: usage_regression, routine_model_drift (the routine.modelDrift scenario),
// usage_analysis_stale, usage_analysis_config_invalid. Each fires once per change (the caller keeps
// the keys in its baseline), so a standing condition does not repeat every morning; a quiet day
// returns nothing. A missing file is "never ran here" and stays quiet: the stale check needs a
// status file to judge against.
//
// TODO(0.31.19): usage_llm_over_budget, with the opt-in LLM rater (batch 10).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { addDays, dayEndMs, dayKeyOfMs, isDayKey, DEFAULT_BOUNDARY_UTC_HOUR, HOUR_MS } from './days.mjs';

const SETTLE_MS = 5 * 60 * 1000;
// The scout fires at 04:10 local (10 min after the day close); the scheduler adds up to ~12 min.
// A day still not computed 90 min after its close has missed its expected run.
const EXPECTED_RUN_MS = 90 * 60 * 1000;
const STATUS_MAX_AGE_MS = 36 * HOUR_MS;
const LATEST_MAX_AGE_DAYS = 3;
const KEEP_KEYS = 80;

// The earliest day with a facts file under state/usage-facts (YYYY-MM-DD.json), or null. The runner
// plans every day from that day on, so a settled day at or after it has an entry in the status file
// (computed, or deferred with a reason); a settled day before it was never expected to have one.
function earliestFactsDay(root) {
  try {
    const days = readdirSync(join(root, 'state', 'usage-facts')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isDayKey).sort();
    return days.length ? days[0] : null;
  } catch { return null; }
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (x) => (typeof x === 'number' && Number.isFinite(x));
const fmt = (x) => (num(x) ? String(Math.round(x * 100) / 100) : 'n/a');
const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

function regressionDetail(day, id, rows) {
  const parts = rows.slice(0, 2).map((r) => {
    const g = r.group !== undefined ? ` [${clip(r.group, 40)}]` : '';
    const rel = num(r.relPct) ? ` (${r.relPct >= 0 ? '+' : ''}${fmt(r.relPct)}%)` : '';
    return `${clip(r.compare, 40)}${g}: ${fmt(r.value)} vs ${fmt(r.baseline)}${rel}, n=${fmt(r.n)}, ${r.label === 'E' ? 'estimated' : 'measured'}`;
  });
  return `${id} regressed on ${day}: ${parts.join(' | ')}${rows.length > 2 ? ` | +${rows.length - 2} more` : ''}. Read the day's report for the cohort.`;
}

/**
 * @param {object} a
 * @param {string} a.root       state root
 * @param {number} a.nowMs
 * @param {object} [a.baseline] the scout's baseline (this module reads known* keys from it)
 * @param {number} [a.boundary] day boundary, UTC hour
 * @returns {{ signals: Array<{kind,detail,dispatch,severity?}>, next: object }}
 */
export function usageSignals({ root, nowMs, baseline = {}, boundary = DEFAULT_BOUNDARY_UTC_HOUR }) {
  const signals = [];
  const next = {};
  const state = (name) => join(root, 'state', name);

  // --- regressions (and the routine model drift scenario) -----------------------------------------
  const latest = readJson(state('usage-analysis-latest.json'));
  if (isObj(latest) && typeof latest.day === 'string' && Array.isArray(latest.regressionIds)) {
    const today = dayKeyOfMs(nowMs, boundary);
    const fresh = latest.day >= addDays(today, -LATEST_MAX_AGE_DAYS);
    const known = new Set(Array.isArray(baseline.knownUsageRegressions) ? baseline.knownUsageRegressions : []);
    const keys = [...known];
    if (fresh) {
      const rows = Array.isArray(latest.regressions) ? latest.regressions : [];
      for (const id of latest.regressionIds) {
        if (typeof id !== 'string') continue;
        const key = `${latest.day}:${id}`;
        if (known.has(key)) continue;
        keys.push(key);
        const mine = rows.filter((r) => isObj(r) && r.id === id);
        const detail = regressionDetail(latest.day, id, mine);
        if (id === 'routine.modelDrift') {
          signals.push({ kind: 'routine_model_drift', detail: `scheduled routines ran against a different model than their pin: ${detail}`, dispatch: 'manual-check', severity: 'high' });
        } else {
          signals.push({ kind: 'usage_regression', detail, dispatch: 'manual-check' });
        }
      }
      if (keys.length !== known.size) next.knownUsageRegressions = keys.slice(-KEEP_KEYS);
    }
  }

  // --- stale: the last settled day has no computed result after its expected run -------------------
  const status = readJson(state('usage-analysis-status.json'));
  if (isObj(status)) {
    const lastClosed = addDays(dayKeyOfMs(nowMs - SETTLE_MS, boundary), -1);
    const due = dayEndMs(lastClosed, boundary) + EXPECTED_RUN_MS;
    const entry = isObj(status.days) ? status.days[lastClosed] : undefined;
    const ranAt = isObj(status.lastRun) ? Date.parse(status.lastRun.at) : NaN;
    // Expected: the settled day's close plus the grace (EXPECTED_RUN_MS), AND the analysis had a day to plan:
    // a facts file exists for that day or an earlier one. A status file with no entry for a day that
    // predates the first facts file (the first morning after landing: facts start the day after) is not stale.
    // A day with an entry that is not computed (deferred) is always expected once the grace has passed.
    const firstFacts = earliestFactsDay(root);
    const planned = isObj(entry) || (firstFacts !== null && firstFacts <= lastClosed);
    let why = null;
    if (nowMs >= due && planned && !(isObj(entry) && entry.state === 'computed')) {
      const reason = isObj(entry) && entry.state === 'deferred' ? `deferred (${clip(entry.kind, 30)}: ${clip(entry.reason, 100)})` : 'no result recorded';
      why = `the settled day ${lastClosed} was not computed after its expected run: ${reason}`;
    } else if (Number.isFinite(ranAt) && nowMs - ranAt > STATUS_MAX_AGE_MS) {
      why = `no analysis run for ${Math.floor((nowMs - ranAt) / HOUR_MS)} h (limit 36 h)`;
    }
    if (why && baseline.knownUsageStaleDay !== lastClosed) {
      signals.push({ kind: 'usage_analysis_stale', detail: `${why}. Run \`/ac usage status\` for the per-day state, and check that the scout's first step ran.`, dispatch: 'manual-check' });
      next.knownUsageStaleDay = lastClosed;
    } else if (!why && baseline.knownUsageStaleDay) {
      next.knownUsageStaleDay = null;
    }
  }

  // --- config invalid ----------------------------------------------------------------------------
  const invalid = readJson(state('usage-analysis-config-invalid.json'));
  if (isObj(invalid) && Array.isArray(invalid.problems) && invalid.problems.length) {
    const sig = createHash('sha256').update(JSON.stringify(invalid.problems)).digest('hex').slice(0, 16);
    if (baseline.knownUsageConfigInvalid !== sig) {
      const first = invalid.problems.slice(0, 3).map((p) => {
        const msg = Array.isArray(p && p.messages) && p.messages.length ? `: ${clip(p.messages[0], 100)}` : '';
        return `${clip(p && p.layer, 30)} layer ${clip(p && p.kind, 30)}${msg}`;
      });
      signals.push({
        kind: 'usage_analysis_config_invalid',
        detail: `${invalid.problems.length} problem(s) in the usage analysis config: ${first.join(' | ')}${invalid.problems.length > 3 ? ' | ...' : ''}. The invalid layer is ignored and the other layers keep working. Run \`/ac usage check config\` to see the layer file paths.`,
        dispatch: 'manual-check',
      });
      next.knownUsageConfigInvalid = sig;
    }
  } else if (baseline.knownUsageConfigInvalid) {
    next.knownUsageConfigInvalid = null;
  }

  return { signals, next };
}
