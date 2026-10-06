// Read dedupe: the rules (unit), then the hook run as the harness runs it
// (PreToolUse, PostToolUse, invalidation and reset events as separate
// processes sharing state on disk). Rules and reasoning:
// hooks/lib/read-dedupe.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, decisionOf, PLUGIN_ROOT } from './helpers.mjs';
import {
  addRange, covers, requestOf, decide, record, invalidate, pathKeyOf, pathHash, denyText,
  MIN_CHARS, MAX_AGE_MS, DEFAULT_LIMIT, LINE_PREFIX_CHARS,
} from '../hooks/lib/read-dedupe.mjs';

// --- unit: ranges and the request ---------------------------------------------

test('addRange merges overlapping and adjacent ranges and keeps gaps', () => {
  assert.deepEqual(addRange([], 1, 10), [[1, 10]]);
  assert.deepEqual(addRange([[1, 10]], 11, 20), [[1, 20]]);
  assert.deepEqual(addRange([[1, 10]], 12, 20), [[1, 10], [12, 20]]);
  assert.deepEqual(addRange([[1, 10], [20, 30]], 8, 22), [[1, 30]]);
  assert.deepEqual(addRange([[20, 30]], 1, 5), [[1, 5], [20, 30]]);
});

test('covers: only a request wholly inside ONE merged range', () => {
  assert.equal(covers([[1, 100]], 10, 90), true);
  assert.equal(covers([[1, 100]], 90, 101), false);
  assert.equal(covers([[1, 50], [60, 100]], 40, 70), false);
  assert.equal(covers([], 1, 1), false);
});

test('requestOf: defaults, and null for anything that is not a plain text range', () => {
  assert.deepEqual(requestOf({ file_path: 'x' }), { start: 1, end: DEFAULT_LIMIT, raw: '1:' });
  assert.deepEqual(requestOf({ file_path: 'x', offset: 10, limit: 5 }), { start: 10, end: 14, raw: '10:5' });
  assert.equal(requestOf({ file_path: 'x', pages: '1-3' }), null);
  assert.equal(requestOf({ file_path: 'x', offset: 0 }), null);
  assert.equal(requestOf({ file_path: 'x', offset: 1.5 }), null);
  assert.equal(requestOf({ file_path: 'x', limit: -1 }), null);
  assert.equal(requestOf(null), null);
});

// --- unit: decide / record on a state object ----------------------------------

const STAT = { mtimeMs: 1000, size: 40000 };
const textResponse = (startLine, numLines, totalLines, cpl = 80) => ({
  type: 'text',
  file: { filePath: 'x', content: Array.from({ length: numLines }, () => 'a'.repeat(cpl)).join('\n'), numLines, startLine, totalLines },
});
const blank = () => ({ v: 1, agents: {}, pending: {} });
function unitRead(state, input, { agent = 'main', pk = 'k', stat = STAT, now = 5000, response } = {}) {
  const d = decide(state, { agent, pk, input, stat, now }).value;
  if (d.action === 'deny') return d;
  const req = requestOf(input);
  const start = req.start;
  record(state, { agent, pk, input, response: response ?? textResponse(start, Math.min(req.end, 500) - start + 1, 500), stat, now });
  return d;
}

test('decide: a covered subrange is denied with the lines; an uncovered one runs', () => {
  const s = blank();
  assert.equal(unitRead(s, { offset: 1, limit: 400 }).action, 'allow');
  const d = unitRead(s, { offset: 120, limit: 61 });
  assert.equal(d.action, 'deny');
  assert.deepEqual([d.a, d.b], [120, 180]);
  assert.equal(unitRead(s, { offset: 380, limit: 100 }).action, 'allow', 'runs past the covered end');
});

test('decide: the age cap lets an old record go (time-based microcompaction has no hook)', () => {
  const s = blank();
  unitRead(s, { offset: 1, limit: 400 }, { now: 5000 });
  assert.equal(decide(s, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat: STAT, now: 5000 + MAX_AGE_MS - 1 }).value.action, 'deny');
  const s2 = blank();
  unitRead(s2, { offset: 1, limit: 400 }, { now: 5000 });
  assert.equal(decide(s2, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat: STAT, now: 5000 + MAX_AGE_MS + 1 }).value.action, 'allow');
});

test('decide: the denial estimate is lines x (average line + prefix)', () => {
  const s = blank();
  unitRead(s, { offset: 1, limit: 400 });
  const d = decide(s, { agent: 'main', pk: 'k', input: { offset: 1, limit: 50 }, stat: STAT, now: 5000 }).value;
  assert.equal(d.est, Math.round(50 * ((400 * 80 + 399) / 400 + LINE_PREFIX_CHARS)));
});

test('decide: a size change with the SAME mtime clears the record, as does an mtime change with the same size', () => {
  for (const stat of [{ mtimeMs: 1000, size: 40001 }, { mtimeMs: 1001, size: 40000 }]) {
    const s = blank();
    unitRead(s, { offset: 1, limit: 400 });
    assert.equal(decide(s, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat, now: 5000 }).value.action, 'allow');
    assert.equal(s.agents.main.files.k, undefined);
  }
});

test('decide: a change of ctime alone (same size, same mtime) clears the record', () => {
  const s = blank();
  const base = { mtimeMs: 1000, size: 40000, ctimeMs: 500 };
  unitRead(s, { offset: 1, limit: 400 }, { stat: base });
  assert.equal(decide(s, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat: base, now: 5000 }).value.action, 'deny');
  const s2 = blank();
  unitRead(s2, { offset: 1, limit: 400 }, { stat: base });
  assert.equal(decide(s2, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat: { ...base, ctimeMs: 501 }, now: 5000 }).value.action, 'allow');
  assert.equal(s2.agents.main.files.k, undefined);
});

test('decide: an allowed repeat-eligible read says why; a first read says nothing; retry carries the deny time and the record age', () => {
  const s = blank();
  assert.equal(unitRead(s, { offset: 1, limit: 400 }, { now: 1000 }).why, undefined, 'first read is not repeat-eligible');
  assert.equal(unitRead(s, { offset: 1, limit: 400 }, { now: 2000 }).why, 'builtin-last');
  assert.equal(unitRead(s, { offset: 380, limit: 100 }, { now: 3000 }).why, 'uncovered');
  const d = unitRead(s, { offset: 100, limit: 100 }, { now: 4000 });
  assert.equal(d.action, 'deny');
  assert.equal(d.age_ms, 3000, 'time since the original read');
  const r = decide(s, { agent: 'main', pk: 'k', input: { offset: 100, limit: 100 }, stat: STAT, now: 9000 }).value;
  assert.equal(r.action, 'retry');
  assert.equal(r.deny_at, 4000);
  assert.equal(r.age_ms, 8000);
  assert.equal(r.idx, 5, 'the fifth Read this agent made');
  const small = blank();
  unitRead(small, { offset: 1, limit: 400 }, { now: 1000, response: textResponse(1, 400, 500, 4) });
  assert.equal(unitRead(small, { offset: 5, limit: 10 }, { now: 1100, response: textResponse(5, 10, 500, 4) }).why, 'small');
  const aged = blank();
  unitRead(aged, { offset: 1, limit: 400 }, { now: 1000 });
  assert.equal(unitRead(aged, { offset: 100, limit: 100 }, { now: 1000 + MAX_AGE_MS + 1 }).why, 'aged');
});

test('record: a truncated, partial or unusable response is not remembered', () => {
  for (const response of [
    { type: 'file_unchanged' },
    { type: 'text', file: { content: 'x', numLines: 1, startLine: 1, totalLines: 10, truncatedByTokenCap: true } },
    { type: 'text', file: { content: '[Truncated: PARTIAL view of the file]', numLines: 1, startLine: 1, totalLines: 10 } },
    { type: 'text', file: { content: 'x', numLines: 0, startLine: 1, totalLines: 10 } },
    { type: 'image', file: {} },
    undefined,
    'garbage',
  ]) {
    const s = blank();
    decide(s, { agent: 'main', pk: 'k', input: { offset: 1, limit: 400 }, stat: STAT, now: 5000 });
    record(s, { agent: 'main', pk: 'k', input: { offset: 1, limit: 400 }, response, stat: STAT, now: 5000 });
    assert.equal(s.agents.main?.files?.k, undefined, JSON.stringify(response));
  }
});

test('record: a file that changed while it was being read is not remembered', () => {
  const s = blank();
  decide(s, { agent: 'main', pk: 'k', input: { offset: 1, limit: 400 }, stat: STAT, now: 5000 });
  record(s, { agent: 'main', pk: 'k', input: { offset: 1, limit: 400 }, response: textResponse(1, 400, 500), stat: { ...STAT, mtimeMs: 2000 }, now: 5000 });
  assert.equal(s.agents.main?.files?.k, undefined);
});

test('invalidate clears one agent\'s path and nothing else', () => {
  const s = blank();
  unitRead(s, { offset: 1, limit: 400 }, { agent: 'a' });
  unitRead(s, { offset: 1, limit: 400 }, { agent: 'b' });
  unitRead(s, { offset: 1, limit: 400 }, { agent: 'a', pk: 'other' });
  invalidate(s, { agent: 'a', pk: 'k' });
  assert.equal(s.agents.a.files.k, undefined);
  assert.ok(s.agents.a.files.other);
  assert.ok(s.agents.b.files.k);
});

test('the deny text is one short sentence that says how to get the read anyway', () => {
  const t = denyText(120, 180);
  assert.equal(t, 'Unchanged since your earlier read (lines 120-180). If that content is no longer in your context, repeat this call and it will run.');
  assert.ok(t.length < 160);
});

test('threshold: justified constants (a denial must cost less than the read it replaces)', () => {
  assert.equal(MIN_CHARS, 2000);
  // The denial text is about 130 characters; the floor is more than 10x that.
  assert.ok(MIN_CHARS >= 10 * denyText(1, 2).length * 0.9);
});

// --- the hook, as the harness runs it -------------------------------------------

let n = 0;
function session() { n += 1; return `sess-rd-${process.pid}-${n}`; }

// A file of `lines` lines, each `cpl` characters (+ newline).
function makeFile(fx, name, lines, cpl = 60) {
  const f = join(fx.dir, name);
  writeFileSync(f, Array.from({ length: lines }, (_, i) => String(i + 1).padStart(4, '0').padEnd(cpl, 'x')).join('\n') + '\n');
  return f;
}

// What the built-in Read would return for this file and range.
function responseFor(file, offset, limit) {
  const all = readFileSync(file, 'utf8').split('\n');
  if (all[all.length - 1] === '') all.pop();
  const start = offset ?? 1;
  const slice = all.slice(start - 1, start - 1 + (limit ?? DEFAULT_LIMIT));
  return { type: 'text', file: { filePath: file, content: slice.join('\n'), numLines: slice.length, startLine: start, totalLines: all.length } };
}

class Agent {
  constructor(fx, sid, agentId, extraEnv = {}) { this.fx = fx; this.sid = sid; this.agentId = agentId; this.env = extraEnv; }
  base(extra = {}) {
    return { session_id: this.sid, cwd: this.fx.dir, ...(this.agentId ? { agent_id: this.agentId, agent_type: 'x' } : {}), ...extra };
  }
  run(event, payload) {
    return runHook('hooks/read-dedupe.mjs', payload, { args: ['--event', event], env: this.env });
  }
  pre(file, offset, limit) {
    const tool_input = { file_path: file, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
    return this.run('pre', this.base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input }));
  }
  post(file, offset, limit, response) {
    const tool_input = { file_path: file, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
    return this.run('post', this.base({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input, tool_response: response ?? responseFor(file, offset, limit) }));
  }
  // A full Read as the harness does it: hook, then the read itself if allowed.
  read(file, offset, limit) {
    const pre = this.pre(file, offset, limit);
    const d = decisionOf(pre.json);
    if (d === 'deny') return { denied: true, reason: pre.json.hookSpecificOutput.permissionDecisionReason, pre };
    this.post(file, offset, limit);
    return { denied: false, pre };
  }
  edit(tool_name, file, key = 'file_path') {
    return this.run('invalidate', this.base({ hook_event_name: 'PostToolUse', tool_name, tool_input: { [key]: file } }));
  }
  reset(hook_event_name = 'PreCompact', extra = {}) {
    return this.run('reset', this.base({ hook_event_name, ...extra }));
  }
}

function withFx(fn) {
  const fx = makeFixture();
  try { return fn(fx); } finally { fx.cleanup(); }
}

const LOG = (fx) => join(fx.stateDir, 'telemetry', 'read-dedupe.jsonl');

test('hook: a range inside an earlier, larger read is denied with the exact text', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  assert.equal(a.read(f, 1, 400).denied, false);
  const r = a.read(f, 120, 61);
  assert.equal(r.denied, true);
  assert.equal(r.reason, 'Unchanged since your earlier read (lines 120-180). If that content is no longer in your context, repeat this call and it will run.');
  assert.equal(r.pre.json.hookSpecificOutput.hookEventName, 'PreToolUse');
}));

test('hook: A, then B, then A again is denied (the built-in keeps only the last range)', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  assert.equal(a.read(f, 1, 100).denied, false);
  assert.equal(a.read(f, 300, 100).denied, false);
  assert.equal(a.read(f, 1, 100).denied, true);
  // B's exact repeat is still the last READ that ran, so the built-in's; a part of it is ours.
  assert.equal(a.read(f, 310, 50).denied, true);
}));

test('hook: two adjacent reads cover a range spanning both', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 100); a.read(f, 101, 100);
  assert.equal(a.read(f, 50, 100).denied, true);
  assert.equal(a.read(f, 150, 100).denied, false, 'not fully covered');
}));

test('hook: the exact repeat of the last read is left to the built-in stub', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 100);
  const pre = a.pre(f, 1, 100);
  assert.equal(pre.json, null, 'no output: the built-in answers it');
}));

test('hook: no offset or limit means the whole file, clamped to its length', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 300);
  const a = new Agent(fx, session());
  a.read(f);
  const r = a.read(f, 50, 5000); // asks past EOF: lines 50-300 are covered
  assert.equal(r.denied, true);
  assert.match(r.reason, /lines 50-300/);
}));

test('hook: a read below the size threshold runs, and one at or above it is denied', () => withFx((fx) => {
  // 10-character lines.
  const f = makeFile(fx, 'small.txt', 400, 10);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  assert.equal(a.read(f, 1, 100).denied, false, '100 x 18 = 1,800 < 2,000');
  // Each line is 10 characters + newline + the 7-character prefix = 18.
  assert.equal(a.read(f, 1, 112).denied, true, '112 x 18 = 2,016 >= 2,000');
  assert.equal(a.read(f, 1, 111).denied, false, '111 x 18 = 1,998 < 2,000');
}));

test('hook: a denied read, repeated, runs and logs both rows; the third identical call is the built-in\'s', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  assert.equal(a.read(f, 120, 61).denied, true);
  const retry = a.read(f, 120, 61);
  assert.equal(retry.denied, false, 'never a trap');
  assert.equal(retry.pre.json, null);
  const rows = readJsonl(LOG(fx));
  assert.deepEqual(rows.map((r) => r.outcome), ['deny', 'retry-ran']);
  assert.equal(rows[0].range, '120-180');
  assert.ok(rows[0].est_chars_avoided > 2000);
  assert.equal(rows[1].est_chars_avoided, 0);
  // The same request after the retry: it is the last read now, the built-in's.
  assert.equal(a.read(f, 120, 61).denied, false);
}));

test('hook: a different request after a denial is judged afresh, and a repeat of the denied one still runs', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  assert.equal(a.read(f, 120, 61).denied, true);
  assert.equal(a.read(f, 200, 61).denied, true, 'a different covered range is denied once');
  assert.equal(a.read(f, 120, 61).denied, false, 'the first denied request still has its retry');
  assert.equal(a.read(f, 200, 61).denied, false);
}));

test('hook: telemetry carries a path hash, never the path, and the documented fields', () => withFx((fx) => {
  const f = makeFile(fx, 'secret-name.txt', 500);
  const sid = session();
  const a = new Agent(fx, sid, 'agent-77');
  a.read(f, 1, 400); a.read(f, 120, 61);
  const text = readFileSync(LOG(fx), 'utf8');
  assert.ok(!text.includes('secret-name'), 'the path is not logged');
  const [row] = readJsonl(LOG(fx));
  assert.equal(row.session_id, sid);
  assert.equal(row.agent_id, 'agent-77');
  assert.match(row.path_hash, /^[0-9a-f]{12}$/);
  assert.equal(row.path_hash, pathHash(pathKeyOf(f, fx.dir)));
  assert.equal(row.outcome, 'deny');
  assert.equal(row.range, '120-180');
  assert.ok(Number.isFinite(row.est_chars_avoided));
  assert.ok(Number.isFinite(Date.parse(row.at)));
}));

test('hook: the main thread logs agent_id "main"', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400); a.read(f, 120, 61);
  assert.equal(readJsonl(LOG(fx))[0].agent_id, 'main');
}));

test('hook: it returns a deny or nothing, never an allow or updatedInput', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  const first = a.pre(f, 1, 400);
  assert.equal(first.json, null);
  a.post(f, 1, 400);
  const out = a.pre(f, 120, 61).json;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
}));

test('hook: deny, retry-ran and allow rows carry the documented telemetry fields', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const transcript = join(fx.dir, 'transcript.jsonl');
  writeFileSync(transcript, 'x'.repeat(1234));
  const a = new Agent(fx, sid, 'agent-t');
  const withExtra = (ev, tool_use_id, offset, limit, extra = {}) => a.run(ev, a.base({
    hook_event_name: ev === 'pre' ? 'PreToolUse' : 'PostToolUse', tool_name: 'Read', tool_use_id, transcript_path: transcript,
    tool_input: { file_path: f, offset, limit }, ...extra,
  }));
  withExtra('pre', 'tu-1', 1, 400);
  a.post(f, 1, 400);
  const d = withExtra('pre', 'tu-2', 120, 61);
  assert.equal(decisionOf(d.json), 'deny');
  withExtra('pre', 'tu-3', 120, 61); // the retry
  withExtra('pre', 'tu-4', 380, 100); // runs past the covered end: allowed, repeat-eligible
  const rows = readJsonl(LOG(fx));
  assert.deepEqual(rows.map((r) => r.outcome), ['deny', 'retry-ran', 'allow']);
  const [deny, retry, allow] = rows;
  for (const r of rows) {
    assert.equal(r.agent_type, 'x');
    assert.equal(r.hook_event, 'pre');
    assert.equal(r.transcript_bytes, 1234);
    assert.ok(r.duration_ms >= 0 && Number.isFinite(r.duration_ms));
    assert.ok(r.lock_wait_ms >= 0 && Number.isFinite(r.lock_wait_ms));
    assert.ok(r.est_chars > 0);
    assert.ok(r.age_ms >= 0);
  }
  assert.equal(deny.tool_use_id, 'tu-2');
  assert.equal(deny.deny_chars, denyText(120, 180).length);
  assert.equal(deny.read_index, 2);
  assert.equal(retry.tool_use_id, 'tu-3');
  assert.ok(Number.isFinite(Date.parse(retry.deny_at)), 'when the denial it overrides was issued');
  assert.ok(Date.parse(retry.deny_at) <= Date.parse(retry.at));
  assert.equal(retry.est_chars_avoided, 0);
  assert.equal(allow.allow_reason, 'uncovered');
  assert.equal(allow.est_chars_avoided, 0);
  assert.equal(allow.range, '380-479');
}));

test('hook: a first read, and a read of a changed file, write no row (only repeat-eligible allows are counted)', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const t = new Date(Date.now() + 60_000);
  utimesSync(f, t, t);
  a.read(f, 120, 61);
  assert.equal(readJsonl(LOG(fx)).length, 0);
}));

// --- invalidation ----------------------------------------------------------------

test('invalidation: Edit, Write, NotebookEdit and MultiEdit by the same agent clear the path', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  for (const [tool, key] of [['Edit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path'], ['MultiEdit', 'file_path']]) {
    const a = new Agent(fx, session());
    a.read(f, 1, 400);
    assert.equal(a.pre(f, 120, 61).json?.hookSpecificOutput?.permissionDecision, 'deny', `${tool}: before`);
    // The edit changes nothing on disk here, so ONLY the invalidation can clear it.
    a.edit(tool, f, key);
    assert.equal(a.read(f, 120, 61).denied, false, `${tool}: after`);
  }
}));

test('invalidation: an edit by one agent leaves another agent\'s record alone', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const a = new Agent(fx, sid, 'agent-a');
  const b = new Agent(fx, sid, 'agent-b');
  a.read(f, 1, 400); b.read(f, 1, 400);
  a.edit('Edit', f);
  assert.equal(a.read(f, 120, 61).denied, false);
  assert.equal(b.read(f, 120, 61).denied, true, 'b\'s record (disk unchanged) stands');
}));

test('invalidation: an edit to a different path does not clear this one; a relative edit path matches', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const other = makeFile(fx, 'other.txt', 10);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  a.edit('Edit', other);
  assert.equal(a.read(f, 120, 61).denied, true);
  a.edit('Edit', 'big.txt'); // relative to the payload cwd
  assert.equal(a.read(f, 150, 61).denied, false);
}));

test('invalidation: a change of mtime, with the same size, clears it (a Bash edit)', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const t = new Date(Date.now() + 60_000);
  utimesSync(f, t, t);
  assert.equal(a.read(f, 120, 61).denied, false);
  // and the fresh read is remembered again
  assert.equal(a.read(f, 130, 40).denied, true);
}));

test('invalidation: a same-size change with the mtime put back clears it (the ctime still moved)', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  // A whole-millisecond mtime, so it can be put back EXACTLY (as `touch -r`, rsync -t, cp -p do).
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
  utimesSync(f, pinned, pinned);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const st = statSync(f);
  const text = readFileSync(f, 'utf8');
  writeFileSync(f, `Z${text.slice(1)}`); // same length, different content
  utimesSync(f, pinned, pinned); // pin the mtime back
  const now = statSync(f);
  assert.equal(now.size, st.size);
  assert.equal(now.mtimeMs, st.mtimeMs, 'the mtime is pinned');
  assert.equal(a.read(f, 120, 61).denied, false, 'the old content must not be claimed as "unchanged"');
}));

test('invalidation: a change of size, with the same mtime, clears it', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const st = statSync(f);
  writeFileSync(f, readFileSync(f, 'utf8') + 'one more line\n');
  utimesSync(f, st.atime, st.mtime);
  assert.equal(a.read(f, 120, 61).denied, false);
}));

test('invalidation: an emptied file is allowed', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  writeFileSync(f, '');
  assert.equal(a.read(f, 120, 61).denied, false);
}));

test('invalidation: PreCompact clears the agent', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  a.reset('PreCompact');
  assert.equal(a.read(f, 120, 61).denied, false);
}));

test('invalidation: SessionStart with source compact, and with source clear, clears it', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  for (const source of ['compact', 'clear']) {
    const a = new Agent(fx, session());
    a.read(f, 1, 400);
    a.reset('SessionStart', { source });
    assert.equal(a.read(f, 120, 61).denied, false, source);
  }
}));

test('invalidation: a subagent\'s compaction clears that subagent only', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const lead = new Agent(fx, sid);
  const sub = new Agent(fx, sid, 'agent-s');
  lead.read(f, 1, 400); sub.read(f, 1, 400);
  sub.reset('PreCompact');
  assert.equal(sub.read(f, 120, 61).denied, false);
  assert.equal(lead.read(f, 120, 61).denied, true, 'the lead did not compact');
}));

test('invalidation: a compaction payload with no agent id forgets every agent of the session', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const lead = new Agent(fx, sid);
  const sub = new Agent(fx, sid, 'agent-s');
  lead.read(f, 1, 400); sub.read(f, 1, 400);
  lead.reset('PreCompact');
  assert.equal(sub.read(f, 120, 61).denied, false);
  assert.equal(lead.read(f, 120, 61).denied, false);
}));

test('invalidation: another session\'s compaction does not touch this one', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  const b = new Agent(fx, session());
  a.read(f, 1, 400); b.read(f, 1, 400);
  b.reset('PreCompact');
  assert.equal(a.read(f, 120, 61).denied, true);
}));

// --- isolation ---------------------------------------------------------------------

test('isolation: a read by one agent never suppresses another agent\'s read', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const lead = new Agent(fx, sid);
  const s1 = new Agent(fx, sid, 'agent-1');
  const s2 = new Agent(fx, sid, 'agent-2');
  lead.read(f, 1, 400);
  assert.equal(s1.read(f, 120, 61).denied, false, 'a subagent has its own context');
  assert.equal(s2.read(f, 120, 61).denied, false);
  assert.equal(s1.read(f, 125, 40).denied, true);
  s1.read(f, 1, 400);
  assert.equal(lead.read(f, 120, 61).denied, true);
}));

test('isolation: the same agent id in another session is another agent', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session(), 'agent-x');
  const b = new Agent(fx, session(), 'agent-x');
  a.read(f, 1, 400);
  assert.equal(b.read(f, 120, 61).denied, false);
}));

test('isolation: different files do not share ranges', () => withFx((fx) => {
  const f = makeFile(fx, 'one.txt', 500);
  const g = makeFile(fx, 'two.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  assert.equal(a.read(g, 120, 61).denied, false);
}));

test('paths: absolute, relative to cwd and backslashed spellings are one file', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  assert.equal(a.read('big.txt', 120, 61).denied, true, 'relative');
  if (process.platform === 'win32') assert.equal(a.read(f.replace(/\\/g, '/'), 130, 61).denied, true, 'forward slashes');
}));

// --- recording rules through the hook -------------------------------------------------

test('record: a read whose response is not a plain text view is not remembered', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.pre(f, 1, 400);
  a.post(f, 1, 400, { type: 'file_unchanged', file: { filePath: f } });
  assert.equal(a.pre(f, 120, 61).json, null);
  a.pre(f, 1, 400);
  a.post(f, 1, 400, { type: 'text', file: { content: 'x', numLines: 1, startLine: 1, totalLines: 500, truncatedByTokenCap: true } });
  assert.equal(a.pre(f, 130, 61).json, null);
}));

test('record: a read that never got a PreToolUse (or a denied one) is not recorded from its PostToolUse alone', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.post(f, 1, 400); // no pre
  assert.equal(a.pre(f, 120, 61).json, null);
}));

test('record: a file changed between the hook and the read is not remembered', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.pre(f, 1, 400);
  const t = new Date(Date.now() + 60_000);
  utimesSync(f, t, t);
  a.post(f, 1, 400);
  assert.equal(a.pre(f, 120, 61).json, null);
}));

test('record: a PDF page read and a malformed range are passed straight through', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const pdf = a.run('pre', a.base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f, pages: '1-3' } }));
  assert.equal(pdf.json, null);
  const bad = a.run('pre', a.base({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f, offset: 'ten', limit: 5 } }));
  assert.equal(bad.json, null);
}));

// --- opt-out and fail-open ----------------------------------------------------------

test('opt-out: CLAUDE_PLUGIN_OPTION_READ_DEDUPE=0 denies nothing and records nothing', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const off = new Agent(fx, session(), undefined, { CLAUDE_PLUGIN_OPTION_READ_DEDUPE: '0' });
  off.read(f, 1, 400);
  assert.equal(off.read(f, 120, 61).denied, false);
  // Turned back on in the same session: the reads made while off were never recorded.
  const on = new Agent(fx, off.sid);
  assert.equal(on.read(f, 120, 61).denied, false);
  assert.equal(readJsonl(LOG(fx)).length, 0);
  // and on, it works
  assert.equal(on.read(f, 1, 400).denied, false);
  assert.equal(on.read(f, 130, 61).denied, true);
}));

test('fail open: garbage on stdin, an empty payload and a missing session id exit 0 with no output', () => withFx((fx) => {
  for (const ev of ['pre', 'post', 'invalidate', 'reset']) {
    const r = runHook('hooks/read-dedupe.mjs', undefined, { args: ['--event', ev] });
    assert.equal(r.status, 0, ev);
    assert.equal(r.stdout.trim(), '');
    const noSid = runHook('hooks/read-dedupe.mjs', { tool_name: 'Read', tool_input: { file_path: 'x' } }, { args: ['--event', ev] });
    assert.equal(noSid.status, 0);
    assert.equal(noSid.stdout.trim(), '');
  }
  const r = runHook('hooks/read-dedupe.mjs', undefined, { args: [] });
  assert.equal(r.status, 0);
}));

test('fail open: an unreadable or corrupt state file never blocks a read', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const dir = join(fx.stateDir, 'state', 'read-dedupe');
  const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  for (const junk of ['{not json', '[]', '{"v":1,"agents":"x","pending":[]}', '{"v":1,"agents":{"main":{"files":{"x":{"ranges":"nope"}}}},"pending":{}}', '']) {
    writeFileSync(join(dir, files[0]), junk);
    const r = a.pre(f, 120, 61);
    assert.equal(r.status, 0, junk);
    assert.notEqual(decisionOf(r.json), 'deny', junk);
  }
}));

test('fail open: a state directory that cannot be used lets every read run', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  // A FILE where the state directory should be.
  mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
  writeFileSync(join(fx.stateDir, 'state', 'read-dedupe'), 'not a directory');
  const a = new Agent(fx, session());
  assert.equal(a.read(f, 1, 400).denied, false);
  assert.equal(a.read(f, 120, 61).denied, false);
}));

const shards = (fx) => readdirSync(join(fx.stateDir, 'state', 'read-dedupe')).filter((n) => n.endsWith('.json'));
const holdLock = (fx, shard) => writeFileSync(join(fx.stateDir, 'state', 'read-dedupe', `${shard}.lock`), JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }));

test('fail open: a held live lock times out into "run", and says so in a lock-timeout row with the wait', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const [shard] = shards(fx);
  // A lock held by THIS (live) process, fresh: the hook waits, then lets the read run.
  holdLock(fx, shard);
  const r = a.pre(f, 120, 61);
  assert.equal(r.status, 0);
  assert.notEqual(decisionOf(r.json), 'deny');
  const rows = readJsonl(LOG(fx));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'lock-timeout');
  assert.equal(rows[0].hook_event, 'pre');
  assert.ok(rows[0].lock_wait_ms >= 700, `waited ${rows[0].lock_wait_ms} ms`);
  assert.equal(rows[0].agent_id, 'main');
  assert.match(rows[0].path_hash, /^[0-9a-f]{12}$/);
}));

test('fail open: a PostToolUse that cannot lock logs a lock-timeout row (the read went unrecorded)', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 100);
  const [shard] = shards(fx);
  a.pre(f, 200, 100);
  holdLock(fx, shard);
  assert.equal(a.post(f, 200, 100).status, 0);
  const rows = readJsonl(LOG(fx)).filter((r) => r.outcome === 'lock-timeout');
  assert.deepEqual(rows.map((r) => [r.outcome, r.hook_event]), [['lock-timeout', 'post']]);
}));

test('contention: agents of one session keep separate state files, so one agent\'s held lock never stalls another', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const lead = new Agent(fx, sid);
  const s1 = new Agent(fx, sid, 'agent-1');
  const s2 = new Agent(fx, sid, 'agent-2');
  lead.read(f, 1, 400); s1.read(f, 1, 400); s2.read(f, 1, 400);
  assert.equal(shards(fx).length, 3, 'one state file per agent');
  // Hold EVERY shard but s2's.
  const d = join(fx.stateDir, 'state', 'read-dedupe');
  const all = shards(fx);
  const s2shard = all.find((n) => {
    const st = JSON.parse(readFileSync(join(d, n), 'utf8'));
    return Object.keys(st.agents).includes('agent-2');
  });
  for (const n of all) if (n !== s2shard) holdLock(fx, n);
  const t0 = Date.now();
  const r = s2.read(f, 120, 61);
  assert.equal(r.denied, true, 'agent-2 is judged normally');
  assert.ok(Date.now() - t0 < 700, 'and does not wait on the others\' locks');
  assert.equal(readJsonl(LOG(fx)).filter((x) => x.outcome === 'lock-timeout').length, 0);
}));

test('contention: many agents reading at once all record and are all denied afterwards', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const agents = Array.from({ length: 6 }, (_, i) => new Agent(fx, sid, `agent-${i}`));
  // Interleave their PreToolUse and PostToolUse the way parallel agents do.
  for (const a of agents) a.pre(f, 1, 400);
  for (const a of agents) a.post(f, 1, 400);
  for (const a of agents) assert.equal(a.read(f, 120, 61).denied, true, a.agentId);
  assert.equal(readJsonl(LOG(fx)).filter((x) => x.outcome === 'lock-timeout').length, 0);
}));

test('reset: a whole-session compaction removes every agent\'s state file, an agent\'s own only that agent\'s', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const sid = session();
  const lead = new Agent(fx, sid);
  const s1 = new Agent(fx, sid, 'agent-1');
  const s2 = new Agent(fx, sid, 'agent-2');
  const other = new Agent(fx, session());
  lead.read(f, 1, 400); s1.read(f, 1, 400); s2.read(f, 1, 400); other.read(f, 1, 400);
  assert.equal(shards(fx).length, 4);
  s1.reset('PreCompact');
  assert.equal(shards(fx).length, 4, 'a subagent reset keeps its (emptied) shard');
  assert.equal(s1.read(f, 120, 61).denied, false);
  lead.reset('PreCompact');
  assert.equal(shards(fx).length, 1, 'only the other session\'s shard is left');
  assert.equal(other.read(f, 120, 61).denied, true);
}));

test('fail open: a stale lock left by a dead process does not stop a read', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, session());
  a.read(f, 1, 400);
  const [shard] = shards(fx);
  writeFileSync(join(fx.stateDir, 'state', 'read-dedupe', `${shard}.lock`), JSON.stringify({ pid: 2147483646, token: 'dead', at: Date.now() - 60_000 }));
  assert.equal(a.read(f, 120, 61).denied, true);
}));

test('fail open: a Read of a missing file is passed through', () => withFx((fx) => {
  const a = new Agent(fx, session());
  const r = a.pre(join(fx.dir, 'nope.txt'), 1, 400);
  assert.equal(r.status, 0);
  assert.equal(r.json, null);
}));

test('a served (remote) call is never judged', () => withFx((fx) => {
  const f = makeFile(fx, 'big.txt', 500);
  const a = new Agent(fx, 'served:abc');
  a.read(f, 1, 400);
  assert.equal(a.read(f, 120, 61).denied, false);
}));

// --- registration and docs ------------------------------------------------------------

test('registration: hooks.json wires every event and plugin.json declares the toggle, on by default', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const find = (event, matcher) => (hooks[event] || []).find((h) => h.matcher === matcher
    && h.hooks.some((x) => x.args.some((arg) => arg.endsWith('hooks/read-dedupe.mjs'))));
  const evArg = (entry) => entry.hooks.find((x) => x.args.some((arg) => arg.endsWith('hooks/read-dedupe.mjs'))).args.slice(-1)[0];
  assert.equal(evArg(find('PreToolUse', '^Read$')), 'pre');
  assert.equal(evArg(find('PostToolUse', '^Read$')), 'post');
  assert.equal(evArg(find('PostToolUse', '^(Edit|Write|NotebookEdit|MultiEdit)$')), 'invalidate');
  assert.equal(evArg(find('SessionStart', '^(compact|clear)$')), 'reset');
  const pre = (hooks.PreCompact || []).find((h) => h.hooks.some((x) => x.args.some((arg) => arg.endsWith('hooks/read-dedupe.mjs'))));
  assert.ok(pre);
  assert.equal(pre.hooks[0].args.slice(-1)[0], 'reset');
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.read_dedupe.type, 'boolean');
  assert.equal(cfg.read_dedupe.default, true);
});

test('docs: README documents the toggle and the env override; TELEMETRY.md documents the stream', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('`read_dedupe`'));
  assert.ok(readme.includes('CLAUDE_PLUGIN_OPTION_READ_DEDUPE=0'));
  const tele = readFileSync(join(PLUGIN_ROOT, 'docs', 'TELEMETRY.md'), 'utf8');
  assert.ok(tele.includes('### `read-dedupe.jsonl`'));
  for (const field of ['path_hash', 'est_chars_avoided', 'retry-ran', 'agent_id', 'range']) assert.ok(tele.includes(field), field);
});
