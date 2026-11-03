// Plan-meter sampler (hooks/plan-meter-sample.mjs, hooks/lib/plan-meter.mjs) and the weight calibrator
// (scripts/calibrate-weights.mjs). The calibrator runs on a small synthetic history whose true weights are known.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { parseUsage } from '../hooks/lib/plan-meter.mjs';
import { applyPlan, readSamples, dedupeReadings } from '../scripts/calibrate-weights.mjs';

// The real shape of a get_usage result (desktop app, 2026-11-03), trimmed of the context block's detail.
const usageResult = (over = {}) => ({
  plan: {
    status: 'ok',
    plan: 'Ultra',
    windows: [
      { label: 'Weekly · all models', percentUsed: 73, resetsAt: '2026-11-06T16:00:00.518Z', resetsIn: '2d 20h' },
      { label: 'Weekly · Fable', percentUsed: 2, resetsAt: '2026-11-06T15:59:59.518Z', resetsIn: '2d 20h' },
    ],
    extraUsage: { enabled: true, spent: '0.00', monthlyLimit: '40.00', currency: 'USD' },
    ...over,
  },
  context: { session: 'self', status: 'ok', tokensUsed: 126688, contextWindow: 250000, percentUsed: 51, categories: [{ name: 'Messages', tokens: 34977, percent: 14 }] },
});
const TOOL = 'mcp__ccd_session_mgmt__get_usage';
const samplesPath = () => join(stateDir(), 'plan-meter-samples.jsonl');
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// --- the sampler ---------------------------------------------------------------------------------------------------

test('sampler: appends one line per reading with the weekly, Fable and 5-hour percents, plan and session; injects nothing', () => {
  const fx = makeFixture();
  try {
    const payload = { hook_event_name: 'PostToolUse', tool_name: TOOL, session_id: 'sess-1', tool_input: {}, tool_response: JSON.stringify(usageResult()) };
    const r = runHook('hooks/plan-meter-sample.mjs', payload);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'zero tokens: nothing injected');
    const [row] = lines(samplesPath());
    assert.equal(row.source, 'get_usage');
    assert.equal(row.weekly_pct, 73);
    assert.equal(row.fable_weekly_pct, 2);
    assert.equal('five_hour_pct' in row, false, 'no 5-hour window on Ultra');
    assert.equal(row.plan, 'Ultra');
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.weekly_resets_at, '2026-11-06T16:00:00.518Z');
    assert.ok(Number.isFinite(Date.parse(row.ts)));

    // content-block shape, a 5-hour window, a second line appended
    const five = usageResult();
    five.plan.windows.push({ label: '5-hour limit', percentUsed: 42, resetsAt: '2026-11-03T20:00:00.000Z', resetsIn: '1h' });
    const r2 = runHook('hooks/plan-meter-sample.mjs', { ...payload, tool_response: [{ type: 'text', text: JSON.stringify(five) }] });
    assert.equal(r2.stdout.trim(), '');
    const rows = lines(samplesPath());
    assert.equal(rows.length, 2);
    assert.equal(rows[1].five_hour_pct, 42);
    // an object response and an MCP-style { content: [...] } response
    runHook('hooks/plan-meter-sample.mjs', { ...payload, tool_response: usageResult() });
    runHook('hooks/plan-meter-sample.mjs', { ...payload, tool_response: { content: [{ type: 'text', text: JSON.stringify(usageResult()) }] } });
    assert.equal(lines(samplesPath()).length, 4);
  } finally { fx.cleanup(); }
});

test('sampler: bad input exits 0 silently and writes nothing', () => {
  const fx = makeFixture();
  try {
    const cases = [
      undefined, // empty stdin
      { tool_name: TOOL },
      { tool_name: TOOL, tool_response: 'not json at all' },
      { tool_name: TOOL, tool_response: '{"plan": 5}' },
      { tool_name: TOOL, tool_response: JSON.stringify({ plan: { windows: [{ label: 'Weekly · Fable', percentUsed: 2 }] } }) }, // no all-models window
      { tool_name: TOOL, tool_response: JSON.stringify({ plan: { windows: [{ label: 'Weekly · all models', percentUsed: 'lots' }] } }) },
      { tool_name: 'Bash', tool_response: JSON.stringify(usageResult()) }, // some other tool
      { tool_response: JSON.stringify(usageResult()) },
    ];
    for (const c of cases) {
      const r = runHook('hooks/plan-meter-sample.mjs', c);
      assert.equal(r.status, 0, JSON.stringify(c));
      assert.equal((r.stdout || '').trim(), '');
    }
    assert.equal(existsSync(samplesPath()), false);
    // garbage on stdin that is not JSON
    const g = runHook('hooks/plan-meter-sample.mjs', undefined);
    assert.equal(g.status, 0);
    assert.equal(parseUsage(undefined), null);
    assert.equal(parseUsage(42), null);
  } finally { fx.cleanup(); }
});

test('the sampler is registered on the get_usage tool only', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PostToolUse;
  const g = hooks.find((h) => h.hooks.some((x) => x.args.some((a) => a.endsWith('plan-meter-sample.mjs'))));
  assert.ok(g, 'registered');
  assert.ok(new RegExp(g.matcher).test(TOOL));
  assert.ok(!new RegExp(g.matcher).test('Bash'));
  assert.ok(g.hooks[0].timeout <= 5);
});

// --- the calibrator ------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const TRUE_W = { opus: 1.4, haiku: 0.4, fable: 3 };
const TRUE_UPP = 30; // units per 1%
const MODELS = { sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5' };
const unitsOf = (r) => (r.in + 5 * r.out + 1.25 * r.cw5 + 2 * r.cw1 + 0.1 * r.cr) * 2e-6; // cache reads at the shipped factor 1

function lcg(seed) { let a = seed; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; }

// Each model has its own token shape (Sonnet reads cache, Opus writes output, Haiku writes cache, Fable is small) and each
// window its own mix, so the weights are identifiable. Returns the requests and the readings the meter would show.
const SHAPE = {
  sonnet: { out: 1e6, cw5: 3e6, cw1: 0, cr: 150e6 },
  opus: { out: 3e6, cw5: 2e6, cw1: 1e6, cr: 30e6 },
  haiku: { out: 2e6, cw5: 12e6, cw1: 0, cr: 20e6 },
  fable: { out: 1e5, cw5: 5e5, cw1: 5e5, cr: 3e6 },
};
const PER_DAY = { sonnet: 3, opus: 2, haiku: 2, fable: 1 };
const MIX = [{ sonnet: 1, opus: 0.3, haiku: 0.5, fable: 1 }, { sonnet: 0.8, opus: 1.4, haiku: 1.5, fable: 0.3 }, { sonnet: 0.6, opus: 0.8, haiku: 1, fable: 1.5 }, { sonnet: 0.9, opus: 1.8, haiku: 0.4, fable: 0.6 }];
function history() {
  const rand = lcg(7);
  const resets = ['2026-10-09T16:00:00.000Z', '2026-10-16T16:00:00.000Z', '2026-10-23T16:00:00.000Z', '2026-10-30T16:00:00.000Z'];
  const reqs = [];
  const readings = [];
  let n = 0;
  resets.forEach((reset, k) => {
    const start = Date.parse(reset) - 7 * DAY;
    let cum = 0;
    for (let d = 0; d < 7; d++) {
      let slot = 0;
      for (const fam of Object.keys(SHAPE)) {
        for (let i = 0; i < PER_DAY[fam]; i++) {
          const sc = MIX[k][fam] * (0.3 + 1.4 * rand());
          const sh = SHAPE[fam];
          const r = { fam, t: start + d * DAY + (1 + (slot += 1)) * 3600e3, in: 1000, out: Math.round(sh.out * sc), cw5: Math.round(sh.cw5 * sc), cw1: Math.round(sh.cw1 * sc), cr: Math.round(sh.cr * sc) };
          reqs.push({ ...r, id: `r${n += 1}` });
          cum += unitsOf(r) * (fam === 'sonnet' ? 1 : TRUE_W[fam]);
        }
      }
      readings.push({ t: start + d * DAY + 20 * 3600e3, y: Math.round(cum / TRUE_UPP), reset });
    }
  });
  return { reqs, readings };
}

function writeTranscript(dir, h) {
  const proj = join(dir, 'projects', 'proj-c');
  mkdirSync(proj, { recursive: true });
  const L = [];
  for (const r of h.reqs) {
    L.push(JSON.stringify({
      type: 'assistant', requestId: r.id, timestamp: new Date(r.t).toISOString(),
      message: { id: `m_${r.id}`, model: MODELS[r.fam], usage: { input_tokens: r.in, output_tokens: r.out, cache_read_input_tokens: r.cr, cache_creation_input_tokens: r.cw5 + r.cw1, cache_creation: { ephemeral_5m_input_tokens: r.cw5, ephemeral_1h_input_tokens: r.cw1 } } },
    }));
  }
  return { proj, push: (l) => L.push(JSON.stringify(l)), flush: () => writeFileSync(join(proj, 'sess-c.jsonl'), `${L.join('\n')}\n`) };
}

// Readings: every other one through the samples file (the sampler's lines), the rest as get_usage results in the transcript;
// one reading appears in both places seconds apart (must count once).
function setup(fx, { extraWindow = false } = {}) {
  const h = history();
  const tr = writeTranscript(fx.dir, h);
  const samples = [];
  let i = 0;
  const result = (y, reset) => JSON.stringify(usageResult({ windows: [{ label: 'Weekly · all models', percentUsed: y, resetsAt: reset, resetsIn: '1d' }] }));
  const both = h.readings[5];
  for (const r of h.readings) {
    i += 1;
    if (i % 2 === 0 || r === both) samples.push({ ts: new Date(r.t).toISOString(), source: 'get_usage', weekly_pct: r.y, weekly_resets_at: r.reset, session_id: 's' });
    if (i % 2 === 1 || r === both) {
      const tt = r === both ? r.t - 20e3 : r.t;
      tr.push({ type: 'assistant', timestamp: new Date(tt).toISOString(), message: { content: [{ type: 'tool_use', id: `tu${i}`, name: TOOL, input: {} }] } });
      tr.push({ type: 'user', timestamp: new Date(tt + 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: [{ type: 'text', text: result(r.y, r.reset) }] }] } });
    }
  }
  // a statusLine-style sample of the first reading (30 s later) is read too, and counts once
  const first = h.readings[0];
  samples.push({ ts: new Date(first.t + 30e3).toISOString(), session_id: 'x', rate_limits: { seven_day: { used_percentage: first.y, resets_at: Date.parse(first.reset) / 1000 } } });
  if (extraWindow) { // a window whose meter fell from 80 to 3: an unseen reset the fit cannot explain
    const reset = '2026-11-06T16:00:00.000Z';
    const st = Date.parse(reset) - 7 * DAY;
    for (const [dt, y] of [[1, 40], [2, 80], [3, 3], [4, 20]]) samples.push({ ts: new Date(st + dt * DAY).toISOString(), source: 'get_usage', weekly_pct: y, weekly_resets_at: reset });
  }
  tr.flush();
  const sf = join(fx.dir, 'samples.jsonl');
  writeFileSync(sf, `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`);
  return { h, projects: join(fx.dir, 'projects'), samples: sf };
}

const runCal = (fx, s, extra = []) => {
  const r = runScript('scripts/calibrate-weights.mjs', ['--projects', s.projects, '--samples', s.samples, '--boot', '200', '--json', ...extra], { timeout: 60000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};

test('calibrator: recovers the known weights and units per 1% from a synthetic history, dedupes a reading seen twice', () => {
  const fx = makeFixture();
  try {
    const s = setup(fx);
    const out = runCal(fx, s);
    const m = out.result.models;
    assert.equal(out.result.enough, true);
    // distinct readings: the history's readings once each (one was in both files, one more in the statusLine shape)
    assert.equal(out.sources.readings, s.h.readings.length);
    assert.equal(out.result.windows.length, 4);
    for (const [a, w] of Object.entries(TRUE_W)) {
      assert.ok(Math.abs(m[a].weight - w) / w < 0.1, `${a}: ${m[a].weight} against ${w}`);
      assert.ok(m[a].interval[0] <= m[a].weight && m[a].weight <= m[a].interval[1], `${a} interval holds the estimate`);
      assert.ok(m[a].calls > 0 && m[a].readings > 0);
    }
    assert.equal(m.sonnet.weight, 1);
    assert.ok(Math.abs(out.result.upp.value - TRUE_UPP) / TRUE_UPP < 0.08, `units per 1%: ${out.result.upp.value}`);
    assert.ok(out.result.rms < 1, `residual ${out.result.rms}`);
  } finally { fx.cleanup(); }
});

test('calibrator: a window whose meter went down is left out and named; the printed fit lists weights, intervals, n and units per 1%', () => {
  const fx = makeFixture();
  try {
    const s = setup(fx, { extraWindow: true });
    const out = runCal(fx, s);
    const bad = out.result.windows.filter((w) => w.excluded);
    assert.equal(bad.length, 1);
    assert.match(bad[0].excluded, /meter went down 80 -> 3/);
    assert.ok(Math.abs(out.result.models.opus.weight - TRUE_W.opus) / TRUE_W.opus < 0.1);
    const text = runScript('scripts/calibrate-weights.mjs', ['--projects', s.projects, '--samples', s.samples, '--boot', '100'], { timeout: 60000 });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /^Plan weights fit: \d+ weekly readings in 4 windows/m);
    assert.match(text.stdout, /Left out: window ending 2026-11-06T16:00Z .*meter went down 80 -> 3/);
    assert.match(text.stdout, /^opus +1\.\d\d +\[/m);
    assert.match(text.stdout, /Units per 1% of the weekly limit \(Sonnet-priced\): \d\d\.\d \[/);
    assert.equal(existsSync(join(fx.stateDir, 'plan-weights.json')), false, 'no --apply: nothing written');
  } finally { fx.cleanup(); }
});

test('calibrator --apply: writes the per-user override only for figures whose interval is tighter, and keeps what it does not change', () => {
  const fx = makeFixture();
  try {
    const s = setup(fx);
    // an override already in force with a very tight opus interval: the new fit cannot beat it
    const file = join(fx.stateDir, 'plan-weights.json');
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ models: { opus: { weight: 1.4, interval: [1.399, 1.401], status: 'measured' } }, custom: { keep: true } }));
    const out = runCal(fx, s, ['--apply']);
    const dec = Object.fromEntries(out.apply.decisions.map((d) => [d.what, d.apply]));
    assert.equal(dec['models.opus'], false);
    assert.equal(dec['models.haiku'], true, 'shipped haiku interval is wide');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(written.models.opus.interval, [1.399, 1.401], 'opus left as it was');
    assert.equal(written.custom.keep, true, 'other keys survive');
    assert.equal(written.models.haiku.status, 'measured');
    assert.ok(Math.abs(written.models.haiku.weight - TRUE_W.haiku) / TRUE_W.haiku < 0.15);
    assert.equal(typeof written.models.haiku.source, 'string');
    // a second run changes nothing it already wrote: not tighter than itself
    const again = runCal(fx, s, ['--apply']);
    assert.equal(again.apply.decisions.find((d) => d.what === 'models.haiku').apply, false);
  } finally { fx.cleanup(); }
});

test('applyPlan: only a narrower interval is applied; no interval in force counts as infinitely wide', () => {
  const result = {
    n: 30,
    windows: [{ used: true }, { used: true }, { used: true }, { used: true }, { used: true }],
    models: { sonnet: { weight: 1, interval: null }, opus: { weight: 1.3, interval: [1.2, 1.4] }, haiku: { weight: 0.4, interval: [0.2, 0.6] }, fable: { weight: 3, interval: [2, 4] } },
    upp: { value: 28, interval: [27, 29] },
  };
  const current = {
    cacheReadFactor: { value: 1 },
    unitsPerPercent: { value: 28.6, interval: [28.4, 28.8] },
    models: { sonnet: { weight: 1 }, opus: { weight: 1.38, interval: [1.26, 1.51] }, haiku: { weight: 0.5, interval: [0.1, 0.9] } },
  };
  const { patch, decisions } = applyPlan(result, current, '2026-11-03');
  assert.deepEqual(Object.keys(patch.models).sort(), ['fable', 'haiku', 'opus']); // fable has no interval in force
  assert.equal(patch.unitsPerPercent, undefined, 'a wider units-per-percent interval than the shipped one is not applied');
  assert.equal(decisions.find((d) => d.what === 'unitsPerPercent').apply, false);
  const wide = { ...result, models: { ...result.models, opus: { weight: 1.3, interval: [1.0, 1.7] } } };
  assert.equal(applyPlan(wide, current).patch.models.opus, undefined);
  // a fit on fewer than 3 windows applies nothing, however tight (rows inside one window are serially correlated)
  const one = { ...result, windows: [{ used: true }], upp: { value: 20, interval: [19.9, 20.1] }, models: { ...result.models, opus: { weight: 2.4, interval: [2.3, 2.5] } } };
  const r1 = applyPlan(one, current);
  assert.deepEqual(r1.patch, {}, 'one window: nothing applied');
  assert.match(r1.decisions.find((d) => d.what === 'unitsPerPercent').reason, /window/);
  // a tighter interval that does not overlap the one in force is shown, not applied
  const far = { ...result, upp: { value: 20, interval: [19.9, 20.1] }, models: { ...result.models, opus: { weight: 2.4, interval: [2.3, 2.5] } } };
  const rf = applyPlan(far, current);
  assert.equal(rf.patch.models.opus, undefined);
  assert.equal(rf.patch.unitsPerPercent, undefined);
  assert.match(rf.decisions.find((d) => d.what === 'models.opus').reason, /overlap/);
});

test('calibrator inputs: samples file reads both line shapes; near-identical readings dedupe', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.dir, 's.jsonl');
    writeFileSync(f, [
      JSON.stringify({ ts: '2026-11-01T10:00:00Z', source: 'get_usage', weekly_pct: 10, weekly_resets_at: '2026-11-06T16:00:00Z' }),
      JSON.stringify({ ts: '2026-11-01T11:00:00Z', rate_limits: { seven_day: { used_percentage: 12, resets_at: 1793030400 } } }),
      'torn line',
      JSON.stringify({ ts: 'bad', weekly_pct: 1 }),
    ].join('\n'));
    const r = readSamples(f);
    assert.equal(r.length, 2);
    assert.equal(r[1].weekly, 12);
    assert.equal(r[1].resetMs, 1793030400000);
    const d = dedupeReadings([{ ...r[0] }, { ...r[0], t: r[0].t + 60e3 }, { ...r[0], t: r[0].t + 600e3 }]);
    assert.equal(d.length, 2, 'within 3 minutes is one reading, 10 minutes later is another');
  } finally { fx.cleanup(); }
});
