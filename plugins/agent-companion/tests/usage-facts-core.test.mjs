// Usage facts, batch 2a: the fact sink in the checkup scan, the per-day facts file, and the
// unit recomputation. Fixtures are synthetic transcripts in a temp root; nothing reads the
// operator's real transcripts and nothing calls a model.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, openSync, writeSync, closeSync, statSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import {
  runCheckup, scanTranscripts, unitsOf, resetUnitCache, factsDir, readHistory, checkupPaths, DAY_MS, dayStartMs,
} from '../scripts/lib/daily-checkup.mjs';
import {
  unitsOfFacts, unitsFromTokens, correctionFlag, hasTerm, operatorPromptText, toolKindsOf, lengthBucket,
  FACTS_VERSION, EXTRACTOR_VERSION,
} from '../scripts/lib/usage/facts.mjs';

const T = (s) => Date.parse(s);
const NOW = T('2026-10-10T09:00:00Z'); // the day 2026-10-09 (08:00Z to 08:00Z) is closed and settled
const DAY = '2026-10-09';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';

function asst(id, ts, model, u = {}, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: id,
    uuid: extra.uuid || `u-${id}-${ts}`,
    cwd: extra.cwd || 'C:/work/projA',
    message: {
      id: `msg_${id}`,
      model,
      content: extra.content || [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: u.i || 0,
        output_tokens: u.o || 0,
        cache_read_input_tokens: u.cr || 0,
        cache_creation_input_tokens: (u.w5 || 0) + (u.w1 || 0) + (u.flat || 0),
        ...(u.flat ? {} : { cache_creation: { ephemeral_5m_input_tokens: u.w5 || 0, ephemeral_1h_input_tokens: u.w1 || 0 } }),
      },
    },
  });
}
const prompt = (uuid, ts, text, extra = {}) => JSON.stringify({
  type: 'user', timestamp: ts, uuid, cwd: 'C:/work/projA', message: { role: 'user', content: text }, ...extra,
});
const toolResult = (uuid, ts) => JSON.stringify({
  type: 'user', timestamp: ts, uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'no, wrong, again' }] },
});

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

const factsFile = (day = DAY) => join(factsDir(), `${day}.json`);
const readFacts = (day = DAY) => JSON.parse(readFileSync(factsFile(day), 'utf8'));
const strip = (f) => { const { computedAt, ...rest } = f; void computedAt; return rest; };

// A main session and one worker, with prompts, tool calls, three models.
function seedDay(root) {
  const bashCommit = [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git -C . commit -m x' } }];
  const agent = [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { prompt: 'p' } }, { type: 'tool_use', id: 'tu3', name: 'SendMessage', input: {} }];
  put(join(root, 'projA', 'sess1.jsonl'), [
    prompt('p1', '2026-10-09T10:00:00Z', 'Please add the thing to the parser and then run the tests for it'),
    asst('m1', '2026-10-09T10:00:05Z', SONNET, { i: 1000, o: 500, cr: 100000, w5: 2000, w1: 1000 }, { content: bashCommit }),
    toolResult('tr1', '2026-10-09T10:00:06Z'),
    asst('m2', '2026-10-09T10:30:00Z', SONNET, { cr: 2_000_000 }, { content: agent }),
    prompt('p2', '2026-10-09T11:05:00Z', 'no, that is wrong'),
    asst('m3', '2026-10-09T11:06:00Z', OPUS, { i: 10, o: 20, flat: 4000 }),
    prompt('meta1', '2026-10-09T11:07:00Z', '<task-notification>done</task-notification>'),
    prompt('p3', '2026-10-09T11:08:00Z', 'x'.repeat(1500)),
  ]);
  const sub = join(root, 'projA', 'sess1', 'subagents', 'agent-w1.jsonl');
  mkdirSync(dirname(sub), { recursive: true });
  writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-companion:ac-haiku', description: 'd' }));
  put(sub, [
    prompt('wp', '2026-10-09T10:10:00Z', 'TYPE: explore\nROLE: reader\nlook around'),
    asst('w1', '2026-10-09T10:11:00Z', HAIKU, { i: 5, o: 50, cr: 500_000 }),
  ]);
}

test('golden facts: rows, raw tokens per model, prompt buckets, tool counts, version stamps', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedDay(root);
    const r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.deepEqual(r.factsWritten, [DAY]);
    const f = readFacts();
    assert.equal(f.schema, 'agent-companion/usage-facts');
    assert.equal(f.factsVersion, FACTS_VERSION);
    assert.equal(f.extractorVersion, EXTRACTOR_VERSION);
    assert.equal(f.day, DAY);
    assert.equal(f.from, '2026-10-09T08:00:00.000Z');
    assert.equal(f.dataThrough, '2026-10-09T11:06:00.000Z');
    const rows = f.rows.map((x) => `${x.hour}|${x.sid}`);
    assert.deepEqual(rows, [
      '2026-10-09T10:00:00.000Z|sess1',
      '2026-10-09T11:00:00.000Z|sess1',
    ]);
    const [h10, h11] = f.rows;
    assert.equal(h10.proj, 'projA');
    assert.equal(h10.cwd, 'C:/work/projA');
    assert.deepEqual(h10.tok[SONNET].m, [1000, 500, 2000, 1000, 2_100_000, 2]);
    assert.deepEqual(h10.tok[SONNET].s, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(h10.tok[HAIKU].s, [5, 50, 0, 0, 500_000, 1], 'a worker request goes to the subagent vector, under its parent session');
    assert.deepEqual(h10.pr, { n: 1, len: [0, 1, 0, 0], corr: 0 });
    assert.deepEqual([h10.ag, h10.sm, h10.gc], [1, 1, 1]);
    assert.deepEqual(h11.tok[OPUS].m, [10, 20, 4000, 0, 0, 1], 'a flat cache write is folded into the 5m slot');
    assert.deepEqual(h11.pr, { n: 2, len: [1, 0, 0, 1], corr: 1 }, 'tool results and task notices are not prompts; "no," is a correction flag');
    assert.deepEqual(Object.keys(f.weightsUsed).sort(), [HAIKU, OPUS, SONNET].sort());
    assert.equal(f.weightsUsed[SONNET].mult, 1);
    assert.equal(f.weightsUsed[SONNET].label, 'M');
    assert.equal(f.weightsUsed[HAIKU].mult, 0.5);
    assert.equal(f.weightsUsed[HAIKU].label, 'E');
    assert.equal(f.weightsUsed[HAIKU].source, 'study-constant');
    // facts hold counts and flags, never the text
    assert.ok(!readFileSync(factsFile(), 'utf8').includes('parser'));
    assert.ok(!readFileSync(factsFile(), 'utf8').includes('xxxxxxxx'));
  } finally { fx.cleanup(); }
});

test('the facts units equal the checkup units for the same day', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seedDay(root);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const rec = readHistory().find((x) => x.day === DAY);
    const f = readFacts();
    assert.ok(Math.abs(unitsOfFacts(f) - rec.units.total) < 0.05, `${unitsOfFacts(f)} vs ${rec.units.total}`);
    assert.ok(Math.abs(unitsOfFacts(f, { kind: 's' }) - rec.units.subagent) < 0.05);
    assert.ok(Math.abs(unitsOfFacts(f, { kind: 'm' }) - rec.units.main) < 0.05);
  } finally { fx.cleanup(); }
});

test('units recomputed with a changed weight equal pricing the same tokens at that weight', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const u = { i: 12345, o: 6789, cr: 4_000_000, w5: 300_000, w1: 100_000 };
    put(join(root, 'projA', 's1.jsonl'), [asst('h1', '2026-10-09T12:00:00Z', HAIKU, u)]);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const f = readFacts();
    const usage = { input: u.i, output: u.o, cacheRead: u.cr, cacheWrite: u.w5 + u.w1, cacheWrite5m: u.w5, cacheWrite1h: u.w1 };
    assert.ok(Math.abs(unitsOfFacts(f) - unitsOf(usage, HAIKU)) < 1e-9, 'recorded weight reproduces the scan');
    // a rescan under weight 1.0 is the same tokens priced as Sonnet
    assert.ok(Math.abs(unitsOfFacts(f, { weights: { [HAIKU]: 1 } }) - unitsOf(usage, SONNET)) < 1e-9);
    assert.ok(Math.abs(unitsOfFacts(f, { weights: { [HAIKU]: 3 } }) - 3 * unitsOf(usage, SONNET)) < 1e-9);
    assert.equal(unitsFromTokens([0, 0, 0, 0, 0, 0], f.weightsUsed[HAIKU]), 0);
  } finally { fx.cleanup(); }
});

test('an incremental scan equals a full scan', () => {
  const all = [
    prompt('p1', '2026-10-09T10:00:00Z', 'first request of the day, long enough to count as a task'),
    asst('a1', '2026-10-09T10:00:05Z', SONNET, { cr: 1_000_000 }),
    asst('a2', '2026-10-09T10:20:00Z', OPUS, { cr: 2_000_000, o: 800 }),
    prompt('p2', '2026-10-09T10:40:00Z', 'wrong again'),
    asst('a3', '2026-10-09T11:10:00Z', SONNET, { cr: 3_000_000 }),
    asst('a4', '2026-10-09T12:10:00Z', SONNET, { cr: 3_000_000 }),
  ];
  let fullFacts;
  const full = mk();
  try {
    put(join(full.root, 'projA', 's1.jsonl'), all);
    resetUnitCache();
    runCheckup({ root: full.root, nowT: NOW, holdMs: 0 });
    fullFacts = strip(readFacts());
  } finally { full.fx.cleanup(); }
  const inc = mk();
  try {
    // the same lines arriving over three runs, the file growing in between
    const incFile = join(inc.root, 'projA', 's1.jsonl');
    put(incFile, all.slice(0, 2));
    resetUnitCache();
    runCheckup({ root: inc.root, nowT: T('2026-10-09T13:00:00Z'), holdMs: 0 });
    put(incFile, all.slice(2, 4), { append: true });
    runCheckup({ root: inc.root, nowT: T('2026-10-09T14:00:00Z'), holdMs: 0 });
    put(incFile, all.slice(4), { append: true });
    runCheckup({ root: inc.root, nowT: NOW, holdMs: 0 });
    const incFacts = strip(readFacts());
    assert.deepEqual(incFacts.rows, fullFacts.rows);
    assert.deepEqual(incFacts.weightsUsed, fullFacts.weightsUsed);
    assert.equal(incFacts.dataThrough, fullFacts.dataThrough);
  } finally { inc.fx.cleanup(); }
});

test('no double count: a request or prompt copied into a second file (resume, fork) is counted once', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const lines = [
      prompt('p1', '2026-10-09T10:00:00Z', 'a prompt that is long enough to be a real task for the bucket'),
      asst('a1', '2026-10-09T10:00:05Z', SONNET, { cr: 1_000_000 }, { uuid: 'same-uuid' }),
    ];
    put(join(root, 'projA', 's1.jsonl'), lines);
    put(join(root, 'projA', 's1-fork.jsonl'), lines);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const f = readFacts();
    const reqs = f.rows.reduce((n, r) => n + r.tok[SONNET].m[5], 0);
    const prompts = f.rows.reduce((n, r) => n + r.pr.n, 0);
    assert.equal(reqs, 1);
    assert.equal(prompts, 1);
    // and a second run over unchanged files adds nothing
    const before = JSON.stringify(strip(f));
    runCheckup({ root, nowT: NOW + 60000, holdMs: 0 });
    assert.equal(JSON.stringify(strip(readFacts())), before);
  } finally { fx.cleanup(); }
});

test('a day file is written once, only after close plus settle, and never rewritten', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T10:00:00Z', SONNET, { cr: 1_000_000 })]);
    const closeMs = T('2026-10-10T08:00:00Z');
    let r = runCheckup({ root, nowT: closeMs + 60_000, holdMs: 0 });
    assert.deepEqual(r.factsWritten, [], 'a minute after close is not settled');
    assert.ok(!existsSync(factsFile()));
    r = runCheckup({ root, nowT: closeMs + 6 * 60_000, holdMs: 0 });
    assert.deepEqual(r.factsWritten, [DAY]);
    const first = readFileSync(factsFile(), 'utf8');
    // late data for the closed day does not rewrite the file
    put(join(root, 'projA', 's1.jsonl'), [asst('a2', '2026-10-09T12:00:00Z', SONNET, { cr: 1_000_000 })], { append: true });
    r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.deepEqual(r.factsWritten, []);
    assert.equal(readFileSync(factsFile(), 'utf8'), first);
    // the open day never gets a file
    assert.ok(!existsSync(factsFile('2026-10-10')));
  } finally { fx.cleanup(); }
});

test('a state written before the sink existed starts facts at the next whole day', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T10:00:00Z', SONNET, { cr: 1_000_000 })]);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    // strip facts from the saved state, as an older release left it
    const stateP = checkupPaths().state;
    const st = JSON.parse(readFileSync(stateP, 'utf8'));
    delete st.facts;
    writeFileSync(stateP, JSON.stringify(st));
    rmSync(factsDir(), { recursive: true, force: true });
    put(join(root, 'projA', 's1.jsonl'), [
      asst('a2', '2026-10-10T12:00:00Z', SONNET, { cr: 1_000_000 }),
      asst('a3', '2026-10-11T12:00:00Z', SONNET, { cr: 1_000_000 }),
    ], { append: true });
    // the upgrade run happens during day 10-10: its facts start at 10-11
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const r = runCheckup({ root, nowT: T('2026-10-12T09:00:00Z'), holdMs: 0 });
    assert.ok(!existsSync(factsFile(DAY)), 'bytes scanned before the sink are not claimed as facts');
    assert.ok(!existsSync(factsFile('2026-10-10')), 'the day that was open at the upgrade is partial: no file');
    assert.deepEqual(r.factsWritten, ['2026-10-11'], 'the first whole day after the upgrade has facts');
    assert.equal(dayStartMs(NOW) + DAY_MS, T('2026-10-11T08:00:00Z'));
  } finally { fx.cleanup(); }
});

test('classifiers: prompt text, tool kinds, correction words, length buckets', () => {
  assert.equal(operatorPromptText({ type: 'user', message: { content: 'hello' } }), 'hello');
  assert.equal(operatorPromptText({ type: 'user', isMeta: true, message: { content: 'hello' } }), null);
  assert.equal(operatorPromptText({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), null);
  assert.equal(operatorPromptText({ type: 'user', message: { content: '<command-name>/x</command-name>' } }), null);
  assert.equal(operatorPromptText({ type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  const k = toolKindsOf([
    { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'git commit -m "x"' } },
    { type: 'tool_use', id: '2', name: 'Bash', input: { command: 'git status' } },
    { type: 'tool_use', id: '3', name: 'Bash', input: { command: 'cd x && git -C y commit --amend' } },
    { type: 'tool_use', id: '4', name: 'Agent', input: {} },
    { type: 'tool_use', id: '5', name: 'SendMessage', input: {} },
    { type: 'tool_use', id: '6', name: 'Read', input: {} },
  ]);
  assert.deepEqual([...k], [['1', 'gc'], ['3', 'gc'], ['4', 'ag'], ['5', 'sm']]);
  assert.equal(correctionFlag('No, that is wrong'), true);
  assert.equal(correctionFlag('Say it AGAIN please'), true);
  assert.equal(correctionFlag('the pianos, stopwatch and nobody'), false, 'whole words only');
  assert.equal(hasTerm('i said so', 'i said'), true);
  assert.deepEqual([0, 59, 60, 199, 200, 999, 1000].map(lengthBucket), [0, 0, 1, 1, 2, 2, 3]);
});

test('no claude call, and every spawn hides its window', () => {
  const { fx, root } = mk();
  try {
    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    const body = `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`;
    writeFileSync(join(bin, 'claude'), body, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    seedDay(root);
    const sep = process.platform === 'win32' ? ';' : ':';
    const res = runScript('scripts/daily-checkup.mjs', ['--root', root, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0'], {
      env: { PATH: `${bin}${sep}${process.env.PATH}` },
    });
    assert.equal(res.status, 0);
    assert.ok(existsSync(factsFile()), 'the script wrote the facts file');
    assert.ok(!existsSync(log), 'the fake claude was never called');
    for (const rel of ['scripts/lib/usage/facts.mjs', 'scripts/lib/daily-checkup.mjs']) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/(?<![.\w])(?:spawn|spawnSync|exec|execFile|execFileSync|fork|spawnFn)\(/g)) {
        const tail = src.slice(m.index, m.index + 400);
        assert.match(tail, /windowsHide:\s*true/, `${rel}: a child process without windowsHide at ${m.index}`);
      }
    }
  } finally { fx.cleanup(); }
});

test('streaming: a synthetic 200 MB transcript is read in chunks, peak RSS stays bounded', (t) => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    const file = join(root, 'projA', 'big.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'w');
    // 20-minute-spaced requests across the day; a long tool_result line between each pair, as real files have.
    const filler = JSON.stringify({ type: 'user', timestamp: '2026-10-09T09:00:00Z', uuid: 'f', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(60_000) }] } });
    const block = [];
    let nReq = 0;
    const TARGET = 200 * 1024 * 1024;
    let written = 0;
    while (written < TARGET) {
      block.length = 0;
      for (let i = 0; i < 20; i += 1) {
        const ts = new Date(T('2026-10-09T08:30:00Z') + ((nReq * 7) % 1400) * 60_000).toISOString();
        block.push(asst(`r${nReq}`, ts, SONNET, { cr: 1000 + (nReq % 7), o: 10 }, { uuid: `uu${nReq}` }));
        nReq += 1;
      }
      block.push(filler);
      const text = `${block.join('\n')}\n`;
      writeSync(fd, text);
      written += Buffer.byteLength(text);
    }
    closeSync(fd);
    assert.ok(statSync(file).size >= TARGET);
    const t0 = Date.now();
    const r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    const secs = (Date.now() - t0) / 1000;
    const maxRssMb = process.resourceUsage().maxRSS / 1024;
    assert.ok(r.bytesRead >= TARGET);
    const f = readFacts();
    const reqs = f.rows.reduce((n, x) => n + x.tok[SONNET].m[5], 0);
    assert.equal(reqs, nReq, 'every distinct request was counted once');
    // The accumulator is per request id (a few hundred bytes each); the file itself is never held.
    t.diagnostic(`peak RSS ${maxRssMb.toFixed(0)} MB, ${nReq} requests, ${secs.toFixed(1)} s`);
    assert.ok(maxRssMb < 512,`peak RSS ${maxRssMb.toFixed(0)} MB for a 200 MB file in ${secs.toFixed(1)} s`);
    assert.ok(secs < 120, `scan took ${secs.toFixed(1)} s`);
  } finally { fx.cleanup(); }
});

test('scanTranscripts without a facts window keeps the old return shape', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T10:00:00Z', SONNET, { cr: 1_000_000 })]);
    const s = scanTranscripts({ root, nowT: NOW, holdMs: 0 });
    assert.ok(s.state.facts && typeof s.state.facts.fromMs === 'number');
    assert.equal(typeof s.filesRead, 'number');
  } finally { fx.cleanup(); }
});
