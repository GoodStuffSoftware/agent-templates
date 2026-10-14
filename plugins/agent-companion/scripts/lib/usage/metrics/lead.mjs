// Lead metrics of the daily usage analysis (design section 2, "Leads (from the xhigh check)"; batch 6a).
//
// A lead is a session with at least one operator prompt (class 'lead', from the runner's session hook), and
// its TREE is the main thread plus its workers: the facts pool the workers' tokens into the lead's row
// (tok[model].s), so a session record already carries its tree. A scenario selects the leads with
// `cohort: { class: ["lead"] }`; these metrics count whatever records the cohort leaves.
//
// Each entry has day(p, rec, rows, x) (a gap: lead figures need the facts, not the history record) and the
// stat(records, ctx) adapter. Every figure has `parts` per session (the bootstrap resamples sessions).
//
// What the facts cannot hold, and how that is handled:
//   * a task (lead.unitsPerTask, lead.workersPerTask) is a prompt of 60 characters or more followed by
//     work events, with carry-over. Facts keep the prompt length bucket per hour but not the order of
//     events, so a task here is a prompt of 60 characters or more (label E).
//   * rework (lead.rework) needs the spawn records' start time and re-spawn keys; it sees the day's own
//     spawns only (a re-spawn across the day boundary is missed).
//   * lead.corrections and lead.costPerCorrection need rater labels (batch 10): no adapter yet.
import { finite } from './helpers.mjs';
import { familyOf } from '../cohort.mjs';
import { r4 } from './day.mjs';

const sumBy = (recs, f) => recs.reduce((s, r) => s + f(r), 0);
const sessionsOf = (recs) => recs.filter((r) => r.kind === 'session');
const prompts = (r) => (r.pr ? r.pr.n : 0);
const tasks = (r) => (r.pr && r.pr.len ? r.pr.len[1] + r.pr.len[2] + r.pr.len[3] : 0); // prompts of 60 characters or more
const TASK_MIN_CHARS = 60; // the facts' first length edge (facts.mjs PROMPT_LEN_EDGES)
export const REWORK_WINDOW_MS = 6 * 3600 * 1000;

const noLead = { gap: true, why: 'no lead sessions in the cohort' };
const part = (r, num, den) => ({ id: r.sid, num, den });

// ratio of two per-session figures: value = sum(num) / sum(den) * scale; sample = the denominator or `sampleOf`
function ratio(recs, numOf, denOf, { scale = 1, sampleOf = null, what = 'the denominator is zero', detail = null } = {}) {
  const ss = sessionsOf(recs);
  if (!ss.length) return noLead;
  const num = sumBy(ss, numOf);
  const den = sumBy(ss, denOf);
  if (!(den > 0)) return { gap: true, why: what };
  return {
    num, den, scale, sample: sampleOf ? sumBy(ss, sampleOf) : den,
    parts: ss.filter((r) => denOf(r) > 0).map((r) => part(r, numOf(r), denOf(r))),
    ...(detail ? { detail: detail(ss) } : {}),
  };
}

const factsOnly = () => ({ gap: true, why: 'reads the facts (lead sessions), not the history record' });

// Re-spawns among one day's spawn records: a spawn is a re-spawn when an earlier spawn of the same session
// shares its description hash, name stem or brief head (rk.d / rk.n / rk.h) and started within six hours of it.
// Shared by the worker metrics of batch 6b (spawn.respawnRate).
export function respawnFlags(spawns, windowMs = REWORK_WINDOW_MS) {
  const flagged = new Set();
  const bySid = new Map();
  for (const s of spawns) {
    if (!bySid.has(s.sid)) bySid.set(s.sid, []);
    bySid.get(s.sid).push(s);
  }
  for (const list of bySid.values()) {
    list.sort((a, b) => (a.startMs || 0) - (b.startMs || 0) || (String(a.id) < String(b.id) ? -1 : 1));
    const last = { d: new Map(), n: new Map(), h: new Map() };
    for (const s of list) {
      if (!Number.isFinite(s.startMs)) continue;
      const rk = s.rk || {};
      let again = false;
      for (const k of ['d', 'n', 'h']) {
        if (rk[k] == null) continue;
        if (last[k].has(rk[k]) && s.startMs - last[k].get(rk[k]) <= windowMs) again = true;
        last[k].set(rk[k], s.startMs);
      }
      if (again) flagged.add(s);
    }
  }
  return flagged;
}

export const LEAD_METRICS = [
  {
    id: 'lead.unitsPerPrompt', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/prompt', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => r.units.total, prompts, { what: 'the leads had no operator prompts' }),
  },
  {
    id: 'lead.threadShare', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of tree units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => r.units.main, (r) => r.units.total, { scale: 100, sampleOf: prompts, what: 'the leads had no units' }),
  },
  {
    id: 'lead.threadUnitsPerPrompt', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/prompt', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => r.units.main, prompts, { what: 'the leads had no operator prompts' }),
  },
  {
    id: 'lead.unitsPerTask', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'units/task', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: { taskMinChars: TASK_MIN_CHARS } },
    day: factsOnly,
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      if (p.taskMinChars !== undefined && p.taskMinChars !== TASK_MIN_CHARS) return { gap: true, why: `the facts hold only the ${TASK_MIN_CHARS}-character prompt bucket` };
      return ratio(recs, (r) => r.units.total, tasks, { what: 'the leads had no prompts of 60 characters or more' });
    },
  },
  {
    id: 'lead.workersPerTask', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'workers/task', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: { taskMinChars: TASK_MIN_CHARS } },
    day: factsOnly,
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      if (p.taskMinChars !== undefined && p.taskMinChars !== TASK_MIN_CHARS) return { gap: true, why: `the facts hold only the ${TASK_MIN_CHARS}-character prompt bucket` };
      return ratio(recs, (r) => r.ag || 0, tasks, { what: 'the leads had no prompts of 60 characters or more' });
    },
  },
  {
    id: 'lead.workersPerPrompt', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'workers/prompt', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => r.ag || 0, prompts, { what: 'the leads had no operator prompts' }),
  },
  {
    // The share of the leads' tree units on one model family (params.family, default opus). The two shares of a
    // two-family mix are 100 minus each other, so a second scenario can carry the other family.
    id: 'lead.modelMix', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of tree units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: { family: 'opus' } },
    day: factsOnly,
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      const want = typeof p.family === 'string' ? p.family : 'opus';
      const unitsOf = (r, family) => sumBy(Object.entries(r.byModel || {}), ([m, u]) => (family === null || familyOf(m) === family ? u.m + u.s : 0));
      return ratio(recs, (r) => unitsOf(r, want), (r) => unitsOf(r, null), {
        scale: 100, sampleOf: prompts, what: 'the leads had no units',
        detail: (ss) => {
          const fam = {};
          for (const r of ss) for (const [m, u] of Object.entries(r.byModel || {})) { const f = familyOf(m) || '(other)'; fam[f] = (fam[f] || 0) + u.m + u.s; }
          const out = {}; for (const k of Object.keys(fam).sort()) out[k] = r4(fam[k]);
          return { family: want, unitsByFamily: out };
        },
      });
    },
  },
  {
    id: 'lead.unitsPerCommitCall', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'units/commit call', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => r.units.total, (r) => r.gc || 0, { what: 'the leads made no git commit Bash calls' }),
  },
  {
    // Units of the spawns that are re-spawns (a fixer worker shares its writer's name stem, so it is one).
    id: 'lead.rework', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'units/day', direction: 'up-is-worse', pool: 'sum',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { respawnHours: 6 } },
    day: factsOnly,
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      const hours = finite(p.respawnHours) !== null && p.respawnHours > 0 ? p.respawnHours : 6;
      const sp = recs.filter((r) => r.kind === 'spawn');
      if (!sp.length) return { gap: true, why: 'no spawn records for the cohort (the spawn hook feeds them)' };
      const re = respawnFlags(sp, hours * 3600 * 1000);
      const units = (s) => (s.units ? s.units.total : 0);
      const rework = sumBy([...re], units);
      return {
        num: rework, den: 1, scale: 1, sample: sp.length,
        detail: { reworkUnits: r4(rework), respawns: re.size, spawns: sp.length, spawnUnits: r4(sumBy(sp, units)) },
      };
    },
  },
  {
    id: 'lead.correctionFlags', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'flagged per 100 prompts', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day: factsOnly,
    stat: (recs) => ratio(recs, (r) => (r.pr ? r.pr.corr : 0), prompts, { scale: 100, what: 'the leads had no operator prompts' }),
  },
];
