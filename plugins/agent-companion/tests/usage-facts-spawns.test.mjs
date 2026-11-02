// Usage facts, batch 2b: spawn records in the facts (request categories, context buckets, STATUS,
// compactions, extra turns, simple runs, the re-spawn key, open-spawn carry-over). Fixtures are
// synthetic transcripts in a temp root; nothing reads the operator's real transcripts and nothing
// calls a model.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import {
  runCheckup, scanTranscripts, resetUnitCache, factsDir, writeOpenFile, checkupPaths, checkupDue, RETRY_MS,
} from '../scripts/lib/daily-checkup.mjs';
import {
  classTool, classToolsOf, requestCategory, statusOf, nameStem, respawnKey, requestBucket, contextBucket,
  newSpawn, addSpawnRequest, isOpen, spawnRecord, SPAWN_MAX_OPEN_MS,
} from '../scripts/lib/usage/spawns.mjs';

const NOW = Date.parse('2026-10-10T09:00:00Z'); // days 2026-10-08 and 2026-10-09 (08:00Z to 08:00Z) are closed and settled
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';

function asst(id, ts, model, u = {}, content = [{ type: 'text', text: 'ok' }], extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: id,
    uuid: `u-${id}-${ts}`,
    cwd: 'C:/work/projA',
    message: {
      id: `msg_${id}`,
      model,
      content,
      usage: {
        input_tokens: u.i || 0,
        output_tokens: u.o || 0,
        cache_read_input_tokens: u.cr || 0,
        cache_creation_input_tokens: (u.w5 || 0) + (u.w1 || 0),
        cache_creation: { ephemeral_5m_input_tokens: u.w5 || 0, ephemeral_1h_input_tokens: u.w1 || 0 },
      },
    },
    ...extra,
  });
}
const user = (uuid, ts, text, extra = {}) => JSON.stringify({
  type: 'user', timestamp: ts, uuid, cwd: 'C:/work/projA', message: { role: 'user', content: text }, ...extra,
});
const toolResult = (uuid, ts) => JSON.stringify({
  type: 'user', timestamp: ts, uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
});
const compact = (uuid, ts) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts, uuid });
const tu = (id, name, input) => [{ type: 'tool_use', id, name, input }];

function put(file, lines, { append = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const text = `${lines.join('\n')}\n`;
  if (append) appendFileSync(file, text); else writeFileSync(file, text);
}

function mk() {
  const fx = makeFixture();
  const root = join(fx.dir, 'transcripts');
  mkdirSync(root, { recursive: true });
  return { fx, root };
}

const readDay = (day) => JSON.parse(readFileSync(join(factsDir(), `${day}.json`), 'utf8'));

function subFile(root, sid, aid, meta) {
  const file = join(root, 'projA', sid, 'subagents', `agent-${aid}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
  return file;
}

const WARM = 40000; // a cache read that puts a request in the first context bucket

// One worker with every category, a compaction, an extra turn, a simple run and a STATUS word.
function seedWorker(root) {
  const file = subFile(root, 'sess1', 'w1', {
    agentType: 'agent-companion:ac-sonnet-medium', description: 'Port the classifier', name: 'w-0-1-2-a1', toolUseId: 'toolu_A',
  });
  put(file, [
    user('b1', '2026-10-09T10:00:00Z', 'TYPE: bounded-feature\nROLE: writer\nport the classifier'),
    // 5 simple steps in a row (output <= 500): a simple run
    asst('r1', '2026-10-09T10:00:10Z', SONNET, { i: 100, o: 50, cr: WARM, w5: 5000 }, tu('t1', 'Read', { file_path: 'a.mjs' })),
    toolResult('x1', '2026-10-09T10:00:11Z'),
    asst('r2', '2026-10-09T10:00:20Z', SONNET, { i: 10, o: 40, cr: WARM }, tu('t2', 'Bash', { command: 'ls -la src' })),
    asst('r3', '2026-10-09T10:00:30Z', SONNET, { i: 10, o: 40, cr: WARM }, tu('t3', 'Bash', { command: 'sleep 30' })),
    asst('r4', '2026-10-09T10:00:40Z', SONNET, { i: 10, o: 40, cr: WARM }, tu('t4', 'Edit', { new_string: 'x' })),
    asst('r5', '2026-10-09T10:00:50Z', SONNET, { i: 10, o: 40, cr: 120000 }, tu('t5', 'Bash', { command: 'git -C . status' })),
    // a large output ends the run
    asst('r6', '2026-10-09T10:01:00Z', SONNET, { i: 10, o: 800, cr: 160000 }, tu('t6', 'Write', { content: 'y'.repeat(900) })),
    compact('c1', '2026-10-09T10:01:30Z'),
    asst('r7', '2026-10-09T10:02:00Z', SONNET, { i: 10, o: 30, cr: 210000 }, tu('t7', 'Bash', { command: 'node --test tests/a.test.mjs' })),
    // a run of 3 is not a run
    asst('r8', '2026-10-09T10:02:10Z', SONNET, { i: 10, o: 30, cr: 20000 }, tu('t8', 'Bash', { command: 'git commit -m x' })),
    asst('r9', '2026-10-09T10:02:20Z', SONNET, { i: 10, o: 30, cr: 20000 }, [...tu('t9', 'mcp__srv__do', {}), ...tu('t10', 'Read', {})]),
    user('e1', '2026-10-09T10:03:00Z', 'continue with the second half'),
    user('m1', '2026-10-09T10:03:01Z', 'harness line', { isMeta: true }),
    asst('r10', '2026-10-09T10:03:10Z', SONNET, { i: 10, o: 900, cr: 20000 }, [{ type: 'text', text: 'STATUS: partial\nhalf done' }]),
  ]);
  return file;
}

test('golden spawn record: categories, context buckets, startup, compaction, extra turns, simple runs, status', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedWorker(root);
    const r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.deepEqual(r.factsWritten, ['2026-10-09']);
    const f = readDay('2026-10-09');
    assert.equal(f.extractorVersion, 2);
    assert.equal(f.spawns.length, 1);
    const sp = f.spawns[0];
    assert.deepEqual(sp, {
      id: 'toolu_A',
      sid: 'sess1',
      aid: 'w1',
      proj: 'projA',
      type: 'bounded-feature',
      role: 'writer',
      rung: 'sonnet/medium',
      fit: null,
      model: SONNET,
      mixed: false,
      start: '2026-10-09T10:00:00.000Z',
      end: '2026-10-09T10:03:10.000Z',
      partial: false,
      req: {
        n: 10,
        bucket: '6-15',
        cat: {
          read: [100, 50, 5000, 0, 40000, 1],
          'bash-read': [20, 80, 0, 0, 160000, 2],
          test: [10, 30, 0, 0, 210000, 1],
          'git-write': [10, 30, 0, 0, 20000, 1],
          wait: [10, 40, 0, 0, 40000, 1],
          'edit-small': [10, 40, 0, 0, 40000, 1],
          'edit-large': [10, 800, 0, 0, 160000, 1],
          mcp: [10, 30, 0, 0, 20000, 1],
          text: [10, 900, 0, 0, 20000, 1],
        },
      },
      ctx: {
        buckets: [[160, 1130, 5000, 0, 220000, 7], [10, 40, 0, 0, 120000, 1], [10, 800, 0, 0, 160000, 1], [10, 30, 0, 0, 210000, 1]],
        peak: 210010,
      },
      startup: [100, 50, 5000, 0, 40000, 1],
      comp: { n: 1, after: [40, 990, 0, 0, 270000, 4] },
      extraTurns: 1,
      status: 'partial',
      simple: { runs: 1, req: 5, tok: [140, 210, 5000, 0, 280000, 5] },
      rk: respawnKey({ description: 'Port the classifier', name: 'w-0-1-2-a1', brief: 'TYPE: bounded-feature\nROLE: writer\nport the classifier' }),
    });
  } finally { fx.cleanup(); }
});

test('a spawn open across the day boundary waits, then lands on its start day', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const file = subFile(root, 'sess2', 'w2', { agentType: 'agent-companion:ac-haiku', description: 'd', toolUseId: 'toolu_B' });
    put(file, [
      user('b', '2026-10-09T07:50:00Z', 'TYPE: explore\nROLE: lookup\nlook'),
      asst('a1', '2026-10-09T07:55:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t1', 'Read', {})),
      asst('a2', '2026-10-09T08:05:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t2', 'Read', {})),
    ]);
    // 08:10Z: the day 2026-10-08 has closed and settled, but the spawn made a request 5 minutes ago
    const early = Date.parse('2026-10-09T08:10:00Z');
    const r1 = runCheckup({ root, nowT: early, holdMs: 0 });
    assert.deepEqual(r1.factsWritten, [], 'the day file waits for its open spawn');
    const open = JSON.parse(readFileSync(join(factsDir(), 'open.json'), 'utf8'));
    assert.equal(open.spawns.length, 1);
    assert.equal(open.spawns[0].id, 'toolu_B');
    assert.equal(open.spawns[0].startDay, '2026-10-08');
    // the worker finishes after the boundary; the scan resumes from the cursor
    put(file, [asst('a3', '2026-10-09T08:20:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t3', 'Read', {}))], { append: true });
    const r2 = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.ok(r2.factsWritten.includes('2026-10-08'));
    const d8 = readDay('2026-10-08');
    assert.equal(d8.spawns.length, 1, 'it lands on the day it started');
    assert.equal(d8.spawns[0].start, '2026-10-09T07:50:00.000Z');
    assert.equal(d8.spawns[0].req.n, 3, 'with every request, including those after the boundary');
    assert.equal(d8.spawns[0].partial, false);
    const d9 = readDay('2026-10-09');
    assert.deepEqual(d9.spawns, [], 'and not on the day it ended');
    assert.ok(d9.rows.some((x) => x.hour === '2026-10-09T08:00:00.000Z'), 'its post-boundary tokens stay in the session-hour rows of the later day');
    const open2 = JSON.parse(readFileSync(join(factsDir(), 'open.json'), 'utf8'));
    assert.deepEqual(open2.spawns, [], 'nothing is open any more');
  } finally { fx.cleanup(); }
});

test('a day deferred for an open spawn is not marked covered: it is due again after the retry delay and then written', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const file = subFile(root, 'sess3', 'w3', { agentType: 'agent-companion:ac-haiku', description: 'd', toolUseId: 'toolu_C' });
    put(file, [
      user('b', '2026-10-09T07:50:00Z', 'TYPE: explore\nROLE: lookup\nlook'),
      asst('a1', '2026-10-09T07:55:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t1', 'Read', {})),
      asst('a2', '2026-10-09T08:05:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t2', 'Read', {})),
    ]);
    const early = Date.parse('2026-10-09T08:10:00Z');
    const r1 = runCheckup({ root, nowT: early, holdMs: 0 });
    assert.deepEqual(r1.factsWritten, []);
    const st1 = JSON.parse(readFileSync(checkupPaths().status, 'utf8'));
    assert.equal(st1.lastDay, '2026-10-07', 'the deferred day 2026-10-08 is not covered');
    assert.equal(checkupDue(early + 60 * 60 * 1000), false, 'rate-limited inside the 3 h retry delay');
    const later = early + RETRY_MS + 60 * 1000;
    assert.equal(checkupDue(later), true, 'due again once the retry delay has passed');
    const r2 = runCheckup({ root, nowT: later, holdMs: 0 });
    assert.deepEqual(r2.factsWritten, ['2026-10-08'], 'the retry writes the deferred day (the spawn is idle by then)');
    assert.ok(existsSync(join(factsDir(), '2026-10-08.json')));
    assert.equal(JSON.parse(readFileSync(checkupPaths().status, 'utf8')).lastDay, '2026-10-08', 'now covered');
    assert.equal(checkupDue(later + RETRY_MS + 1), false, 'normal path: one run per day once the facts file exists');
  } finally { fx.cleanup(); }
});

test('an open spawn is forced closed 48 hours after its start', () => {
  const sp = newSpawn({ key: 'k', sid: 's', aid: 'a', proj: null, start: 1_000_000 });
  addSpawnRequest(sp, { ts: 1_000_000 + 100, model: SONNET, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, ctx: 1, cats: null });
  assert.equal(isOpen(sp, 1_000_000 + 60_000), true);
  assert.equal(isOpen(sp, 1_000_000 + 31 * 60_000), false, 'idle for 30 minutes');
  sp.t1 = 1_000_000 + SPAWN_MAX_OPEN_MS + 5;
  assert.equal(isOpen(sp, 1_000_000 + SPAWN_MAX_OPEN_MS + 10), false, 'past the 48 h cap');
});

test('an incremental scan of a spawn equals a full scan', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedWorker(root);
    const full = scanTranscripts({ root, nowT: NOW, holdMs: 0 }).state.facts.spawns;
    assert.equal(Object.keys(full).length, 1);
    // the same worker, appended in three pieces and scanned after each
    const lines = readFileSync(join(root, 'projA', 'sess1', 'subagents', 'agent-w1.jsonl'), 'utf8').split('\n').filter(Boolean);
    const root2 = join(fx.dir, 'transcripts2');
    const file = subFile(root2, 'sess1', 'w1', { agentType: 'agent-companion:ac-sonnet-medium', description: 'Port the classifier', name: 'w-0-1-2-a1', toolUseId: 'toolu_A' });
    let from = 0;
    let st = null;
    let seen = null;
    for (const to of [4, 11, lines.length]) {
      put(file, lines.slice(from, to), { append: from > 0 });
      from = to;
      const r = scanTranscripts({ root: root2, nowT: NOW, holdMs: 0, state: st, seen });
      st = r.state;
      seen = r.seen;
    }
    assert.deepEqual(st.facts.spawns, full);
  } finally { fx.cleanup(); }
});

test('status parsing reuses the status-line parser', () => {
  assert.equal(statusOf('STATUS: done\nall good'), 'done');
  assert.equal(statusOf('**STATUS:** blocked\nneed a token'), 'blocked');
  assert.equal(statusOf('> Status - Partial\nhalf'), 'partial');
  assert.equal(statusOf('STATUS: done | blocked | partial'), null, 'the template line is not a status');
  assert.equal(statusOf('no status here'), null);
  assert.equal(statusOf(''), null);
});

test('the last text of the worker decides the STATUS word', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const file = subFile(root, 'sess3', 'w3', { agentType: 'agent-companion:ac-haiku', description: 'd', toolUseId: 'toolu_C' });
    put(file, [
      user('b', '2026-10-09T10:00:00Z', 'TYPE: explore\nROLE: lookup\nlook'),
      asst('a1', '2026-10-09T10:00:10Z', HAIKU, { o: 20, cr: WARM }, [{ type: 'text', text: 'STATUS: done\nfirst answer' }]),
      user('e', '2026-10-09T10:05:00Z', 'one more thing please'),
      asst('a2', '2026-10-09T10:05:10Z', HAIKU, { o: 20, cr: WARM }, [{ type: 'text', text: 'STATUS: blocked\nneed access' }]),
    ]);
    const bare = subFile(root, 'sess3', 'w4', { agentType: 'agent-companion:ac-haiku', description: 'd2', toolUseId: 'toolu_D' });
    put(bare, [
      user('b4', '2026-10-09T10:00:00Z', 'look'),
      asst('d1', '2026-10-09T10:00:10Z', HAIKU, { o: 20, cr: WARM }, tu('t', 'Read', {})),
    ]);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const byId = Object.fromEntries(readDay('2026-10-09').spawns.map((s) => [s.id, s]));
    assert.equal(byId.toolu_C.status, 'blocked');
    assert.equal(byId.toolu_C.extraTurns, 1);
    assert.equal(byId.toolu_D.status, null);
    assert.equal(byId.toolu_D.type, null);
    assert.equal(byId.toolu_D.extraTurns, 0);
  } finally { fx.cleanup(); }
});

test('classifiers: request categories, buckets, re-spawn key', () => {
  const c = (name, input) => classTool({ name, input });
  assert.equal(c('Read', {}), 'read');
  assert.equal(c('Bash', { command: 'ls -la' }), 'bash-read');
  assert.equal(c('Bash', { command: 'git -C . diff' }), 'bash-read');
  assert.equal(c('Bash', { command: 'mkdir out' }), 'bash-other');
  assert.equal(c('Bash', { command: 'node --test tests/x.test.mjs' }), 'test');
  assert.equal(c('Bash', { command: 'git commit -m x' }), 'git-write');
  assert.equal(c('Bash', { command: 'sleep 20 && ls' }), 'wait');
  assert.equal(c('PowerShell', { command: 'Get-Content a.txt' }), 'bash-read');
  assert.equal(c('Edit', { new_string: 'x'.repeat(400) }), 'edit-small');
  assert.equal(c('Edit', { new_string: 'x'.repeat(401) }), 'edit-large');
  assert.equal(c('Write', { content: 'x'.repeat(501) }), 'edit-large');
  assert.equal(c('Agent', {}), 'orchestrate');
  assert.equal(c('SendMessage', {}), 'orchestrate');
  assert.equal(c('mcp__a__b', {}), 'mcp');
  assert.equal(c('TodoWrite', {}), 'meta');
  assert.equal(requestCategory(new Map([['1', 'read'], ['2', 'test']])), 'test', 'precedence picks the most expensive step');
  assert.equal(requestCategory(new Map()), 'text');
  assert.deepEqual([...classToolsOf([{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'a', name: 'Read', input: {} }])], [['a', 'read']]);
  assert.deepEqual([1, 5, 6, 15, 16, 40, 41].map(requestBucket), [0, 0, 1, 1, 2, 2, 3]);
  assert.deepEqual([0, 99999, 100000, 149999, 150000, 199999, 200000].map(contextBucket), [0, 0, 1, 1, 2, 2, 3]);
  assert.equal(nameStem('Worker-Batch-2'), nameStem('worker-batch-2-retry'));
  assert.notEqual(nameStem('alpha-writer'), nameStem('beta-writer'));
  const k1 = respawnKey({ description: 'Port it', name: 'w-1', brief: 'TYPE: x\n\nport it' });
  const k2 = respawnKey({ description: 'Port it', name: 'w-1-retry', brief: 'TYPE: x port it' });
  assert.deepEqual(k1, k2, 'the same description, name stem and brief head give the same key');
  assert.deepEqual(respawnKey({}), { d: null, n: null, h: null });
  assert.match(k1.d, /^[0-9a-f]{12}$/, 'hashed, never the text');
});

test('simple runs: a run of 4 or more steps with small output counts, a run of 3 does not', () => {
  const sp = newSpawn({ key: 'k', sid: 's', aid: 'a', proj: null, start: 1 });
  const u = (o) => ({ input: 1, output: o, cacheRead: 100, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const seq = [10, 10, 10, 10, 900, 10, 10, 10, 900, 10, 10, 10, 10, 10];
  seq.forEach((o, i) => addSpawnRequest(sp, { ts: 1000 + i, model: SONNET, usage: u(o), ctx: 101, cats: null }));
  const rec = spawnRecord(sp);
  assert.equal(rec.simple.runs, 2, 'the trailing open run is closed when the record is built');
  assert.equal(rec.simple.req, 9);
  assert.equal(rec.simple.tok[5], 9);
  assert.equal(sp.cur.len, 5, 'building a record does not change the accumulator');
});

test('facts hold hashes and tokens, never the brief, the description or the name', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedWorker(root);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const text = readFileSync(join(factsDir(), '2026-10-09.json'), 'utf8');
    for (const secret of ['Port the classifier', 'w-0-1-2-a1', 'port the classifier', 'continue with the second half', 'half done']) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
  } finally { fx.cleanup(); }
});

test('no claude call, every spawn hides its window, and nothing is written outside --root and the state dir', () => {
  const { fx, root } = mk();
  try {
    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    seedWorker(root);
    const walk = (dir, out = {}) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out); else out[relative(fx.dir, p).split('\\').join('/')] = `${st.size}`;
      }
      return out;
    };
    const before = walk(root);
    const sep = process.platform === 'win32' ? ';' : ':';
    const res = runScript('scripts/daily-checkup.mjs', ['--root', root, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0'], {
      env: { PATH: `${bin}${sep}${process.env.PATH}` },
    });
    assert.equal(res.status, 0);
    assert.ok(existsSync(join(factsDir(), '2026-10-09.json')), 'the script wrote the facts file');
    assert.ok(!existsSync(log), 'the fake claude was never called');
    assert.deepEqual(walk(root), before, 'the transcript root is read-only');
    const after = walk(fx.dir);
    const stray = Object.keys(after).filter((p) => !p.startsWith('transcripts/') && !p.startsWith('fakebin/') && !p.startsWith('.claude/agent-companion/'));
    assert.deepEqual(stray, [], 'every new file is under the state dir');
    for (const rel of ['scripts/lib/usage/spawns.mjs', 'scripts/lib/usage/facts.mjs', 'scripts/lib/daily-checkup.mjs']) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/(?<![.\w])(?:spawn|spawnSync|exec|execFile|execFileSync|fork|spawnFn)\(/g)) {
        assert.match(src.slice(m.index, m.index + 400), /windowsHide:\s*true/, `${rel}: a child process without windowsHide at ${m.index}`);
      }
    }
  } finally { fx.cleanup(); }
});

test('writeOpenFile writes nothing when no spawn is open and no file exists', () => {
  const { fx } = mk();
  try {
    assert.equal(writeOpenFile({ facts: { spawns: {}, landed: {} } }, NOW), false);
    assert.ok(!existsSync(join(factsDir(), 'open.json')));
  } finally { fx.cleanup(); }
});

// --- Completion closes a spawn at once (the 04:10 run must not wait on a finished worker) ---

const withStop = (line, stop) => { const j = JSON.parse(line); j.message.stop_reason = stop; return JSON.stringify(j); };
const EARLY = Date.parse('2026-10-09T08:10:00Z'); // the day 2026-10-08 closed 10 minutes ago

function seedLate(root, { endTurn = false, parent = false, aid = 'wl', sid = 'sessL' } = {}) {
  const file = subFile(root, sid, aid, { agentType: 'agent-companion:ac-haiku', description: 'd', toolUseId: 'toolu_P' });
  put(file, [
    user('bl', '2026-10-09T07:50:00Z', 'TYPE: explore\nROLE: lookup\nlook'),
    asst('l1', '2026-10-09T07:54:00Z', HAIKU, { i: 5, o: 50, cr: WARM }, tu('t1', 'Read', {})),
    withStop(asst('l2', '2026-10-09T07:55:00Z', HAIKU, { i: 5, o: 60, cr: WARM }, [{ type: 'text', text: 'STATUS: done\nok' }]), endTurn ? 'end_turn' : null),
  ]);
  if (parent) {
    put(join(root, 'projA', `${sid}.jsonl`), [
      user('pp', '2026-10-09T07:49:00Z', 'please look into it and report back to me'),
      asst('p1', '2026-10-09T07:49:30Z', SONNET, { i: 5, o: 20, cr: WARM }, tu('toolu_P', 'Agent', { prompt: 'look' })),
      JSON.stringify({ type: 'user', timestamp: '2026-10-09T07:55:10Z', uuid: 'tr-p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_P', content: 'STATUS: done' }] } }),
    ]);
  }
}

test('a spawn that completed before the boundary does not block the day file (end_turn signal)', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedLate(root, { endTurn: true });
    const r = runCheckup({ root, nowT: EARLY, holdMs: 0 });
    assert.ok(r.factsWritten.includes('2026-10-08'), 'the day file is written at once');
    assert.equal(readDay('2026-10-08').spawns.length, 1);
    assert.equal(readDay('2026-10-08').spawns[0].status, 'done');
  } finally { fx.cleanup(); }
});

test('a spawn that completed before the boundary does not block the day file (parent tool_result signal)', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedLate(root, { parent: true });
    const r = runCheckup({ root, nowT: EARLY, holdMs: 0 });
    assert.ok(r.factsWritten.includes('2026-10-08'));
    assert.equal(readDay('2026-10-08').spawns.length, 1);
  } finally { fx.cleanup(); }
});

test('a spawn without a completion signal waits for the idle fallback', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedLate(root, {});
    assert.deepEqual(runCheckup({ root, nowT: EARLY, holdMs: 0 }).factsWritten, [], 'idle 15 minutes: still open');
    const r = runCheckup({ root, nowT: Date.parse('2026-10-09T08:30:00Z'), holdMs: 0 });
    assert.ok(r.factsWritten.includes('2026-10-08'), 'idle 35 minutes: closed by the fallback');
  } finally { fx.cleanup(); }
});

test('a new turn re-opens a spawn that had ended', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedLate(root, { endTurn: true });
    const file = join(root, 'projA', 'sessL', 'subagents', 'agent-wl.jsonl');
    put(file, [user('again', '2026-10-09T08:08:00Z', 'one more question please'), asst('l3', '2026-10-09T08:09:00Z', HAIKU, { o: 10, cr: WARM }, tu('t9', 'Read', {}))], { append: true });
    assert.deepEqual(runCheckup({ root, nowT: EARLY, holdMs: 0 }).factsWritten, []);
  } finally { fx.cleanup(); }
});

test('a completed spawn gives the same record whichever completion signal is seen', () => {
  const recs = [];
  for (const opts of [{ endTurn: true }, { parent: true }, { endTurn: true, parent: true }]) {
    const { fx, root } = mk();
    try {
      resetUnitCache();
      seedLate(root, opts);
      runCheckup({ root, nowT: NOW, holdMs: 0 });
      recs.push(readDay('2026-10-08').spawns);
    } finally { fx.cleanup(); }
  }
  assert.equal(recs[0].length, 1);
  assert.deepEqual(recs[1], recs[0]);
  assert.deepEqual(recs[2], recs[0]);
});

test('spawn type (A-1): the telemetry row wins, the brief TYPE token is the fallback for known names only, neither is null', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const worker = (aid, tuid, brief) => {
      const file = subFile(root, 'sess5', aid, { agentType: 'agent-companion:ac-haiku', description: 'd', toolUseId: tuid });
      put(file, [
        user(`b-${aid}`, '2026-10-09T10:00:00Z', brief),
        asst(`a-${aid}`, '2026-10-09T10:00:10Z', HAIKU, { o: 20, cr: WARM }, tu(`t-${aid}`, 'Read', {})),
      ]);
    };
    worker('w1', 'toolu_T1', 'TYPE: explore\nROLE: lookup\nlook'); // the telemetry row says bounded-feature: it wins
    worker('w2', 'toolu_T2', 'TYPE: explore\nlook'); // no row: the brief token, a known name
    worker('w3', 'toolu_T3', 'TYPE: zz-not-a-task-type\nlook'); // no row, unknown token: unknown, and the token is not stored
    worker('w4', 'toolu_T4', 'just look'); // no row, no TYPE line: unknown
    worker('w5', 'toolu_T5', 'look'); // a row with an alias and its resolved name: the resolved name
    const tdir = telemetryDir();
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'spawns.jsonl'), `${[
      { at: '2026-10-09T10:00:00.000Z', session_id: 'sess5', tool_use_id: 'toolu_T1', declared_type: 'bounded-feature', declared_type_resolved: null, fit: 'fit' },
      { at: '2026-10-09T10:00:00.000Z', session_id: 'sess5', tool_use_id: 'toolu_T5', declared_type: 'some-alias', declared_type_resolved: 'bounded-feature', fit: 'over' },
      { at: '2026-10-09T10:00:00.000Z', session_id: 'sess5', tool_use_id: 'toolu_other', declared_type: null, fit: 'fit' },
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const day = readDay('2026-10-09');
    const byId = Object.fromEntries(day.spawns.map((s) => [s.id, s]));
    assert.equal(byId.toolu_T1.type, 'bounded-feature');
    assert.equal(byId.toolu_T1.fit, 'fit');
    assert.equal(byId.toolu_T2.type, 'explore');
    assert.equal(byId.toolu_T3.type, null);
    assert.equal(byId.toolu_T4.type, null);
    assert.equal(byId.toolu_T5.type, 'bounded-feature');
    assert.ok(!JSON.stringify(day).includes('zz-not-a-task-type'), 'an unknown brief token is never stored');
    assert.ok(day.spawns.every((s) => s.type !== 'none'), 'no spawn type says "none"');
  } finally { fx.cleanup(); }
});
