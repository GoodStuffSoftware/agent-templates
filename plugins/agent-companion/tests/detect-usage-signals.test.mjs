// The scout's usage-analysis signals (scripts/detect.mjs + scripts/lib/usage/signals.mjs), the
// scout_plugin_update option and its --print-option, and the scout routine's first step.
// Synthetic fixtures only: a temp state root with the runner's output files.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

// Day boundary is 08:00Z. At 2026-03-10T10:00Z the last settled day is 2026-03-09 and its expected
// run (close 08:00Z + 90 min) has passed; at 08:10Z it has not.
const LATE = '2026-03-10T10:00:00Z';
const EARLY = '2026-03-10T08:10:00Z';
const USAGE_KINDS = ['usage_regression', 'routine_model_drift', 'usage_analysis_stale', 'usage_analysis_config_invalid'];

const write = (file, obj) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`); };
const files = (stateDir) => ({
  latest: join(stateDir, 'state', 'usage-analysis-latest.json'),
  status: join(stateDir, 'state', 'usage-analysis-status.json'),
  invalid: join(stateDir, 'state', 'usage-analysis-config-invalid.json'),
});

function detect(dir, now, env = {}) {
  const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: { AGENT_COMPANION_FAKE_NOW: now, ...env }, timeout: 90000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, 'detect prints JSON');
  return res.json;
}
const usageOnly = (json) => (json.signals || []).filter((s) => USAGE_KINDS.includes(s.kind) && !(s.kind === 'routine_model_drift' && !/usage|regress/.test(s.detail)));
const ofKind = (json, kind) => (json.signals || []).filter((s) => s.kind === kind);

const okStatus = (lastRunAt) => ({
  schema: 'agent-companion/usage-analysis-status',
  lastRun: { at: lastRunAt, scheduled: true },
  days: { '2026-03-08': { state: 'computed' }, '2026-03-09': { state: 'computed' } },
});
const latestWith = (regs) => ({
  schema: 'agent-companion/usage-analysis-latest',
  day: '2026-03-09',
  lines: ['day 2026-03-09: 100 u', regs.length ? 'regressions: x' : 'regressions: none', 'report: reports/usage/usage-2026-03-09.md'],
  regressionIds: [...new Set(regs.map((r) => r.id))].sort(),
  regressions: regs,
  surfaceKey: 'k',
});
const reg = (id, extra = {}) => ({ id, compare: 'prior-day', value: 12, baseline: 8, relPct: 50, n: 30, label: 'M', interval: 'none', ...extra });

test('quiet day: nothing usage-related is emitted, with or without the runner files', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    assert.deepEqual(usageOnly(detect(dir, LATE)), [], 'no files at all: the runner never ran here');
    const f = files(stateDir);
    write(f.latest, latestWith([]));
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    assert.deepEqual(usageOnly(detect(dir, LATE)), [], 'files present, day computed, no regression');
  } finally { cleanup(); }
});

test('usage_regression: one signal per regressed scenario, once per day and scenario', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    write(f.latest, latestWith([reg('day.unitsPerHour'), reg('workers.rework', { group: 'sonnet-low', label: 'E' })]));
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    const hits = ofKind(detect(dir, LATE), 'usage_regression');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.dispatch), ['manual-check', 'manual-check']);
    const a = hits.find((h) => h.detail.startsWith('day.unitsPerHour'));
    assert.ok(a, 'names the scenario');
    assert.match(a.detail, /2026-03-09/);
    assert.match(a.detail, /12 vs 8 \(\+50%\)/);
    const b = hits.find((h) => h.detail.startsWith('workers.rework'));
    assert.match(b.detail, /\[sonnet-low\]/);
    assert.match(b.detail, /estimated/);
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_regression'), [], 'the same day and scenario do not repeat');
    // a new regression on the same day fires, the old ones stay quiet
    write(f.latest, latestWith([reg('day.unitsPerHour'), reg('workers.rework'), reg('week.pace')]));
    const again = ofKind(detect(dir, LATE), 'usage_regression');
    assert.equal(again.length, 1);
    assert.ok(again[0].detail.startsWith('week.pace'));
  } finally { cleanup(); }
});

test('usage_regression: a summary older than three days is left to the stale check', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    write(f.latest, latestWith([reg('day.unitsPerHour')]));
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    assert.deepEqual(ofKind(detect(dir, '2026-03-20T10:00:00Z'), 'usage_regression'), []);
  } finally { cleanup(); }
});

test('routine_model_drift: the routine.modelDrift scenario regression is high severity and not a usage_regression', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    write(f.latest, latestWith([reg('routine.modelDrift', { value: 2, baseline: 0, relPct: null, n: 2 })]));
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    const json = detect(dir, LATE);
    assert.deepEqual(ofKind(json, 'usage_regression'), []);
    const hit = ofKind(json, 'routine_model_drift').filter((s) => /routine\.modelDrift/.test(s.detail));
    assert.equal(hit.length, 1);
    assert.equal(hit[0].severity, 'high');
    assert.equal(hit[0].dispatch, 'manual-check');
    assert.match(hit[0].detail, /2 vs 0/);
  } finally { cleanup(); }
});

test('usage_analysis_stale: a settled day not computed after its expected run, once per missed day', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    const st = okStatus('2026-03-09T08:10:30Z');
    st.days['2026-03-09'] = { state: 'deferred', kind: 'open-spawns', reason: 'a spawn is still open' };
    write(f.status, st);
    assert.deepEqual(ofKind(detect(dir, EARLY), 'usage_analysis_stale'), [], 'before the expected run it is not late yet');
    const hit = ofKind(detect(dir, LATE), 'usage_analysis_stale');
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /2026-03-09/);
    assert.match(hit[0].detail, /open-spawns/);
    assert.equal(hit[0].dispatch, 'manual-check');
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_analysis_stale'), [], 'not repeated for the same day');
  } finally { cleanup(); }
});

test('usage_analysis_stale: an older closed day with no facts file fires once; a complete run of days does not', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    const facts = (d) => write(join(stateDir, 'state', 'usage-facts', `${d}.json`), { day: d });
    for (const d of ['2026-03-05', '2026-03-07', '2026-03-08', '2026-03-09']) facts(d);
    const hit = ofKind(detect(dir, LATE), 'usage_analysis_stale');
    assert.equal(hit.length, 1, 'the 03-06 gap is reported');
    assert.match(hit[0].detail, /2026-03-06 has no facts file/);
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_analysis_stale'), [], 'not repeated for the same day');
    facts('2026-03-06');
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_analysis_stale'), [], 'the retried day clears it');
  } finally { cleanup(); }
});

test('usage_analysis_stale: no run for more than 36 hours, even when the day is recorded computed', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    write(files(stateDir).status, okStatus('2026-03-08T12:00:00Z'));
    const hit = ofKind(detect(dir, EARLY), 'usage_analysis_stale');
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /no analysis run for \d+ h/);
  } finally { cleanup(); }
});

test('usage_analysis_config_invalid: fires when the marker appears and again only when its problems change', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const f = files(stateDir);
    write(f.status, okStatus('2026-03-10T08:10:30Z'));
    const problems = [{ layer: 'user', kind: 'errors', messages: ['scenarios[0].id: not a valid id'] }];
    write(f.invalid, { signal: 'usage_analysis_config_invalid', at: '2026-03-10T08:10:00Z', problems });
    const hit = ofKind(detect(dir, LATE), 'usage_analysis_config_invalid');
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /1 problem/);
    assert.match(hit[0].detail, /user layer errors: scenarios\[0\]\.id/);
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_analysis_config_invalid'), [], 'a standing problem is not repeated');
    problems.push({ layer: 'project', kind: 'refusals', messages: ['environment: refused'] });
    write(f.invalid, { signal: 'usage_analysis_config_invalid', at: '2026-03-10T08:10:00Z', problems });
    assert.equal(ofKind(detect(dir, LATE), 'usage_analysis_config_invalid').length, 1, 'a changed set fires again');
    // fixed: the marker is removed by the loader; a later problem fires fresh
    writeFileSync(f.invalid, 'null');
    assert.deepEqual(ofKind(detect(dir, LATE), 'usage_analysis_config_invalid'), []);
    write(f.invalid, { signal: 'usage_analysis_config_invalid', at: '2026-03-11T08:10:00Z', problems: problems.slice(0, 1) });
    assert.equal(ofKind(detect(dir, LATE), 'usage_analysis_config_invalid').length, 1);
  } finally { cleanup(); }
});

test('scout_plugin_update: declared in userConfig, default true; --print-option prints the effective value', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const o = manifest.userConfig.scout_plugin_update;
  assert.equal(o.type, 'boolean');
  assert.equal(o.default, true);
  assert.equal(manifest.userConfig.usage_analysis_report_dir.type, 'string');
  assert.equal(manifest.userConfig.usage_analysis_report_dir.default, '');
  const { dir, cleanup } = makeFixture();
  try {
    const print = (env) => runScript('scripts/detect.mjs', ['--print-option', 'scout_plugin_update'], { cwd: dir, env });
    const dflt = print({});
    assert.equal(dflt.status, 0, dflt.stderr);
    assert.equal(dflt.stdout.trim(), 'true');
    for (const v of ['false', '0', 'off']) assert.equal(print({ CLAUDE_PLUGIN_OPTION_SCOUT_PLUGIN_UPDATE: v }).stdout.trim(), 'false');
    assert.equal(print({ CLAUDE_PLUGIN_OPTION_SCOUT_PLUGIN_UPDATE: 'true' }).stdout.trim(), 'true');
    const bad = runScript('scripts/detect.mjs', ['--print-option', 'no_such_option'], { cwd: dir });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout.trim(), '');
  } finally { cleanup(); }
});

test('scout routine md: the scheduled analysis is the first step, 04:10 local, and the update step is gated', () => {
  const md = readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8');
  const analysis = md.indexOf('usage-analysis.mjs" --scheduled');
  const update = md.indexOf('claude plugin marketplace update agent-templates && claude plugin update agent-companion@agent-templates');
  const gate = md.indexOf('--print-option scout_plugin_update');
  const step1 = md.indexOf('## STEP 1');
  const where = md.indexOf('## Where you are running');
  assert.ok(analysis > where, 'the analysis is in the run section');
  assert.ok(analysis > 0 && analysis < update, 'the analysis comes before the plugin update');
  assert.ok(analysis < gate, 'and before the option check');
  assert.ok(gate > 0 && gate < update, 'the option is read before the update runs');
  assert.ok(update < step1, 'the update stays before STEP 1');
  assert.match(md, /node "\$AC\/scripts\/usage-analysis\.mjs" --scheduled/, 'uses the root already resolved in STEP 0');
  assert.match(md.split('\n---\n')[0], /^model: sonnet$/m, 'frontmatter pins the model');
  assert.match(md, /04:10 local/);
  assert.match(md, /cron `10 4 \* \* \*`/);
  assert.match(md, /fixed 08:00Z day close/);
  assert.match(md, /04:00 EDT, 03:00 EST/);
  // the update command appears once, inside the option check
  assert.equal(md.split('claude plugin marketplace update agent-templates && claude plugin update').length, 2);
  // the skip branch is the false branch
  const block = md.slice(gate - 40, update + 120);
  assert.match(block, /= "false" \]; then[\s\S]*skipping[\s\S]*else[\s\S]*claude plugin marketplace update/);
  for (const k of USAGE_KINDS) assert.ok(md.includes(`\`${k}\``), `${k} is documented`);
  // the zero-token analysis must be the first thing a local run does after locating the plugin
  const firstRun = md.slice(where).search(/^node "\$AC\/scripts\//m);
  assert.equal(md.slice(where).indexOf('usage-analysis.mjs" --scheduled') > 0, true);
  assert.ok(firstRun >= 0);
  assert.equal(md.slice(where + firstRun).startsWith('node "$AC/scripts/usage-analysis.mjs" --scheduled'), true, 'no other script runs before it');
});
