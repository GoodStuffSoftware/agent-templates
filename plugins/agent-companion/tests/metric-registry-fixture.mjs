// Deterministic fixture for the metric-registry parity test. runParity() evaluates every one of
// the 13 register metrics through the public evalMetric over synthetic history, spawn and denial
// rows (plain and staged-baseline triggers) and returns one JSON-able object. The golden file
// (fixtures/metric-registry/parity.golden.json) was generated from decision-register.mjs BEFORE
// the metrics moved into scripts/lib/usage/metrics/, so a byte-identical result proves the move.
import { evalMetric, emptyState } from '../scripts/lib/decision-register.mjs';

const T = (s) => Date.parse(s);
const AF = T('2026-10-10T08:00:00Z');
const NOW = T('2026-10-14T10:00:00Z');
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
const at = (day, i) => new Date(T(`${day}T09:00:00Z`) + i * 60000).toISOString();

function history() {
  return DAYS.map((day, k) => {
    const rec = {
      day,
      units: { total: 100 + k * 7, main: 40 + k * 3, subagent: 60 + k * 4 },
      subagent: { unitsOver150k: 10 + k, compactions: k % 4 },
      spawns: { total: 20 + k * 2, byType: { 'bounded-feature': { n: 5 + k, units: 12 + k * 2 } }, byRung: { 'sonnet/high': { n: 3 + k, units: 7 + k } } },
      ceilingNudges: k % 3,
      limit: { hits: 0 },
    };
    if (day === '2026-10-07') rec.units.total = 0; // a usage-lockout day: a gap
    if (day === '2026-10-08') rec.limit.hits = 2; // a limit-hit day: a gap for per-day totals only
    if (day === '2026-10-09') delete rec.subagent; // a partial record
    return rec;
  });
}

function spawnRows() {
  const rows = [];
  for (const [k, day] of DAYS.entries()) {
    const eff = k < 5 ? 'xhigh' : 'high';
    for (let i = 0; i < 14; i++) {
      rows.push({
        at: at(day, i), session_id: `s-${day}`, caller_is_subagent: false, caller_effort: eff,
        desc_sha: `h-${day}-${i % (k % 2 ? 14 : 9)}`, name_effective: `task-${day}-${i % 11}`, tool_use_id: `tu-${day}-${i}`,
        declared_type: i % 5 === 0 ? 'code-review' : 'bounded-feature', declared_type_resolved: i % 6 === 0 ? 'code-review' : undefined,
        fit: ['fit', 'over', 'under'][i % 3], model: i % 7 === 0 ? 'haiku' : 'sonnet',
        caller_tool_use_id: i % 5 === 0 ? `tu-${day}-${i - 1 < 0 ? 0 : i - 1}` : '',
        review_verdict: i % 5 === 0 ? (i % 10 === 0 ? 'FIX' : 'PASS') : undefined,
        ...(i === 13 ? { redone: true } : {}),
      });
    }
    // a subagent-spawned row, and a row with no effort: never lead rows
    rows.push({ at: at(day, 20), session_id: `s-${day}`, caller_is_subagent: true, caller_effort: 'high', tool_use_id: `sub-${day}`, declared_type: 'explore' });
    rows.push({ at: at(day, 21), session_id: `s-${day}`, caller_effort: '', tool_use_id: `ne-${day}`, declared_type: 'explore' });
  }
  rows.push({ at: 'not-a-date', tool_use_id: 'junk' });
  return rows;
}

function denialRows() {
  const out = [];
  for (const [k, day] of DAYS.entries()) {
    for (let i = 0; i < 2 + (k % 3); i++) out.push({ at: at(day, 5 + i), session_id: `s-${day}`, outcome: 'deny', guard: ['fit', 'warrant', 'premium-cap', 'inherit', 'other'][i % 5] });
    out.push({ at: at(day, 30), session_id: `s-${day}`, outcome: 'allow', guard: 'fit' });
  }
  return out;
}

const SOURCES = {
  unitsPerSpawn: 'history', mainUnitsPerDay: 'history', shareOver150kPct: 'history', compactionsPer100Spawns: 'history', ceilingNudgesPerDay: 'history',
  leadEffortShare: 'spawns', reviewsPerWriter: 'spawns', haikuSpawns: 'spawns', leadRebriefsPer100Spawns: 'spawns', reviewFixShareByLeadEffort: 'spawns',
  leadRoutingDeniesPer100Spawns: 'spawns', leadUnderProvisionedShare: 'spawns', mainUnitsPerLeadSpawn: 'history',
};
const PARAMS = {
  unitsPerSpawn: { type: 'bounded-feature' }, leadEffortShare: { levels: ['high'] }, reviewsPerWriter: { writerType: 'bounded-feature' },
  leadRebriefsPer100Spawns: { levels: ['high'] }, reviewFixShareByLeadEffort: { levels: ['high'] }, leadRoutingDeniesPer100Spawns: { levels: ['high'] },
  leadUnderProvisionedShare: { levels: ['high'] },
};
const LEVEL = new Set(['leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare']);

export const METRIC_IDS = Object.keys(SOURCES);

export function runParity() {
  const h = history(); const s = spawnRows(); const d = denialRows();
  const out = {};
  for (const metric of METRIC_IDS) {
    const params = PARAMS[metric] || {};
    const base = { id: 'm', premise: 'p1', kind: 'metric', source: SOURCES[metric], metric, params, op: '>', threshold: 0.001, minSample: 1, minDays: 1 };
    const plain = evalMetric({ decision: { decided: '2026-10-01' }, trigger: base, key: 'dec/m', history: h, spawnRows: s, denialRows: d, nowT: NOW, state: emptyState(), activeFromMs: null });
    const staged = { ...base, minSample: 5, baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 1, ...(LEVEL.has(metric) ? { levels: ['xhigh'] } : {}) }, post: { minDays: 2 } };
    const state = emptyState();
    const stagedOut = evalMetric({ decision: { decided: '2026-10-01' }, trigger: staged, key: 'dec/m', history: h, spawnRows: s, denialRows: d, nowT: NOW, state, activeFromMs: AF });
    const b = state.baselines ? state.baselines['dec/m'] : null;
    out[metric] = { plain, staged: stagedOut, baseline: b ? { days: b.days, pooled: b.pooled, n: b.n } : null };
  }
  return out;
}
