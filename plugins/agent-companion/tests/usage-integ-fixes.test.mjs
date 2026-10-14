// 0.31.18 integration review fixes: the stale-signal rule on a first morning, rung labels and plugin command
// hints in scrubbed signal text, the CLI path (usage_analysis option, --dry-run, scheduled bounds) and the
// init proposal that never names an event the operator does not have. Synthetic fixtures only.
import { makeFixture, runScript } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { usageSignals } from '../scripts/lib/usage/signals.mjs';
import { makeScrubber } from '../scripts/lib/scrub.mjs';
import { addDays, dayRange } from '../scripts/lib/usage/days.mjs';
import { SCHEDULED_MAX_SECONDS, SCHEDULED_MAX_DAYS } from '../scripts/usage-analysis.mjs';
import { buildProposal } from '../scripts/lib/usage/init.mjs';
import { PLUGIN_ROOT } from './helpers.mjs';

const write = (file, obj) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`); };
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { let names = []; try { names = readdirSync(d); } catch { return; } for (const n of names) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'latin1'); } };
  walk(dir);
  return out;
};

// ---------------------------------------------------------------- stale rule --
// "Expected": the settled day (the day before today, boundary 08:00Z) has closed AND the 90-minute grace
// has passed, AND the analysis had something to plan for it: the status file has an entry for the day, or a
// facts file exists for that day or an earlier one. No entry for a day that predates the first facts file
// (the first morning after landing: facts start the day after) is not stale.

const LATE = Date.parse('2026-03-10T10:00:00Z'); // settled day 2026-03-09, close 08:00Z + 90 min passed
const EARLY = Date.parse('2026-03-10T08:10:00Z'); // grace not over
const statusAt = (days) => ({ schema: 'agent-companion/usage-analysis-status', lastRun: { at: '2026-03-10T08:10:30Z', scheduled: true }, days });
const stale = (root, nowMs) => usageSignals({ root, nowMs }).signals.filter((s) => s.kind === 'usage_analysis_stale');
const factsFile = (root, day) => write(join(root, 'state', 'usage-facts', `${day}.json`), { day });

test('stale: the first morning after landing (status days empty, no facts yet) is not stale', () => {
  const fx = makeFixture();
  try {
    write(join(fx.stateDir, 'state', 'usage-analysis-status.json'), statusAt({}));
    assert.deepEqual(stale(fx.stateDir, LATE), []);
    // facts that start AFTER the settled day do not make it expected either
    factsFile(fx.stateDir, '2026-03-10');
    assert.deepEqual(stale(fx.stateDir, LATE), []);
  } finally { fx.cleanup(); }
});

test('stale: an absent entry IS stale once facts exist for the settled day or earlier, but not inside the grace', () => {
  const fx = makeFixture();
  try {
    write(join(fx.stateDir, 'state', 'usage-analysis-status.json'), statusAt({}));
    factsFile(fx.stateDir, '2026-03-09');
    const hit = stale(fx.stateDir, LATE);
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /2026-03-09 was not computed after its expected run: no result recorded/);
    assert.deepEqual(stale(fx.stateDir, EARLY), [], 'before close + 90 min the run is not yet expected');
  } finally { fx.cleanup(); }
});

test('stale: a deferred entry is still stale after the grace', () => {
  const fx = makeFixture();
  try {
    write(join(fx.stateDir, 'state', 'usage-analysis-status.json'), statusAt({ '2026-03-09': { state: 'deferred', kind: 'no-facts', reason: 'not written' } }));
    const hit = stale(fx.stateDir, LATE);
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /deferred \(no-facts/);
  } finally { fx.cleanup(); }
});

test('stale and config-invalid hints name a command with no path in it', () => {
  const fx = makeFixture();
  try {
    write(join(fx.stateDir, 'state', 'usage-analysis-status.json'), statusAt({ '2026-03-09': { state: 'deferred', kind: 'x', reason: 'y' } }));
    const [hit] = stale(fx.stateDir, LATE);
    assert.match(hit.detail, /`\/ac usage status`/);
    write(join(fx.stateDir, 'state', 'usage-analysis-config-invalid.json'), { problems: [{ layer: 'user', kind: 'invalid', messages: ['bad'] }] });
    const cfg = usageSignals({ root: fx.stateDir, nowMs: LATE }).signals.find((s) => s.kind === 'usage_analysis_config_invalid');
    assert.match(cfg.detail, /`\/ac usage check config`/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- scrubber --

const OWNER = ['zq', 'owner'].join('');
const REPO = ['zq', 'privrepo'].join('');
const scrub = makeScrubber({ users: ['qzhandle'], names: [], publicUrls: [] });

test('scrub: rung labels (every known model and effort) and the plugin command hints stay readable', () => {
  for (const m of ['haiku', 'sonnet', 'opus', 'fable']) {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(scrub(`prior-day [${m}/${e}]: 12 vs 8`), `prior-day [${m}/${e}]: 12 vs 8`);
    }
  }
  assert.equal(scrub('rung sonnet-5-5/high drifted'), 'rung sonnet-5-5/high drifted');
  for (const hint of ['Run `/ac usage status` for the per-day state', 'Run `/ac usage check config` to see the layer file paths']) {
    assert.equal(scrub(hint), hint);
  }
});

test('scrub: privacy is as strong as before: private owner/repo pairs and user paths still go', () => {
  assert.equal(scrub(`repository ${OWNER}/${REPO} not found`), 'repository <repo> not found');
  // the rung exemption is exactly model/effort: other pairs, a repo that merely starts like an effort, upper case
  assert.equal(scrub(`${OWNER}/high`), '<repo>');
  assert.equal(scrub('sonnet/secretproj'), '<repo>');
  assert.equal(scrub('opus/highway'), '<repo>');
  assert.equal(scrub('Sonnet/High'), '<repo>');
  assert.equal(scrub('scripts/usage-analysis.mjs'), '<repo>', 'script paths are still treated as a pair: hints use /ac commands instead');
  const win = ['C:', 'Us' + 'ers', 'qzhandle', 'dev', 'x'].join('\\');
  const s = scrub(`sonnet/high failed at ${win} for ${OWNER}/${REPO}`);
  assert.equal(s, 'sonnet/high failed at <path> for <repo>');
  assert.doesNotMatch(s, /qzhandle/);
  assert.equal(scrub(`https://github.com/${OWNER}/${REPO} sonnet/low`), '<repo-url> sonnet/low');
});

// ---------------------------------------------------------------- CLI --

const SONNET = 'claude-sonnet-5-5';
const tok = (u) => [u, 0, 0, 0, 0, 1];
const zero = () => [0, 0, 0, 0, 0, 0];
const row = (hourIso, sid, units) => ({ hour: hourIso, sid, proj: 'alpha', cwd: null, tok: { [SONNET]: { m: tok(units), s: zero() } }, pr: { n: 1, len: [1, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0 });
function writeFacts(root, day) {
  write(join(root, 'state', 'usage-facts', `${day}.json`), {
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${addDays(day, 1)}T08:00:00.000Z`, dataThrough: `${addDays(day, 1)}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${addDays(day, 1)}T09:00:00.000Z`,
    weightsUsed: { [SONNET]: { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 } },
    rows: [row(`${day}T10:00:00Z`, `s-${day}`, 20), row(`${day}T11:00:00Z`, `t-${day}`, 22)], spawns: [],
  });
}
function transcriptFx(fx, day) {
  const tdir = join(fx.dir, 'transcripts');
  const asst = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, cwd: '/work/proj-a', message: { id: `msg_${id}`, model: SONNET, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: u, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  const prompt = (uuid, ts, text) => JSON.stringify({ type: 'user', timestamp: ts, uuid, cwd: '/work/proj-a', message: { role: 'user', content: text } });
  mkdirSync(join(tdir, 'proj-a'), { recursive: true });
  writeFileSync(join(tdir, 'proj-a', 'sess-1.jsonl'), `${[prompt('p1', `${day}T10:00:00Z`, 'Please add the thing to the parser'), asst('m1', `${day}T10:00:05Z`, 4000)].join('\n')}\n`);
  return tdir;
}
const lastJson = (r) => JSON.parse(r.stdout.trim().split('\n').pop());

test('cli: usage_analysis=false makes --scheduled print one line, exit 0 and touch nothing; a typed run still works', () => {
  const fx = makeFixture();
  try {
    const transcripts = join(fx.dir, 'tr'); mkdirSync(transcripts, { recursive: true });
    const base = ['--root', fx.stateDir, '--transcripts', transcripts, '--now', '2026-03-09T12:00:00Z', '--hold-ms', '0'];
    const before = snapshot(fx.stateDir);
    const off = runScript('scripts/usage-analysis.mjs', ['--scheduled', ...base], { cwd: fx.dir, env: { CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS: 'false' }, timeout: 60000 });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout.trim().split('\n').length, 1, off.stdout);
    assert.match(off.stdout, /usage_analysis=false/);
    assert.deepEqual(snapshot(fx.stateDir), before);
    const on = runScript('scripts/usage-analysis.mjs', ['--scheduled', ...base], { cwd: fx.dir, timeout: 60000 });
    assert.equal(on.status, 0, on.stderr);
    assert.ok(existsSync(join(fx.stateDir, 'state', 'usage-analysis-status.json')), 'control: the option at its default runs the stage');
    const typed = runScript('scripts/usage-analysis.mjs', [...base, '--force'], { cwd: fx.dir, env: { CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS: 'false' }, timeout: 60000 });
    assert.doesNotMatch(typed.stdout, /usage_analysis=false/, 'a run typed by hand is the operator asking for it');
  } finally { fx.cleanup(); }
});

test('cli: --dry-run writes nothing at all under --root (no scan state, no facts, no lock)', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'dry-root'); mkdirSync(root, { recursive: true });
    const tdir = transcriptFx(fx, '2026-10-09');
    writeFacts(root, '2026-10-08'); // facts already on disk are analysed, never rewritten
    const before = snapshot(root);
    const r = runScript('scripts/usage-analysis.mjs', ['--dry-run', '--no-register', '--root', root, '--transcripts', tdir, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0'], { cwd: fx.dir, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(root), before, `dry run wrote: ${Object.keys(snapshot(root)).join(', ')}`);
    assert.match(r.stdout, /computed 1/, 'it still analyses the facts on disk');
  } finally { fx.cleanup(); }
});

test('cli: --scheduled caps the days per run by default, --max-days overrides, explicit days are not capped', () => {
  assert.equal(SCHEDULED_MAX_SECONDS, 120);
  assert.equal(SCHEDULED_MAX_DAYS, 14);
  const fx = makeFixture();
  try {
    for (const day of dayRange('2026-09-10', '2026-10-04')) writeFacts(fx.stateDir, day); // 25 settled days
    const args = (...more) => ['--no-scan', '--no-register', '--root', fx.stateDir, '--now', '2026-10-06T12:00:00Z', ...more];
    const first = runScript('scripts/usage-analysis.mjs', ['--scheduled', ...args()], { cwd: fx.dir, timeout: 90000 });
    assert.equal(first.status, 0, first.stderr);
    const j1 = lastJson(first);
    assert.equal(j1.computed.length, 14);
    assert.ok(j1.remaining >= 10, `the rest resumes next run: ${first.stdout}`);
    const second = runScript('scripts/usage-analysis.mjs', ['--scheduled', '--max-days', '2', ...args()], { cwd: fx.dir, timeout: 90000 });
    assert.equal(lastJson(second).computed.length, 2);
    const explicit = runScript('scripts/usage-analysis.mjs', ['--scheduled', '--from', '2026-09-10', '--to', '2026-09-30', '--force', ...args()], { cwd: fx.dir, timeout: 90000 });
    assert.equal(lastJson(explicit).computed.length, 21, 'explicit days are not limited to the per-run default');
    const bad = runScript('scripts/usage-analysis.mjs', ['--max-days', '0', ...args()], { cwd: fx.dir, timeout: 30000 });
    assert.equal(bad.status, 2);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- init --

const registerWith = (dir, ids) => {
  const ex = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'decision-register.example.json'), 'utf8'));
  ex.decisions = ids.map((id) => ({ ...ex.decisions[0], id }));
  const file = join(dir, 'decision-register.json');
  write(file, ex);
  return file;
};
const refsOf = (o) => JSON.stringify(o).match(/rollout:[A-Za-z0-9._-]+/g) || [];

test('init: only rollout ids that exist are referenced; without leads-xhigh the scenario is commented out with a reason', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root'); mkdirSync(root, { recursive: true });
    write(join(root, 'rollout.json'), { 'leads-high': '2026-10-10T20:03:00Z', 'context-ceiling': '2026-10-01T00:00:00Z' });
    const reg = registerWith(fx.dir, ['leads-effort-high']);
    const r = runScript('scripts/usage-analysis.mjs', ['init', '--from-register', '--root', root, '--register', reg], { cwd: fx.dir, timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const user = JSON.parse(readFileSync(join(root, 'config', 'usage-analysis.json'), 'utf8'));
    const table = JSON.parse(readFileSync(join(root, 'rollout.json'), 'utf8'));
    assert.deepEqual(refsOf(user.windows), ['rollout:leads-high']);
    for (const ref of refsOf(user.windows)) assert.ok(ref.slice('rollout:'.length) in table, ref);
    assert.deepEqual(user.scenarios, [], 'the xhigh comparison has no start event: not proposed live');
    assert.match(user['$commented-out'].reason, /no "leads-xhigh" row/);
    assert.equal(user['$commented-out'].scenario.id, 'u.leadsXhighVsHigh');
    assert.ok(!('leads-xhigh' in user.windows));
    assert.ok(!/\n/.test(user['$commented-out'].reason), 'one line');
  } finally { fx.cleanup(); }
});

test('init: with no rollout table at all the proposal falls back to the decision event, never a missing rollout', () => {
  const p = buildProposal({ decisions: [{ id: 'leads-effort-high' }] });
  assert.deepEqual(refsOf(p.windows), []);
  assert.equal(p.windows['leads-high'].from, 'decision:leads-effort-high');
  assert.deepEqual(p.scenarios, []);
});

test('init: with both rollout rows the whole leads comparison is proposed live', () => {
  const p = buildProposal({ decisions: [{ id: 'leads-effort-high' }] }, { rolloutIds: new Set(['leads-high', 'leads-xhigh']) });
  assert.deepEqual(refsOf(p).sort(), ['rollout:leads-high', 'rollout:leads-xhigh', 'rollout:leads-xhigh']);
  assert.deepEqual(p.scenarios.map((s) => s.id), ['u.leadsXhighVsHigh']);
  assert.ok(!p['$commented-out']);
});

// ---------------------------------------------------------------- docs --

test('docs: every usage option, the day close and the scheduled bounds are documented', () => {
  const doc = readFileSync(join(PLUGIN_ROOT, 'docs', 'USAGE-ANALYSIS.md'), 'utf8');
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const skill = readFileSync(join(PLUGIN_ROOT, 'skills', 'usage-analysis', 'SKILL.md'), 'utf8');
  const routine = readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8');
  for (const o of ['usage_analysis', 'usage_analysis_report_dir', 'scout_plugin_update']) {
    assert.match(doc, new RegExp(`\`${o}\``), `docs: ${o}`);
    assert.match(readme, new RegExp(`^\\| \`${o}\` \\|`, 'm'), `README option table: ${o}`);
  }
  assert.match(readme, /`scenario`: `scenario`/, 'README documents the scenario trigger kind');
  for (const text of [doc, skill, routine]) assert.match(text, /08:00Z/);
  for (const text of [doc, routine]) assert.match(text, /04:00 EDT/);
  for (const text of [doc, routine]) assert.match(text, /03:00 EST/);
  assert.doesNotMatch(routine, /04:00 local day close/);
  assert.match(doc, /--max-seconds N` \| 120/);
  assert.match(doc, /--max-days N` \| 14/);
  assert.match(doc, /SessionStart summary/);
  assert.match(doc, /Unattended sessions/);
  assert.doesNotMatch(skill, /`list` shows the ones the plugin implements/);
});
