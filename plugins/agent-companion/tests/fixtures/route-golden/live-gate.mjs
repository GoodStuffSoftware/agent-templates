// The LIVE acceptance gate for resolveRoute() (ADR 0003 slice 1).
//
// reference/ holds the resolver exactly as it shipped BEFORE resolveRoute()
// existed — hooks/lib/context.mjs and config/model-tiers.json copied byte for
// byte from the pinned baseline commit; tests/route-golden.test.mjs checks
// their sha256 against the one expected.json recorded when it was generated.
// The gate stages that frozen resolver next to the CURRENT config and runs
// both over the same case matrix. So a routine table edit (a trial's
// reviewBy extended, a trial ended, a row retuned) changes both sides alike
// and stays green, while a change to the resolution LOGIC shows up as a
// difference — and a frozen expected.json no longer has to be regenerated,
// which after merge could only have been done from the code under test.
//
// A difference passes only if it belongs to one of the two classes slice 1
// decided on, and only if it is EXACTLY the answer that class prescribes
// (computed here from the config and the ADR rule, not by the resolver):
//
//   restated preset  (slice 1b, operator-approved 2026-09-24; ADR §1): an
//     explicit weight/kind/consequence EQUAL to the type's preset restates
//     the type instead of departing from it. The case must resolve exactly as
//     the reference resolves the same case with those fields dropped.
//   floor after trial  (ADR §9 slice 1: "except where a shipped override would
//     break a floor"; operator-decided 2026-09-24): the reference returned a
//     trial before any consequence floor ran. When the reference's answer is a
//     trial below the resolved consequence's floor, the answer must be that
//     trial lifted to exactly the floor (F1 critical, F5 elevated), with the
//     trial still the winning layer and the lift recorded.
//
// Anything else is a mismatch. A trial the new resolver refuses (F2 fable, F4
// retired or unsupported effort) is a mismatch too: the shipped table should
// never carry one, so it is reported rather than permitted.
//
// Kept free of any import from the resolver under test, so a caller can
// stage any copy of it (tests stage deliberately broken ones to prove the
// gate goes red).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REFERENCE_DIR = join(HERE, 'reference');
export const REFERENCE_FILES = ['hooks/lib/context.mjs', 'config/model-tiers.json'];

// sha256 of a text file as git stores it (LF), whatever the checkout did.
export function sha256Text(path) {
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

// Stage a resolver module next to a config in a fresh temp directory and
// import it. Each staging is its own module instance with its own
// modelTiers() cache, reading exactly `configText` (plus the operator
// override under the state root, which the caller keeps hermetic).
export async function stageResolver({ contextSource, configText }) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-route-live-'));
  mkdirSync(join(dir, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'lib', 'context.mjs'), contextSource);
  writeFileSync(join(dir, 'config', 'model-tiers.json'), configText);
  const mod = await import(pathToFileURL(join(dir, 'hooks', 'lib', 'context.mjs')).href);
  return { dir, mod, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

// The reference resolver has no clock parameter; pin the global Date around
// each call instead (synchronous, so nothing else observes it).
export function atClock(iso, fn) {
  const Real = globalThis.Date;
  const fixed = Real.parse(iso);
  class Pinned extends Real {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  }
  globalThis.Date = Pinned;
  try { return fn(); } finally { globalThis.Date = Real; }
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const normCons = (v) => (v === 'inherit' ? 'routine' : v);

// The same case with every explicit field that EQUALS the type's preset
// dropped to "not given" (ADR §1: only a DEPARTURE skips layers 1-2).
export function restatedArgs(cfg, args) {
  const t = args.type ? (cfg.taskTypes || {})[args.type] : null;
  if (!t || typeof t !== 'object') return args;
  const a = { ...args };
  if (a.weightExplicit && a.weight === t.weight) { delete a.weight; delete a.weightExplicit; }
  if (a.kindExplicit && (a.kind || 'bounded') === (t.kind || 'bounded')) { delete a.kind; delete a.kindExplicit; }
  if (a.consequenceExplicit && normCons(a.consequence || 'routine') === normCons(t.consequence || 'routine')) {
    delete a.consequence; delete a.consequenceExplicit;
  }
  return a;
}

// F1 / F5 from the ADR §1 table, applied to a (model, effort) pair from the
// config alone: the model rises to the consequence's modelFloor, the effort
// to its effortFloor, within what the model accepts (a model that takes no
// effort parameter stays effortless, as the grid leaves it).
export const FLOOR_LABEL = { critical: 'F1', elevated: 'F5' };
export function floorsFor(cfg, consequence, model, effort) {
  const tiers = cfg.tiers || {};
  const cons = (cfg.consequence || {})[consequence] || {};
  const aliasOf = (m) => Object.entries(tiers).find(([a, s]) => m && new RegExp(s.match || a, 'i').test(m))?.[0] || m;
  const rank = (a) => tiers[a]?.rank ?? 0;
  const efforts = (a) => {
    const supported = Array.isArray(tiers[a]?.efforts) ? tiers[a].efforts : [];
    return Object.entries(cfg.efforts || {}).sort((x, y) => (x[1].rank ?? 0) - (y[1].rank ?? 0))
      .map(([n]) => n).filter((n) => supported.includes(n));
  };
  let m = model;
  let e = effort;
  if (cons.modelFloor && rank(cons.modelFloor) > rank(aliasOf(m))) {
    m = cons.modelFloor;
    const list = efforts(m);
    if (!list.includes(e)) e = list[0] || '';
  }
  if (cons.effortFloor) {
    const list = efforts(aliasOf(m));
    const fi = list.indexOf(cons.effortFloor);
    if (fi >= 0 && (e ? list.indexOf(e) : -1) < fi) e = cons.effortFloor;
  }
  return { model: m, effort: e };
}

// A floor entry that LIFTED the winning layer's candidate. (Later commits
// may add entries describing the grid's own internal raises; those are part
// of the grid's answer, which the reference already produced.)
export const liftsOf = (route) => (route.floorsApplied || []).filter((f) => f.within !== 'grid');

// Run the gate. `cur` is the resolver under test, `ref` the staged reference,
// both reading the same config `cfg`. Returns every mismatch and the size of
// each class; the caller asserts.
export function compareLive({ cur, ref, cfg, cases, clocks }) {
  const mismatches = [];
  const counts = { cases: 0, identical: 0, restated: 0, floorAfterTrial: 0 };
  for (const clock of clocks) {
    for (const c of cases) {
      counts.cases += 1;
      const tag = `${clock.slice(0, 10)} ${c.key}`;
      const rArgs = restatedArgs(cfg, c.args);
      const asGiven = plain(atClock(clock, () => ref.resolveExpected(c.args)));
      const want = rArgs === c.args ? asGiven : plain(atClock(clock, () => ref.resolveExpected(rArgs)));
      const restated = JSON.stringify(want) !== JSON.stringify(asGiven);

      let route;
      let wrapped;
      try {
        route = cur.resolveRoute({ ...c.args, now: clock });
        wrapped = plain(cur.resolveExpected({ ...c.args, now: clock }));
      } catch (e) {
        mismatches.push(`${tag}: resolver threw ${e.message}`);
        continue;
      }
      const lifts = liftsOf(route);
      const pred = want.trial ? floorsFor(cfg, want.consequence, want.model, want.effort) : null;
      const floored = !!pred && (pred.model !== want.model || pred.effort !== want.effort);

      if (floored) {
        const label = FLOOR_LABEL[want.consequence];
        const problems = [];
        if (route.layer !== 'trial') problems.push(`layer ${route.layer}, want trial (only the floor lifts it)`);
        if (route.model !== pred.model || route.effort !== pred.effort) problems.push(`${route.model}/${route.effort}, want exactly the floor ${pred.model}/${pred.effort}`);
        if (!lifts.length || !lifts.every((f) => f.floor === label)) problems.push(`lifts ${JSON.stringify(lifts)}, want ${label} only`);
        const { rationale: wr, ...wrest } = wrapped;
        const { rationale: rr, ...rrest } = want;
        try { assertSame(wrest, { ...rrest, model: pred.model, effort: pred.effort }); } catch { problems.push(`wrapper ${JSON.stringify(wrest)}`); }
        if (!(typeof wr === 'string' && wr.startsWith(rr) && /; floors: F[15] /.test(wr))) problems.push(`wrapper rationale ${JSON.stringify(wr)}`);
        if (problems.length) mismatches.push(`${tag}: floor-after-trial: ${problems.join('; ')}`);
        else counts.floorAfterTrial += 1;
        if (restated) counts.restated += 1;
        continue;
      }

      const problems = [];
      if (route.model !== want.model || route.effort !== want.effort) {
        problems.push(`resolveRoute ${route.model}/${route.effort} (layer ${route.layer}) vs reference ${want.model}/${want.effort}`);
      }
      if (want.model) {
        const layer = want.trial ? 'trial' : 'grid';
        if (route.layer !== layer) problems.push(`layer ${route.layer}, want ${layer}`);
      }
      if (lifts.length) problems.push(`a floor lifted a layer outside the floor-after-trial class: ${JSON.stringify(lifts)}`);
      try { assertSame(wrapped, want); } catch {
        problems.push(`resolveExpected differs\n    got  ${JSON.stringify(wrapped)}\n    want ${JSON.stringify(want)}`);
      }
      if (problems.length) mismatches.push(`${tag}: ${problems.join('; ')}`);
      else if (restated) counts.restated += 1;
      else counts.identical += 1;
    }
  }
  return { mismatches, counts };
}

function assertSame(a, b) {
  if (JSON.stringify(sortKeys(a)) !== JSON.stringify(sortKeys(b))) throw new Error('differs');
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
