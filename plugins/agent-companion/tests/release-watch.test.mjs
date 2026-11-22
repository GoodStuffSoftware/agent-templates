import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'release-watch.mjs');
const HOUR = 3600e3;
const T = Date.parse('2026-03-01T10:00:00Z');

let tmp; let state; let claude;
const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: claude, AGENT_COMPANION_STATE_DIR: state, AGENT_COMPANION_FAKE_NOW: '', CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MINUTES: '' });
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rw-'));
  state = join(tmp, 'ac'); claude = join(tmp, 'claude');
  mkdirSync(join(state, 'state'), { recursive: true }); mkdirSync(join(claude, 'plugins'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claude; process.env.AGENT_COMPANION_STATE_DIR = state; delete process.env.AGENT_COMPANION_FAKE_NOW;
});

const W = await import('../scripts/release-watch.mjs');
const S = await import('../hooks/lib/release-watch-state.mjs');
const installed = (t = T) => ({ plugins: { 'agent-companion@x': [{ version: '1.2.3', lastUpdated: new Date(t).toISOString() }] } });
const file = (n) => join(state, 'state', n);
const flag = [{ name: 'queue-clears', value: 3.6, detail: 'x' }];

test('schedule: eight checks at the decided hours', () => {
  const s = W.buildSchedule(T, '1', null);
  assert.deepEqual(s.due.map((d) => (d - T) / HOUR), [1, 2, 4, 8, 12, 16, 20, 24]);
  assert.deepEqual(W.dueIndexes(s, T + 30 * 60e3), []);
  assert.deepEqual(W.dueIndexes(s, T + 2 * HOUR), [0, 1]);
});

test('newestInstall picks the newest copy and ignores other plugins', () => {
  const i = { plugins: { 'other@x': [{ lastUpdated: '2030-01-01T00:00:00Z' }], 'agent-companion@x': [{ version: 'a', lastUpdated: '2026-01-01T00:00:00Z' }, { version: 'b', lastUpdated: '2026-02-01T00:00:00Z' }] } };
  assert.equal(W.newestInstall(i).version, 'b');
  assert.equal(W.newestInstall({}), null);
});

test('tick: nothing due is a quiet no-op; catch-up covers all due checks once', () => {
  let calls = 0; const run = () => { calls++; return null; };
  let r = W.tick({ at: T + 10 * 60e3, installed: installed(), run, holdMinutes: 30 });
  assert.equal(r.ran, false); assert.equal(calls, 0);
  r = W.tick({ at: T + 11 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.deepEqual(r.checks, [1, 2, 3, 4]); assert.equal(calls, 1);
  r = W.tick({ at: T + 11.5 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(r.ran, false);
  r = W.tick({ at: T + 30 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.deepEqual(r.checks, [5, 6, 7, 8]);
  assert.equal(JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8')).closed, true);
  const rows = readFileSync(file('release-watch-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].late, true);
});

test('tick: a new install re-arms the schedule and keeps the previous T as base', () => {
  W.tick({ at: T + 1, installed: installed(), run: () => null });
  const T2 = T + 48 * HOUR;
  W.tick({ at: T2 + 1, installed: installed(T2), run: () => null });
  const s = JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8'));
  assert.equal(s.T, T2); assert.equal(s.prevT, T); assert.deepEqual(s.done, []);
});

test('tick: fail-open on missing install, corrupt run file and a throwing analysis', () => {
  assert.equal(W.tick({ at: T, installed: {} }).installed, false);
  writeFileSync(file('release-watch-run.json'), '{nope');
  const r = W.tick({ at: T + 2 * HOUR, installed: installed(), run: () => { throw new Error('boom'); } });
  assert.equal(r.ran, true); assert.deepEqual(r.flagged, []);
});

test('tick CLI: exits 0 fast with no data at all', () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, 'tick'], { env: env(), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 3000, 'under 3 s including node startup');
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'garbage');
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'tick'], { env: env(), encoding: 'utf8', windowsHide: true }).status, 0);
});

// ---- thresholds on invented metrics ----
const tel = (o) => o;
function metrics(over = {}) {
  const w = { n: 40, finished: 40, unitsPerWorker: { mean: 1, p50: 0.8, p90: 2 }, peakCtxP90: 100000, over110kPct: 10, over150kPct: 0, noStatusPct: 5, partialPct: 10, blockedPct: 1, hookErrorWorkersPct: 40, apiErrorWorkers: 0, apiNonUsageWorkers: 0 };
  return {
    spawns: { since: 100, base: 700, perHour: { since: 10, base: 10 } }, span: { since: 10, base: 168 },
    telemetry: {}, bash: { since: { n: 100, failPct: 4 }, base: { n: 500, failPct: 4 } },
    queueClears: { since: 0, base: 5, perHour: { since: 0, base: 0.03 } },
    workers: { since: { ...w }, base: { ...w } }, hookSignatures: { since: {}, base: {} }, ...over,
  };
}
const names = (m) => W.evaluate(m).map((f) => f.name);
const t = (since, base, ps, pb) => ({ since, base, per100spawns: { since: ps, base: pb } });

test('evaluate: a quiet release flags nothing', () => assert.deepEqual(names(metrics()), []));
test('evaluate: worker guard over 2x its pooled rate (n>=10), new guard (>=3), lead guard per hour', () => {
  assert.ok(names(metrics({ telemetry: { 'denial:python-stdin/deny': t(30, 56, 30, 8) } })).includes('guard:python-stdin/deny'));
  assert.deepEqual(names(metrics({ telemetry: { 'denial:python-stdin/deny': t(12, 56, 12, 8) } })), []);
  assert.ok(names(metrics({ telemetry: { 'denial:fresh-guard/deny': t(5, 0, 30, null) } })).includes('guard:fresh-guard/deny'));
  assert.ok(names(metrics({ telemetry: { 'denial:delegation/deny': t(100, 300, 100, 40) } })).includes('guard:delegation/deny'));
});
test('evaluate: spawn rewrites, queue, context, status, bash, api, runaway, bleed', () => {
  assert.ok(names(metrics({ telemetry: { 'denial:fit/deny': t(4, 1, 4, 0.1) } })).includes('spawn-rewrites'));
  assert.ok(names(metrics({ telemetry: { 'gate:denied': t(25, 40, 25, 6) } })).includes('queue-denied'));
  assert.ok(names(metrics({ queueClears: { since: 31, base: 5, perHour: { since: 3.6, base: 0.06 } } })).includes('queue-clears'));
  assert.ok(names(metrics({ telemetry: { 'handoff:hard/deny': t(3, 0, 3, 0) } })).includes('handoff-hard-deny'));
  const m = metrics(); m.workers.since = { ...m.workers.since, over150kPct: 8, noStatusPct: 20, partialPct: 40, blockedPct: 9, hookErrorWorkersPct: 60, apiErrorWorkers: 3, apiNonUsageWorkers: 1, unitsPerWorker: { mean: 2, p50: 1, p90: 4 } };
  const n = names(m);
  for (const x of ['context-over-150k', 'no-final-status', 'partial-share', 'blocked-share', 'hook-error-share', 'api-errors', 'units-per-worker', 'units-p90']) assert.ok(n.includes(x), x);
  assert.ok(names(metrics({ bash: { since: { n: 100, failPct: 9 }, base: { n: 1, failPct: 1 } } })).includes('worker-bash-fail'));
  assert.ok(names(metrics({ telemetry: { 'runaway:fired': t(1, 0, 1, 0) } })).includes('runaway'));
  assert.ok(names(metrics({ hookSignatures: { since: { 'PreToolUse:Bash boom': 6 }, base: {} } })).some((x) => x.startsWith('hook-signature')));
});
test('evaluate: too little data stays silent', () => {
  const m = metrics({ spawns: { since: 3, base: 700, perHour: { since: 1, base: 1 } }, telemetry: { 'denial:fit/deny': t(3, 0, 100, 0) } });
  m.workers.since.n = 3; m.workers.since.over150kPct = 90;
  assert.deepEqual(names(m), []);
});

// ---- analyze on a fake data tree ----
test('analyze: reads telemetry and worker transcripts of invented data', () => {
  const tel2 = join(state, 'telemetry'); mkdirSync(tel2, { recursive: true });
  const row = (o) => JSON.stringify(o) + '\n';
  writeFileSync(join(tel2, 'spawns.jsonl'), row({ at: T + HOUR }) + row({ at: T + 2 * HOUR }) + row({ at: T - 2 * HOUR }));
  writeFileSync(join(tel2, 'denials.jsonl'), row({ at: T + HOUR, guard: 'g', outcome: 'deny' }) + row({ at: T - HOUR, guard: 'g', outcome: 'deny' }));
  const sd = join(claude, 'projects', 'C--proj', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  const ts = new Date(T + HOUR).toISOString();
  const lines = [{ type: 'assistant', timestamp: ts, requestId: 'r1', message: { model: 'claude-sonnet', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 200000 }, content: [{ type: 'text', text: 'STATUS: done' }] } }];
  writeFileSync(join(sd, 'agent-a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.spawns.since, 2); assert.equal(m.spawns.base, 1);
  assert.equal(m.telemetry['denial:g/deny'].since, 1);
  assert.equal(m.workers.since.n, 1); assert.equal(m.workers.since.over150kPct, 100);
});

// ---- state, hold, clear ----
test('state: fail open on bad files', () => {
  writeFileSync(file('release-watch-flag.json'), '{bad'); writeFileSync(file('release-hold.json'), 'xx');
  assert.equal(S.isHoldActive(), false); assert.equal(S.flagLine(), null); assert.equal(S.noteReply(), false);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T }), null);
  assert.doesNotThrow(() => S.clear());
});

test('hold is written only after notifiedAt + delay with no reply', () => {
  S.openFlag({ version: '1', flags: flag, at: T, check: '+1h' });
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 29 * 60e3 }), null);
  assert.equal(S.isHoldActive(), false);
  assert.equal(S.maybeHold({ holdMinutes: 0, at: T + 99 * HOUR }), null, '0 = notify only');
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * 60e3 }));
  assert.equal(S.isHoldActive(), true);
});

test('a reply before the hold stops the countdown; a reply during the hold does not lift it', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  assert.equal(S.noteReply(T + 60e3), true);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR }), null);
  S.clear({ at: T + 6 * HOUR });
  S.openFlag({ version: '1', flags: [{ name: 'other', value: 1 }], at: T + 7 * HOUR });
  S.maybeHold({ holdMinutes: 30, at: T + 8 * HOUR });
  assert.equal(S.isHoldActive(), true);
  assert.equal(S.noteReply(T + 9 * HOUR), false);
  assert.equal(S.isHoldActive(), true);
});

test('clear lifts the hold, logs a row, and the cooldown suppresses the same flag unless it worsens', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  S.maybeHold({ holdMinutes: 30, at: T + HOUR });
  const r = S.clear({ by: 'test', at: T + 2 * HOUR });
  assert.deepEqual(r, { flagCleared: true, holdCleared: true });
  assert.equal(S.isHoldActive(), false); assert.equal(existsSync(file('release-hold.json')), false);
  assert.equal(S.flagLine(), null);
  assert.equal(S.openFlag({ version: '1', flags: [{ name: 'queue-clears', value: 4 }], at: T + 3 * HOUR }), null, 'inside the 4 h cooldown, same size');
  assert.ok(S.openFlag({ version: '1', flags: [{ name: 'queue-clears', value: 9 }], at: T + 3 * HOUR }), 'worsened more than 2x');
  S.clear({ at: T + 3.5 * HOUR });
  assert.equal(S.openFlag({ version: '1', flags: [{ name: 'queue-clears', value: 9 }], at: T + 30 * HOUR }), null, 'answered stays answered, however much later');
  const rows = readFileSync(file('release-watch-checks.jsonl'), 'utf8').trim().split('\n');
  assert.ok(rows.length >= 2);
});

test('flag line: open unanswered flag and hold, silent when answered', () => {
  assert.equal(S.flagLine(), null);
  S.openFlag({ version: '1.2.3', flags: flag, at: T, check: '+4h' });
  const l = S.flagLine();
  assert.match(l, /RELEASE WATCH 1\.2\.3/); assert.match(l, /PushNotification/); assert.match(l, /queue-clears/);
  S.noteReply(T + 1);
  assert.equal(S.flagLine(), null);
  S.clear({ at: T - 1 });
  S.openFlag({ version: '1.2.3', flags: [{ name: 'z', value: 1 }], at: T });
  S.maybeHold({ holdMinutes: 1, at: T + HOUR });
  assert.match(S.flagLine(), /RELEASE HOLD/);
});

// ---- hooks ----
function hook(name, payload) {
  return spawnSync(process.execPath, [join(ROOT, 'hooks', name)], { input: JSON.stringify(payload), env: { ...env(), AC_ATTENDED: '1' }, encoding: 'utf8', windowsHide: true, cwd: tmp });
}
test('hooks: lead sees the line on every prompt, a subagent never does, a prompt acks', () => {
  S.openFlag({ version: '9', flags: flag, at: Date.now() });
  const sub = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', agent_id: 'a1', prompt: 'x', cwd: tmp });
  assert.equal(sub.stdout, '');
  const lead = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hello', cwd: tmp });
  assert.match(lead.stdout, /RELEASE WATCH 9/);
  const after = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'again', cwd: tmp });
  assert.doesNotMatch(after.stdout, /RELEASE WATCH/, 'answered after the first genuine prompt');
});
test('hooks: a task notification is not a reply', () => {
  S.openFlag({ version: '9', flags: flag, at: Date.now() });
  hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<task-notification>done', cwd: tmp });
  assert.match(hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi', cwd: tmp }).stdout, /RELEASE WATCH/);
});
test('hooks: SessionStart shows the line to a lead, not to a subagent', () => {
  S.openFlag({ version: '9', flags: flag, at: Date.now() });
  const lead = hook('scout-surface.mjs', { hook_event_name: 'SessionStart', session_id: 's', source: 'startup', cwd: tmp });
  assert.match(lead.stdout, /RELEASE WATCH 9/);
  const sub = hook('scout-surface.mjs', { hook_event_name: 'SessionStart', session_id: 's', agent_id: 'a1', source: 'startup', cwd: tmp });
  assert.doesNotMatch(sub.stdout, /RELEASE WATCH/);
});

test('cleanup', () => { rmSync(tmp, { recursive: true, force: true }); });
void tel;
