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
  let calls = 0; const run = () => { calls++; return rich(); };
  let r = W.tick({ at: T + 10 * 60e3, installed: installed(), run, holdMinutes: 30 });
  assert.equal(r.ran, false); assert.equal(calls, 0);
  r = W.tick({ at: T + 11 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.deepEqual(r.checks, [1, 2, 3, 4]); assert.equal(calls, 1);
  r = W.tick({ at: T + 11.5 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(r.ran, false);
  r = W.tick({ at: T + 30 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.deepEqual(r.checks, [5, 6, 7, 8]);
  const fin = JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8'));
  assert.equal(fin.v, 2); assert.equal(fin.status, 'finished'); assert.equal(fin.releases[0].status, 'finished');
  const rows = readFileSync(file('release-watch-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.event === 'check').late, true);
});

test('tick: an install while the chain is watched joins it and keeps the first install as the baseline anchor', () => {
  W.tick({ at: T + 1, installed: installed(), run: () => null });
  const T2 = T + 48 * HOUR;
  W.tick({ at: T2 + 1, installed: installed(T2), run: () => null });
  const s = JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8'));
  assert.equal(s.baseAnchor, T); assert.equal(s.releases.length, 2); assert.equal(s.releases[1].T, T2); assert.deepEqual(s.releases[1].done, []);
  assert.equal(s.releases[0].status, 'waiting-chain', 'the older release has all its checks done and waits for the chain');
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
// Enough activity since the install to finish the chain (finish floors: 100 spawns, 60 workers, 600 Bash calls, 6 active hours).
const rich = () => { const m = metrics(); m.workers.since.n = 60; m.workers.since.finished = 60; m.bash.since.n = 600; return m; };
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

// ---- 0.31.64 watch v2 stage 1: the 16 spec tests (docs/adr/0008-release-watch-v2.md; spec section 1.8) ----
const MIN = 60e3;
// A transcript user record. `over` sets origin and the system-turn markers; the text is what the candidate's sha is matched against.
const urec = (at, text, over = {}) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { content: text }, ...over });
const HUMAN = { origin: { kind: 'human' } };
// An open flag at T, shown to s1 at T, and a candidate typed at T+5m in s1.
function armCandidate(text = 'looks fine') {
  S.openFlag({ version: '1', flags: flag, at: T });
  assert.ok(S.noteShown('s1', T));
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: text, at: T + 5 * MIN }));
  return text;
}
const tailOf = (...recs) => () => recs;

test('human-record-acks', () => {
  const text = armCandidate();
  const ack = S.confirmCandidates({ at: T + 6 * MIN, readTail: tailOf(urec(T + 5 * MIN, text, HUMAN)) });
  assert.ok(ack);
  const f = S.readFlag();
  assert.equal(f.ackedAt, iso(T + 5 * MIN)); assert.equal(f.ack.signal, 'transcript-origin-human'); assert.equal(f.ack.session, 's1');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 31 * MIN }), null);
  assert.equal(S.isHoldActive(), false);
});

test('scheduled-wakeup-no-ack', () => {
  const text = armCandidate();
  const rec = urec(T + 5 * MIN, text, { isMeta: true, promptSource: 'system', turnOrigin: 'scheduled', wakeupSource: 'schedule_wakeup' });
  assert.equal(S.confirmCandidates({ at: T + 6 * MIN, readTail: tailOf(rec) }), null);
  assert.equal(S.readFlag().ackedAt, null);
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * MIN }), 'hold written at notifiedAt + 30 min');
});

for (const [name, over] of [['task-notification-no-ack', { origin: { kind: 'task-notification' } }], ['peer-message-no-ack', { origin: { kind: 'peer' }, isMeta: true }],
  ['no-origin-no-ack', { promptSource: 'sdk' }]]) {
  test(name, () => {
    const text = armCandidate();
    assert.equal(S.confirmCandidates({ at: T + 6 * MIN, readTail: tailOf(urec(T + 5 * MIN, text, over)) }), null);
    assert.equal(S.readFlag().ackedAt, null, 'no ack from a record that is not a typed prompt');
    assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * MIN }));
  });
}

test('not-shown-no-ack', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  assert.ok(S.noteShown('s1', T));
  assert.equal(S.noteCandidate({ sessionId: 's2', transcriptPath: 'fake', prompt: 'hello', at: T + 5 * MIN }), false, 's2 never saw the flag');
  assert.deepEqual(S.readFlag().candidates || [], []);
  assert.equal(S.confirmCandidates({ at: T + 6 * MIN, readTail: tailOf(urec(T + 5 * MIN, 'hello', HUMAN)) }), null);
  assert.equal(S.readFlag().ackedAt, null);
});

test('same-turn-not-ack', () => {
  S.openFlag({ version: '1', flags: flag, at: Date.now() });
  const first = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'first', origin: { kind: 'human' }, cwd: tmp });
  assert.match(first.stdout, /RELEASE WATCH/, 'the first typed prompt is the turn that shows the flag');
  assert.equal(S.readFlag().ackedAt, null, 'the prompt typed before the flag was shown does not answer it');
  assert.ok(S.readFlag().shownTo.s);
  const next = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'second', origin: { kind: 'human' }, cwd: tmp });
  assert.doesNotMatch(next.stdout, /RELEASE WATCH/);
  assert.ok(S.readFlag().ackedAt, 'the next typed prompt in that session answers it');
});

test('candidate-expires', () => {
  const text = armCandidate();
  assert.equal(S.confirmCandidates({ at: T + 16 * MIN, readTail: tailOf(urec(T + 5 * MIN, text, { isMeta: true })) }), null, 'past the 10 min TTL with no matching human record');
  assert.deepEqual(S.readFlag().candidates, []);
  const rej = S.readRows().filter((r) => r.event === 'ack-rejected');
  assert.equal(rej.length, 1); assert.equal(rej[0].session, 's1');
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * MIN }), 'the hold follows');
});

test('payload-origin', () => {
  S.openFlag({ version: '1', flags: flag, at: Date.now() });
  hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'one', cwd: tmp });
  assert.equal(S.readFlag().ackedAt, null);
  hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'two', origin: { kind: 'human' }, cwd: tmp });
  const f = S.readFlag();
  assert.ok(f.ackedAt, 'acked at once, no transcript read'); assert.equal(f.ack.signal, 'payload-origin-human');
});

test('clear-words-need-typed', () => {
  S.openFlag({ version: '1', flags: [{ name: 'z', value: 1 }], at: T });
  assert.ok(S.maybeHold({ holdMinutes: 1, at: T + HOUR }));
  assert.ok(S.noteShown('s1', T + HOUR)); // a session sees the hold line
  assert.equal(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'build is green', at: T + HOUR + MIN }), false, 'during a hold only the clear words are recorded');
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'clear hold', at: T + HOUR + 2 * MIN }));
  const sched = urec(T + HOUR + 2 * MIN, 'clear hold', { isMeta: true, promptSource: 'system', turnOrigin: 'scheduled' });
  assert.equal(S.confirmCandidates({ at: T + HOUR + 3 * MIN, readTail: tailOf(sched) }), null);
  assert.equal(S.isHoldActive(), true, 'the words in a scheduled record leave the hold on');
  const r = S.confirmCandidates({ at: T + HOUR + 4 * MIN, readTail: tailOf(urec(T + HOUR + 2 * MIN, 'clear hold', HUMAN)) });
  assert.ok(r && r.cleared);
  assert.equal(S.isHoldActive(), false, 'typed, the words lift it');
});

test('low-sample-inconclusive', () => {
  const m = metrics({ spawns: { since: 26, base: 700, perHour: { since: 2.6, base: 10 } }, telemetry: { 'denial:type-required/deny': t(1, 0, 3.8, 0) } });
  const e = W.evaluate(m);
  assert.equal(e.metrics.find((x) => x.name === 'spawn-rewrites').status, 'inconclusive');
  assert.notEqual(e.verdict, 'flag'); assert.equal(e.verdict, 'inconclusive'); assert.deepEqual(e.flags, []);
});

test('queue-denied-relative', () => {
  const q = (denied) => W.evaluate(metrics({ spawns: { since: 40, base: 700, perHour: { since: 4, base: 10 } }, telemetry: { 'gate:denied': t(denied, 42, denied * 2.5, 6) } })).metrics.find((x) => x.name === 'queue-denied');
  const ok = q(8);
  assert.equal(ok.value, 20); assert.equal(ok.limit, 20); assert.equal(ok.status, 'ok');
  assert.equal(q(9).status, 'flag');
});

test('refusals-split', () => {
  const b = (n, realFails, refusals) => ({ since: { n, realFails, realFailPct: +(100 * realFails / n).toFixed(1), refusals, refusalPer100: +(100 * refusals / n).toFixed(1) }, base: { n: 500, realFails: 20, realFailPct: 4, refusals: 0, refusalPer100: 0 } });
  const e = W.evaluate(metrics({ bash: b(355, 9, 20) }));
  const get = (x, name) => x.metrics.find((y) => y.name === name);
  assert.equal(get(e, 'worker-bash-fail').value, 2.5); assert.equal(get(e, 'worker-bash-fail').status, 'ok');
  assert.equal(get(e, 'harness-refusals').value, 5.6); assert.equal(get(e, 'harness-refusals').status, 'ok');
  const f = W.evaluate(metrics({ bash: b(200, 4, 25) }));
  assert.equal(get(f, 'harness-refusals').status, 'flag'); assert.equal(get(f, 'worker-bash-fail').status, 'ok');
  // a refusal-only flag never starts a hold
  const r = W.tick({ at: T + HOUR, installed: installed(), run: () => metrics({ bash: b(200, 4, 25) }), holdMinutes: 30 });
  assert.deepEqual(r.flagged, ['harness-refusals']); assert.equal(S.flagIsOpen(), true);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + HOUR + 31 * MIN }), null); assert.equal(S.isHoldActive(), false);
});

test('few-events-ok', () => {
  const sg = (n) => W.evaluate(metrics({ spawns: { since: 40, base: 700, perHour: { since: 4, base: 10 } }, telemetry: { 'struggle:x': t(n, 0, n * 2.5, 0) } })).metrics.find((x) => x.name === 'struggle');
  assert.equal(sg(2).status, 'ok', '5 per 100 is over the limit of 2, but 2 events are under the event floor of 3');
  assert.equal(sg(3).status, 'flag');
  const big = W.evaluate(metrics({ spawns: { since: 300, base: 700, perHour: { since: 30, base: 10 } }, telemetry: { 'struggle:x': t(2, 0, 0.7, 0) } }));
  assert.equal(big.metrics.find((x) => x.name === 'struggle').status, 'ok');
});

test('inconclusive-rolls', () => {
  const seen = []; let next = metrics();
  const run = (o) => { seen.push(o); return next; };
  const run1 = () => JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8')).releases[0];
  W.tick({ at: T + HOUR, installed: installed(), run, holdMinutes: 30 });
  W.tick({ at: T + 2 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(run1().lastConclusiveAt, T + 2 * HOUR);
  next = metrics({ spawns: { since: 2, base: 700, perHour: { since: 0.5, base: 10 } } });
  const r3 = W.tick({ at: T + 4 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(r3.verdict, 'inconclusive');
  assert.equal(run1().lastConclusiveAt, T + 2 * HOUR, 'an inconclusive check leaves it unchanged');
  next = metrics();
  W.tick({ at: T + 8 * HOUR, installed: installed(), run, holdMinutes: 30 });
  assert.equal(seen[3].winFrom, T + 2 * HOUR, 'check 4 measures from the last conclusive check');
  assert.equal(run1().lastConclusiveAt, T + 8 * HOUR);
  const rows = S.readRows().filter((r) => r.event === 'check');
  assert.deepEqual(rows.map((r) => r.verdict), ['clean', 'clean', 'inconclusive', 'clean']);
});

test('status-lines', () => {
  W.tick({ at: T + HOUR, installed: installed(), run: () => metrics({ telemetry: { 'gate:denied': t(25, 40, 25, 6) } }), holdMinutes: 30 });
  W.tick({ at: T + 2 * HOUR, installed: installed(), run: () => metrics({ spawns: { since: 2, base: 700, perHour: { since: 0.5, base: 10 } } }), holdMinutes: 30 });
  const out = W.status(T + 2 * HOUR + 1000);
  assert.match(out, /FLAG/); assert.match(out, /INCONCLUSIVE/);
  assert.match(out, /limit /); assert.match(out, /base /); assert.match(out, /n=\d+/); assert.match(out, /%\/h/);
  assert.match(out, /queue-denied/);
});

// ---- stage 2: chain of releases, finish and extension, flag migration, standing health ----
const none = () => null;
const instV = (version, at) => ({ plugins: { 'agent-companion@x': [{ version, lastUpdated: iso(at) }] } });
const runFile = () => JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8'));
const allRows = () => S.readRows();
const flagged = () => metrics({ telemetry: { 'gate:denied': t(25, 40, 25, 6) } });

test('migrate-v1: a run file from before v2 becomes a one-release chain and keeps its done checks', () => {
  const old = { version: '1.2.3', T, due: W.CHECK_HOURS.map((h) => T + h * HOUR), done: [0], lastAt: T + HOUR, lastConclusiveAt: T + HOUR, closed: false };
  writeFileSync(file('release-watch-run.json'), JSON.stringify(old));
  const m = W.migrateRun(old);
  assert.equal(m.v, 2); assert.equal(m.baseAnchor, T); assert.equal(m.status, 'watching'); assert.equal(m.releases.length, 1);
  assert.deepEqual(m.releases[0].done, [0]); assert.equal(m.releases[0].lastConclusiveAt, T + HOUR);
  assert.equal(W.migrateRun({ ...old, closed: true }).status, 'finished');
  assert.equal(W.migrateRun({ nope: 1 }), null);
  const r = W.tick({ at: T + 2 * HOUR + 1, installed: installed(), run: () => metrics(), standingRun: none });
  assert.deepEqual(r.checks, [2]);
  const s = runFile();
  assert.equal(s.v, 2); assert.deepEqual(s.releases[0].done, [0, 1]); assert.equal(s.baseAnchor, T);
});

test('chain-baseline-fixed: every check of a chain reads the same baseline, the 7 days before the FIRST install', () => {
  const seen = []; const run = (o) => { seen.push(o); return metrics(); };
  const T2 = T + 10 * HOUR;
  W.tick({ at: T + HOUR, installed: installed(), run, standingRun: none });
  W.tick({ at: T2 + HOUR, installed: installed(T2), run, standingRun: none });
  assert.equal(seen.length, 2);
  for (const o of seen) { assert.equal(o.baseTo, T); assert.equal(o.baseFrom, T - 7 * 24 * HOUR); }
  assert.equal(seen[1].T, T2, 'the analysis anchor is the newest release');
  assert.equal(seen[1].winFrom, T + HOUR, 'the window starts at the last conclusive check');
  assert.equal(runFile().baseAnchor, T);
});

test('chain-flag-survives-install: an open flag stays open when a newer release joins the chain', () => {
  const T2 = T + 10 * HOUR;
  W.tick({ at: T + HOUR, installed: installed(), run: flagged, standingRun: none });
  assert.equal(S.flagIsOpen(S.readFlag()), true);
  const r = W.tick({ at: T2 + HOUR, installed: installed(T2), run: () => metrics(), standingRun: none });
  assert.equal(r.verdict, 'clean');
  const f = S.readFlag();
  assert.equal(S.flagIsOpen(f), true, 'a clean check never closes a flag');
  assert.deepEqual(f.flags.map((x) => x.name), ['queue-denied']);
  assert.equal(Date.parse(f.T), T, 'the flag stays anchored on the chain start');
  assert.equal(runFile().releases.length, 2);
});

test('per-version-split: with two releases the analysis splits the since side by the release that produced each row', () => {
  const T2 = T + 3 * HOUR;
  const tdir = join(claude, 'agent-companion', 'telemetry'); mkdirSync(tdir, { recursive: true });
  const rows = [
    ...[1, 2, 3].map((i) => rowj({ at: T + 20 * MIN * i, guard_version: '1.0.0' })),
    ...[1, 2, 3, 4, 5].map((i) => rowj({ at: T2 + 20 * MIN * i, guard_version: '1.1.0' })),
    rowj({ at: T - 2 * HOUR }),
  ];
  writeFileSync(join(tdir, 'spawns.jsonl'), rows.join(''));
  const rel = [{ version: '1.0.0', T }, { version: '1.1.0', T: T2 }];
  const m = W.analyze({ T: T2, nowMs: T2 + 6 * HOUR, winFrom: T, baseFrom: T - 7 * 24 * HOUR, baseTo: T, releases: rel });
  assert.equal(m.spawns.since, 8); assert.equal(m.spawns.base, 1);
  assert.equal(m.byVersion['1.0.0'].spawns.since, 3); assert.equal(m.byVersion['1.1.0'].spawns.since, 5);
  assert.equal(m.byVersion['1.1.0'].spawns.base, 1, 'the baseline side is shared');
  assert.equal(W.analyze({ T, nowMs: T2 + 6 * HOUR, baseFrom: T - 7 * 24 * HOUR, baseTo: T }).byVersion, undefined, 'one release has no split');
  // through a tick the check row carries both versions
  W.tick({ at: T + HOUR, installed: instV('1.0.0', T), run: none, standingRun: none });
  W.tick({ at: T2 + 4 * HOUR, installed: instV('1.1.0', T2), standingRun: none });
  const row = allRows().filter((r) => r.event === 'check').pop();
  assert.deepEqual(Object.keys(row.byVersion).sort(), ['1.0.0', '1.1.0']);
  assert.deepEqual(row.releases.map((x) => x.version).sort(), ['1.0.0', '1.1.0']);
});

test('chain-finishes-together: every release of the chain finishes at once, with one finished row', () => {
  W.tick({ at: T + HOUR, installed: instV('1.0.0', T), run: () => rich(), standingRun: none });
  const T2 = T + 3 * HOUR;
  W.tick({ at: T + 28 * HOUR, installed: instV('1.1.0', T2), run: () => rich(), standingRun: none });
  const s = runFile();
  assert.equal(s.status, 'finished');
  assert.deepEqual(s.releases.map((r) => r.status), ['finished', 'finished']);
  assert.deepEqual(s.releases.map((r) => r.done.length), [8, 8]);
  const fin = allRows().filter((r) => r.event === 'finished');
  assert.equal(fin.length, 1); assert.deepEqual(fin[0].releases, ['1.0.0', '1.1.0']);
  assert.equal(fin[0].T, iso(T2), 'the finished row names the newest release');
  // a finished chain is quiet; a later install starts a new chain with its own baseline
  assert.equal(W.tick({ at: T + 29 * HOUR, installed: instV('1.1.0', T2), run: () => rich(), standingRun: none }).ran, false);
  const T3 = T + 40 * HOUR;
  W.tick({ at: T3 + HOUR, installed: instV('1.2.0', T3), run: () => rich(), standingRun: none });
  assert.equal(runFile().baseAnchor, T3); assert.equal(runFile().releases.length, 1);
});

test('finish-needs-activity: too little activity adds a check 4 h later, and 72 h after the install stops as insufficient-data with a flag that never holds', () => {
  // metrics() has 40 workers and 500 Bash calls since: under the finish floors (60 and 600).
  let r = W.tick({ at: T + 24 * HOUR, installed: installed(), run: () => metrics(), holdMinutes: 30, standingRun: none });
  assert.deepEqual(r.checks, [1, 2, 3, 4, 5, 6, 7, 8]);
  let s = runFile();
  assert.equal(s.status, 'watching'); assert.equal(s.extendedTo, T + 28 * HOUR); assert.equal(s.releases[0].due.length, 9);
  assert.equal(allRows().filter((x) => x.event === 'check').pop().extendedTo, iso(T + 28 * HOUR));
  assert.equal(S.flagIsOpen(S.readFlag()), false, 'a clean check with short activity opens nothing yet');
  // the extension is due at +28 h and not before
  assert.equal(W.tick({ at: T + 27 * HOUR, installed: installed(), run: () => metrics(), standingRun: none }).ran, false);
  r = W.tick({ at: T + 28 * HOUR, installed: installed(), run: () => metrics(), standingRun: none });
  assert.deepEqual(r.checks, [9]);
  s = runFile(); assert.equal(s.extendedTo, T + 32 * HOUR); assert.equal(s.status, 'watching');
  // a long silence: the next extension would pass the cap
  r = W.tick({ at: T + 72 * HOUR, installed: installed(), run: () => metrics(), holdMinutes: 30, standingRun: none });
  assert.equal(runFile().status, 'insufficient-data'); assert.equal(runFile().releases[0].status, 'insufficient-data');
  const rows = allRows();
  const ins = rows.find((x) => x.event === 'insufficient-data'); assert.ok(ins);
  assert.equal(ins.floors.workers, 60); assert.equal(ins.activity.workers, 40);
  const f = S.readFlag();
  assert.equal(S.flagIsOpen(f), true); assert.deepEqual(f.flags.map((x) => x.name), ['insufficient-data']);
  assert.match(f.flags[0].detail, /workers 40\/60 short/);
  assert.equal(r.held, false);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 72 * HOUR + 31 * MIN }), null); assert.equal(S.isHoldActive(), false);
  assert.equal(W.tick({ at: T + 80 * HOUR, installed: installed(), run: () => metrics(), standingRun: none }).ran, false, 'the chain has stopped');
  // enough activity at an extension finishes the chain instead
});

test('finish-needs-activity: activity that reaches the floors at an extension finishes the chain', () => {
  let m = metrics();
  W.tick({ at: T + 24 * HOUR, installed: installed(), run: () => m, standingRun: none });
  assert.equal(runFile().status, 'watching');
  m = rich();
  W.tick({ at: T + 28 * HOUR, installed: installed(), run: () => m, standingRun: none });
  assert.equal(runFile().status, 'finished');
  assert.equal(allRows().filter((x) => x.event === 'finished').length, 1);
});

// A standing-health stub: 2116 spawns and 127 queue denials in the week is 6.0 per 100, over the ceiling of 5.
const standingStub = (over = {}) => () => metrics({ spawns: { since: 2116, base: 8000, perHour: { since: 12.6, base: 7 } }, telemetry: { 'gate:denied': t(127, 400, 6, 5) }, activeDays: { since: 7, base: 28 }, ...over });
const standingRows = () => allRows().filter((x) => x.event === 'standing');

test('standing-ceiling: a metric over its fixed ceiling is a finding; it is only reported and never touches the flag, the hold or the chain', () => {
  const r = W.tick({ at: T, installed: {}, standingRun: standingStub() });
  assert.equal(r.standing, 'findings');
  const st = JSON.parse(readFileSync(file('release-watch-standing.json'), 'utf8'));
  const q = st.findings.find((x) => x.name === 'queue-denied');
  assert.ok(q); assert.equal(q.kind, 'ceiling'); assert.equal(q.value, 6); assert.equal(q.ceiling, 5);
  assert.equal(st.shownOn, null);
  assert.equal(standingRows().length, 1); assert.equal(standingRows()[0].findings[0].name, 'queue-denied');
  assert.equal(existsSync(file('release-watch-flag.json')), false, 'no flag');
  assert.equal(S.readFlag(), null); assert.equal(S.isHoldActive(), false); assert.equal(r.held, false);
  assert.equal(existsSync(file('release-watch-run.json')), false, 'no chain started');
  // with a flag and a hold already there they stay exactly as they were
  W.tick({ at: T + HOUR, installed: installed(), run: flagged, holdMinutes: 30, standingRun: none });
  const before = readFileSync(file('release-watch-flag.json'), 'utf8');
  const hb = S.maybeHold({ holdMinutes: 30, at: T + HOUR + 31 * MIN }); assert.ok(hb);
  const holdBefore = existsSync(file('release-watch-hold.json')) ? readFileSync(file('release-watch-hold.json'), 'utf8') : null;
  const st2 = W.standing({ at: T + 3 * 24 * HOUR, run: standingStub() });
  assert.equal(st2.verdict, 'findings');
  assert.equal(readFileSync(file('release-watch-flag.json'), 'utf8'), before);
  if (holdBefore) assert.equal(readFileSync(file('release-watch-hold.json'), 'utf8'), holdBefore);
  assert.equal(S.isHoldActive(), true);
});

test('standing-trend-short-history: a trend is judged only with 14 active days of history; a ceiling is judged regardless', () => {
  const b = (since, base) => ({ since: { n: 1500, realFails: since, realFailPct: +(100 * since / 1500).toFixed(1), refusals: 0, refusalPer100: 0 }, base: { n: 1500, realFails: base, realFailPct: +(100 * base / 1500).toFixed(1), refusals: 0, refusalPer100: 0 } });
  // worker-bash-fail 4% against 2% before: over 1.5x, under the ceiling of 5, 60 and 30 events
  const short = W.standing({ at: T, run: () => metrics({ bash: b(60, 30), activeDays: { since: 7, base: 5 } }) });
  assert.equal(short.verdict, 'inconclusive'); assert.equal(short.trend, 'inconclusive (history short)'); assert.deepEqual(short.findings, []);
  const none14 = W.standing({ at: T + HOUR, run: () => metrics({ bash: b(60, 30) }) });
  assert.equal(none14.verdict, 'inconclusive', 'no history information at all counts as short');
  const long = W.standing({ at: T + 2 * HOUR, run: () => metrics({ bash: b(60, 30), activeDays: { since: 7, base: 20 } }) });
  assert.equal(long.verdict, 'findings'); assert.equal(long.trend, 'judged');
  const f = long.findings.find((x) => x.name === 'worker-bash-fail');
  assert.ok(f); assert.equal(f.kind, 'trend'); assert.equal(f.value, 4); assert.equal(f.prior, 2);
  const quiet = W.standing({ at: T + 3 * HOUR, run: () => metrics({ bash: b(60, 50), activeDays: { since: 7, base: 20 } }) });
  assert.equal(quiet.verdict, 'ok'); assert.deepEqual(quiet.findings, []);
  const few = W.standing({ at: T + 4 * HOUR, run: () => metrics({ bash: b(60, 10), activeDays: { since: 7, base: 20 } }) });
  assert.equal(few.verdict, 'ok', 'a prior side under 20 events is no trend');
  // a ceiling still shows on a short history
  const ceil = W.standing({ at: T + 5 * HOUR, run: standingStub({ activeDays: { since: 7, base: 3 } }) });
  assert.equal(ceil.verdict, 'findings'); assert.equal(ceil.trend, 'inconclusive (history short)');
});

test('standing-daily: one standing check per day; the same day writes no second row, the next day does', () => {
  let calls = 0; const sr = () => { calls++; return metrics({ activeDays: { since: 7, base: 20 } }); };
  W.tick({ at: T, installed: {}, standingRun: sr });
  assert.equal(calls, 1); assert.equal(standingRows().length, 1);
  W.tick({ at: T + 2 * HOUR, installed: {}, standingRun: sr });
  assert.equal(calls, 1); assert.equal(standingRows().length, 1, 'same day: no second row');
  W.tick({ at: T + 25 * HOUR, installed: {}, standingRun: sr });
  assert.equal(calls, 2); assert.equal(standingRows().length, 2, 'next day: a new row');
  // the same rule holds with a chain running, and the run file remembers when
  W.tick({ at: T + 26 * HOUR, installed: installed(T + 26 * HOUR), run: none, standingRun: sr });
  W.tick({ at: T + 27 * HOUR, installed: installed(T + 26 * HOUR), run: none, standingRun: sr });
  assert.equal(calls, 2);
  assert.equal(W.standingDue(runFile(), T + 25 * HOUR + 23 * HOUR), false);
  assert.equal(W.standingDue(runFile(), T + 25 * HOUR + 25 * HOUR), true);
});

// A flag written by hand the way a pre-v2 build wrote it (no `v`).
const legacyFlag = (over = {}) => ({ version: '1.2.3', T: iso(T), check: '+1h', flags: [{ name: 'queue-denied', value: 20, n: 40, level: 3, detail: 'x' }], openedAt: iso(T + HOUR), notifiedAt: iso(T + HOUR), ackedAt: null, shownTo: {}, candidates: [], ack: null, clearedAt: null, cooldown: {}, ...over });
const putFlag = (f) => writeFileSync(file('release-watch-flag.json'), JSON.stringify(f));

test('legacy-flag-superseded: a pre-v2 flag whose sample is under the v2 floor is closed, the ack stays and nothing restarts', () => {
  const ackedAt = iso(T + 2 * HOUR);
  putFlag(legacyFlag({ flags: [{ name: 'queue-denied', value: 20, n: 10, detail: 'x' }, { name: 'hook-error-share', value: 60, n: 8 }], ackedAt }));
  const r = W.tick({ at: T + 3 * HOUR, installed: {}, standingRun: none });
  assert.deepEqual(r.migrated, { superseded: true });
  const f = S.readFlag();
  assert.equal(f.v, 2); assert.equal(f.clearedBy, 'v2-migration'); assert.equal(f.clearedAt, iso(T + 3 * HOUR));
  assert.match(f.supersededReason, /superseded by v2 evidence rules/);
  assert.equal(f.ackedAt, ackedAt, 'the ack is kept'); assert.equal(f.notifiedAt, iso(T + HOUR), 'the countdown is not restarted');
  assert.equal(S.flagIsOpen(f), false);
  const row = allRows().find((x) => x.event === 'flag-superseded');
  assert.ok(row); assert.equal(row.ackKept, true); assert.deepEqual(row.flags, ['queue-denied', 'hook-error-share']);
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR }), null, 'a closed flag starts no hold');
  // the migration runs once
  assert.equal(W.tick({ at: T + 4 * HOUR, installed: {}, standingRun: none }).migrated, undefined);
  assert.equal(allRows().filter((x) => x.event === 'flag-superseded').length, 1);
});

test('legacy-flag-superseded: an item of unknown size or of a name in no class is kept', () => {
  putFlag(legacyFlag({ flags: [{ name: 'queue-denied', value: 20, n: 10 }, { name: 'mystery', value: 1 }] }));
  const r = W.migrateFlag({ at: T + 3 * HOUR });
  assert.deepEqual(r.kept, ['mystery']);
  assert.deepEqual(S.readFlag().flags.map((x) => x.name), ['mystery']);
  putFlag(legacyFlag({ flags: [{ name: 'queue-denied', value: 20 }] }));
  assert.deepEqual(W.migrateFlag({ at: T + 3 * HOUR }).kept, ['queue-denied'], 'unknown n: kept');
});

test('legacy-flag-still-flags-revoked: a flag still over the v2 floor keeps its items, and an ack without a typed record is revoked with the countdown restarted', () => {
  putFlag(legacyFlag({ ackedAt: iso(T + 2 * HOUR), shownTo: { s1: iso(T + HOUR) }, candidates: [{ x: 1 }] }));
  const at = T + 3 * HOUR;
  const r = W.tick({ at, installed: {}, standingRun: none });
  assert.deepEqual(r.migrated, { kept: ['queue-denied'], revoked: true });
  const f = S.readFlag();
  assert.equal(f.v, 2); assert.equal(S.flagIsOpen(f), true);
  assert.equal(f.ackedAt, null); assert.equal(f.ack, null); assert.equal(f.notifiedAt, iso(at)); assert.deepEqual(f.candidates, []);
  const row = allRows().find((x) => x.event === 'ack-revoked'); assert.ok(row);
  assert.match(S.flagLine() || '', /queue-denied/, 'the flag is shown again');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: at + 10 * MIN }), null, 'the countdown restarted from the migration');
  assert.ok(S.maybeHold({ holdMinutes: 30, at: at + 31 * MIN }), 'and a hold follows if still unanswered');
});

test('legacy-ack-revoked: an ack written by a build without human records is revoked; an unacked flag only gets the v2 marker', () => {
  putFlag(legacyFlag());
  assert.deepEqual(W.migrateFlag({ at: T + 3 * HOUR }), { kept: ['queue-denied'] });
  const f = S.readFlag();
  assert.equal(f.v, 2); assert.equal(f.notifiedAt, iso(T + HOUR), 'no ack to revoke: countdown untouched');
  assert.equal(allRows().filter((x) => x.event === 'ack-revoked').length, 0);
  assert.equal(W.migrateFlag({ at: T + 4 * HOUR }), null, 'a v2 flag is never migrated again');
});

test('legacy-ack-kept: a legacy ack with a typed record at its time stays, as an ack object naming the session', () => {
  const ackedAt = T + 2 * HOUR;
  putFlag(legacyFlag({ ackedAt: iso(ackedAt), shownTo: { sess1: iso(T + HOUR) } }));
  const projects = join(tmp, 'projects'); mkdirSync(join(projects, 'p'), { recursive: true });
  writeFileSync(join(projects, 'p', 'sess1.jsonl'), [urec(T, 'old'), humanRec(ackedAt + 500, 'looks fine')].join('\n') + '\n');
  const r = W.migrateFlag({ at: T + 3 * HOUR, projectsDir: projects });
  assert.deepEqual(r, { kept: ['queue-denied'] });
  const f = S.readFlag();
  assert.equal(f.ackedAt, iso(ackedAt)); assert.equal(f.notifiedAt, iso(T + HOUR));
  assert.equal(f.ack.session, 'sess1'); assert.equal(f.ack.signal, 'transcript-origin-human'); assert.equal(f.ack.shownAt, iso(T + HOUR));
  assert.equal(allRows().filter((x) => x.event === 'ack-revoked').length, 0);
  assert.equal(S.flagLine(), null, 'answered: silent');
  // a typed record far from the ack time does not count
  putFlag(legacyFlag({ ackedAt: iso(ackedAt + 10 * MIN) }));
  assert.equal(W.migrateFlag({ at: T + 3 * HOUR, projectsDir: projects }).revoked, true);
});

test('cleanup', () => { rmSync(tmp, { recursive: true, force: true }); });
void tel;
