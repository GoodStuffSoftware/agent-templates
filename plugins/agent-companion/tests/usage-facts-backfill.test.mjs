// Usage facts backfill (0.31.19). A checkup state that predates the fact sink (every install
// upgraded from 0.31.17 or earlier) had its cursors past every byte already read, and 0.31.18
// started its facts at the next whole day: `usage-analysis --scheduled` then found no facts day and
// computed nothing for up to two days. The scan now rebuilds the facts once, from each transcript's
// start up to the state's own cursor. Fixtures are synthetic transcripts in a temp root.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { makeFixture, runScript } from './helpers.mjs';
import {
  runCheckup, resetUnitCache, factsDir, checkupPaths, DAY_MS, dayStartMs, factsBackfillFrom, FACTS_BACKFILL_VERSION,
} from '../scripts/lib/daily-checkup.mjs';

const T = (s) => Date.parse(s);
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';

function asst(id, ts, model, u = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, cwd: 'C:/work/projA',
    message: {
      id: `msg_${id}`, model, content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: u.i || 0, output_tokens: u.o || 0, cache_read_input_tokens: u.cr || 0, cache_creation_input_tokens: 0 },
    },
  });
}
const prompt = (uuid, ts, text) => JSON.stringify({ type: 'user', timestamp: ts, uuid, cwd: 'C:/work/projA', message: { role: 'user', content: text } });

function put(file, lines, { append = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  (append ? appendFileSync : writeFileSync)(file, `${lines.join('\n')}\n`);
}

function mk() {
  const fx = makeFixture();
  const root = join(fx.dir, 'transcripts');
  mkdirSync(root, { recursive: true });
  return { fx, root };
}

const factsFile = (day) => join(factsDir(), `${day}.json`);
const readFacts = (day) => JSON.parse(readFileSync(factsFile(day), 'utf8'));
const comparable = (f) => ({ rows: f.rows, spawns: f.spawns, weightsUsed: f.weightsUsed, dataThrough: f.dataThrough });
const readState = () => JSON.parse(readFileSync(checkupPaths().state, 'utf8'));
const writeState = (st) => writeFileSync(checkupPaths().state, JSON.stringify(st));

// Two days of a main session and one worker. `part` 1 is what the old release scanned; part 2 arrives after the upgrade.
const MAIN = 'projA/sess1.jsonl';
const SUB = 'projA/sess1/subagents/agent-w1.jsonl';
const part1 = {
  [MAIN]: [
    prompt('p1', '2026-10-08T10:00:00Z', 'Please add the thing to the parser and then run the tests for it'),
    asst('m1', '2026-10-08T10:00:05Z', SONNET, { i: 1000, o: 500, cr: 100000 }),
    prompt('p2', '2026-10-09T10:00:00Z', 'no, that is wrong'),
    asst('m2', '2026-10-09T10:00:05Z', SONNET, { cr: 2_000_000 }),
  ],
  [SUB]: [
    prompt('wp', '2026-10-09T10:10:00Z', 'TYPE: explore\nROLE: reader\nlook around'),
    asst('w1', '2026-10-09T10:11:00Z', HAIKU, { i: 5, o: 50, cr: 500_000 }),
  ],
};
const part2 = {
  [MAIN]: [asst('m3', '2026-10-09T12:00:00Z', SONNET, { cr: 3_000_000 })],
  [SUB]: [asst('w2', '2026-10-09T10:20:00Z', HAIKU, { cr: 700_000 })],
};

function seed(root, part, append) {
  for (const [rel, lines] of Object.entries(part)) put(join(root, rel), lines, { append });
  writeFileSync(join(root, SUB).replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-companion:ac-haiku', description: 'd' }));
}

const UPGRADE = T('2026-10-09T13:00:00Z'); // during day 2026-10-09: the old scan read part 1 here
const NOW = T('2026-10-10T09:00:00Z'); // 2026-10-08 and 2026-10-09 closed and settled

// The reference: one full scan with the sink on from the start.
function referenceFacts() {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seed(root, part1, false);
    seed(root, part2, true);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    return { d8: comparable(readFacts('2026-10-08')), d9: comparable(readFacts('2026-10-09')) };
  } finally { fx.cleanup(); }
}

// Scan part 1 the way an older release left the state, then shape the facts window with `shape`.
function upgradedState(root, shape) {
  resetUnitCache();
  seed(root, part1, false);
  runCheckup({ root, nowT: UPGRADE, holdMs: 0 });
  const st = readState();
  shape(st);
  writeState(st);
  rmSync(factsDir(), { recursive: true, force: true });
  seed(root, part2, true);
}

test('a state written before the sink existed is backfilled: its closed days equal a full scan', () => {
  const ref = referenceFacts();
  const { fx, root } = mk();
  try {
    upgradedState(root, (st) => { delete st.facts; }); // 0.31.17 and earlier: no facts at all
    const r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.deepEqual(r.factsWritten, ['2026-10-08', '2026-10-09']);
    assert.deepEqual(comparable(readFacts('2026-10-08')), ref.d8);
    assert.deepEqual(comparable(readFacts('2026-10-09')), ref.d9);
    assert.equal(readState().facts.bf, FACTS_BACKFILL_VERSION);
    // a second run neither backfills again nor counts anything twice
    const before = readFileSync(checkupPaths().state, 'utf8');
    const again = runCheckup({ root, nowT: NOW + 60_000, holdMs: 0 });
    assert.deepEqual(again.factsWritten, []);
    const st = JSON.parse(before); const st2 = readState();
    assert.deepEqual(st2.facts.rows, st.facts.rows);
  } finally { fx.cleanup(); }
});

test('the 0.31.18 live shape (facts window starting tomorrow, partial spawn, no backfill mark) is rebuilt, not double counted', () => {
  const ref = referenceFacts();
  const { fx, root } = mk();
  try {
    upgradedState(root, (st) => {
      // what 0.31.18 left on an upgraded machine: the window at the next whole day, an accumulator
      // holding the rows and a mid-file (partial) spawn of the bytes read since, and no `bf` mark
      delete st.facts.bf;
      st.facts.fromMs = dayStartMs(UPGRADE) + DAY_MS;
      for (const a of Object.values(st.facts.spawns)) a.partial = true;
      assert.ok(Object.keys(st.facts.rows).length > 0, 'the fixture keeps the old accumulator rows');
    });
    const r = runCheckup({ root, nowT: NOW, holdMs: 0 });
    assert.deepEqual(r.factsWritten, ['2026-10-08', '2026-10-09'], 'the closed days before the old window start get facts');
    assert.deepEqual(comparable(readFacts('2026-10-08')), ref.d8);
    assert.deepEqual(comparable(readFacts('2026-10-09')), ref.d9, 'rows and spawns equal a full scan: the old accumulator is replaced, not added to');
    assert.equal(readFacts('2026-10-09').spawns[0].partial, false);
  } finally { fx.cleanup(); }
});

test('a prompt copied into a later file after the backfill is counted once (the old seen set held no prompt keys)', () => {
  const ref = referenceFacts();
  const { fx, root } = mk();
  try {
    upgradedState(root, (st) => { delete st.facts; });
    // an older release recorded no `p:` keys: drop them from the saved seen set
    const seenP = checkupPaths().seen;
    const b = readFileSync(seenP);
    const drop = new Set(['p:p1', 'p:p2'].map((k) => createHash('md5').update(k).digest('hex').slice(0, 16)));
    const keep = [];
    for (let i = 0; i + 12 <= b.length; i += 12) if (!drop.has(b.subarray(i, i + 8).toString('hex'))) keep.push(b.subarray(i, i + 12));
    assert.equal(keep.length, b.length / 12 - 2, 'the fixture held both prompt keys');
    writeFileSync(seenP, Buffer.concat(keep));
    // a resumed session copies the 10-09 prompt into a new file
    put(join(root, 'projA', 'sess1-resume.jsonl'), [part1[MAIN][2]]);
    runCheckup({ root, nowT: NOW, holdMs: 0 });
    const prompts = (f) => f.rows.reduce((n, r) => n + r.pr.n, 0);
    assert.equal(prompts(readFacts('2026-10-09')), prompts({ rows: ref.d9.rows }));
    assert.equal(prompts(readFacts('2026-10-09')), 1);
  } finally { fx.cleanup(); }
});

test('a fresh state needs no backfill; the window is the lookback, never before the scan start', () => {
  const { fx, root } = mk();
  try {
    resetUnitCache();
    seed(root, part1, false);
    runCheckup({ root, nowT: UPGRADE, holdMs: 0 });
    const st = readState();
    assert.equal(st.facts.bf, FACTS_BACKFILL_VERSION);
    assert.equal(st.facts.fromMs, st.scanFromMs);
    assert.equal(factsBackfillFrom({ scanFromMs: T('2026-10-02T08:00:00Z') }, T('2026-10-14T01:00:00Z')), T('2026-10-06T08:00:00Z'));
    assert.equal(factsBackfillFrom({ scanFromMs: T('2026-10-12T08:00:00Z') }, T('2026-10-14T01:00:00Z')), T('2026-10-12T08:00:00Z'));
  } finally { fx.cleanup(); }
});

test('cli: --scheduled on an upgraded state computes the closed days (the live symptom was computed: [])', () => {
  const { fx, root } = mk();
  try {
    upgradedState(root, (st) => { delete st.facts.bf; st.facts.fromMs = dayStartMs(UPGRADE) + DAY_MS; });
    const r = runScript('scripts/usage-analysis.mjs', ['--scheduled', '--no-register', '--root', fx.stateDir, '--transcripts', root, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0'], { cwd: fx.dir, timeout: 90000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.computed, ['2026-10-08', '2026-10-09']);
    const res = JSON.parse(readFileSync(join(fx.stateDir, 'state', 'usage-analysis', '2026-10-09.json'), 'utf8'));
    assert.ok(res.totals.sessions > 0 && res.totals.spawns > 0 && res.totals.units > 0, JSON.stringify(res.totals));
    assert.ok(existsSync(join(fx.stateDir, 'state', 'usage-analysis-latest.json')));
  } finally { fx.cleanup(); }
});
