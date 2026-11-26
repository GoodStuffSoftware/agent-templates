// Post-release hold (0.31.63 part 2): while release-hold.json is active, new spawns and resumes are denied, the resource
// queue admits nothing new, running workers are told to hand off, and the operator's "clear hold" lifts it.
// Invented data only. Every guard fails open on an unreadable hold file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeFixture, runHook, decisionOf, PLUGIN_ROOT, queueFreeEnv } from './helpers.mjs';
import { gateDecision } from '../hooks/lib/resource-gate.mjs';
import { evaluate } from '../scripts/release-watch.mjs';

const holdFile = () => join(process.env.AGENT_COMPANION_STATE_DIR, 'state', 'release-hold.json');
const putHold = (obj) => { mkdirSync(join(process.env.AGENT_COMPANION_STATE_DIR, 'state'), { recursive: true }); writeFileSync(holdFile(), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const HOLD = { since: '2026-03-01T12:00:00.000Z', version: '9.9.9', reason: 'test', flags: [{ name: 'guard:demo/deny' }], workers: 'handoff', clearedAt: null };
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

function withFx(fn) {
  const fx = makeFixture();
  return Promise.resolve().then(() => fn(fx)).finally(() => fx.cleanup());
}

// ---- spawn-guard
const spawnPayload = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_input: { description: 'demo', prompt: 'Goal: demo', subagent_type: 'general-purpose' } };

test('spawn-guard: held -> deny naming the hold and the way to clear it', () => withFx(() => {
  putHold(HOLD);
  const r = runHook('hooks/spawn-guard.mjs', spawnPayload);
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(reason(r), /post-release hold/);
  assert.doesNotMatch(reason(r), /release-watch\.mjs clear/, 'agents are not given the clear command');
  assert.match(reason(r), /clear hold/);
  assert.match(reason(r), /guard:demo\/deny/);
}));

test('spawn-guard: not held -> the hold text is absent', () => withFx(() => {
  const r = runHook('hooks/spawn-guard.mjs', spawnPayload);
  assert.doesNotMatch(reason(r), /post-release hold/);
}));

test('spawn-guard: a cleared or unreadable hold file fails open', () => withFx(() => {
  for (const bad of ['{not json', '[]', '"x"', JSON.stringify({ ...HOLD, clearedAt: '2026-03-01T13:00:00Z' })]) {
    putHold(bad);
    assert.doesNotMatch(reason(runHook('hooks/spawn-guard.mjs', spawnPayload)), /post-release hold/, bad);
  }
}));

// ---- resume-guard: only a worker idle past 2 minutes counts as a restart
function idleWorker(root, ageMs) {
  const sub = join(root, 'session', 'subagents');
  mkdirSync(sub, { recursive: true });
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - ageMs).toISOString(), message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(sub, 'agent-a1.jsonl'), `${line}\n`);
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'worker-x', model: 'claude-haiku-4-5-20251001' }));
  return join(root, 'session', 'main.jsonl');
}
const resume = (main) => runHook('hooks/resume-guard.mjs', { session_id: 's1', transcript_path: main, tool_name: 'SendMessage', tool_input: { to: 'worker-x', message: 'hi' } });

test('resume-guard: held -> an idle worker is not restarted; a running one can still be messaged; not held -> no hold text', () => withFx(() => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rh-'));
  try {
    const idle = idleWorker(root, 10 * 60e3);
    assert.doesNotMatch(reason(resume(idle)), /post-release hold/, 'not held');
    putHold(HOLD);
    const r = resume(idle);
    assert.equal(decisionOf(r.json), 'deny');
    assert.match(reason(r), /post-release hold/);
    const busy = idleWorker(root, 5e3);
    assert.notEqual(decisionOf(resume(busy).json), 'deny', 'a running worker can be told to hand off');
    putHold('garbage');
    assert.notEqual(decisionOf(resume(idle).json), 'deny', 'bad hold file fails open');
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

// ---- resource queue: admission refused, exit nonzero, command not run
function queueRun(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rq-hold-'));
  const marker = join(root, 'ran.txt');
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'resource-queue.mjs'), 'run', '--resource', 'box:1', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...queueFreeEnv(), CI_BUDGET_DIR: join(root, 'ledger'), CI_LOCAL_LOCK_DIR: join(root, 'legacy'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ...extraEnv },
  });
  const ran = existsSync(marker);
  rmSync(root, { recursive: true, force: true });
  return { r, ran };
}

test('resource-queue run: held -> refused with the hold message, nonzero exit, command not run; not held -> runs', () => withFx(() => {
  const ok = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.equal(ok.ran, true);
  putHold(HOLD);
  const held = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.notEqual(held.r.status, 0);
  assert.match(held.r.stderr, /post-release hold/);
  assert.equal(held.ran, false);
  putHold('{broken');
  const bad = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.equal(bad.r.status, 0, 'a bad hold file fails open');
}));

// ---- resource-gate: deny with the hold text instead of rewriting
test('resource-gate: held -> a heavy command is denied with the hold text, not rewritten; not held -> rewritten', () => withFx(async () => {
  const opts = { cwd: process.cwd(), mode: 'rewrite', env: { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home' }, exists: () => false, read: () => null };
  const free = await gateDecision('pnpm test:e2e', opts);
  assert.equal(free.action, 'rewrite');
  putHold(HOLD);
  const held = await gateDecision('pnpm test:e2e', opts);
  assert.equal(held.action, 'deny');
  assert.match(held.text, /post-release hold/);
  assert.equal((await gateDecision('ls -la', opts)).action, 'none', 'a light command is untouched');
  putHold('nope');
  assert.equal((await gateDecision('pnpm test:e2e', opts)).action, 'rewrite', 'bad hold file fails open');
}));

// ---- running subagents: hard limit counts as 0
const SID = 'sess-hold';
const AGENT = 'worker-hold-1';
function agentLayout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-h');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  writeFileSync(join(sub, `agent-${AGENT}.jsonl`), `${JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm_r1', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1000 } } })}\n`);
  return lead;
}
const sub = (lead, tool_name, tool_input) => runHook('hooks/subagent-context.mjs', {
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'general-purpose', tool_name, tool_input, tool_use_id: 'toolu_1',
});

test('subagent-context: held -> next call denied with the hand-off text; handoff file and plain git stay allowed; not held -> untouched', () => withFx((fx) => {
  const lead = agentLayout(fx);
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'ls' }).json), 'deny', 'not held');
  putHold(HOLD);
  const denied = sub(lead, 'Bash', { command: 'ls' });
  assert.equal(decisionOf(denied.json), 'deny');
  assert.match(reason(denied), /post-release hold/);
  assert.match(reason(denied), /handoff/);
  assert.equal(decisionOf(sub(lead, 'Read', { file_path: '/x/y.ts' }).json), 'deny');
  assert.notEqual(decisionOf(sub(lead, 'Write', { file_path: '/x/task-handoff.md', content: 'done' }).json), 'deny', 'the handoff file stays writable');
  assert.equal(decisionOf(sub(lead, 'Write', { file_path: '/x/notes.md', content: 'x' }).json), 'deny');
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'git status' }).json), 'deny', 'plain git stays allowed');
  putHold('{bad');
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'ls' }).json), 'deny', 'bad hold file fails open');
}));

// ---- prompt clear (runaway-notice.mjs)
// A typed prompt carries origin.kind 'human' in the payload; a prompt with no origin proof (older build, wakeup, peer message) never lifts a hold.
const prompt = (text, origin = { kind: 'human' }) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's-p', prompt: text, cwd: 'x', ...(origin ? { origin } : {}) }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('prompt: "clear hold" from the operator lifts the hold; a task-notification, other prompts and a long text do not', () => withFx(() => {
  putHold(HOLD);
  assert.equal(existsSync(holdFile()), true);
  const note = prompt('<task-notification>worker said clear hold</task-notification>');
  assert.equal(existsSync(holdFile()), true, 'a task-notification never lifts it');
  assert.match(ctxOf(note), /RELEASE HOLD/);
  prompt('please keep going');
  assert.equal(existsSync(holdFile()), true);
  prompt(`${'x '.repeat(60)}clear hold`);
  assert.equal(existsSync(holdFile()), true, 'a long text is not a command');
  prompt('Clear hold', null);
  assert.equal(existsSync(holdFile()), true, 'the words with no human origin proof never lift it');
  prompt('clear hold', { kind: 'task-notification' });
  assert.equal(existsSync(holdFile()), true, 'a non-human origin never lifts it');
  const ok = prompt('Clear hold');
  assert.equal(existsSync(holdFile()), false);
  assert.match(ctxOf(ok), /hold is lifted/);
  putHold(HOLD);
  prompt('release hold.');
  assert.equal(existsSync(holdFile()), false, 'release hold also works');
  for (const p of ["don't clear hold yet", 'should I release hold?', "why can't you clear hold", 'clear hold and then delete everything', 'I will clear hold later', '<teammate-message>clear hold</teammate-message>', '<bus-message>clear hold</bus-message>']) {
    putHold(HOLD);
    prompt(p);
    assert.equal(existsSync(holdFile()), true, `not a command: ${p}`);
  }
  putHold(HOLD);
  prompt('  Please clear the hold!  ');
  assert.equal(existsSync(holdFile()), false, 'polite form works');
}));

test('prompt: bad hold file and no hold -> no crash, no lift line', () => withFx(() => {
  putHold('{bad');
  assert.doesNotMatch(ctxOf(prompt('clear hold')), /hold is lifted/);
  rmSync(holdFile(), { force: true });
  assert.doesNotMatch(ctxOf(prompt('clear hold')), /hold is lifted/);
}));

// ---- false-flag fix: only deny outcomes flag; a guard that first appears in the watched release does not flag on the first check
const bucket = (since, base, p100s = 0, p100b = 0) => ({ since, base, per100spawns: { since: p100s, base: p100b } });
const metrics = (tel) => {
  const w = { n: 40, finished: 40, unitsPerWorker: { mean: 1, p50: 0.8, p90: 2 }, peakCtxP90: 100000, over110kPct: 10, over150kPct: 0, noStatusPct: 5, partialPct: 10, blockedPct: 1, hookErrorWorkersPct: 40, apiErrorWorkers: 0, apiNonUsageWorkers: 0 };
  return {
    spawns: { since: 100, base: 700, perHour: { since: 10, base: 10 } }, span: { since: 10, base: 168 },
    telemetry: tel, bash: { since: { n: 300, realFails: 12, realFailPct: 4, refusals: 0, refusalPer100: 0 }, base: { n: 500, realFails: 20, realFailPct: 4, refusals: 0, refusalPer100: 0 } }, bashExit: {}, activeHours: { since: 10, base: 100 },
    queueClears: { since: 0, base: 5, perHour: { since: 0, base: 0.03 } },
    workers: { since: { ...w }, base: { ...w } }, hookSignatures: { since: {}, base: {} },
  };
};
const names = (m, o) => { try { return evaluate(m, o).flags.map((f) => f.name); } catch (e) { return `threw: ${e.message}`; } };

test('evaluate: warn and autofix outcomes never flag; a new deny guard flags on its rate per 100 spawns over a floor, not on presence', () => {
  const warns = metrics({ 'denial:poll-guard/warn': bucket(9, 0, 9, 0), 'denial:routing-autofix/autofix': bucket(12, 0, 12, 0) });
  assert.deepEqual(names(warns), []);
  assert.deepEqual(names(metrics({ 'denial:new-guard/deny': bucket(5, 0, 12, 0) })), ['guard:new-guard/deny'], '12 per 100 spawns, over the floor of 10');
  assert.deepEqual(names(metrics({ 'denial:new-guard/deny': bucket(5, 0, 4, 0) })), [], 'present but under the floor');
  assert.deepEqual(names(metrics({ 'denial:new-guard/deny': bucket(2, 0, 30, 0) })), [], 'too few hits');
});

// ---- 0.31.64 ack fixes: transcript scan depth, fresh-session ack, tick confirms "clear hold", legacy-ack window
import * as S from '../hooks/lib/release-watch-state.mjs';

const FLAG = [{ name: 'queue-clears', value: 3.6, detail: 'x' }];
let flagSeq = 0;
const freshFlag = () => [{ name: `queue-flag-${++flagSeq}`, value: 3.6, detail: 'x' }]; // a new name each time: an answered name is on cooldown
const iso = (t) => new Date(t).toISOString();
const urec = (at, text, origin = { kind: 'human' }) => JSON.stringify({ type: 'user', ...(origin ? { origin } : {}), timestamp: iso(at), message: { content: text } });
const filler = (at, bytes) => JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'text', text: 'x'.repeat(bytes) }] } });
const mkTranscript = (fx, name, lines) => { const p = join(fx.dir, `${name}.jsonl`); writeFileSync(p, lines.join('\n') + '\n'); return p; };
const readFlagNow = () => S.readFlag();
const hookEnv = { env: { CLAUDE_CODE_SESSION_ATTENDED: '1', AC_ATTENDED: '1' } };
const promptHook = (session, text, extra = {}) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: text, cwd: 'x', ...extra }, hookEnv);
const startHook = (session) => runHook('hooks/scout-surface.mjs', { hook_event_name: 'SessionStart', session_id: session, source: 'startup', cwd: 'x' }, hookEnv);

test('confirm: the human record is found even when more than 256 KB follows it; past the 16 MB cap it is not', () => withFx((fx) => {
  const t0 = Date.now();
  S.openFlag({ version: '9', flags: FLAG, at: t0 - 60e3 });
  S.noteShown('s1', t0 - 30e3);
  const lines = [urec(t0 - 1000, 'looks fine'), ...Array.from({ length: 12 }, (_, i) => filler(t0 + i, 64 * 1024))]; // ~768 KB after the human record
  const tp = mkTranscript(fx, 'busy', lines);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: tp, prompt: 'looks fine', at: t0 }));
  const ack = S.confirmCandidates({ at: t0 + 5000 });
  assert.ok(ack, 'confirmed from a transcript whose end holds only filler');
  assert.equal(ack.signal, 'transcript-origin-human');
  assert.ok(readFlagNow().ackedAt);
  // Past the hard cap the record is out of reach: no ack, and the candidate is kept until the TTL.
  S.openFlag({ version: '10', flags: [{ name: 'queue-denied', value: 20, detail: 'y' }], at: t0 + 10e3 });
  S.noteShown('s1', t0 + 11e3);
  const big = [urec(t0 + 12e3, 'acknowledged'), ...Array.from({ length: 17 }, (_, i) => filler(t0 + 13e3 + i, 1024 * 1024))];
  const tp2 = mkTranscript(fx, 'huge', big);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: tp2, prompt: 'acknowledged', at: t0 + 14e3 }));
  assert.equal(S.confirmCandidates({ at: t0 + 15e3 }), null, 'a record more than 16 MB back is not read');
}));

test('fresh session: the flag shown at SessionStart is recorded, so the first reply typed there acks (also one starting with "[" or "<")', () => withFx(() => {
  for (const reply of ['ack', '[ack]', '<ack>']) {
    S.openFlag({ version: '9', flags: freshFlag(), at: Date.now() });
    const out = startHook('fresh-1');
    assert.match(out.stdout, /RELEASE WATCH 9/, 'SessionStart shows the flag');
    assert.ok(readFlagNow().shownTo['fresh-1'], 'SessionStart recorded the flag as shown to the session');
    const r = promptHook('fresh-1', reply, { origin: { kind: 'human' } });
    assert.doesNotMatch(r.stdout || '', /RELEASE WATCH/, `answered by the first reply: ${reply}`);
    const f = readFlagNow();
    assert.ok(f.ackedAt, `acked: ${reply}`);
    assert.equal(f.ack.signal, 'payload-origin-human');
    S.writeJson(S.paths().flag, { ...f, clearedAt: iso(Date.now()) });
  }
}));

test('prompt: only exact automated markers are skipped; a bracketed reply with no origin is still a candidate for the transcript check', () => withFx(() => {
  S.openFlag({ version: '9', flags: FLAG, at: Date.now() });
  startHook('s-m');
  promptHook('s-m', '<task-notification>done</task-notification>', { origin: null });
  assert.deepEqual(readFlagNow().candidates, [], 'a task-notification text is no candidate');
  promptHook('s-m', '[ack]');
  assert.equal(readFlagNow().candidates.length, 1);
  assert.equal(readFlagNow().ackedAt, null);
}));

test('transcript only: no origin in the payload, the typed record in the transcript acks on the next hook run; a task-notification or scheduled record with the same text does not', () => withFx((fx) => {
  for (const [name, origin, acks] of [['human', { kind: 'human' }, true], ['notification', { kind: 'task-notification' }, false], ['scheduled', { kind: 'scheduled' }, false]]) {
    S.openFlag({ version: '9', flags: freshFlag(), at: Date.now() });
    const sid = `s-t-${name}`;
    promptHook(sid, 'first look');                       // shows the flag: the session is now recorded as shown
    assert.ok(readFlagNow().shownTo[sid]);
    const tp = mkTranscript(fx, `tr-${name}`, [urec(Date.now() + 200, 'ack', origin)]);
    promptHook(sid, 'ack', { transcript_path: tp });   // payload carries no origin: a candidate
    assert.equal(readFlagNow().ackedAt, null, 'not acked on the turn itself');
    assert.equal(readFlagNow().candidates.length, 1);
    promptHook(sid, 'anything', { transcript_path: tp });          // the next hook run confirms against the transcript
    const f = readFlagNow();
    if (acks) { assert.ok(f.ackedAt, 'acked from the transcript'); assert.equal(f.ack.signal, 'transcript-origin-human'); }
    else assert.equal(f.ackedAt, null, `a ${name} record never acks`);
    S.writeJson(S.paths().flag, { ...f, clearedAt: iso(Date.now()) });
  }
}));

test('hold: the tick confirms a pending "clear hold" from the transcript, so the operator need not repeat it', () => withFx((fx) => {
  const t0 = Date.now();
  S.openFlag({ version: '9', flags: FLAG, at: t0 - 3600e3 });
  S.noteShown('s1', t0 - 60e3);
  putHold({ ...HOLD, since: iso(t0 - 30e3) });
  assert.equal(S.isHoldActive(), true);
  const tp = mkTranscript(fx, 'clr', [urec(t0 - 500, 'clear hold')]);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: tp, prompt: 'clear hold', at: t0 }), 'recorded during the hold');
  assert.equal(S.maybeHold({ holdMinutes: 30, at: t0 + 5000 }), null);
  assert.equal(S.isHoldActive(), false, 'the tick lifted the hold');
  // A candidate whose record is not typed leaves the hold in place.
  S.openFlag({ version: '9', flags: freshFlag(), at: t0 - 3600e3 });
  S.noteShown('s1', t0 + 1000);
  putHold({ ...HOLD, since: iso(t0) });
  const tp2 = mkTranscript(fx, 'clr2', [urec(t0 + 60e3, 'clear hold', { kind: 'scheduled' })]);
  S.writeJson(S.paths().flag, { ...readFlagNow(), candidates: [] });
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: tp2, prompt: 'clear hold', at: t0 + 61e3 }));
  S.maybeHold({ holdMinutes: 30, at: t0 + 62e3 });
  assert.equal(S.isHoldActive(), true);
}));

test('findHumanRecordNear: a slow hook (up to 30 s) still finds the typed record; with a text hash only that text counts', () => withFx((fx) => {
  const t0 = Date.parse('2026-03-01T12:00:00Z');
  const proj = join(fx.dir, 'projects', 'p1'); mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'sess-a.jsonl'), [urec(t0, 'ok go'), urec(t0 + 1000, 'sched', { kind: 'scheduled' })].join('\n') + '\n');
  const find = (o) => S.findHumanRecordNear({ projectsDir: join(fx.dir, 'projects'), near: t0 + 25e3, ...o });
  assert.equal(find({})?.session, 'sess-a', '25 s later, inside the 30 s window');
  assert.equal(find({ near: t0 + 40e3 }), null, 'outside the window');
  assert.equal(find({ sha: S.promptSha('ok go') })?.promptAt, t0, 'the hash of the text matches');
  assert.equal(find({ sha: S.promptSha('something else') }), null, 'a different text is not the reply');
  assert.equal(find({ near: t0 + 1000 })?.promptAt, t0, 'only typed records count, never the scheduled one');
}));

// ---- held sessions through the hooks (0.31.66)
const heldFile = () => join(process.env.AGENT_COMPANION_STATE_DIR, 'state', 'release-hold-sessions.json');
const sessionsOf = () => JSON.parse(readFileSync(heldFile(), 'utf8')).sessions;
const promptAs = (sid, text, origin = { kind: 'human' }) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: text, cwd: '/w/demo', transcript_path: '/t/demo.jsonl', ...(origin ? { origin } : {}) }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });

test('hold notice records the lead session; after the clear each recorded lead gets the cleared notice once, others never', () => withFx(() => {
  putHold(HOLD);
  const shown = promptAs('lead-a', 'status?');
  assert.match(ctxOf(shown), /Stop and wait: end your turn now\. A local message arrives/);
  assert.doesNotMatch(ctxOf(shown), /CronCreate|cron/);
  promptAs('lead-a', 'and now?');
  promptAs('lead-b', 'hello');
  const l = sessionsOf();
  assert.equal(l.length, 2, 'deduped by session');
  assert.equal(l.find((x) => x.sessionId === 'lead-a').cwd, '/w/demo');
  assert.equal(l.find((x) => x.sessionId === 'lead-a').transcriptPath, '/t/demo.jsonl');
  const ok = promptAs('lead-b', 'clear hold');
  assert.match(ctxOf(ok), /hold is lifted/);
  assert.doesNotMatch(ctxOf(promptAs('lead-b', 'next')), /was cleared at/, 'the session that lifted it was told already');
  const n = promptAs('lead-a', 'continue');
  assert.match(ctxOf(n), /post-release hold was cleared at .* by the operator\. Resume from your handoff or where you stopped\./);
  assert.doesNotMatch(ctxOf(promptAs('lead-a', 'again')), /was cleared at/, 'once');
  assert.doesNotMatch(ctxOf(promptAs('lead-z', 'hi')), /was cleared at/, 'never held, never told');
}));

test('subagent denied by the hold: handoff-and-stop wording only, no cron; the denial is recorded as a subagent', () => withFx((fx) => {
  const lead = agentLayout(fx);
  putHold(HOLD);
  const denied = sub(lead, 'Bash', { command: 'ls' });
  assert.equal(decisionOf(denied.json), 'deny');
  assert.match(reason(denied), /Write your handoff and stop/);
  assert.doesNotMatch(reason(denied), /CronCreate/);
  assert.ok(sessionsOf().some((x) => x.agentId), 'recorded with its agent id');
}));

// ---- the local message each held lead is owed after a clear (hooks/hold-message.mjs) ----
const L_A = 'local_aaaa1111-0000-4000-8000-000000000001';
const L_B = 'local_bbbb2222-0000-4000-8000-000000000002';
const L_SELF = 'local_cccc3333-0000-4000-8000-000000000003';
const clearOut = (...ids) => `cleared (flag true, hold true)\nheld sessions: ${ids.length} lead, 0 subagent\nSend each of these sessions a local message now: ${ids.join(' ')}\n`;
const clearPayload = (tp, stdout, command = 'node /p/scripts/release-watch.mjs clear --by operator') => ({ hook_event_name: 'PostToolUse', session_id: 'lead-self', transcript_path: tp, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } });
const stopPayload = (tp, extra = {}) => ({ hook_event_name: 'Stop', session_id: 'lead-self', transcript_path: tp, ...extra });
const sendUse = (name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] } }) + '\n';
const pendingFile = () => join(process.env.AGENT_COMPANION_STATE_DIR, 'state', 'release-hold-message-pending.json');

test('hold-message post: a Bash clear adds the send-a-local-message instruction with the ids and records the owed ids; other commands add nothing', () => withFx((fx) => {
  const tp = join(fx.dir, 't.jsonl'); writeFileSync(tp, 'x\n');
  const r = runHook('hooks/hold-message.mjs', clearPayload(tp, clearOut(L_A, L_B)), { args: ['--event', 'post'] });
  assert.match(ctxOf(r), new RegExp(`Send each of these sessions a local message now: ${L_A} ${L_B}`));
  assert.match(ctxOf(r), /SendMessage/); assert.match(ctxOf(r), /mcp__ccd_session_mgmt__send_message/);
  assert.deepEqual(JSON.parse(readFileSync(pendingFile(), 'utf8'))['lead-self'].ids, [L_A, L_B]);
  assert.equal(ctxOf(runHook('hooks/hold-message.mjs', clearPayload(tp, clearOut(L_A), 'node /p/scripts/release-watch.mjs status'), { args: ['--event', 'post'] })), '');
  assert.equal(ctxOf(runHook('hooks/hold-message.mjs', clearPayload(tp, 'cleared (flag true, hold true)\nheld sessions: none recorded\n'), { args: ['--event', 'post'] })), '', 'no ids: nothing to say');
  assert.equal(ctxOf(runHook('hooks/hold-message.mjs', { ...clearPayload(tp, clearOut(L_A)), agent_id: 'sub-1' }, { args: ['--event', 'post'] })), '', 'a subagent is not the lead');
}));

test('hold-message post: the session that ran the clear is not told to message itself', () => withFx((fx) => {
  const desk = join(fx.dir, 'desk', 'acct', 'org'); mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, L_SELF + '.json'), JSON.stringify({ sessionId: L_SELF, cliSessionId: 'lead-self' }));
  const r = runHook('hooks/hold-message.mjs', clearPayload(join(fx.dir, 'none.jsonl'), clearOut(L_SELF, L_B)), { args: ['--event', 'post'], env: { AGENT_COMPANION_DESKTOP_SESSIONS_DIR: join(fx.dir, 'desk') } });
  assert.doesNotMatch(ctxOf(r), new RegExp(L_SELF)); assert.match(ctxOf(r), new RegExp(L_B));
}));

test('hold-message stop: blocks once naming the ids not yet messaged; counts SendMessage to and ccd send_message session_id since the clear; never a second block', () => withFx((fx) => {
  const tp = join(fx.dir, 't.jsonl');
  writeFileSync(tp, sendUse('SendMessage', { to: L_A, message: 'before the clear: does not count' }));
  runHook('hooks/hold-message.mjs', clearPayload(tp, clearOut(L_A, L_B)), { args: ['--event', 'post'] });
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(tp, { agent_id: 'sub-1' }), { args: ['--event', 'stop'] }).json, null, 'a subagent end is never blocked');
  appendFileSync(tp, sendUse('SendMessage', { to: L_A, message: 'hold cleared, resume' }));
  const b = runHook('hooks/hold-message.mjs', stopPayload(tp), { args: ['--event', 'stop'] });
  assert.equal(b.json.decision, 'block');
  assert.match(b.json.reason, new RegExp(L_B)); assert.doesNotMatch(b.json.reason, new RegExp(L_A));
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(tp), { args: ['--event', 'stop'] }).json, null, 'one block at most');
}));

test('hold-message stop: every id messaged (either tool) -> no block and the owed record is dropped; no record -> silent', () => withFx((fx) => {
  const tp = join(fx.dir, 't.jsonl'); writeFileSync(tp, '');
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(tp), { args: ['--event', 'stop'] }).json, null, 'nothing owed');
  runHook('hooks/hold-message.mjs', clearPayload(tp, clearOut(L_A, L_B)), { args: ['--event', 'post'] });
  appendFileSync(tp, sendUse('SendMessage', { to: L_A, message: 'resume' }) + sendUse('mcp__ccd_session_mgmt__send_message', { session_id: L_B, message: 'resume' }));
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(tp), { args: ['--event', 'stop'] }).json, null);
  assert.equal(JSON.parse(readFileSync(pendingFile(), 'utf8'))['lead-self'], undefined);
}));

test('hold-message stop: fails open on an unreadable transcript path (still blocks only once) and on a broken record file', () => withFx((fx) => {
  runHook('hooks/hold-message.mjs', clearPayload(join(fx.dir, 'gone.jsonl'), clearOut(L_A)), { args: ['--event', 'post'] });
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(join(fx.dir, 'gone.jsonl')), { args: ['--event', 'stop'] }).json.decision, 'block');
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(join(fx.dir, 'gone.jsonl')), { args: ['--event', 'stop'] }).json, null);
  writeFileSync(pendingFile(), '{broken');
  assert.equal(runHook('hooks/hold-message.mjs', stopPayload(join(fx.dir, 'gone.jsonl')), { args: ['--event', 'stop'] }).json, null);
}));

test('the prompt that lifts the hold also gets the instruction for the other mapped held leads', () => withFx((fx) => {
  const desk = join(fx.dir, 'desk', 'acct', 'org'); mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, L_A + '.json'), JSON.stringify({ sessionId: L_A, cliSessionId: 'lead-a' }));
  const e = { CLAUDE_CODE_SESSION_ATTENDED: '1', AGENT_COMPANION_DESKTOP_SESSIONS_DIR: join(fx.dir, 'desk') };
  const as = (sid, text) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: text, cwd: '/w/demo', transcript_path: '/t/demo.jsonl', origin: { kind: 'human' } }, { env: e });
  putHold(HOLD);
  as('lead-a', 'status?');
  const ok = as('lead-b', 'clear hold');
  assert.match(ctxOf(ok), /hold is lifted/);
  assert.match(ctxOf(ok), new RegExp(`Send each of these sessions a local message now: ${L_A}`));
}));

// ---- 0.31.66 round: owed messages on every lift, locks, cap order ----
const liftByTick = (fx, held) => {
  const t0 = Date.now();
  S.openFlag({ version: '9', flags: freshFlag(), at: t0 - 3600e3 });
  S.noteShown('s1', t0 - 60e3);
  putHold({ ...HOLD, since: iso(t0 - 30e3) });
  for (const h of held) S.noteHeld(h, t0 - 20e3);
  const tp = mkTranscript(fx, 'tick-lift', [urec(t0 - 500, 'clear hold')]);
  assert.ok(S.noteCandidate({ sessionId: 's1', transcriptPath: tp, prompt: 'clear hold', at: t0 }));
  S.maybeHold({ holdMinutes: 30, at: t0 + 5000 });
  assert.equal(S.isHoldActive(), false, 'the tick lifted the hold');
  return tp;
};
const HELD_LEADS = [{ session_id: 'lead-a', cwd: '/w/a', transcript_path: '/t/a.jsonl' }, { session_id: 'lead-b', cwd: '/w/b', transcript_path: '/t/b.jsonl' }, { session_id: 'sub-1', agent_id: 'ag1', cwd: '/w/a' }];

test('owed: a lift by the tick records who is owed; the next lead prompt gets the message instruction (unmapped leads by Claude Code session id), the Stop hook blocks once, the claim is once', () => withFx((fx) => {
  const desk = join(fx.dir, 'desk', 'acct', 'org'); mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, L_A + '.json'), JSON.stringify({ sessionId: L_A, cliSessionId: 'lead-a' }));
  const prevDesk = process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR; process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR = join(fx.dir, 'desk'); // the lift (this process) maps the held leads
  try { liftByTick(fx, HELD_LEADS); } finally { if (prevDesk === undefined) delete process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR; else process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR = prevDesk; }
  assert.deepEqual(S.owedSessions().map((x) => x.sessionId).sort(), ['lead-a', 'lead-b', 'sub-1'], 'recorded and unclaimed');
  const tp = join(fx.dir, 'lead-c.jsonl'); writeFileSync(tp, 'x\n');
  const e = { CLAUDE_CODE_SESSION_ATTENDED: '1', AGENT_COMPANION_DESKTOP_SESSIONS_DIR: join(fx.dir, 'desk') };
  const first = runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'lead-c', prompt: 'status?', cwd: '/w/c', transcript_path: tp, origin: { kind: 'human' } }, { env: e });
  assert.match(ctxOf(first), /no desktop session to message/);
  assert.match(ctxOf(first), new RegExp(`Send each of these sessions a local message now: ${L_A}`), 'the mapped lead by its desktop id');
  assert.match(ctxOf(first), /lead-b \(cwd \/w\/b\)/, 'the unmapped lead by its Claude Code session id');
  assert.doesNotMatch(ctxOf(first), /lead-a \(cwd/, 'a mapped lead is not in the unmapped list');
  assert.doesNotMatch(ctxOf(first), /sub-1/, 'a subagent is not a lead to message');
  assert.deepEqual(S.owedSessions(), [], 'claimed');
  assert.ok(S.readPendingMessages('lead-c'), 'the claim is recorded so the Stop hook can hold the session to it');
  const again = runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'lead-d', prompt: 'hello', cwd: '/w/d', transcript_path: '/t/d.jsonl', origin: { kind: 'human' } }, { env: e });
  assert.doesNotMatch(ctxOf(again), /no desktop session to message|Send each of these/, 'no second lead is told');
  const stop = runHook('hooks/hold-message.mjs', { hook_event_name: 'Stop', session_id: 'lead-c', transcript_path: tp }, { args: ['--event', 'stop'] });
  assert.equal(stop.json && stop.json.decision, 'block');
  assert.equal(runHook('hooks/hold-message.mjs', { hook_event_name: 'Stop', session_id: 'lead-c', transcript_path: tp }, { args: ['--event', 'stop'] }).json, null, 'one block at most');
}));

test('owed: release-watch held lists the sessions still owed a message after a lift nobody claimed, and nothing once claimed', () => withFx((fx) => {
  liftByTick(fx, HELD_LEADS);
  const env = { ...process.env, AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR, AGENT_COMPANION_DESKTOP_SESSIONS_DIR: join(fx.dir, 'none') };
  const run = (...a) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'release-watch.mjs'), ...a], { env, encoding: 'utf8', windowsHide: true });
  const out = run('held');
  assert.match(out.stdout, /hold cleared; these sessions are still owed a local message/);
  assert.match(out.stdout, /lead-a/); assert.match(out.stdout, /lead-b/);
  const j = JSON.parse(run('held', '--json').stdout);
  assert.equal(j.owed, true); assert.equal(j.held, false); assert.equal(j.sessions.length, 3);
  S.takeOwedMessages('lead-z');
  assert.doesNotMatch(run('held').stdout, /still owed a local message/);
}));

test('owed: a typed "clear hold" lists the unmapped leads by Claude Code session id, and a lead sees the owed text once', () => withFx(() => {
  putHold(HOLD);
  promptAs('lead-a', 'status?');
  promptAs('lead-b', 'hello');
  const ok = promptAs('lead-b', 'clear hold');
  assert.match(ctxOf(ok), /hold is lifted/);
  assert.match(ctxOf(ok), /no desktop session to message/);
  assert.match(ctxOf(ok), /lead-a \(cwd \/w\/demo\)/);
  assert.doesNotMatch(ctxOf(ok), /lead-b \(cwd/, 'the lead that lifted it is not told to message itself');
  assert.doesNotMatch(ctxOf(promptAs('lead-a', 'next')), /no desktop session to message/, 'claimed once');
}));

test('held records: capHeld drops subagent records first, then the oldest leads', () => {
  const rec = (sessionId, agentId, t) => ({ sessionId, agentId, firstSeen: iso(t), lastSeen: iso(t) });
  const list = [rec('l1', null, 1000), rec('s1', 'a1', 5000), rec('l2', null, 2000), rec('s2', 'a2', 6000), rec('l3', null, 3000)];
  const kept = S.capHeld(list, 4).map((x) => x.sessionId);
  assert.deepEqual(kept.sort(), ['l1', 'l2', 'l3', 's2'], 'the oldest subagent goes first even though a lead is older');
  const two = S.capHeld(list, 2).map((x) => x.sessionId).sort();
  assert.deepEqual(two, ['l2', 'l3'], 'leads fill the cap before any subagent; the oldest lead goes last');
  assert.equal(S.capHeld(list, 10).length, 5, 'under the cap: untouched');
});

test('held records: parallel writers (separate processes) lose no record', () => withFx(async () => {
  putHold(HOLD);
  const stateDir = process.env.AGENT_COMPANION_STATE_DIR;
  const mod = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'release-watch-state.mjs')).href;
  const code = `const S = await import(process.argv[1]); const i = process.argv[2]; S.noteHeld({ session_id: 'par-' + i, cwd: '/w/' + i, transcript_path: '/t/' + i + '.jsonl' });`;
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, mod, String(i)], { env: { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir }, windowsHide: true, stdio: 'ignore' });
    c.on('error', rej); c.on('exit', res);
  })));
  const ids = sessionsOf().map((x) => x.sessionId).sort();
  assert.deepEqual(ids, Array.from({ length: N }, (_, i) => 'par-' + i).sort(), 'every writer\'s record is kept');
}));
