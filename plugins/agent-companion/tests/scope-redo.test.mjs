// Token bleed guard, phase 2: the new-file tripwire (hooks/scope-tripwire.mjs) and the redo
// alert (hooks/lib/redo-alert.mjs, spawn-guard.mjs, advisory-b.mjs ledger rows).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, decisionOf } from './helpers.mjs';
import { briefSketch, sketchSimilarity, briefBody, firstUserText } from '../hooks/lib/brief-match.mjs';
import { redoNote, REDO_NOTE } from '../hooks/lib/redo-alert.mjs';
import { LOOKUP_DENY_REASON, WRITER_DENY_REASON } from '../hooks/lib/scope-tripwire.mjs';

// --- Fixtures -------------------------------------------------------------------------

const SID = 'lead-sess-1';

// A helper's transcript at the real layout: <project>/<session>/subagents/agent-<id>.jsonl,
// the brief as its first user message.
function helperTranscript(dir, brief, agentId, sid = SID) {
  const proj = join(dir, 'projects', 'p');
  const sub = join(proj, sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  const f = join(sub, `agent-${agentId}.jsonl`);
  writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: brief }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
  ].join('\n') + '\n');
  return { lead: join(proj, `${sid}.jsonl`), file: f };
}

function writeFile(dir, agentId, brief, filePath, extra = {}, env = {}) {
  const { lead } = helperTranscript(dir, brief, agentId);
  return runHook('hooks/scope-tripwire.mjs', {
    session_id: SID, agent_id: agentId, agent_type: 'agent-companion:ac-sonnet-high', transcript_path: lead,
    cwd: dir, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, ...extra,
  }, { env });
}

// --- Tripwire -------------------------------------------------------------------------

const LOOKUP_BRIEF = 'TYPE: research\nROLE: lookup\n\nFind out how the rate limiter in the gateway decides to reject a request and report the rule in three sentences. Read src/gateway/limiter.ts and its tests only.';
const WRITER_BRIEF = 'TYPE: bounded-feature\nROLE: writer\n\nAdd a --dry-run flag to scripts/prune.mjs and cover it in tests/prune.test.mjs. Write notes to notes/prune-dry-run.md.';

test('tripwire: a lookup helper is denied at its first unrequested new file, with the approved reason', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const r = writeFile(dir, 'a1', LOOKUP_BRIEF, join(dir, 'scripts', 'probe.mjs'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decisionOf(r.json), 'deny');
    assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, 'Your brief asks for no new files: report the proposal instead.');
    assert.equal(LOOKUP_DENY_REASON, 'Your brief asks for no new files: report the proposal instead.');
    // The same file again is still denied (a retry does not reset the count).
    assert.equal(decisionOf(writeFile(dir, 'a1', LOOKUP_BRIEF, join(dir, 'scripts', 'probe.mjs')).json), 'deny');
  } finally { cleanup(); }
});

test('tripwire: never counted - a file the brief names, the detail and handoff files, an existing file, scratchpad, the lead', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const brief = `${LOOKUP_BRIEF}\nWrite the answer to out/limiter-answer.md.`;
    const pass = (fp, extra) => assert.equal(decisionOf(writeFile(dir, 'a2', brief, fp, extra).json), null, fp);
    pass(join(dir, 'out', 'limiter-answer.md'));          // the requested output, by path
    pass(join(dir, 'elsewhere', 'limiter-answer.md'));    // ... or by name
    pass(join(dir, 'limiter-detail.md'));                 // <task>-detail.md
    pass(join(dir, 'limiter-handoff.md'));                // handoff file the context notice asks for
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'existing.ts'), 'x');
    pass(join(dir, 'src', 'existing.ts'));                // an overwrite is not a new file
    pass(join(dir, 'tmp', 'scratch.txt'), { scratchpad_dir: join(dir, 'tmp') });
    // The lead's own Write carries no agent_id.
    const lead = runHook('hooks/scope-tripwire.mjs', {
      session_id: SID, cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'a-new-file.mjs'), content: 'x' },
    });
    assert.equal(decisionOf(lead.json), null);
    // A brief that names a directory covers files under it.
    const dirBrief = `${LOOKUP_BRIEF}\nPut the output under reports/out/.`;
    assert.equal(decisionOf(writeFile(dir, 'a3', dirBrief, join(dir, 'reports', 'out', 'x.md')).json), null);
  } finally { cleanup(); }
});

test('tripwire: lookup kinds are research, lookup, survey, explore and verify; a brief without TYPE or ROLE, or a review, is never counted', () => {
  const { dir, cleanup } = makeFixture();
  try {
    let n = 0;
    for (const t of ['research', 'lookup', 'survey', 'explore', 'verify']) {
      n += 1;
      assert.equal(decisionOf(writeFile(dir, `k${n}`, `TYPE: ${t}\n\nlook at the thing`, join(dir, `new${n}.mjs`)).json), 'deny', t);
    }
    assert.equal(decisionOf(writeFile(dir, 'n1', 'look at the thing', join(dir, 'u1.mjs')).json), null);
    assert.equal(decisionOf(writeFile(dir, 'n2', 'TYPE: code-review\nROLE: reviewer\n\nreview it', join(dir, 'u2.mjs')).json), null);
    assert.equal(decisionOf(writeFile(dir, 'n3', 'ROLE: lookup\n\nlook at the thing', join(dir, 'u3.mjs')).json), 'deny'); // ROLE alone selects the kind
  } finally { cleanup(); }
});

test('tripwire: a writer gets one note at the third unrequested new file and is denied from the fourth', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const w = (name) => writeFile(dir, 'w1', WRITER_BRIEF, join(dir, 'src', name));
    assert.equal(decisionOf(w('one.mjs').json), null);
    assert.equal(decisionOf(w('two.mjs').json), null);
    // A file the brief names does not count toward the three.
    assert.equal(decisionOf(writeFile(dir, 'w1', WRITER_BRIEF, join(dir, 'tests', 'prune.test.mjs')).json), null);
    const third = w('three.mjs');
    assert.equal(decisionOf(third.json), 'proceed');
    assert.match(third.json.hookSpecificOutput.additionalContext, /third new file/);
    const fourth = w('four.mjs');
    assert.equal(decisionOf(fourth.json), 'deny');
    assert.equal(fourth.json.hookSpecificOutput.permissionDecisionReason, 'Check in with the lead before building more beyond the brief.');
    assert.equal(WRITER_DENY_REASON, 'Check in with the lead before building more beyond the brief.');
    assert.equal(decisionOf(w('five.mjs').json), 'deny');
    // Another helper starts its own count.
    assert.equal(decisionOf(writeFile(dir, 'w2', WRITER_BRIEF, join(dir, 'src', 'one.mjs')).json), null);
  } finally { cleanup(); }
});

test('tripwire: thresholds are options; scope_tripwire off counts nothing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_SCOPE_TRIPWIRE_WRITER_NOTE: '2', CLAUDE_PLUGIN_OPTION_SCOPE_TRIPWIRE_WRITER_DENY: '3', CLAUDE_PLUGIN_OPTION_SCOPE_TRIPWIRE_LOOKUP_DENY: '2' };
    const w = (name) => writeFile(dir, 'o1', WRITER_BRIEF, join(dir, name), {}, env);
    assert.equal(decisionOf(w('a.mjs').json), null);
    assert.equal(decisionOf(w('b.mjs').json), 'proceed'); // note at the second
    assert.equal(decisionOf(w('c.mjs').json), 'deny');    // denied at the third
    assert.equal(decisionOf(writeFile(dir, 'o2', LOOKUP_BRIEF, join(dir, 'x.mjs'), {}, env).json), null);
    assert.equal(decisionOf(writeFile(dir, 'o2', LOOKUP_BRIEF, join(dir, 'y.mjs'), {}, env).json), 'deny');
    const off = writeFile(dir, 'o3', LOOKUP_BRIEF, join(dir, 'z.mjs'), {}, { CLAUDE_PLUGIN_OPTION_SCOPE_TRIPWIRE: 'false' });
    assert.equal(decisionOf(off.json), null);
  } finally { cleanup(); }
});

test('tripwire: fails open on an unreadable transcript, a missing file_path, an Edit', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const noTranscript = runHook('hooks/scope-tripwire.mjs', {
      session_id: 'nope', agent_id: 'zz', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'n.mjs'), content: 'x' },
    });
    assert.equal(decisionOf(noTranscript.json), null);
    assert.equal(decisionOf(writeFile(dir, 'e1', LOOKUP_BRIEF, undefined).json), null);
    assert.equal(decisionOf(writeFile(dir, 'e2', LOOKUP_BRIEF, join(dir, 'n.mjs'), { tool_name: 'Edit' }).json), null);
  } finally { cleanup(); }
});

test('tripwire: the plugin\'s appended clauses do not name files (the brief proper does)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const appended = `${LOOKUP_BRIEF}\n\n[agent-companion: scope] Create no new files beyond the requested output and the <task>-detail.md detail file.\n[agent-companion: reporting contract] ... probe.mjs ...`;
    assert.equal(decisionOf(writeFile(dir, 'c1', appended, join(dir, 'probe.mjs')).json), 'deny');
  } finally { cleanup(); }
});

test('hooks.json registers the tripwire on Write only', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const e = hooks.hooks.PreToolUse.find((x) => x.hooks.some((h) => h.args.join(' ').includes('scope-tripwire.mjs')));
  assert.ok(e);
  assert.equal(e.matcher, '^Write$');
});

// --- Brief matching -------------------------------------------------------------------

// Three distinct tasks of one TYPE that share the usual acceptance boilerplate, and a re-send of the first.
const ACCEPT = 'Acceptance: tests for the change, a CHANGELOG line, the README row, version bump, CI green, fast-forward main through the normal flow. Do not touch the unrelated modules. Budget: about 60 tool calls; near it, write a handoff file and report partial.';
const BRIEF_A = `TYPE: bounded-feature\nROLE: writer\n\nThe upload client in src/net/uploader.ts gives up on the first network error. Add retry with exponential backoff (base 200 ms, factor 2, at most 5 attempts, jitter up to 20 percent) for connection resets and 502, 503 and 504 responses only; a 4xx must never be retried. Expose the attempt count in the returned result and log each retry at debug level through the existing logger. Cover the schedule, the 4xx case and the give-up case in tests/uploader.retry.test.mjs with a fake clock. ${ACCEPT}`;
const BRIEF_B = `TYPE: bounded-feature\nROLE: writer\n\nThe export command in scripts/export-report.mjs writes a CSV with a hard-coded column order. Add a --columns option that takes a comma-separated list of column names, validates each against the known set, rejects an unknown name with exit code 2 and a message that lists the valid names, and keeps the current order when the option is absent. Update the usage text and add three cases to tests/export-report.test.mjs. ${ACCEPT}`;
const BRIEF_C = `TYPE: bounded-feature\nROLE: writer\n\nThe settings page component in web/src/SettingsPage.tsx re-renders the whole form on every keystroke. Move the draft values into a reducer, memoize the section components, and debounce the autosave call by 400 ms so only the last edit in a burst is sent. Keep the visible behaviour and the existing test ids unchanged, and add a test in web/src/SettingsPage.test.tsx that types five characters quickly and expects one save. ${ACCEPT}`;
const BRIEF_A_RESENT = `${BRIEF_A}\n\nA first attempt stopped partway. Start from what is on the branch, do not redo the finished parts, and finish the retry schedule and its tests.`;

test('briefSketch: re-sent brief scores high, distinct briefs of one type score low', () => {
  const [a, b, c, a2] = [BRIEF_A, BRIEF_B, BRIEF_C, BRIEF_A_RESENT].map(briefSketch);
  assert.ok(a && b && c && a2);
  for (const [x, y, label] of [[a, b, 'A/B'], [a, c, 'A/C'], [b, c, 'B/C']]) {
    assert.ok(sketchSimilarity(x, y) < 0.4, `${label} ${sketchSimilarity(x, y)}`);
  }
  assert.ok(sketchSimilarity(a, a2) > 0.8, String(sketchSimilarity(a, a2)));
  assert.equal(briefSketch('run the tests'), null); // too short to be told apart
  assert.equal(sketchSimilarity(null, a), 0);
});

test('briefBody drops the plugin\'s appended text and the declaration lines; firstUserText reads the brief', () => {
  const body = briefBody(`TYPE: research\nfind the thing in src/a.ts\n\n[agent-companion: scope] clause\nmore`);
  assert.ok(body.includes('src/a.ts') && !body.includes('clause') && !/TYPE/.test(body));
  const { dir, cleanup } = makeFixture();
  try {
    const { file } = helperTranscript(dir, 'hello brief', 'f1');
    assert.equal(firstUserText(file), 'hello brief');
    assert.equal(firstUserText(join(dir, 'missing.jsonl')), '');
  } finally { cleanup(); }
});

// --- Redo alert -----------------------------------------------------------------------

// One helper that ran and stopped: its transcript plus the SubagentStop hook, which writes the ledger row.
function runHelper(dir, brief, agentId, status, sid = SID) {
  const { lead } = helperTranscript(dir, brief, agentId, sid);
  const r = runHook('hooks/advisory-b.mjs', {
    session_id: sid, agent_id: agentId, agent_type: 'agent-companion:ac-sonnet-high', transcript_path: lead,
    last_assistant_message: status ? `STATUS: ${status}\nthe rest` : 'no status line',
  }, { args: ['--event', 'worker-stop'] });
  assert.equal(r.status, 0, r.stderr);
}

function ledgerRows(stateDir, sid = SID) {
  const f = join(stateDir, 'state', 'worker-ledger', `${sid}.jsonl`);
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('ledger: a stop row carries the brief sketch and TYPE next to the STATUS word', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    runHelper(dir, BRIEF_A, 'h1', 'partial');
    const [row] = ledgerRows(stateDir);
    assert.equal(row.ev, 'stop');
    assert.equal(row.status, 'partial');
    assert.equal(row.bty, 'bounded-feature');
    assert.ok(Array.isArray(row.bfp) && row.bfp.length > 20 && row.bfp.every((h) => /^[0-9a-f]{7}$/.test(h)));
    assert.ok(!JSON.stringify(row).includes('uploader'), 'the row holds hashes, never brief text');
  } finally { cleanup(); }
});

function spawn(dir, prompt, sid = 'lead-sess-2') {
  return runHook('hooks/spawn-guard.mjs', {
    session_id: sid, cwd: dir,
    tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', description: 'x', prompt },
  });
}
const noteIn = (r) => String(r.json?.hookSpecificOutput?.additionalContext || '').includes(REDO_NOTE);

test('redo alert: a task that ended partial, spawned again with a re-sent brief, gets the note', () => {
  const { dir, cleanup } = makeFixture();
  try {
    runHelper(dir, BRIEF_A, 'h1', 'partial');
    const r = spawn(dir, BRIEF_A_RESENT);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(decisionOf(r.json), 'deny', r.stdout);
    assert.ok(noteIn(r), r.stdout);
    assert.equal(REDO_NOTE, 'third attempt at this task: re-brief it or move it up a rung instead of retrying');
  } finally { cleanup(); }
});

test('redo alert: distinct tasks of the same type and boilerplate never match', () => {
  const { dir, cleanup } = makeFixture();
  try {
    runHelper(dir, BRIEF_A, 'h1', 'partial');
    runHelper(dir, BRIEF_B, 'h2', 'partial');
    assert.ok(!noteIn(spawn(dir, BRIEF_C)), 'C vs A+B');
    assert.ok(noteIn(spawn(dir, BRIEF_B.replace('three cases', 'four cases'))), 'control: a lightly edited B matches B');
  } finally { cleanup(); }
});

test('redo alert: a finished task is not a redo once; run twice it is (any status), across sessions', () => {
  const { dir, cleanup } = makeFixture();
  try {
    runHelper(dir, BRIEF_B, 'h1', 'done');
    assert.ok(!noteIn(spawn(dir, BRIEF_B)), 'one done run');
    runHelper(dir, BRIEF_B, 'h2', 'blocked', 'lead-sess-other'); // a different lead session
    assert.ok(noteIn(spawn(dir, BRIEF_B)), 'two earlier runs');
    // A helper continued with the same agent id is the same run, not a second one.
  } finally { cleanup(); }
});

test('redo alert: not for a review (it quotes the writer brief), a different TYPE, a run older than 24 hours, a helper\'s own spawn, or option off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    runHelper(dir, BRIEF_A, 'h1', 'partial');
    const review = `TYPE: code-review\nROLE: reviewer\n\nReview this change against the brief below.\n\n${BRIEF_A}`;
    assert.ok(!noteIn(spawn(dir, review)), 'review');
    assert.ok(!noteIn(spawn(dir, BRIEF_A_RESENT.replace('TYPE: bounded-feature', 'TYPE: integration'))), 'other type');
    const sub = runHook('hooks/spawn-guard.mjs', {
      session_id: 'lead-sess-2', agent_id: 'sub9', agent_type: 'agent-companion:ac-sonnet-high', cwd: dir,
      tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', description: 'x', prompt: BRIEF_A_RESENT },
    });
    assert.ok(!noteIn(sub), 'a helper spawning');
    const off = runHook('hooks/spawn-guard.mjs', {
      session_id: 'lead-sess-2', cwd: dir,
      tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', description: 'x', prompt: BRIEF_A_RESENT },
    }, { env: { CLAUDE_PLUGIN_OPTION_REDO_ALERT: 'false' } });
    assert.ok(!noteIn(off), 'option off');
    assert.ok(noteIn(spawn(dir, BRIEF_A_RESENT)), 'control: the same spawn with the option on');
    // Age the ledger past 24 hours: file mtime and the row's own time.
    const f = join(stateDir, 'state', 'worker-ledger', `${SID}.jsonl`);
    const old = new Date(Date.now() - 30 * 3600 * 1000);
    writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), at: old.toISOString() })).join('\n') + '\n');
    utimesSync(f, old, old);
    assert.ok(!noteIn(spawn(dir, BRIEF_A_RESENT)), 'older than 24 hours');
  } finally { cleanup(); }
});

test('redoNote: pure check over a ledger directory', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state', 'worker-ledger');
    mkdirSync(dir, { recursive: true });
    const sk = briefSketch(BRIEF_A);
    const row = (id, status, extra = {}) => JSON.stringify({ at: new Date().toISOString(), ev: 'stop', agent_id: id, bfp: sk, bty: 'bounded-feature', status, ...extra });
    writeFileSync(join(dir, 's1.jsonl'), `${row('x1', 'done')}\n`);
    assert.equal(redoNote(BRIEF_A_RESENT), null);
    writeFileSync(join(dir, 's1.jsonl'), `${row('x1', 'partial')}\n`);
    assert.equal(redoNote(BRIEF_A_RESENT), REDO_NOTE);
    // The same agent id twice is one run.
    writeFileSync(join(dir, 's1.jsonl'), `${row('x1', 'done')}\n${row('x1', 'done')}\n`);
    assert.equal(redoNote(BRIEF_A_RESENT), null);
    writeFileSync(join(dir, 's1.jsonl'), `${row('x1', 'done')}\n${row('x2', null)}\n`);
    assert.equal(redoNote(BRIEF_A_RESENT), REDO_NOTE);
    assert.equal(redoNote('too short'), null);
    assert.equal(readdirSync(dir).length, 1);
  } finally { cleanup(); }
});
