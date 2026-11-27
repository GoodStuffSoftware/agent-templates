import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import './isolate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'release-watch.mjs');
const HOUR = 3600e3;
const T = Date.parse('2026-03-01T10:00:00Z');
process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE = 'all'; // these tests cover the all-calls hold (0.31.75: the default scope is releases)

let tmp; let state; let claude;
const env = () => ({ ...process.env, AGENT_COMPANION_DESKTOP_SESSIONS_DIR: join(tmp, 'desk'), CLAUDE_CONFIG_DIR: claude, AGENT_COMPANION_STATE_DIR: state, AGENT_COMPANION_FAKE_NOW: '', CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MINUTES: '', CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE: 'all' });
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rw-'));
  state = join(tmp, 'ac'); claude = join(tmp, 'claude');
  mkdirSync(join(state, 'state'), { recursive: true }); mkdirSync(join(claude, 'plugins'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claude; process.env.AGENT_COMPANION_STATE_DIR = state; process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR = join(tmp, 'desk'); delete process.env.AGENT_COMPANION_FAKE_NOW;
});

const W = await import('../scripts/release-watch.mjs');
const S = await import('../hooks/lib/release-watch-state.mjs');
const installed = (t = T) => ({ plugins: { 'agent-companion@x': [{ version: '1.2.3', lastUpdated: new Date(t).toISOString() }] } });
const file = (n) => join(state, 'state', n);
const flag = [{ name: 'queue-clears', value: 3.6, detail: 'x' }];
const iso = (t) => new Date(t).toISOString();
// A reply the way the hook records it: the flag was shown to the session, then a typed prompt (origin human in the transcript) is confirmed.
const humanRec = (at, prompt) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: iso(at), message: { content: prompt } });
const humanAck = (at, { session = 's1', prompt = 'ack' } = {}) => {
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
  W.tick({ at: T2 + HOUR, installed: installed(T2), run: () => null });
  const s = JSON.parse(readFileSync(file('release-watch-run.json'), 'utf8'));
  assert.equal(s.baseAnchor, T); assert.equal(s.releases.length, 2); assert.equal(s.releases[1].T, T2); assert.deepEqual(s.releases[1].done, [0], "the new release first +1h check ran, one hour after its install");
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
  const m = metrics(); m.workers.since = { ...m.workers.since, over150kPct: 8, noStatusPct: 20, partialPct: 40, blockedPct: 15, hookErrorWorkersPct: 60, apiErrorWorkers: 3, apiNonUsageWorkers: 2, unitsPerWorker: { mean: 2, p50: 1, p90: 4 } };
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

// ---- 0.31.65 standing metrics ----
function worker(proj, id, { atype, finished = true, text, handback, extra = [], brief = 'Do the invented task.', refusals = 0, bash = 0, at = T + HOUR } = {}) {
  const sd = join(claude, 'projects', proj, 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  const ts = new Date(at).toISOString();
  const a = (content) => ({ type: 'assistant', timestamp: ts, requestId: id + content.length + Math.random(), message: { model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 5 }, content } });
  const L = [{ type: 'user', timestamp: ts, message: { role: 'user', content: brief } }];
  for (let i = 0; i < bash; i++) {
    L.push(a([{ type: 'tool_use', id: `${id}-b${i}`, name: 'Bash', input: { command: 'x' } }]));
    if (i < refusals) L.push({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-b${i}`, is_error: true, content: 'This agent is isolated in the worktree W, but this command is too complex to verify' }] } });
  }
  if (text) L.push(a([{ type: 'text', text }]));
  if (handback) L.push(a([{ type: 'tool_use', id: id + '-hb', name: 'SubagentHandback', input: { message: handback } }]));
  L.push(...extra.map((t) => a([{ type: 'text', text: t }])));
  const fp = join(sd, `agent-${id}.jsonl`);
  writeFileSync(fp, L.map((l) => JSON.stringify(l)).join('\n'));
  writeFileSync(fp.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: atype || 'agent-companion:ac-sonnet-low', finished }));
  return fp;
}
const wk = (m) => m.workers.since;

test('standing-metrics: STATUS is read from the SubagentHandback call and from earlier in the transcript', () => {
  worker('C--pa', 'hb1', { handback: 'STATUS: partial\nBLOCKERS: none' });
  worker('C--pa', 'hb2', { handback: 'no status here' });
  worker('C--pa', 'wake', { text: 'STATUS: blocked\nneeds a credential', extra: ['The monitor expired; the report above stands.'] });
  worker('C--pa', 'plain', { text: 'STATUS: done' });
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(wk(m).finished, 4);
  assert.equal(wk(m).noStatusPct, 25, 'only the handback without a STATUS line');
  assert.equal(wk(m).partialPct, 25); assert.equal(wk(m).blockedPct, 25);
});

test('standing-metrics: off-contract types and hook-verification probes are left out of status and Bash metrics and named', () => {
  worker('C--pb', 'ok', { text: 'STATUS: done', bash: 10, refusals: 1 });
  worker('C--pb', 'ex1', { atype: 'Explore', text: 'findings only', bash: 10, refusals: 5 });
  worker('C--pb', 'ex2', { atype: 'web-fetch', text: 'page text' });
  worker('C--pb', 'pr1', { brief: 'TYPE: x\n\nHook verification spawn, not real work: reply FOUND: no', text: 'FOUND: no', bash: 10, refusals: 5 });
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(wk(m).n, 4); assert.equal(wk(m).finished, 1); assert.equal(wk(m).noStatusPct, 0);
  assert.deepEqual(wk(m).excluded, { probes: 1, byType: { Explore: 1, 'web-fetch': 1 } });
  assert.equal(m.bash.since.n, 10); assert.equal(m.bash.since.refusals, 1); assert.equal(m.bash.since.refusalPer100, 10);
});

test('standing-metrics: files are chosen by mtime inside the window, every project represented; the cap drops the oldest', () => {
  const a = worker('C--aaa', 'old', { text: 'STATUS: done' });
  const b = worker('C--zzz', 'mid', { text: 'STATUS: done' });
  const c = worker('C--zzz', 'new', { text: 'STATUS: done' });
  const t = (s) => new Date(Date.now() - s * 1000);
  utimesSync(a, t(300), t(300)); utimesSync(b, t(200), t(200)); utimesSync(c, t(100), t(100));
  assert.equal(wk(W.analyze({ T, nowMs: T + 3 * HOUR })).n, 3, 'default cap covers a busy week');
  assert.equal(wk(W.analyze({ T, nowMs: T + 3 * HOUR, scanCap: 2 })).n, 2, 'a safety cap keeps the newest two, not alphabetical order');
  assert.ok(W.WORKER_SCAN_CAP >= 6000);
});

test('standing-metrics: blocked-share needs 5 blocked workers before it can flag', () => {
  const mk = (blockedPct, finished) => { const m = metrics(); m.workers.since = { ...m.workers.since, finished, blockedPct }; return names(m).includes('blocked-share'); };
  assert.equal(W.TH.blockedMinEv, 5);
  assert.equal(mk(8, 39), false, '3 blocked of 39 stays quiet');
  assert.equal(mk(10, 40), false, '4 blocked of 40 stays quiet');
  assert.equal(mk(12.5, 40), true, '5 blocked of 40 flags');
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
  assert.equal(S.readFlag().notifiedAt, null, 'the tick never marks the flag as notified');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR }), null, 'never shown: no countdown, so no hold');
  assert.ok(S.noteShown('s1', T)); // a session shows the flag: the countdown starts here
  assert.equal(S.readFlag().notifiedAt, iso(T));
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
  S.noteShown('s2', T + 7 * HOUR);
  S.maybeHold({ holdMinutes: 30, at: T + 8 * HOUR });
  assert.equal(S.isHoldActive(), true);
  assert.equal(humanAck(T + 9 * HOUR), null);
  assert.equal(S.isHoldActive(), true);
});

test('clear lifts the hold, logs a row, and the cooldown suppresses the same flag unless it worsens', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  S.noteShown('s1', T);
  S.maybeHold({ holdMinutes: 30, at: T + HOUR });
  const r = S.clear({ by: 'test', at: T + 2 * HOUR });
  assert.deepEqual(r, { flagCleared: true, holdCleared: true, heldSessions: [] });
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
  S.noteShown('s1', T);
  S.maybeHold({ holdMinutes: 1, at: T + HOUR });
  assert.match(S.flagLine(), /RELEASE HOLD/);
});

test('flag line during a hold names flags raised later, and is unchanged without any', () => {
  S.openFlag({ version: '1', flags: [{ name: 'z', value: 1 }], at: T });
  S.noteShown('s1', T);
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
  const after = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'ack', origin: { kind: 'human' }, cwd: tmp });
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

// ---- 0.31.65 flag delivery: the countdown starts at the first showing, and the flag line has its own hook process ----
const R = await import('../hooks/lib/runaway.mjs');
const hookAt = (args, payload, at) => spawnSync(process.execPath, [join(ROOT, 'hooks', 'runaway-notice.mjs'), ...args], {
  input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: tmp, ...payload }),
  env: { ...env(), AC_ATTENDED: '1', ...(at ? { AGENT_COMPANION_FAKE_NOW: String(at) } : {}) }, encoding: 'utf8', windowsHide: true, cwd: tmp,
});
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } };

test('delivery timeline: the tick writes the flag, the lead is idle for 2 h, the first prompt shows it and the 30 min countdown starts there', () => {
  S.openFlag({ version: '7.7.7', flags: flag, at: T, check: '+1h' });
  assert.equal(S.readFlag().notifiedAt, null, 'the tick does not count as a notification');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 31 * 60e3 }), null, 'nobody saw it: no hold 31 min after the tick');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 2 * HOUR - 1 }), null, 'still unseen 2 h on: still no hold');
  const r = hookAt(['--watch'], { session_id: 'lead-idle', prompt: 'back again' }, T + 2 * HOUR);
  const line = ctxOf(r);
  assert.match(line, /RELEASE WATCH 7\.7\.7/); assert.match(line, /Hold countdown: 30 min left/);
  const f = S.readFlag();
  assert.equal(f.notifiedAt, iso(T + 2 * HOUR), 'the countdown starts at the showing, not at the tick');
  assert.equal(f.shownTo['lead-idle'], iso(T + 2 * HOUR)); assert.equal(f.ackedAt, null, 'showing is not an answer');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 2 * HOUR + 29 * 60e3 }), null);
  assert.equal(S.isHoldActive(), false);
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 2 * HOUR + 31 * 60e3 }), 'held 30 min after the showing');
  assert.equal(S.isHoldActive(), true);
});

test('delivery: a later prompt of the same session shows the shrinking countdown without moving the start; showing never acks; a worse flag restarts it', () => {
  S.openFlag({ version: '7.7.7', flags: [{ name: 'queue-clears', value: 3, level: 3, detail: 'x' }], at: T });
  hookAt(['--watch'], { session_id: 'lead-a', prompt: 'one' }, T + HOUR);
  const later = ctxOf(hookAt(['--watch'], { session_id: 'lead-a', prompt: 'ack' }, T + HOUR + 10 * 60e3));
  assert.match(later, /Hold countdown: 20 min left/);
  assert.equal(S.readFlag().notifiedAt, iso(T + HOUR)); assert.equal(S.readFlag().ackedAt, null);
  // a flag that is new, or has more than doubled, is a new notification: unseen again until a session shows it
  S.openFlag({ version: '7.7.7', flags: [{ name: 'another-flag', value: 2, level: 2 }], at: T + 2 * HOUR });
  assert.equal(S.readFlag().notifiedAt, null, 'renotify clears the first-showing time');
  assert.deepEqual(S.readFlag().shownTo, {});
  assert.equal(S.maybeHold({ holdMinutes: 30, at: T + 5 * HOUR }), null);
  assert.match(ctxOf(hookAt(['--watch'], { session_id: 'lead-a', prompt: 'three' }, T + 3 * HOUR)), /Hold countdown: 30 min left/);
});

test('hook modes: --watch prints the flag line and leaves queued notices alone; --no-watch drains notices and prints no flag line', () => {
  S.openFlag({ version: '7.7.7', flags: flag, at: T });
  assert.ok(R.queueNotice('lead-m', 'invented queued notice'));
  const w = ctxOf(hookAt(['--watch'], { session_id: 'lead-m', prompt: 'p1' }, T + HOUR));
  assert.match(w, /RELEASE WATCH 7\.7\.7/); assert.doesNotMatch(w, /invented queued notice/);
  const nw = ctxOf(hookAt(['--no-watch'], { session_id: 'lead-m', prompt: 'p2' }, T + HOUR));
  assert.match(nw, /invented queued notice/); assert.doesNotMatch(nw, /RELEASE WATCH/);
  assert.equal(ctxOf(hookAt(['--no-watch'], { session_id: 'lead-m', prompt: 'p3' }, T + HOUR)), '', 'drained once');
  const both = ctxOf(hookAt([], { session_id: 'lead-m', prompt: 'p4' }, T + HOUR));
  assert.match(both, /RELEASE WATCH 7\.7\.7/, 'no argument still runs the release watch');
  // --no-watch never shows the flag, so it never starts the countdown
  S.clear({ at: T + 2 * HOUR });
  S.openFlag({ version: '7.7.7', flags: [{ name: 'fresh-one', value: 5 }], at: T + 3 * HOUR });
  hookAt(['--no-watch'], { session_id: 'lead-n', prompt: 'p5' }, T + 4 * HOUR);
  assert.equal(S.readFlag().notifiedAt, null);
});

test('hooks.json: UserPromptSubmit registers runaway-notice twice, --no-watch (10 s) and --watch (5 s); PostToolUse stays on the plain form', () => {
  const h = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const reg = (ev) => (h[ev] || []).flatMap((g) => g.hooks.map((x) => ({ ...x, matcher: g.matcher }))).filter((x) => (x.args || []).some((a) => a.endsWith('runaway-notice.mjs')));
  const ups = reg('UserPromptSubmit');
  assert.equal(ups.length, 2);
  const nw = ups.find((x) => x.args.includes('--no-watch')); const w = ups.find((x) => x.args.includes('--watch'));
  assert.ok(nw && w); assert.equal(nw.timeout, 10); assert.equal(w.timeout, 5);
  const post = reg('PostToolUse');
  assert.equal(post.length, 1); assert.deepEqual(post[0].args.filter((a) => a.startsWith('--')), []);
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
  assert.equal(S.readFlag().notifiedAt, null, 'not shown yet');
  S.noteShown('s1', T);
  const n0 = S.readFlag().notifiedAt;
  assert.equal(n0, iso(T), 'the first showing starts the countdown');
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
// Routine data for the inconclusive-heavy replay (5 spawns/h, small workers: most windows stay under the evidence floors).
// The demo-guard denial rate is 1 per 12 h, the same as its baseline (20 in 7 days over 1176 spawns = 1.7 per 100 spawns). It was first 1 per 2 h
// (`upTo / HOUR / 2`): 10 per 100 spawns at 5 spawns/h, about 5.9x the 1.70 per 100 baseline. v1 passed that only because its windows were per check
// and never reached 10 events; v2 rolls the window until a check is conclusive, so it legitimately flags a 6x rate. The rate was lowered to
// the baseline rate on purpose, not to hide a v2 flag. A rate at the baseline is replayed conclusively in the 12-spawns-per-hour test below.
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
  assert.equal(W.tick({ at: T + 8 * HOUR + 31 * 60e3, installed: installed(), holdMinutes: 30 }).held, false, 'no session has shown the flag: no countdown, no hold');
  assert.ok(S.noteShown('s1', T + 9 * HOUR)); // a session shows the flag one hour after the tick
  assert.equal(W.tick({ at: T + 9 * HOUR + 29 * 60e3, installed: installed(), holdMinutes: 30 }).held, false, 'the countdown runs from the showing');
  assert.equal(W.tick({ at: T + 9 * HOUR + 31 * 60e3, installed: installed(), holdMinutes: 30 }).held, true);
  assert.equal(S.isHoldActive(), true);
});

// A routine week with enough activity to be conclusive: 12 spawns/h, 6 workers/h each running 15 Bash calls (none fail), denials at the baseline rate (1 per 5 h).
let bseq = 0;
function putBashWorkers(from, to, everyMs, bashPer = 15) {
  const sd = join(claude, 'projects', 'C--proj', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  for (let at = from; at < to; at += everyMs) {
    const n = bseq++;
    const calls = Array.from({ length: bashPer }, (_, i) => ({ type: 'tool_use', id: `tu${n}-${i}`, name: 'Bash', input: { command: 'true' } }));
    writeFileSync(join(sd, `agent-b${n}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: iso(at), requestId: `rb${n}`, message: { model: 'claude-sonnet', usage: { input_tokens: 40000, output_tokens: 2000 }, content: [...calls, { type: 'text', text: 'STATUS: done' }] } }) + '\n');
  }
}
function seedConclusive(upTo) {
  putBashWorkers(T - 7 * DAY, T, HOUR / 6); putBashWorkers(T, T + upTo, HOUR / 6);
  putRows('spawns.jsonl', [...spread(12 * 168, T - 7 * DAY, T, (at) => ({ at })), ...spread(12 * upTo / HOUR, T, T + upTo, (at) => ({ at }))]);
  putRows('denials.jsonl', [...spread(Math.round(168 / 5), T - 7 * DAY, T, (at) => ({ at, guard: 'demo-guard', outcome: 'deny' })), ...spread(Math.round(upTo / HOUR / 5), T, T + upTo, (at) => ({ at, guard: 'demo-guard', outcome: 'deny' }))]);
}

test('replay: a routine week at 12 spawns per hour is conclusive from +4h, flags nothing, never holds and finishes by +24h', () => {
  seedConclusive(24 * HOUR);
  const verdicts = {};
  for (const h of CHECKS) {
    const r = W.tick({ at: T + h * HOUR, installed: installed(), holdMinutes: 30, standingRun: none });
    verdicts[h] = r.verdict;
    assert.deepEqual(r.flagged, [], `+${h}h flags: ${r.flagged}`);
    assert.equal(r.held, false);
    assert.equal(W.tick({ at: T + h * HOUR + 31 * 60e3, installed: installed(), holdMinutes: 30, standingRun: none }).held, false);
  }
  assert.equal(verdicts[1], 'inconclusive'); assert.equal(verdicts[2], 'inconclusive');
  for (const h of [4, 8, 12, 16, 20, 24]) assert.equal(verdicts[h], 'clean', `+${h}h: ${verdicts[h]}`);
  assert.equal(S.isHoldActive(), false); assert.equal(S.flagIsOpen(), false);
  assert.equal(runFile().status, 'finished'); assert.equal(runFile().everFlagged, false);
  assert.equal(allRows().filter((x) => x.event === 'finished').length, 1);
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
  S.noteShown('s1', T + 5 * HOUR);
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
  const next = hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'ack', origin: { kind: 'human' }, cwd: tmp });
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
  hook('runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'ack', origin: { kind: 'human' }, cwd: tmp });
  const f = S.readFlag();
  assert.ok(f.ackedAt, 'acked at once, no transcript read'); assert.equal(f.ack.signal, 'payload-origin-human');
});

test('clear-words-need-typed', () => {
  S.openFlag({ version: '1', flags: [{ name: 'z', value: 1 }], at: T });
  assert.ok(S.noteShown('s1', T)); // a session sees the flag: the countdown starts
  assert.ok(S.maybeHold({ holdMinutes: 1, at: T + HOUR }));
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

test('status-lines: a v1 check row (metrics is the old analysis object) prints without throwing', () => {
  const old = { version: '1.2.3', T, due: W.CHECK_HOURS.map((h) => T + h * HOUR), done: [0], lastAt: T + HOUR, lastConclusiveAt: T + HOUR, closed: false };
  writeFileSync(file('release-watch-run.json'), JSON.stringify(old));
  S.appendRow({ at: iso(T + HOUR), event: 'check', T: iso(T), version: '1.2.3', check: 1, flags: [], metrics: { spawns: { since: 26, base: 2116 } } });
  const out = W.status(T + 2 * HOUR);
  assert.match(out, /release 1\.2\.3/); assert.match(out, /no open flag/);
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

test('chain baseline (0.31.76): each check reads the 7 days before the NEWEST release was installed; the chain key stays the first install', () => {
  const seen = []; const run = (o) => { seen.push(o); return metrics(); };
  const T2 = T + 10 * HOUR;
  W.tick({ at: T + HOUR, installed: installed(), run, standingRun: none });
  W.tick({ at: T2 + HOUR, installed: installed(T2), run, standingRun: none });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].baseTo, T); assert.equal(seen[0].baseFrom, T - 7 * 24 * HOUR);
  assert.equal(seen[1].baseTo, T2, "the second release is compared with the week before its own install"); assert.equal(seen[1].baseFrom, T2 - 7 * 24 * HOUR);
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

test('finish-clean-after-ack: an answered flag is cleared by the next conclusive clean check and the chain finishes', () => {
  W.tick({ at: T + HOUR, installed: installed(), run: flagged, standingRun: none });
  assert.equal(S.flagIsOpen(S.readFlag()), true);
  assert.ok(humanAck(T + HOUR + MIN), 'the operator answered the flag');
  assert.equal(S.flagIsOpen(S.readFlag()), true, 'answered, not yet cleared');
  const r = W.tick({ at: T + 2 * HOUR + 1, installed: installed(), run: () => rich(), standingRun: none });
  assert.equal(r.verdict, 'clean'); assert.equal(r.flagCleared, true);
  let f = S.readFlag();
  assert.equal(S.flagIsOpen(f), false);
  assert.equal(f.clearedAt, iso(T + 2 * HOUR + 1)); assert.equal(f.clearedBy, 'v2-watch'); assert.equal(f.clearedReason, 'clean after ack');
  const row = allRows().find((x) => x.event === 'flag-cleared');
  assert.ok(row); assert.equal(row.reason, 'clean after ack'); assert.deepEqual(row.flags, ['queue-denied']);
  W.tick({ at: T + 24 * HOUR, installed: installed(), run: () => rich(), standingRun: none });
  assert.equal(runFile().status, 'finished', 'no open flag is left to block the finish');
  assert.equal(runFile().everFlagged, true);
  assert.equal(allRows().filter((x) => x.event === 'flag-cleared').length, 1);
  assert.equal(allRows().filter((x) => x.event === 'finished').length, 1);
  f = S.readFlag(); assert.equal(f.clearedReason, 'clean after ack');
});

test('finish-clean-after-ack: a clean check never clears a flag nobody answered', () => {
  W.tick({ at: T + HOUR, installed: installed(), run: flagged, standingRun: none });
  const r = W.tick({ at: T + 2 * HOUR + 1, installed: installed(), run: () => rich(), standingRun: none });
  assert.equal(r.verdict, 'clean'); assert.equal(r.flagCleared, undefined);
  assert.equal(S.flagIsOpen(S.readFlag()), true); assert.equal(allRows().filter((x) => x.event === 'flag-cleared').length, 0);
});

test('finish-open-flag-at-cap: an unanswered open flag blocks the finish to the 72 h cap, and the closing text blames the flag, not the floors', () => {
  W.tick({ at: T + HOUR, installed: installed(), run: flagged, standingRun: none });
  assert.equal(S.readFlag().ackedAt, null);
  // the activity floors are reached (rich), the verdict is clean, but the flag is unanswered
  W.tick({ at: T + 24 * HOUR, installed: installed(), run: () => rich(), standingRun: none });
  assert.equal(runFile().status, 'watching'); assert.equal(runFile().extendedTo, T + 28 * HOUR);
  W.tick({ at: T + 72 * HOUR, installed: installed(), run: () => rich(), standingRun: none });
  const s = runFile();
  assert.equal(s.status, 'insufficient-data'); assert.equal(s.insufficientBecause, 'open-flag');
  const ins = allRows().find((x) => x.event === 'insufficient-data'); assert.ok(ins);
  assert.ok(ins.activity.workers >= ins.floors.workers, 'the floors were reached');
  const f = S.readFlag();
  assert.equal(S.flagIsOpen(f), true); assert.deepEqual(f.flags.map((x) => x.name), ['queue-denied'], 'the original flag is the open one, no second insufficient-data flag');
  const text = W.status(T + 73 * HOUR);
  assert.doesNotMatch(text, /floors were not reached/);
  assert.match(text, /unanswered flag was still open at the cap/);
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
  S.noteShown('s1', T + HOUR); // a session shows the flag; the countdown starts there
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

// A flag written by hand the way a v1 build wrote it (no `v`): items are {name, value, level, limit, detail} with NO sample size; the sample
// size lives in the v1 check row (metrics.spawns.since, metrics.workers.since.n) and in the detail text ("per N spawns", "n=N").
const v1Item = (name, value, limit, detail) => ({ name, value, level: value, limit, detail });
const legacyFlag = (over = {}) => ({ version: '1.2.3', T: iso(T), check: '+1h', flags: [v1Item('queue-denied', 23.1, 20, '6 denied')], openedAt: iso(T + HOUR), notifiedAt: iso(T + HOUR), ackedAt: null, shownTo: {}, candidates: [], ack: null, clearedAt: null, cooldown: {}, ...over });
const putFlag = (f) => writeFileSync(file('release-watch-flag.json'), JSON.stringify(f));
// The v1 check row that raised the flag: what a v1 build appended (no `chain`; metrics a subset of the analysis).
const putV1Check = ({ at = T + HOUR, flags, spawns = 40, workers = 25 } = {}) => {
  S.appendRow({ at: iso(at), event: 'check', T: iso(T), version: '1.2.3', check: 1, covered: [1], late: false, flags: flags || [v1Item('queue-denied', 23.1, 20, '6 denied')],
    metrics: { spawns: { since: spawns, base: 700, perHour: { since: spawns, base: 4 } }, workers: { since: { n: workers }, base: { n: 400 } } } });
};
const resetRows = () => rmSync(file('release-watch-checks.jsonl'), { force: true });

test('legacy-flag-superseded: a pre-v2 flag whose sample is under the v2 floor is closed, the ack stays and nothing restarts', () => {
  const ackedAt = iso(T + 2 * HOUR);
  const items = [v1Item('queue-denied', 23.1, 20, '6 denied'), v1Item('hook-error-share', 60, 50, '8 of 8 workers')];
  putFlag(legacyFlag({ flags: items, ackedAt }));
  putV1Check({ flags: items, spawns: 10, workers: 8 });
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
  const items = [v1Item('queue-denied', 23.1, 20, '6 denied'), v1Item('mystery', 1, 1, 'x')];
  putFlag(legacyFlag({ flags: items }));
  putV1Check({ flags: items, spawns: 10 });
  const r = W.migrateFlag({ at: T + 3 * HOUR });
  assert.deepEqual(r.kept, ['mystery']);
  assert.deepEqual(S.readFlag().flags.map((x) => x.name), ['mystery']);
  // a check row without metrics and a detail without a sample size: unknown n, kept
  resetRows();
  putFlag(legacyFlag({ flags: [v1Item('queue-denied', 23.1, 20, '6 denied')] }));
  S.appendRow({ at: iso(T + HOUR), event: 'check', T: iso(T), version: '1.2.3', check: 1, flags: [v1Item('queue-denied', 23.1, 20, '6 denied')] });
  assert.deepEqual(W.migrateFlag({ at: T + 3 * HOUR }).kept, ['queue-denied'], 'unknown n: kept');
  // no check row at all: also kept
  resetRows();
  putFlag(legacyFlag());
  assert.deepEqual(W.migrateFlag({ at: T + 3 * HOUR }).kept, ['queue-denied']);
});

// The live flag, copied in shape from the real state file at 2026-11-22: spawn-rewrites 1 per 26 spawns, queue-denied 6 denied, worker-bash-fail 8.2 with n=355.
// The v1 check row recorded 26 spawns and 25 workers in the window.
const LIVE_T = Date.parse('2026-11-22T21:14:56.581Z'); const LIVE_AT = Date.parse('2026-11-22T22:20:01Z');
const liveItems = () => [v1Item('spawn-rewrites', 3.8, 3, '1 rewrites/denials per 26 spawns'), v1Item('queue-denied', 23.1, 20, '6 denied'), v1Item('worker-bash-fail', 8.2, 7, 'n=355, 29 real failures')];
function putLive() {
  resetRows();
  putFlag(legacyFlag({ T: iso(LIVE_T), flags: liveItems(), openedAt: iso(LIVE_AT), notifiedAt: iso(LIVE_AT) }));
  S.appendRow({ at: iso(LIVE_AT), event: 'check', T: iso(LIVE_T), version: '1.2.3', check: 1, covered: [1], late: false, flags: liveItems(),
    metrics: { spawns: { since: 26, base: 700, perHour: { since: 20, base: 4 } }, workers: { since: { n: 25 }, base: { n: 400 } } } });
}
const bashOf = (realFails, realFailPct) => ({ n: 355, realFails, realFailPct, refusals: 0, refusalPer100: 0 });
const liveRun = (bashSince, spawns = 100) => () => metrics({ spawns: { since: spawns, base: 700, perHour: { since: 10, base: 10 } }, bash: { since: bashSince, base: { n: 500, realFails: 5, realFailPct: 1, refusals: 0, refusalPer100: 0 } } });

test('legacy-live-flag: the real v1 flag under v2 on the fallback shapes: only the 355-call Bash item survives', () => {
  putLive();
  // the default analysis finds nothing in the empty data tree: the stored shapes decide (26 spawns < 30, 355 Bash calls >= 200)
  const r = W.migrateFlag({ at: LIVE_AT + HOUR });
  assert.deepEqual(r, { kept: ['worker-bash-fail'] });
  assert.deepEqual(S.readFlag().flags.map((x) => x.name), ['worker-bash-fail']);
  assert.equal(S.readFlag().v, 2); assert.equal(S.flagIsOpen(S.readFlag()), true);
  // the same through the tick, with a run that saw no spawns
  putLive();
  assert.deepEqual(W.tick({ at: LIVE_AT + HOUR, installed: {}, standingRun: none, run: liveRun(bashOf(29, 8.2), 0) }).migrated, { kept: ['worker-bash-fail'] });
});

test('legacy-live-flag: the real v1 flag under v2 on a re-run of the analysis', () => {
  // the re-run finds the Bash failure rate under its limit: none of the three items would flag now
  putLive();
  assert.deepEqual(W.migrateFlag({ at: LIVE_AT + HOUR, run: liveRun(bashOf(5, 1.4)) }), { superseded: true });
  assert.equal(S.flagIsOpen(S.readFlag()), false);
  // the re-run still sees the Bash failure rate over its limit: that item stays, the two small-sample items go
  putLive();
  assert.deepEqual(W.migrateFlag({ at: LIVE_AT + HOUR, run: liveRun(bashOf(29, 8.2)) }), { kept: ['worker-bash-fail'] });
  assert.equal(S.readFlag().flags[0].name, 'worker-bash-fail');
  // a re-run that saw under half the recorded spawns is no answer: the stored shapes decide, with the same outcome
  putLive();
  assert.deepEqual(W.migrateFlag({ at: LIVE_AT + HOUR, run: liveRun(bashOf(5, 1.4), 5) }), { kept: ['worker-bash-fail'] });
});

test('legacy-flag-still-flags-revoked: a flag still over the v2 floor keeps its items, and an ack without a typed record is revoked with the countdown restarted', () => {
  putV1Check();
  putFlag(legacyFlag({ ackedAt: iso(T + 2 * HOUR), shownTo: { s1: iso(T + HOUR) }, candidates: [{ x: 1 }] }));
  const at = T + 3 * HOUR;
  const r = W.tick({ at, installed: {}, standingRun: none });
  assert.deepEqual(r.migrated, { kept: ['queue-denied'], revoked: true });
  const f = S.readFlag();
  assert.equal(f.v, 2); assert.equal(S.flagIsOpen(f), true);
  assert.equal(f.ackedAt, null); assert.equal(f.ack, null); assert.equal(f.notifiedAt, null); assert.deepEqual(f.candidates, []);
  const row = allRows().find((x) => x.event === 'ack-revoked'); assert.ok(row);
  assert.match(S.flagLine() || '', /queue-denied/, 'the flag is shown again');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: at + 31 * MIN }), null, 'no countdown until a session shows the flag again');
  assert.ok(S.noteShown('s1', at)); // the first showing starts the countdown
  assert.equal(S.maybeHold({ holdMinutes: 30, at: at + 10 * MIN }), null, 'the countdown restarted from that showing');
  assert.ok(S.maybeHold({ holdMinutes: 30, at: at + 31 * MIN }), 'and a hold follows if still unanswered');
});

test('legacy-ack-revoked: an ack written by a build without human records is revoked; an unacked flag only gets the v2 marker', () => {
  putV1Check();
  putFlag(legacyFlag());
  assert.deepEqual(W.migrateFlag({ at: T + 3 * HOUR }), { kept: ['queue-denied'] });
  const f = S.readFlag();
  assert.equal(f.v, 2); assert.equal(f.notifiedAt, iso(T + HOUR), 'no ack to revoke: countdown untouched');
  assert.equal(allRows().filter((x) => x.event === 'ack-revoked').length, 0);
  assert.equal(W.migrateFlag({ at: T + 4 * HOUR }), null, 'a v2 flag is never migrated again');
});

test('legacy-ack-kept: a legacy ack with a typed record at its time stays, as an ack object naming the session', () => {
  const ackedAt = T + 2 * HOUR;
  putV1Check();
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

// ---- held sessions: record, list, clear, one-time cleared notice ----
const startHold = () => { S.openFlag({ version: '1', flags: flag, at: T }); S.noteShown('s0', T); return S.maybeHold({ holdMinutes: 30, at: T + HOUR }); };
const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { env: env(), encoding: 'utf8', windowsHide: true });

test('held sessions: recorded once per session (a subagent apart), updated on repeat, capped, nothing recorded when not held', () => {
  assert.equal(S.noteHeld({ session_id: 'lead-a' }, T), false, 'not held: nothing recorded');
  startHold();
  assert.ok(S.noteHeld({ session_id: 'lead-a', cwd: '/w/demo', transcript_path: '/t/a.jsonl' }, T + 2 * HOUR));
  S.noteHeld({ session_id: 'lead-a', cwd: '/w/demo' }, T + 3 * HOUR);
  S.noteHeld({ session_id: 'lead-a', agent_id: 'sub-1', cwd: '/w/demo' }, T + 3 * HOUR);
  const l = S.heldSessions();
  assert.equal(l.length, 2, 'one lead entry, one subagent entry');
  const lead = l.find((x) => !x.agentId);
  assert.deepEqual([lead.sessionId, lead.cwd, lead.transcriptPath, lead.firstSeen, lead.lastSeen], ['lead-a', '/w/demo', '/t/a.jsonl', iso(T + 2 * HOUR), iso(T + 3 * HOUR)]);
  assert.equal(l.find((x) => x.agentId).agentId, 'sub-1');
  for (let i = 0; i < S.HELD_CAP + 20; i++) S.noteHeld({ session_id: `bulk-${i}` }, T + 4 * HOUR + i);
  assert.equal(S.heldSessions().length, S.HELD_CAP);
});

test('held: the CLI lists the held sessions as text and JSON; none recorded says so', () => {
  assert.match(cli('held').stdout, /none recorded/);
  startHold();
  S.noteHeld({ session_id: 'lead-a', cwd: '/w/demo' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-b', cwd: '/w/other' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-a', agent_id: 'sub-1' }, T + 2 * HOUR);
  const t = cli('held').stdout;
  assert.match(t, /2 lead, 1 subagent/);
  assert.match(t, /lead lead-a  local unmapped/);
  assert.match(t, /No desktop session found for these .*lead-a \(cwd \/w\/demo\); lead-b \(cwd \/w\/other\)/);
  assert.doesNotMatch(t, /Send each of these sessions/, 'nothing mapped: no ids to message');
  const j = JSON.parse(cli('held', '--json').stdout);
  assert.equal(j.held, true); assert.equal(j.sessions.length, 3);
});

test('clear: prints the held list, stores it with clearedAt in the history row; a cleared notice reaches each lead once', () => {
  startHold();
  S.noteHeld({ session_id: 'lead-a', cwd: '/w/demo' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-b', cwd: '/w/other' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-a', agent_id: 'sub-1' }, T + 2 * HOUR);
  const out = cli('clear', '--by', 'operator').stdout;
  assert.match(out, /cleared \(flag true, hold true\)/);
  assert.match(out, /lead lead-a/); assert.match(out, /lead lead-b/);
  assert.match(out, /No desktop session found for these/);
  const row = readFileSync(file('release-watch-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.event === 'clear').pop();
  assert.ok(row.clearedAt); assert.equal(row.heldSessions.length, 3);
  assert.equal(S.heldSessions().length, 0, 'no hold now');
  const n = S.clearedNotice('lead-a', T + 5 * HOUR);
  assert.match(n, /post-release hold was cleared at .* by the operator\. Resume from your handoff or where you stopped\./);
  assert.equal(S.clearedNotice('lead-a', T + 6 * HOUR), null, 'once per session');
  assert.equal(S.clearedNotice('stranger', T + 6 * HOUR), null, 'a session that was never held');
  assert.equal(S.clearedNotice('sub-1', T + 6 * HOUR), null, 'a subagent id is not a lead');
  assert.match(S.clearedNotice('lead-b', T + 6 * HOUR), /cleared/);
  assert.match(cli('held').stdout, /still owed a local message/, 'a clear nobody has claimed: the sessions are still owed a message');
  S.takeOwedMessages('lead-z', T + 7 * HOUR);
  assert.match(cli('held').stdout, /none recorded/, 'claimed: nothing owed');
});

test('a new hold starts a new list, and a stale cleared notice is not shown during it', () => {
  startHold();
  S.noteHeld({ session_id: 'lead-a' }, T + 2 * HOUR);
  S.clear({ at: T + 3 * HOUR });
  S.openFlag({ version: '2', flags: [{ name: 'other', value: 1 }], at: T + 10 * HOUR });
  S.noteShown('s9', T + 10 * HOUR);
  S.maybeHold({ holdMinutes: 30, at: T + 12 * HOUR });
  assert.equal(S.clearedNotice('lead-a', T + 12 * HOUR), null, 'held again: no cleared notice');
  S.noteHeld({ session_id: 'lead-c' }, T + 13 * HOUR);
  assert.deepEqual(S.heldSessions().map((x) => x.sessionId), ['lead-c']);
});

test('wording: a lead is told to stop and wait for the local message, no cron; a subagent only to write its handoff and stop', () => {
  startHold();
  const lead = S.flagLine({ at: T + 2 * HOUR });
  assert.match(lead, /Stop and wait: end your turn now\. A local message arrives in this session when the hold clears/);
  assert.doesNotMatch(lead, /CronCreate|cron|20 minutes/);
  assert.doesNotMatch(lead, /<plugin root>/);
  const deny = S.holdDenyMessage('starting a new agent', { session_id: 'lead-a' });
  assert.match(deny, /Stop and wait/); assert.doesNotMatch(deny, /CronCreate/);
  const sub = S.holdDenyMessage('resuming a worker', { session_id: 'lead-a', agent_id: 'sub-1' });
  assert.match(sub, /Write your handoff and stop/); assert.doesNotMatch(sub, /CronCreate/);
  assert.equal(S.heldSessions().length, 2, 'the denials were recorded too');
});

// ---- desktop session ids and the local message after a clear ----
const putDesktop = (cliId, local, extra = {}, rel = ['acct-1', 'org-1']) => {
  const d = join(tmp, 'desk', ...rel); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, local + '.json'), JSON.stringify({ sessionId: local, cliSessionId: cliId, cwd: '/w/demo', title: 'invented', ...extra }));
};

test('desktop map: Claude Code session id -> local_ id, from every account and org folder; junk and non-session files ignored', () => {
  putDesktop('lead-a', 'local_aaaa1111-0000-4000-8000-000000000001');
  putDesktop('lead-b', 'local_bbbb2222-0000-4000-8000-000000000002', {}, ['acct-2', 'org-9']);
  writeFileSync(join(tmp, 'desk', 'acct-1', 'org-1', 'local_broken.json'), '{nope');
  writeFileSync(join(tmp, 'desk', 'acct-1', 'org-1', 'notes.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: 'lead-z' }));
  const m = S.desktopSessionMap();
  assert.equal(m.get('lead-a'), 'local_aaaa1111-0000-4000-8000-000000000001');
  assert.equal(m.get('lead-b'), 'local_bbbb2222-0000-4000-8000-000000000002');
  assert.equal(m.has('lead-z'), false);
  assert.equal(S.desktopSessionMap(join(tmp, 'nowhere')).size, 0, 'a missing store is an empty map');
});

test('clear: mapped leads get the local-message line and localSessionId in JSON; unmapped leads and subagents are not messaged', () => {
  putDesktop('lead-a', 'local_aaaa1111-0000-4000-8000-000000000001');
  startHold();
  S.noteHeld({ session_id: 'lead-a', cwd: '/w/demo' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-b', cwd: '/w/other' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-a', agent_id: 'sub-1' }, T + 2 * HOUR);
  const held = cli('held').stdout;
  assert.match(held, /Send each of these sessions a local message now: local_aaaa1111-0000-4000-8000-000000000001\n/);
  const out = cli('clear').stdout;
  assert.match(out, /lead lead-a  local local_aaaa1111-0000-4000-8000-000000000001/);
  assert.match(out, /^Send each of these sessions a local message now: local_aaaa1111-0000-4000-8000-000000000001$/m);
  assert.match(out, /No desktop session found for these \(message by hand\): lead-b \(cwd \/w\/other\)/);
  assert.doesNotMatch(out, /sub-1/);
});

test('clear --json: localSessionId on each lead entry, null when unmapped', () => {
  putDesktop('lead-a', 'local_aaaa1111-0000-4000-8000-000000000001');
  startHold();
  S.noteHeld({ session_id: 'lead-a' }, T + 2 * HOUR);
  S.noteHeld({ session_id: 'lead-b' }, T + 2 * HOUR);
  const j = JSON.parse(cli('clear', '--json').stdout);
  assert.equal(j.heldSessions.find((x) => x.sessionId === 'lead-a').localSessionId, 'local_aaaa1111-0000-4000-8000-000000000001');
  assert.equal(j.heldSessions.find((x) => x.sessionId === 'lead-b').localSessionId, null);
});

// ---- 0.31.66 counting fixes ----
test('count-once: a tool_result repeated in an api-request-blob record counts once', () => {
  const sd = join(claude, 'projects', 'C--pdup', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  const ts = new Date(T + HOUR).toISOString();
  const res = { type: 'tool_result', tool_use_id: 'dup-1', is_error: true, content: 'PreToolUse:Bash hook error: invented boom' };
  const L = [
    { type: 'user', timestamp: ts, message: { role: 'user', content: 'Do the invented task.' } },
    { type: 'user', timestamp: ts, message: { role: 'user', content: [res] } },
    { type: 'api-request-blob', timestamp: ts, message: { role: 'user', content: [res] } },
    { type: 'api-request-blob', timestamp: ts, message: { role: 'user', content: [res] } },
  ];
  writeFileSync(join(sd, 'agent-dup.jsonl'), L.map((l) => JSON.stringify(l)).join('\n'));
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.hookSignatures.since['PreToolUse:Bash invented boom'], 1);
});

test('hook-error noise: the harness worktree-isolation block is never a signature or a hook error; one event of a new signature is a note, not a FLAG', () => {
  const sd = join(claude, 'projects', 'C--pnoise', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  const ts = new Date(T + HOUR).toISOString();
  const line = (id, text) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
  const first = JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'Do the invented task.' } });
  writeFileSync(join(sd, 'agent-noise.jsonl'), [first, line('n-1', 'PreToolUse:Edit hook error: This session is running in an isolated git worktree at `/w/invented`, but `/w/other/x` is outside it.'), line('n-2', 'PreToolUse:Bash hook error: invented single boom')].join('\n'));
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.deepEqual(Object.keys(m.hookSignatures.since), ['PreToolUse:Bash invented single boom'], 'the harness block is not a signature');
  const one = names(metrics({ hookSignatures: { since: { 'PreToolUse:Bash invented single boom': 1 }, base: {} } }));
  assert.ok(!one.some((x) => x.startsWith('hook-signature')), 'one event is a note, not a flag');
  assert.ok(names(metrics({ hookSignatures: { since: { 'PreToolUse:Bash invented single boom': 5 }, base: {} } })).some((x) => x.startsWith('hook-signature')), 'five events flag');
});

test('count-once: two hard denials from one worker are one worker, and the row count stays in the detail', () => {
  putRows('handoff-limit.jsonl', [{ at: T + HOUR, limit: 'hard', action: 'deny', agent_id: 'wA', session_id: 's1' }, { at: T + 2 * HOUR, limit: 'hard', action: 'deny', agent_id: 'wA', session_id: 's1' },
    { at: T + 2 * HOUR, limit: 'hard', action: 'deny', session_id: 's2' }]);
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.telemetry['handoff:hard/deny'].since, 3);
  assert.equal(m.handoffHardWorkers.since, 2);
  const x = W.evaluate(metrics({ handoffHardWorkers: { since: 1, base: 0 }, telemetry: { 'handoff:hard/deny': t(3, 0, 3, 0) } })).metrics.find((y) => y.name === 'handoff-hard-deny');
  assert.equal(x.events, 1);
});

test('status: an install newer than the armed releases is reported as not armed yet, and status writes nothing', () => {
  W.tick({ at: T + HOUR, installed: installed(), run: () => metrics(), holdMinutes: 30 });
  const T2 = T + 2 * HOUR + 3 * 60e3;
  const before = readFileSync(file('release-watch-run.json'), 'utf8');
  const inst2 = { plugins: { 'agent-companion@x': [{ version: '9.9.9', lastUpdated: iso(T2) }] } };
  const out = W.status(T2 + 60e3, { installed: inst2 });
  assert.match(out, /release 9\.9\.9 installed .*: not armed yet; the 10-minute job arms it by \d\d:\d0Z/);
  assert.equal(JSON.parse(W.status(T2 + 60e3, { json: true, installed: inst2 })).pending.version, '9.9.9');
  assert.doesNotMatch(W.status(T2, { installed: installed() }), /not armed yet/);
  assert.equal(readFileSync(file('release-watch-run.json'), 'utf8'), before);
});

// ---- 0.31.71: ack intent, release owner first, clear removes the hold-session list (temp state dirs only) ----
test('ack-intent: the ack wording acks; a question or a request for analysis does not', () => {
  for (const yes of ['ack', 'Ack.', 'acknowledged', 'please acknowledge it', 'keep it', "it's fine", 'no rollback', 'ok, keep it, no rollback', 'looks fine', 'ack and no rollback', '[ack]']) assert.equal(S.isAckText(yes), true, yes);
  for (const no of ['Well analysis please', 'why did it flag?', 'ack?', 'show me the numbers', 'ok', 'please', 'keep going with the other task', '', 'x'.repeat(200)]) assert.equal(S.isAckText(no), false, no);
});

test('ack-intent: a non-ack reply leaves the flag open and the countdown running', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  assert.ok(S.noteShown('s1', T));
  assert.equal(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'Well analysis please', at: T + 5 * MIN }), false);
  assert.equal(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'typed', payloadOrigin: { kind: 'human' }, at: T + 6 * MIN }), false, 'a human payload origin alone no longer acks');
  assert.deepEqual(S.readFlag().candidates, []);
  assert.equal(S.readFlag().ackedAt, null);
  assert.ok(S.maybeHold({ holdMinutes: 30, at: T + 31 * MIN }), 'the countdown ran on: hold written');
});

test('ack-intent: an ack reply still needs the human origin', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  S.noteShown('s1', T);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'ack', at: T + 5 * MIN }));
  assert.equal(S.confirmCandidates({ at: T + 6 * MIN, readTail: tailOf(urec(T + 5 * MIN, 'ack', { origin: { kind: 'peer' }, isMeta: true })) }), null);
  assert.equal(S.readFlag().ackedAt, null);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: 'fake', prompt: 'ack', payloadOrigin: { kind: 'human' }, at: T + 7 * MIN }), 'payload human origin plus ack wording acks');
  assert.equal(S.readFlag().ack.signal, 'payload-origin-human');
});

test('ack-intent: the notice names the ack wording', () => {
  S.openFlag({ version: '1', flags: flag, at: T });
  assert.match(S.flagLine({ at: T }), /"ack", "keep it", "no rollback"/);
});

const putOwner = (session, at, transcriptPath) => S.writeJson(S.paths().owner, { session, at: iso(at), transcriptPath });
function ownerFixture() {
  const tp = join(tmp, 'owner.jsonl'); writeFileSync(tp, '{}\n');
  S.writeJson(S.paths().run, { v: 2, releases: [{ version: '2', T }] });
  S.openFlag({ version: '2', flags: flag, at: T + 10 * MIN });
  return tp;
}

test('owner-first: a live owner sees the notice; other leads only after the delay', () => {
  const tp = ownerFixture();
  const at = T + 11 * MIN;
  putOwner('owner-s', T + 2 * MIN, tp);
  utimesSync(tp, new Date(at), new Date(at));
  assert.match(S.flagLine({ at, sessionId: 'owner-s' }), /RELEASE WATCH/);
  assert.equal(S.flagLine({ at, sessionId: 'other-s' }), null, 'others wait');
  utimesSync(tp, new Date(T + 10 * MIN + S.OWNER_GRACE_MS), new Date(T + 10 * MIN + S.OWNER_GRACE_MS));
  assert.equal(S.flagLine({ at: T + 10 * MIN + S.OWNER_GRACE_MS - 1000, sessionId: 'other-s' }), null);
  assert.match(S.flagLine({ at: T + 10 * MIN + S.OWNER_GRACE_MS, sessionId: 'other-s' }), /RELEASE WATCH/, 'after the delay others see it too');
  assert.match(S.flagLine({ at, sessionId: null }), /RELEASE WATCH/, 'an unknown caller keeps today\'s behaviour');
});

test('owner-first: no owner, an owner of an older install, an idle owner or a missing transcript keep today\'s behaviour', () => {
  const tp = ownerFixture();
  const at = T + 11 * MIN;
  assert.match(S.flagLine({ at, sessionId: 'other-s' }), /RELEASE WATCH/, 'no owner record');
  utimesSync(tp, new Date(at), new Date(at));
  putOwner('owner-s', T - 3 * HOUR, tp);
  assert.match(S.flagLine({ at, sessionId: 'other-s' }), /RELEASE WATCH/, 'owner noted an older install');
  putOwner('owner-s', T + 2 * MIN, tp);
  utimesSync(tp, new Date(at - 5 * HOUR), new Date(at - 5 * HOUR));
  assert.match(S.flagLine({ at, sessionId: 'other-s' }), /RELEASE WATCH/, 'owner transcript idle for hours: not live');
  putOwner('owner-s', T + 2 * MIN, join(tmp, 'missing.jsonl'));
  assert.match(S.flagLine({ at, sessionId: 'other-s' }), /RELEASE WATCH/, 'owner transcript missing');
});

test('owner-first: the install hook records the installing lead as owner (a worker or another command does not)', () => {
  const run = (payload) => spawnSync(process.execPath, [join(ROOT, 'hooks', 'hold-message.mjs'), '--event', 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: '', ...payload }), env: env(), encoding: 'utf8', windowsHide: true, cwd: tmp });
  run({ session_id: 'w', agent_id: 'a1', transcript_path: 't', tool_input: { command: 'claude plugin update agent-companion@agent-templates --scope user' } });
  run({ session_id: 'l0', transcript_path: 't', tool_input: { command: 'ls' } });
  assert.equal(S.readJson(S.paths().owner), null);
  run({ session_id: 'lead-1', transcript_path: 'tp1', tool_input: { command: 'claude plugin marketplace update agent-templates && claude plugin update agent-companion@agent-templates --scope user' } });
  assert.equal(S.readJson(S.paths().owner).session, 'lead-1');
  assert.equal(S.readJson(S.paths().owner).transcriptPath, 'tp1');
});

test('owner-first: the prompt hook shows the owner first and holds the notice back from others', () => {
  const tp = ownerFixture();
  const at = T + 11 * MIN;
  putOwner('owner-s', T + 2 * MIN, tp);
  utimesSync(tp, new Date(at), new Date(at));
  assert.equal(ctxOf(hookAt(['--watch'], { session_id: 'other-s', prompt: 'hello' }, at)), '');
  assert.equal((S.readFlag().shownTo || {})['other-s'], undefined, 'not recorded as shown');
  assert.match(ctxOf(hookAt(['--watch'], { session_id: 'owner-s', prompt: 'hello' }, at)), /RELEASE WATCH/);
  assert.ok(S.readFlag().shownTo['owner-s']);
});

test('owner-first: a cleared notice shown while the flag is held back does not start the countdown for that session', () => {
  const tp = ownerFixture();
  const at = T + 11 * MIN;
  putOwner('owner-s', T + 2 * MIN, tp);
  utimesSync(tp, new Date(at), new Date(at));
  S.writeJson(S.paths().heldSessions, { holdSince: iso(T - HOUR), sessions: [{ sessionId: 'other-s', agentId: null, cwd: '/w' }], clearedAt: iso(at - MIN), noticed: {} });
  const out = ctxOf(hookAt(['--watch'], { session_id: 'other-s', prompt: 'hello' }, at));
  assert.match(out, /hold was cleared/, 'the cleared notice is shown');
  assert.doesNotMatch(out, /RELEASE WATCH/, 'the flag is held back for the owner');
  assert.equal((S.readFlag().shownTo || {})['other-s'], undefined, 'not recorded as shown the flag');
});

test('isAckText: ordinary acks match, near-misses and questions do not', () => {
  const yes = ['ack', 'Ack.', 'ACK!', 'yes ack it', 'ok ack', 'ack thanks', 'acked', 'ack it please', 'ack — keep it', 'ack - keep it', 'keep 0.31.71', 'ack 0.31.71', 'yes, ack it', 'ok, ack', "ack'd", 'keep it', 'no rollback', 'all good'];
  const no = ["don't ack", 'no, roll back', 'ack and roll back', 'ack?', 'ok ack?', 'keep 0.31.71?', 'Well analysis please', 'why did it flag?', 'ok', 'yes', 'please', 'ack, keep going', 'roll back 0.31.71'];
  for (const t of yes) assert.equal(S.isAckText(t), true, `ack: ${t}`);
  for (const t of no) assert.equal(S.isAckText(t), false, `not ack: ${t}`);
});

test('compat: a 0.31.70 flag with no chain field still matches its cooldown keys; an old hook-signature key holds for the normalised name', () => {
  const raw = 'hook-signature:PreToolUse:Bash exit 12 in /a/b/c.mjs';
  S.openFlag({ version: '1', T, chain: T, flags: [{ name: 'queue-clears', value: 3.6, level: 3.6 }, { name: raw, value: 3, level: 3 }], at: T + MIN });
  S.clear({ by: 'operator', at: T + 2 * MIN });
  const f = S.readFlag();
  delete f.chain; // 0.31.70 shape: no chain field, the cooldown key is the baseline anchor
  S.writeJson(S.paths().flag, f);
  assert.equal(S.openFlag({ version: '1', T, chain: T, flags: [{ name: 'queue-clears', value: 3.6, level: 3.6 }], at: T + 3 * MIN }), null, 'the old cooldown key still answers');
  assert.equal(S.openFlag({ version: '1', T, chain: T, flags: [{ name: 'hook-signature:PreToolUse:Bash exit N in <path>', value: 3, level: 3 }], at: T + 3 * MIN }), null, 'the old raw signature name answers the normalised one');
});

test('clear: removes a stale hold-session list; keeps one that still owes messages', () => {
  const listF = S.paths().heldSessions;
  S.writeJson(listF, { holdSince: iso(T - HOUR), sessions: [{ sessionId: 'old', agentId: null }], clearedAt: iso(T - 13 * HOUR), noticed: {}, owed: { ids: [], unmapped: [], claimedBy: 'x' } });
  S.openFlag({ version: '1', flags: flag, at: T });
  S.clear({ by: 'operator', at: T + MIN });
  assert.equal(existsSync(listF), false, 'the stale list of an earlier hold is gone');
  S.writeJson(S.paths().hold, { since: iso(T), version: '1', reason: 'x', flags: [], clearedAt: null });
  S.writeJson(listF, { holdSince: iso(T), sessions: [{ sessionId: 'lead-a', agentId: null, cwd: '/w' }], clearedAt: null, noticed: {} });
  S.clear({ by: 'operator', at: T + 2 * MIN });
  assert.ok(S.readJson(listF).owed, 'a lift keeps the list: its messages are owed to the next lead');
  S.clear({ by: 'operator', at: T + 3 * MIN });
  assert.ok(existsSync(listF), 'a second clear does not drop unclaimed owed messages');
  S.takeOwedMessages('lead-b', T + 4 * MIN);
  S.clear({ by: 'operator', at: T + 5 * MIN });
  assert.ok(existsSync(listF), 'claimed but recent: a later clear keeps the list, unmapped leads still read it');
  S.clear({ by: 'operator', at: T + 2 * MIN + S.OWED_TTL_MS + MIN });
  assert.equal(existsSync(listF), false, 'older than the owed-message TTL: the next clear removes it');
});

test('clear: a second clear after the claim does not take the cleared notice from a held lead (review scenario)', () => {
  const listF = S.paths().heldSessions;
  S.writeJson(S.paths().hold, { since: iso(T), version: '1', reason: 'x', flags: [], clearedAt: null });
  S.writeJson(listF, { holdSince: iso(T), sessions: [{ sessionId: 'lead-a', agentId: null, cwd: '/w' }], clearedAt: null, noticed: {} });
  S.clear({ by: 'operator', at: T + MIN });                 // the lift: the list is kept and owes messages
  S.takeOwedMessages('lead-b', T + 2 * MIN);                // the CLI clear's own hook claims them at once
  S.clear({ by: 'operator', at: T + 3 * MIN });             // a retry or a flag-only clear
  assert.match(S.clearedNotice('lead-a', T + 4 * MIN) || '', /hold was cleared/, 'the unmapped lead still gets its cleared notice');
});

test('clear: a list from an earlier hold is dropped when a new hold is lifted', () => {
  const listF = S.paths().heldSessions;
  S.writeJson(listF, { holdSince: iso(T - 5 * HOUR), sessions: [{ sessionId: 'old', agentId: null }], clearedAt: null, noticed: {} });
  S.writeJson(S.paths().hold, { since: iso(T), version: '1', reason: 'x', flags: [], clearedAt: null });
  const r = S.clear({ by: 'operator', at: T + MIN });
  assert.equal(r.holdCleared, true);
  assert.equal(existsSync(listF), false);
});

// ---- 0.31.71 check fixes: usage limit, signature workers, lead-hours ----
const putWorker = (id, recs, finished = true) => {
  const sd = join(claude, 'projects', 'C--p71', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, `agent-${id}.jsonl`), recs.map((l) => JSON.stringify(l)).join('\n'));
  writeFileSync(join(sd, `agent-${id}.meta.json`), JSON.stringify({ finished, agentType: 'ac-sonnet-low' }));
};
const wts = (min) => new Date(T + HOUR + min * 60e3).toISOString();
const prompt71 = (min) => ({ type: 'user', timestamp: wts(min), message: { role: 'user', content: 'Do the invented task.' } });
const apiErr = (min, err) => ({ type: 'assistant', timestamp: wts(min), isApiErrorMessage: true, apiError: err, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'error' }] } });
const say = (min, text) => ({ type: 'assistant', timestamp: wts(min), requestId: `r${min}${text.length}`, message: { role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text }] } });

test('0.31.71 api-errors: usage-limit errors never count, an info line names the time; real api errors still flag', () => {
  for (let i = 0; i < 4; i++) putWorker(`ul${i}`, [prompt71(i), apiErr(10 + i, 'usage_limit_reached')]);
  let m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.workers.since.apiNonUsageWorkers, 0); assert.equal(m.workers.since.usageLimitWorkers, 4);
  assert.ok(!W.evaluate(m, { minWorkers: 1 }).flags.some((f) => f.name === 'api-errors'), 'four usage-limit workers raise no flag');
  const ev = W.evaluate(m, { minWorkers: 1 }).metrics.find((x) => x.name === 'api-errors');
  assert.equal(ev.status, 'ok'); assert.match(ev.detail, /usage limit hit at 2026-03-01T11:10Z/);
  for (let i = 0; i < 2; i++) putWorker(`real${i}`, [prompt71(i), apiErr(20 + i, 'overloaded_error')]);
  m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.workers.since.apiNonUsageWorkers, 2);
  assert.ok(W.evaluate(m, { minWorkers: 1 }).flags.some((f) => f.name === 'api-errors'));
});

test('0.31.71 no-final-status: workers that ended on the usage limit are out of numerator and denominator, counted apart', () => {
  putWorker('ulA', [prompt71(0), say(1, 'working'), apiErr(5, 'usage_limit_reached')]);
  putWorker('ulB', [prompt71(0), apiErr(6, 'usage_limit_reached')]);
  putWorker('resumed', [prompt71(0), apiErr(5, 'usage_limit_reached'), say(30, 'done.\nSTATUS: done')]);
  putWorker('none1', [prompt71(0), say(2, 'no status line here')]);
  const m = W.analyze({ T, nowMs: T + 3 * HOUR }); const ws = m.workers.since;
  assert.equal(ws.usageLimitEnded, 2); assert.equal(ws.finished, 4); assert.equal(ws.noStatusFinished, 2);
  assert.equal(ws.noStatusPct, 50, '1 none of 2 counted workers');
  const ns = W.evaluate(m, { minWorkers: 1 }).metrics.find((x) => x.name === 'no-final-status');
  assert.equal(ns.n, 2); assert.match(ns.detail, /2 usage-limit endings left out/);
});

test('0.31.71 hook-signature: distinct workers are counted, events shown next to them', () => {
  const sig = (id, i) => ({ type: 'user', timestamp: wts(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-${i}`, is_error: true, content: 'PreToolUse:Write hook error: Failed running the hook script, exit code 2' }] } });
  putWorker('loop', [prompt71(0), ...[1, 2, 3, 4, 5].map((i) => sig('loop', i))]);
  let m = W.analyze({ T, nowMs: T + 3 * HOUR }); const k = Object.keys(m.hookSignatures.since)[0];
  assert.equal(m.hookSignatures.since[k], 1, 'one worker'); assert.equal(m.hookSignatureEvents.since[k], 5, 'five events');
  const flags = (mm) => W.evaluate(mm, { minWorkers: 1 }).flags.filter((f) => f.name.startsWith('hook-signature'));
  assert.equal(flags(m).length, 0, 'one looping worker is not a new-signature flag');
  for (let i = 0; i < 4; i++) putWorker(`w${i}`, [prompt71(0), sig(`w${i}`, 1)]);
  m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.hookSignatures.since[k], 5);
  const f = flags(m); assert.equal(f.length, 1); assert.match(f[0].detail, /5 workers, 9 events/);
});

test('0.31.71 guard:delegation/deny: rate per active lead-hour, more leads at once do not raise it', () => {
  const base = Array.from({ length: 24 }, (_, i) => ({ at: T - 7 * DAY + i * HOUR + 60e3, session_id: 'L0' }));
  const baseDen = base.map((r) => ({ at: r.at + 1000, guard: 'delegation', outcome: 'deny', session_id: 'L0' }));
  const since = []; const den = [];
  for (const L of ['A', 'B', 'C']) for (let h = 0; h < 4; h++) { since.push({ at: T + h * HOUR + 60e3, session_id: L }); den.push({ at: T + h * HOUR + 2000, guard: 'delegation', outcome: 'deny', session_id: L }); }
  putRows('spawns.jsonl', [...base, ...since]); putRows('denials.jsonl', [...baseDen, ...den]);
  let m = W.analyze({ T, nowMs: T + 4 * HOUR });
  assert.deepEqual(m.leadHours, { since: 12, base: 24 });
  const dg = (mm) => W.evaluate(mm).metrics.find((x) => x.name === 'guard:delegation/deny');
  assert.equal(dg(m).value, 1); assert.equal(dg(m).base, 1); assert.equal(dg(m).status, 'ok', 'three leads at once: the old per-clock-hour rate (3/h vs 0.14/h) would have flagged');
  putRows('denials.jsonl', [...baseDen, ...den, ...den.map((r) => ({ ...r, at: r.at + 500 })), ...den.map((r) => ({ ...r, at: r.at + 900 })), ...den.map((r) => ({ ...r, at: r.at + 1500 }))]);
  m = W.analyze({ T, nowMs: T + 4 * HOUR });
  assert.equal(dg(m).status, 'flag', 'four times the rate per lead-hour still flags');
});

// ---- 0.31.71 leg C: per-version worker split, flag stamps, designed denies ----
test('0.31.71 per-version split: a worker belongs to the release in its spawn row; time-based only when the row is missing, and labelled', () => {
  const T2 = T + 3 * HOUR;
  const tdir = join(claude, 'agent-companion', 'telemetry'); mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, 'spawns.jsonl'), [rowj({ at: T + 3.5 * HOUR, guard_version: '1.0.0', tool_use_id: 'toolu_A', session_id: 's' }), rowj({ at: T - 2 * HOUR })].join(''));
  const sd = join(claude, 'projects', 'C--p71c', 'sess', 'subagents'); mkdirSync(sd, { recursive: true });
  const mk = (id, toolUseId) => {
    writeFileSync(join(sd, `agent-${id}.jsonl`), JSON.stringify({ type: 'user', timestamp: iso(T2 + HOUR), message: { role: 'user', content: 'task' } }));
    writeFileSync(join(sd, `agent-${id}.meta.json`), JSON.stringify({ finished: true, agentType: 'ac-sonnet-low', ...(toolUseId ? { toolUseId } : {}) }));
  };
  mk('A', 'toolu_A'); mk('B', null);
  const rel = [{ version: '1.0.0', T }, { version: '1.1.0', T: T2 }];
  const m = W.analyze({ T: T2, nowMs: T2 + 6 * HOUR, winFrom: T, baseFrom: T - 7 * 24 * HOUR, baseTo: T, releases: rel });
  assert.equal(m.byVersion['1.0.0'].workers.since.n, 1, 'worker A started after the second install but its spawn row says 1.0.0');
  assert.equal(m.byVersion['1.1.0'].workers.since.n, 1, 'worker B has no spawn row: time-attributed to the newest release');
  assert.deepEqual(m.workerVersionBasis, { spawn: 1, time: 1 });
});

test('0.31.71 flag stamps: T, version and check name the release and the check that produced the flags, not the chain base', () => {
  const T1 = T + 2 * HOUR;
  W.tick({ at: T + HOUR, installed: instV('1.0.0', T), run: () => metrics(), standingRun: none });
  W.tick({ at: T1 + 1.5 * HOUR, installed: instV('1.1.0', T1), run: flagged, standingRun: none });
  const f = S.readFlag();
  assert.equal(f.version, '1.1.0'); assert.equal(Date.parse(f.T), T1); assert.equal(f.check, '+1h'); assert.equal(Date.parse(f.chain), T, 'the chain base is kept apart');
});

test('0.31.76 cadence: an older release due while the newest is under an hour old waits; one check then covers both', () => {
  const calls = [];
  W.tick({ at: T + HOUR, installed: instV('1.0.0', T), run: () => metrics(), standingRun: none });
  const r1 = W.tick({ at: T + 4 * HOUR + 60e3, installed: instV('1.1.0', T + 3.5 * HOUR), run: (o) => { calls.push(o); return flagged(o); }, standingRun: none });
  assert.equal(r1.ran, false, 'a window under an hour is not measured'); assert.equal(calls.length, 0);
  const r2 = W.tick({ at: T + 4.5 * HOUR + 60e3, installed: instV('1.1.0', T + 3.5 * HOUR), run: (o) => { calls.push(o); return flagged(o); }, standingRun: none });
  assert.equal(r2.ran, true); assert.equal(calls.length, 1, 'one analysis for the whole chain');
  const f = S.readFlag();
  assert.equal(f.version, '1.1.0'); assert.equal(Date.parse(f.T), T + 3.5 * HOUR); assert.equal(f.check, '+1h');
  assert.ok(runFile().releases[0].done.includes(2) && runFile().releases[1].done.includes(0), 'both releases had their due slot covered by that one check');
  const rows = readFileSync(file('release-watch-checks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === 'check');
  assert.equal(rows.length, 2);
  assert.ok(Date.parse(rows[1].window.to) - Date.parse(rows[1].window.from) >= HOUR, 'window at least one hour');
});

test('0.31.71 designed denies: a guard deny that works as designed is not a hook error and not a signature; real errors still flag', () => {
  const res = (id, i, text) => ({ type: 'user', timestamp: wts(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-${i}`, is_error: true, content: text }] } });
  const designed = [
    'PreToolUse:PowerShell hook error: Heavy command (build (box 6)) not run (rewrite does not apply in this permission mode). Run it as: node queue.mjs',
    'PreToolUse:Bash hook error: git worktree remove not run: on Windows it follows junctions and directory symlinks inside the tree.',
    'PreToolUse:Write hook error: Check in with the lead before building more beyond the brief.',
  ];
  designed.forEach((txt, i) => putWorker(`d${i}`, [prompt71(0), res(`d${i}`, 1, txt)]));
  putWorker('real1', [prompt71(0), res('real1', 1, 'PreToolUse:Bash hook error: Failed running /opt/tools/a/x.mjs: exit code 3 in box 4')]);
  putWorker('real2', [prompt71(0), res('real2', 1, 'PreToolUse:Bash hook error: Failed running /opt/tools/b/x.mjs: exit code 7 in box 9')]);
  const m = W.analyze({ T, nowMs: T + 3 * HOUR });
  assert.equal(m.workers.since.hookErrorWorkersPct, 40, 'only the two real errors count');
  const keys = Object.keys(m.hookSignatures.since);
  assert.equal(keys.length, 1, `one normalised signature, got ${JSON.stringify(keys)}`);
  assert.equal(m.hookSignatures.since[keys[0]], 2);
});

test('designed-denies: prefixes and normalisation', async () => {
  const D = await import('../hooks/lib/designed-denies.mjs');
  assert.ok(D.isDesignedDeny('Heavy command (test (box 12)) not run')); assert.ok(!D.isDesignedDeny('Heavy command'));
  assert.ok(!D.isDesignedDeny('TypeError: x is not a function'));
  assert.equal(D.normalizeSignature('exit 12 in /a/b/c.mjs and C:\\x\\y.js'), 'exit N in <path> and <path>');
});

test('designed-denies: every guard deny text is listed, and a crash still is not', async () => {
  const D = await import('../hooks/lib/designed-denies.mjs');
  const { ENV_MSG } = await import('../hooks/lib/env-dump-guard.mjs');
  const { KILL_MSG } = await import('../hooks/lib/process-kill-guard.mjs');
  const { PUSH_DELETE_MSG } = await import('../hooks/lib/push-delete-guard.mjs');
  const { PY_MSG } = await import('../hooks/lib/python-stdin.mjs');
  const { WRITER_DENY_REASON } = await import('../hooks/lib/scope-tripwire.mjs');
  const { denyText, streakPrefix } = await import('../hooks/lib/handoff-limit.mjs');
  const { workerWaitDenyText } = await import('../hooks/lib/poll-guard.mjs');
  const { HEAVY_DENY_PREFIX } = await import('../hooks/lib/resource-gate.mjs');
  const { WORKTREE_DENY_PREFIX } = await import('../hooks/lib/worktree-remove.mjs');
  const texts = { ENV_MSG, KILL_MSG, PUSH_DELETE_MSG, PY_MSG, WRITER_DENY_REASON, HEAVY: `${HEAVY_DENY_PREFIX}test, box 12) not run`, WORKTREE: `${WORKTREE_DENY_PREFIX}: on Windows`,
    CONTEXT: denyText(150000, 140000), STREAK: streakPrefix(7) + denyText(150000, 140000), SLEEP: workerWaitDenyText('/p', 10),
    GIT: 'DESTRUCTIVE GIT (backup rule, no exceptions): first create', JUNCTION: 'Git Bash `rm -rf` follows an NTFS junction INTO its target', SUBAGENT: 'Not shown: you are a subagent' };
  for (const [k, t] of Object.entries(texts)) assert.ok(D.isDesignedDeny(t), `${k} is a designed deny`);
  // a guard that exports a *_MSG constant has a deny the list must know: a new one that is missing fails here
  const libDir = join(ROOT, 'hooks', 'lib');
  for (const f of readdirSync(libDir).filter((x) => x.endsWith('.mjs'))) {
    if (!/export const [A-Z_]*_MSG\b/.test(readFileSync(join(libDir, f), 'utf8'))) continue;
    const mod = await import(pathToFileURL(join(libDir, f)).href);
    for (const [name, val] of Object.entries(mod)) if (/_MSG$/.test(name) && typeof val === 'string') assert.ok(D.isDesignedDeny(val), `${f} ${name} is missing from designed-denies.mjs`);
  }
  for (const crash of ['TypeError: Cannot read properties of undefined', 'Error: Cannot find module', 'SyntaxError: Unexpected token', '[agent-companion] hook crashed']) assert.ok(!D.isDesignedDeny(crash), crash);
});

// ---- 0.31.75: hold sample floor, severity exemption, scope ----
const holdAfter = (flags) => { S.openFlag({ version: '1', flags, at: T, check: '+1h' }); S.noteShown('s1', T); return S.maybeHold({ holdMinutes: 30, at: T + 31 * 60e3 }); };
test('floor: a flag below 8 events or 30 samples notifies but never holds; at the floor it holds', () => {
  assert.equal(holdAfter([{ name: 'spawn-rewrites', value: 11, events: 4, n: 34 }]), null, '4 events over 34 spawns: no hold');
  assert.equal(S.flagIsOpen(), true, 'the flag is still open and shown');
  assert.match(S.flagLine({ at: T + 60e3, sessionId: 's1' }) || '', /below the hold floor/);
  assert.equal(S.isHoldActive(), false);
});
test('floor: n under 30 never holds; exactly at the floor holds', () => {
  assert.equal(holdAfter([{ name: 'partial-share', value: 40, events: 9, n: 20 }]), null, 'n 20 is under the sample floor');
});
test('floor: exactly 8 events over 30 samples holds', () => {
  assert.ok(holdAfter([{ name: 'spawn-rewrites', value: 11, events: 8, n: 30 }]));
});

test('floor: severity flags (runaway) hold on one event; options move or switch off the floor', () => {
  assert.ok(holdAfter([{ name: 'runaway', value: 1, events: 1, n: 0 }]), 'runaway with 1 event still starts a hold');
  assert.equal(S.meetsHoldFloor({ name: 'runaway', events: 1, n: 1 }), true);
  assert.equal(S.meetsHoldFloor({ name: 'other', events: 1, n: 1 }), false);
  assert.equal(S.meetsHoldFloor({ name: 'other', value: 3 }), true, 'a flag with no counts cannot be judged small');
  assert.equal(S.meetsHoldFloor({ name: 'guard:x/deny', events: 30, n: 5 }), true, 'n is active hours for guard:* and queue-clears: only the event floor applies');
  assert.equal(S.meetsHoldFloor({ name: 'guard:x/deny', events: 3, n: 5 }), false);
  process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MIN_EVENTS = '0'; process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MIN_N = '0';
  try { assert.equal(S.meetsHoldFloor({ name: 'other', events: 1, n: 1 }), true, 'floor 0 = off'); }
  finally { delete process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MIN_EVENTS; delete process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_MIN_N; }
});

test('scope: releases (default) refuses only release actions; all keeps the all-calls hold', () => {
  const was = process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE;
  try {
    delete process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE;
    assert.equal(S.holdScope(), 'releases');
    assert.ok(holdAfter([{ name: 'spawn-rewrites', value: 11, events: 20, n: 90 }]));
    assert.equal(S.holdDenyMessage('new agents'), null, 'releases scope: no all-calls denial');
    assert.equal(S.noteHeld({ session_id: 'a' }), false, 'releases scope records no held sessions');
    for (const c of ['claude plugin install agent-companion@x', 'claude plugin update agent-companion', 'claude plugin marketplace update', 'git push origin HEAD:release/0.31.75', 'gh pr merge 5 --repo o/agent-templates', 'gh pr create --base main --head release/0.31.75']) {
      assert.match(S.releaseActionDeny(c) || '', /post-release hold/, c);
    }
    for (const c of ['git push origin fix/x', 'npm test', 'gh pr merge 5 --repo o/other', 'claude plugin install other-plugin']) assert.equal(S.releaseActionDeny(c, () => 'fix/demo'), null, c); // the PR-head lookup is mocked: no network
    process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE = 'all';
    assert.equal(S.holdScope(), 'all');
    assert.equal(S.releaseActionDeny('claude plugin update agent-companion'), null, 'all scope: the all-calls path owns the refusal');
    assert.ok(S.holdDenyMessage('new agents'), 'all scope keeps the old denial');
  } finally { process.env.CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE = was; }
});

// ---- 0.31.76: false-hold detectors (fixtures follow the root-cause analysis of the recorded episodes; every id is invented) ----
const rowl = (o) => JSON.stringify(o) + '\n';
function replayFixture({ spawns = 34, denials = [], planned = 0, unplanned = 0, done = 0, handoffRows = [] } = {}) {
  const tdir = join(claude, 'agent-companion', 'telemetry'); mkdirSync(tdir, { recursive: true });
  let sp = ''; for (let i = 0; i < spawns; i++) sp += rowl({ at: T + HOUR + i * 60e3, session_id: 'sess-fake-1' });
  for (let i = 0; i < 140; i++) sp += rowl({ at: T - 24 * HOUR - i * 600e3, session_id: 'sess-fake-1' });
  writeFileSync(join(tdir, 'spawns.jsonl'), sp);
  writeFileSync(join(tdir, 'denials.jsonl'), denials.map(rowl).join(''));
  writeFileSync(join(tdir, 'handoff-limit.jsonl'), handoffRows.map(rowl).join(''));
  let n = 0;
  const mk = (text) => putWorker(`rp${n++}`, [prompt71(n), say(n, text)]);
  for (let i = 0; i < planned; i++) mk('Handed off.\nDONE: partial, handoff at C:/fake/tasks/x-handoff.md');
  for (let i = 0; i < unplanned; i++) mk('STATUS: partial\nstopped early');
  for (let i = 0; i < done; i++) mk('STATUS: done');
  return W.analyze({ T, nowMs: T + 2 * HOUR });
}
const metricOf = (m, name) => W.evaluate(m).metrics.find((x) => x.name === name);
const denial = (agent, guard = 'type-required', i = 0) => ({ at: T + HOUR + 28000 + i * 7000, session_id: 'sess-fake-1', agent_id: agent, guard, outcome: 'deny' });

test('0.31.76 spawn-rewrites: one agent retrying the same refused spawn counts once; distinct agents still count', () => {
  let m = replayFixture({ denials: [0, 1, 2, 3].map((i) => denial('agent-fake-a', 'type-required', i)), done: 5 });
  assert.deepEqual(m.rewriteActors, { since: 1, base: 0 });
  assert.equal(metricOf(m, 'spawn-rewrites').status, 'ok');
  m = replayFixture({ denials: ['a', 'b', 'c', 'd'].map((a, i) => denial('agent-fake-' + a, 'type-required', i)), done: 5 });
  assert.equal(metricOf(m, 'spawn-rewrites').status, 'flag', 'a type-required guard denying every spawn still shows');
});

test('0.31.76 partial-share: a planned hand-off ending is not a partial; unplanned partials still count', () => {
  let m = replayFixture({ planned: 12, unplanned: 1, done: 31 });
  assert.equal(m.workers.since.plannedHandoffs, 12); assert.equal(m.workers.since.partialPct, 3.1);
  assert.equal(metricOf(m, 'partial-share').status, 'ok');
  m = replayFixture({ planned: 0, unplanned: 20, done: 24 });
  assert.equal(metricOf(m, 'partial-share').status, 'flag');
});

test('0.31.76 replay: the E7 window (4 retries of one agent, 54% partial that is hand-offs) gives no flag and no hold', () => {
  const m = replayFixture({ denials: [0, 1, 2, 3].map((i) => denial('agent-fake-a', 'type-required', i)), planned: 12, unplanned: 1, done: 11 });
  const e = W.evaluate(m);
  assert.deepEqual(e.flags.map((f) => f.name).filter((x) => x !== 'usage-source-empty'), [], 'the fixture has no usage source, which never holds');
  assert.ok(!e.metrics.some((x) => x.hold && x.status === 'flag'));
});

test('0.31.76 replay: the real defect of E3 (hand-off guard end-blocks on valid hand-offs) still flags', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ at: T + HOUR + i * 60e3, session_id: 'sess-fake-2', agent_id: 'agent-fake-' + i, limit: 'hard', action: 'end-block' }));
  const m = replayFixture({ spawns: 37, handoffRows: rows, planned: 10, done: 20 });
  assert.ok(W.evaluate(m).flags.map((f) => f.name).includes('handoff-end-block'));
});
