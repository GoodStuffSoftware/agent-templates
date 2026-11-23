import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import './isolate.mjs';

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
const iso = (t) => new Date(t).toISOString();
// A reply the way the hook records it: the flag was shown to the session, then a typed prompt (origin human in the transcript) is confirmed.
const humanRec = (at, prompt) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: iso(at), message: { content: prompt } });
const humanAck = (at, { session = 's1', prompt = 'hi' } = {}) => {
  S.noteShown(session, at);
  S.noteCandidate({ sessionId: session, transcriptPath: 'fake', prompt, at: at + 1000 });
  return S.confirmCandidates({ at: at + 2000, readTail: () => [humanRec(at + 1000, prompt)] });
};

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
  let calls = 0; const run = () => { calls++; return metrics(); };
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
    telemetry: {}, bash: { since: { n: 300, realFails: 12, realFailPct: 4, refusals: 0, refusalPer100: 0 }, base: { n: 500, realFails: 20, realFailPct: 4, refusals: 0, refusalPer100: 0 } }, bashExit: {}, activeHours: { since: 10, base: 100 },
    queueClears: { since: 0, base: 5, perHour: { since: 0, base: 0.03 } },
    workers: { since: { ...w }, base: { ...w } }, hookSignatures: { since: {}, base: {} }, ...over,
  };
}
const names = (m) => W.evaluate(m).flags.map((f) => f.name);
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
  assert.ok(names(metrics({ bash: { since: { n: 300, realFails: 27, realFailPct: 9, refusals: 0, refusalPer100: 0 }, base: { n: 500, realFails: 5, realFailPct: 1, refusals: 0, refusalPer100: 0 } } })).includes('worker-bash-fail'));
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
  const tel2 = join(claude, 'agent-companion', 'telemetry'); mkdirSync(tel2, { recursive: true });
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
  assert.ok(humanAck(T + 60e3));
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR }), null);
  S.clear({ at: T + 6 * HOUR });
  S.openFlag({ version: '1', flags: [{ name: 'other', value: 1 }], at: T + 7 * HOUR });
  S.maybeHold({ holdMinutes: 30, at: T + 8 * HOUR });
  assert.equal(S.isHoldActive(), true);
  assert.equal(humanAck(T + 9 * HOUR), null);
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
  assert.ok(humanAck(T + 1));
  assert.equal(S.flagLine(), null);
  S.clear({ at: T - 1 });
  S.openFlag({ version: '1.2.3', flags: [{ name: 'z', value: 1 }], at: T });
  S.maybeHold({ holdMinutes: 1, at: T + HOUR });
  assert.match(S.flagLine(), /RELEASE HOLD/);
});

test('flag line during a hold names flags raised later, and is unchanged without any', () => {
  S.openFlag({ version: '1', flags: [{ name: 'z', value: 1 }], at: T });
  S.maybeHold({ holdMinutes: 1, at: T + HOUR });
  const before = S.flagLine();
  assert.match(before, /RELEASE HOLD/); assert.doesNotMatch(before, /Later checks/);
  S.openFlag({ version: '1', flags: [{ name: 'z', value: 1 }], at: T + 2 * HOUR });
  assert.equal(S.flagLine(), before, 'same flags: line unchanged');
  S.openFlag({ version: '1', flags: [{ name: 'worker-bash-fail', value: 10.7, detail: '10.7 vs limit 7' }], at: T + 3 * HOUR });
  const after = S.flagLine();
  assert.match(after, /RELEASE HOLD/);
  assert.match(after, /Later checks also flagged: worker-bash-fail \(10\.7 vs limit 7\)\./);
  assert.doesNotMatch(after, /also flagged: z/);
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
  const plain = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'again', cwd: tmp });
  assert.match(plain.stdout, /RELEASE WATCH/, 'a prompt with no human origin proof no longer acks');
  const after = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'typed', origin: { kind: 'human' }, cwd: tmp });
  assert.doesNotMatch(after.stdout, /RELEASE WATCH/, 'answered by the typed prompt');
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

// ---- 0.31.63 fix round: one test per fix, invented data ----
const rowj = (o) => JSON.stringify(o) + '\n';
const DAY = 24 * HOUR;
const putRows = (name, rows, dir = 'telemetry') => { const d = join(dir === 'telemetry' ? join(claude, 'agent-companion') : state, dir); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), rows.map(rowj).join('')); };
const spread = (n, from, to, mk) => Array.from({ length: n }, (_, i) => mk(from + ((to - from) * (i + 0.5)) / n, i));

test('B1: queue-clears counts failure clears only and judges them against the 7-day baseline', () => {
  assert.equal(W.isFailureClear({ rule: 'pid-dead', type: 'lease', label: 'build' }), true);
  assert.equal(W.isFailureClear({ rule: 'requester-gone', type: 'waiting' }), false, 'a waiting ticket whose requester left is routine');
  assert.equal(W.isFailureClear({ rule: 'pid-dead', type: 'lease', label: 'node --test tests/demo.test.mjs' }), false, 'test-run labels are not failures');
  assert.equal(W.isFailureClear({ rule: 'pid-dead', type: 'lease', label: 'x', worktree: 'D:\\scratch\\temp\\wt-1' }), false);
  assert.equal(W.isFailureClear({ rule: 'idle', type: 'lease' }), false);
  const clears = [...spread(14, T - 7 * DAY, T, (at) => ({ at, rule: 'pid-dead', type: 'lease', label: 'build' })),
    ...spread(60, T, T + 4 * HOUR, (at) => ({ at, rule: 'requester-gone', type: 'waiting' })),
    ...spread(20, T, T + 4 * HOUR, (at) => ({ at, rule: 'pid-dead', type: 'lease', label: 'node --test a.test.mjs' }))];
  putRows('clears.jsonl', clears, 'ci-budget');
  const m = W.analyze({ T, nowMs: T + 4 * HOUR });
  assert.equal(m.queueClears.since, 0); assert.equal(m.queueClears.base, 14);
  assert.ok(!names(m).includes('queue-clears'));
  // A few failure clears at about the baseline pace do not flag; a burst well over twice the pooled rate does.
  const mk = (n, h) => metrics({ span: { since: h, base: 168 }, queueClears: { since: n, base: 14, perHour: { since: n / h, base: 0.083 } } });
  assert.ok(!names(mk(3, 40)).includes('queue-clears'));
  assert.ok(!names(mk(6, 24)).includes('queue-clears'), 'a handful of interrupted runs in a day is routine development');
  assert.ok(names(mk(12, 1)).includes('queue-clears'));
  // the context ceiling is judged against how often the baseline workers already went over it
  const mc = (since, base) => { const m = metrics(); m.workers.since.over150kPct = since; m.workers.base.over150kPct = base; return names(m); };
  assert.ok(!mc(6.5, 22.4).includes('context-over-150k')); assert.ok(mc(40, 22.4).includes('context-over-150k')); assert.ok(mc(8, 0).includes('context-over-150k'));
});

test('B2: the hold\'s own denials and rows logged during a hold never count', () => {
  S.appendRow({ at: new Date(T + 2.5 * HOUR).toISOString(), event: 'hold', flags: ['x'] });
  S.appendRow({ at: new Date(T + 3 * HOUR).toISOString(), event: 'clear' });
  putRows('spawns.jsonl', [{ at: T + 1 * HOUR }, { at: T + 2.7 * HOUR }, { at: T + 3 * HOUR + 2 * 60e3 }, { at: T + 3.5 * HOUR }]);
  putRows('denials.jsonl', [...spread(40, T + 2.5 * HOUR, T + 3 * HOUR, (at) => ({ at, guard: 'spawn-guard', outcome: 'deny' })), { at: T + 3.2 * HOUR, guard: 'spawn-guard', outcome: 'deny' }]);
  const m = W.analyze({ T, nowMs: T + 4 * HOUR });
  assert.equal(m.spawns.since, 2, 'spawns inside the hold and its 5 min grace are dropped');
  assert.equal(m.telemetry['denial:spawn-guard/deny'].since, 1);
  assert.equal(S.holdIntervals(T + 4 * HOUR).length, 1);
});

test('B3: per-window rates; answered flag quiet unless its rate more than doubles; repeat of an unanswered flag keeps the countdown', () => {
  // tick hands each check its own window and a baseline that never moves
  const seen = []; const run = (o) => { seen.push(o); return metrics(); };
  W.tick({ at: T + HOUR, installed: installed(), run, holdMinutes: 30 });
  W.tick({ at: T + 2 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(seen[0].winFrom, T); assert.equal(seen[1].winFrom, T + HOUR); assert.equal(seen[1].T, T);
  putRows('spawns.jsonl', [{ at: T - 6 * DAY }, { at: T - 8 * DAY }, { at: T + 90 * 60e3 }]);
  const m = W.analyze({ T, nowMs: T + 2 * HOUR, winFrom: T + HOUR });
  assert.equal(m.spawns.base, 1, 'baseline is the 7 days before T'); assert.equal(m.spawns.since, 1);
  // answered: same level stays quiet, up to 2x stays quiet, over 2x comes back
  const fl = (level) => [{ name: 'queue-clears', value: level, level, detail: 'x' }];
  const a = new Date(T).toISOString();
  assert.ok(S.openFlag({ version: '1', T: a, check: '+1h', flags: fl(3), at: T }));
  assert.ok(humanAck(T + 60e3));
  assert.equal(S.openFlag({ version: '1', T: a, check: '+2h', flags: fl(3), at: T + HOUR }), null);
  assert.equal(S.openFlag({ version: '1', T: a, check: '+4h', flags: fl(5.5), at: T + 4 * HOUR }), null);
  assert.ok(S.openFlag({ version: '1', T: a, check: '+8h', flags: fl(7), at: T + 8 * HOUR }), 'more than doubled');
  assert.equal(S.readFlag().ackedAt, null, 'worse than answered: unanswered again');
  // unanswered repeat does not restart the countdown
  rmSync(file('release-watch-flag.json'), { force: true });
  S.openFlag({ version: '1', T: a, check: '+1h', flags: fl(3), at: T });
  const n0 = S.readFlag().notifiedAt;
  S.openFlag({ version: '1', T: a, check: '+2h', flags: fl(3.5), at: T + 20 * 60e3 });
  assert.equal(S.readFlag().notifiedAt, n0);
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * 60e3 }), 'countdown ran from the first notice');
});

test('refusal text carries no clear command; clear() leaves the hold off even when the delete fails', () => {
  S.writeJson(S.paths().hold, { since: new Date(T).toISOString(), version: '1', reason: 'r', flags: [{ name: 'a' }], clearedAt: null });
  const msg = S.holdDenyMessage('new work');
  assert.match(msg, /clear hold/); assert.doesNotMatch(msg, /release-watch|--by|node /);
  S.openFlag({ version: '1', T: new Date(T).toISOString(), check: '+1h', flags: flag, at: T });
  const h = S.readHold();
  const r = S.clear({ by: 'operator', at: T + HOUR });
  assert.equal(r.holdCleared, true);
  // Simulate a failed delete: the cleared file is still on disk.
  S.writeJson(S.paths().hold, { ...h, clearedAt: new Date(T + HOUR).toISOString() });
  assert.equal(S.isHoldActive(), false);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 3 * HOUR }), null, 'a clear newer than the notice never re-holds');
});

test('new guard keys flag on rate, not presence', () => {
  assert.deepEqual(names(metrics({ telemetry: { 'denial:fresh/deny': t(5, 0, 3, null) } })), []);
  assert.deepEqual(names(metrics({ telemetry: { 'denial:fresh/deny': t(2, 0, 40, null) } })), []);
  assert.ok(names(metrics({ telemetry: { 'denial:fresh/deny': t(5, 0, 12, null) } })).includes('guard:fresh/deny'));
});

// ---- replay: install, checks at +1,2,4,8,12,16,20,24 h ----
// Worker transcripts (the units half of the usage metric): one small worker every `everyMs` from `from` to `to`.
let wseq = 0;
function putWorkers(from, to, everyMs, units = { input_tokens: 40000, output_tokens: 2000 }) {
  const sd = join(claude, 'projects', 'C--proj', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  for (let at = from; at < to; at += everyMs) {
    const n = wseq++;
    writeFileSync(join(sd, `agent-w${n}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), requestId: `rq${n}`, message: { model: 'claude-sonnet', usage: units, content: [{ type: 'text', text: 'STATUS: done' }] } }) + '\n');
  }
}
function seedRoutine(upTo, extraDenials = []) {
  putWorkers(T - 7 * DAY, T, 6 * HOUR); putWorkers(T, T + upTo, HOUR / 2);
  putRows('spawns.jsonl', [...spread(1176, T - 7 * DAY, T, (at) => ({ at })), ...spread(Math.round(5 * upTo / HOUR), T, T + upTo, (at) => ({ at }))]);
  putRows('denials.jsonl', [...spread(20, T - 7 * DAY, T, (at) => ({ at, guard: 'demo-guard', outcome: 'deny' })), ...spread(Math.round(upTo / HOUR / 12), T, T + upTo, (at) => ({ at, guard: 'demo-guard', outcome: 'deny' })), ...extraDenials]);
  putRows('clears.jsonl', [...spread(14, T - 7 * DAY, T, (at) => ({ at, rule: 'pid-dead', type: 'lease', label: 'build' })),
    ...spread(Math.round(upTo / HOUR), T, T + upTo, (at) => ({ at, rule: 'requester-gone', type: 'waiting' })),
    ...spread(Math.round(upTo / HOUR / 2), T, T + upTo, (at) => ({ at, rule: 'pid-dead', type: 'lease', label: 'node --test x.test.mjs' }))], 'ci-budget');
}
const CHECKS = [1, 2, 4, 8, 12, 16, 20, 24];

test('replay: routine queue activity and the hold\'s own denials over 24 h never start a hold', () => {
  // A hold the operator lifted at +3h: its denials (40, over +2.5h..+3h) fall in the +4h window.
  S.appendRow({ at: new Date(T + 2.5 * HOUR).toISOString(), event: 'hold', flags: ['x'] });
  S.appendRow({ at: new Date(T + 3 * HOUR).toISOString(), event: 'clear' });
  seedRoutine(24 * HOUR, spread(40, T + 2.5 * HOUR, T + 3 * HOUR, (at) => ({ at, guard: 'spawn-guard', outcome: 'deny' })));
  for (const h of CHECKS) {
    const r = W.tick({ at: T + h * HOUR, installed: installed(), holdMinutes: 30 });
    assert.deepEqual(r.flagged, [], `+${h}h flags: ${r.flagged}`);
    assert.equal(r.held, false);
    assert.equal(W.tick({ at: T + h * HOUR + 31 * 60e3, installed: installed(), holdMinutes: 30 }).held, false);
  }
  assert.equal(S.isHoldActive(), false);
  assert.equal(S.flagIsOpen(), false);
});

test('replay: a real spike in the same replay still flags and holds', () => {
  seedRoutine(8 * HOUR, spread(40, T + 5 * HOUR, T + 7 * HOUR, (at) => ({ at, guard: 'demo-guard', outcome: 'deny' })));
  const extra = spread(40, T + 5 * HOUR, T + 7 * HOUR, (at) => ({ at, rule: 'pid-dead', type: 'lease', label: 'build' }));
  const cf = join(state, 'ci-budget', 'clears.jsonl'); writeFileSync(cf, readFileSync(cf, 'utf8') + extra.map(rowj).join(''));
  for (const h of [1, 2, 4]) assert.deepEqual(W.tick({ at: T + h * HOUR, installed: installed(), holdMinutes: 30 }).flagged, []);
  const r = W.tick({ at: T + 8 * HOUR, installed: installed(), holdMinutes: 30 });
  assert.ok(r.flagged.includes('queue-clears'), String(r.flagged)); assert.ok(r.flagged.includes('guard:demo-guard/deny'), String(r.flagged));
  assert.equal(r.held, false);
  assert.equal(W.tick({ at: T + 8 * HOUR + 31 * 60e3, installed: installed(), holdMinutes: 30 }).held, true);
  assert.equal(S.isHoldActive(), true);
});

// ---- 0.31.63 usage metric: a scratch state dir must not hide the telemetry ----
const checkRun = (scratch, since) => spawnSync(process.execPath, [SCRIPT, 'check', '--since', new Date(since).toISOString()], { env: { ...env(), AGENT_COMPANION_STATE_DIR: scratch, AGENT_COMPANION_FAKE_NOW: String(T + 3 * HOUR) }, encoding: 'utf8', windowsHide: true });

test('usage: the state-dir override moves only the watch\'s own files, never the telemetry or usage data', () => {
  putRows('spawns.jsonl', [...spread(70, T - 7 * DAY, T, (at) => ({ at })), ...spread(30, T, T + 3 * HOUR, (at) => ({ at }))]);
  putWorkers(T - 7 * DAY, T, 6 * HOUR); putWorkers(T, T + 3 * HOUR, HOUR / 2);
  // a decoy under the scratch state dir that the watch must NOT read
  const scratch = join(tmp, 'scratch-state'); mkdirSync(join(scratch, 'telemetry'), { recursive: true });
  writeFileSync(join(scratch, 'telemetry', 'spawns.jsonl'), rowj({ at: T + HOUR }).repeat(99));
  process.env.AGENT_COMPANION_STATE_DIR = scratch;
  try { for (const k of ['run', 'flag', 'hold', 'checks']) assert.ok(S.paths()[k].startsWith(scratch.replace(/\\/g, '/')) || S.paths()[k].startsWith(scratch), `${k} follows the override`); }
  finally { process.env.AGENT_COMPANION_STATE_DIR = state; }
  const before = existsSync(join(scratch, 'state')) ? readdirSync(join(scratch, 'state')) : [];
  const r = checkRun(scratch, T);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.spawns.since, 30, 'real telemetry, not the decoy'); assert.equal(m.spawns.base, 70);
  assert.ok(m.workers.since.n > 0 && m.workers.base.n > 0);
  assert.ok(m.estUnitsPerHour.since > 0 && m.estUnitsPerHour.base > 0, 'a scratch state dir no longer zeroes the usage metric');
  assert.ok(m.usage.since.pctPerHour > 0 && m.usage.base.pctPerHour > 0);
  assert.equal(m.verdict, 'inconclusive', 'too few workers and Bash calls for a verdict');
  const after = existsSync(join(scratch, 'state')) ? readdirSync(join(scratch, 'state')) : [];
  assert.deepEqual(after, before, 'check wrote none of the watch\'s own files');
});

test('usage: an empty usage source is an error the verdict names, never a quiet clean', () => {
  // spawns in the telemetry but no worker transcripts at all: the units half measured nothing
  putRows('spawns.jsonl', [...spread(70, T - 7 * DAY, T, (at) => ({ at })), ...spread(30, T, T + 3 * HOUR, (at) => ({ at }))]);
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.estUnitsPerHour.base, 0); assert.equal(m.usage.base.empty, true); assert.deepEqual(m.usage.base.why, ['no worker transcripts']);
  const f = W.evaluate(m).flags.find((x) => x.name === 'usage-source-empty');
  assert.ok(f, 'flagged'); assert.match(f.detail, /usage source empty \(baseline: no worker transcripts\)/);
  const r = checkRun(join(tmp, 'scratch-state'), T);
  assert.match(JSON.parse(r.stdout).verdict, /^FLAG usage-source-empty/);
  // no spawn rows at all: names the telemetry
  rmSync(join(claude, 'agent-companion', 'telemetry'), { recursive: true, force: true });
  putWorkers(T - 7 * DAY, T + 3 * HOUR, HOUR);
  const m2 = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.deepEqual(m2.usage.base.why, ['no spawn rows in telemetry']);
  assert.ok(W.evaluate(m2).flags.map((x) => x.name).includes('usage-source-empty'));
  // a quiet window with a healthy baseline is not an error
  assert.ok(!names(metrics({ spawns: { since: 2, base: 700, perHour: { since: 0.2, base: 10 } } })).includes('usage-source-empty'));
  assert.ok(names(metrics({ spawns: { since: 100, base: 0, perHour: { since: 10, base: 0 } } })).includes('usage-source-empty'));
});

test('usage: units per hour convert to percent of the weekly limit (28.6 units = 1%)', () => {
  const m = metrics({ spawns: { since: 100, base: 1680, perHour: { since: 10, base: 10 } } });
  m.workers.since = { ...m.workers.since, unitsPerWorker: { mean: 1.43, p50: 1, p90: 2 } }; m.workers.base = { ...m.workers.base, unitsPerWorker: { mean: 2.86, p50: 1, p90: 2 } };
  const u = W.usageOf(m, 28.6);
  assert.deepEqual([u.since.unitsPerHour, u.since.pctPerHour, u.base.unitsPerHour, u.base.pctPerHour], [14.3, 0.5, 28.6, 1]);
  assert.equal(u.unitsPerPercent, 28.6); assert.equal(u.since.empty, false);
  assert.equal(W.usageOf(m, 57.2).since.pctPerHour, 0.25, 'a bigger 1% means a smaller percent');
  // analyze carries the same figure: units per hour over the current units-per-percent
  putRows('spawns.jsonl', spread(60, T, T + 3 * HOUR, (at) => ({ at })).concat(spread(10, T - 7 * DAY, T, (at) => ({ at }))));
  putWorkers(T - 7 * DAY, T + 3 * HOUR, HOUR);
  const a = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(a.usage.since.pctPerHour, +(a.estUnitsPerHour.since / a.usage.unitsPerPercent).toFixed(3));
  assert.ok(a.usage.since.pctPerHour > 0);
});

test('live-check rows never count in any telemetry metric', () => {
  const synth = (o) => ({ ...o, session_id: 'live-check' });
  const real = (o) => ({ ...o, session_id: 'real-session-1' });
  putRows('spawns.jsonl', [...spread(70, T - 7 * DAY, T, (at) => real({ at })), ...spread(19, T, T + HOUR, (at) => real({ at })), ...spread(5, T, T + HOUR, (at) => synth({ at }))]);
  putRows('resource-gate.jsonl', [...spread(3, T, T + HOUR, (at) => real({ at, event: 'granted' })), ...spread(6, T, T + HOUR, (at) => synth({ at, event: 'denied' }))]);
  putRows('denials.jsonl', spread(4, T, T + HOUR, (at) => synth({ at, guard: 'spawn-guard', outcome: 'deny' })));
  const m = W.analyze({ T, nowMs: T + HOUR });
  assert.equal(m.spawns.since, 19, 'live-check spawns are not counted');
  assert.equal(m.telemetry['gate:denied'], undefined, 'live-check denials are not counted');
  assert.equal(m.telemetry['gate:granted'].since, 3);
  assert.equal(m.telemetry['denial:spawn-guard/deny'], undefined);
  assert.ok(!W.evaluate(m).flags.map((x) => x.name).includes('queue-denied'));
  assert.ok(W.SYNTHETIC_SESSIONS.has('live-check'));
});

test('usage-source-empty is reported but never starts a hold', () => {
  for (const k of ['flag', 'hold', 'run']) rmSync(S.paths()[k], { force: true });
  const only = () => metrics({ spawns: { since: 100, base: 0, perHour: { since: 10, base: 0 } } });
  assert.deepEqual(names(only()), ['usage-source-empty']);
  let r = W.tick({ at: T + HOUR, installed: installed(), holdMinutes: 30, run: only });
  assert.deepEqual(r.flagged, ['usage-source-empty']); assert.equal(S.flagIsOpen(), true);
  assert.match(S.flagLine(), /usage-source-empty/); assert.match(S.flagLine(), /never starts a hold/);
  for (const min of [31, 120, 24 * 60]) {
    r = W.tick({ at: T + HOUR + min * 60e3, installed: installed(), holdMinutes: 30, run: only });
    assert.equal(r.held, false, `no hold after ${min} min`);
  }
  assert.equal(S.isHoldActive(), false);
  // beside a release flag the hold still starts, and names only the release flag
  S.openFlag({ version: '1', flags: [{ name: 'usage-source-empty', value: 0, level: 0 }, { name: 'queue-denied', value: 30, level: 30 }], at: T + 5 * HOUR, check: '+4h' });
  const h = S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR + 31 * 60e3 });
  assert.ok(h, 'a release flag beside it still holds'); assert.match(h.reason, /queue-denied/); assert.doesNotMatch(h.reason, /usage-source-empty/);
  assert.deepEqual(h.flags.map((x) => x.name), ['queue-denied']); assert.doesNotMatch(S.holdDenyMessage(), /usage-source-empty/);
  // an answered release flag is not revived by a later usage-source-empty
  S.clear({ by: 'operator', at: T + 6 * HOUR });
  for (const k of ['flag', 'hold']) rmSync(S.paths()[k], { force: true });
  S.openFlag({ version: '1', flags: [{ name: 'queue-denied', value: 30, level: 30 }], at: T + 7 * HOUR, check: '+8h' });
  assert.ok(humanAck(T + 7 * HOUR + 60e3));
  S.openFlag({ version: '1', flags: [{ name: 'usage-source-empty', value: 0, level: 0 }], at: T + 8 * HOUR, check: '+8h' });
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 8 * HOUR + 31 * 60e3 }), null, 'answered queue-denied + usage-source-empty: no hold');
  assert.equal(S.isHoldActive(), false);
});

test('cleanup', () => { rmSync(tmp, { recursive: true, force: true }); });
void tel;
