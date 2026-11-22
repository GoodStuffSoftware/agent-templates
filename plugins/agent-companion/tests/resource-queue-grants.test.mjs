// The grants log (grants.jsonl in the ledger directory, scripts/ci-budget.mjs recordGrant), its summary
// (grantsSummary / `resource-queue.mjs grants`) and the split-ledger warning of `status`. Fake work only:
// every ledger is a fresh temp dir, the clock and pid liveness are injected. Spec: docs/resource-queue.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourceStatus, formatResourceStatus, grantsSummary, formatGrantsSummary } from '../scripts/ci-budget.mjs';
import { summarizeGrants, appendGrant } from '../scripts/lib/resource-rules.mjs';
import { makeWorld, GB } from './resource-queue-world.mjs';

const grantRows = (w) => {
  const f = join(w.dir, 'grants.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('a grant with no wait writes one row with every field', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ box: 4, resources: { pool: 1 }, ramMb: 2000, label: 'first', project: 'proj-a' });
    const rows = grantRows(w);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      ts: rows[0].ts, id: a.id, kind: 'run', label: 'first', project: 'proj-a', requested: { box: 4, pool: 1 }, ramMb: 2000,
      waitedMs: 0, waitedBy: {}, limiting: [], backfilled: false, overCapacity: false, held: { box: 0, ramMb: 0 },
    });
    assert.equal(typeof rows[0].ts, 'number');
    const b = await w.acq({ box: 2, label: 'second' });
    assert.deepEqual(grantRows(w)[1].held, { box: 4, ramMb: 2000 }, 'held at grant time counts the first lease');
    a.release(); b.release();
  } finally { w.done(); }
});

test('a wait is attributed to the resource that blocked it: 3 polls on a lane, then 2 on RAM', async () => {
  const w = makeWorld();
  try {
    const other = await w.acq({ box: 1, label: 'other' }); // a lease on the ledger turns the RAM gate on
    const lane = await w.acq({ resources: { 'app-e2e': 1 }, label: 'lane holder' });
    let n = 0;
    const b = await w.acq({
      box: 4, resources: { 'app-e2e': 1 }, ramMb: 8000, label: 'B',
      delay: async (ms) => {
        w.t += ms; n += 1;
        if (n === 3) { lane.release(); w.free = 4 * GB; }
        if (n === 5) w.free = 48 * GB;
      },
    });
    const row = grantRows(w).find((r) => r.label === 'B');
    assert.equal(row.waitedMs, 5 * 1500);
    assert.deepEqual(row.waitedBy, { 'app-e2e': 3 * 1500, ram: 2 * 1500 });
    assert.deepEqual([...row.limiting].sort(), ['app-e2e', 'ram']);
    assert.equal(row.overCapacity, false);
    assert.equal(row.backfilled, false);
    assert.deepEqual(row.held, { box: 1, ramMb: 0 });
    assert.deepEqual(row.requested, { box: 4, 'app-e2e': 1 });
    assert.equal(row.ramMb, 8000);
    b.release(); other.release();
  } finally { w.done(); }
});

test('an over-capacity grant after the bounded wait is marked, with what it went over', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { pool: 2 }, label: 'A' });
    const b = await w.acq({ resources: { pool: 1 }, label: 'B', maxWaitMs: 5000 });
    const row = grantRows(w).find((r) => r.label === 'B');
    assert.equal(row.overCapacity, true);
    assert.deepEqual(row.overCap, ['pool 2+1/2']);
    assert.deepEqual(row.limiting, ['pool']);
    assert.ok(row.waitedMs >= 5000);
    a.release(); b.release();
  } finally { w.done(); }
});

test('a backfilled grant is marked', async () => {
  const w = makeWorld({ budget: 10 });
  try {
    const a = await w.acq({ box: 2, resources: { 'app-e2e': 1 }, label: 'A' });
    const pB = w.acq({ box: 4, resources: { 'app-e2e': 1 }, label: 'B' });
    w.t += 1;
    const c = await w.acq({ box: 3, label: 'C' });
    assert.equal(grantRows(w).find((r) => r.label === 'C').backfilled, true);
    c.release(); a.release();
    (await pB).release();
    assert.equal(grantRows(w).find((r) => r.label === 'B').backfilled, false);
  } finally { w.done(); }
});

test('the summary computes median, p90 and the share of wait time per limiting resource from fixture rows', () => {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) {
    rows.push({ ts: 1, waitedMs: i * 1000, waitedBy: i <= 6 ? { box: i * 1000 } : { ram: i * 1000 }, limiting: [i <= 6 ? 'box' : 'ram'], backfilled: i === 1, overCapacity: i === 10 });
  }
  rows.push({ ts: 1, waitedMs: 0, waitedBy: {}, limiting: [] }); // an eleventh grant that did not wait
  const s = summarizeGrants(rows);
  assert.equal(s.count, 11);
  assert.equal(s.waited, 10);
  assert.equal(s.medianWaitMs, 5000, 'sorted 0,1000..10000: the 6th of 11');
  assert.equal(s.p90WaitMs, 9000, 'nearest rank: ceil(0.9 * 11) = 10th of 11');
  assert.equal(s.maxWaitMs, 10000);
  assert.equal(s.totalWaitMs, 55000);
  assert.equal(s.backfilled, 1);
  assert.equal(s.overCapacity, 1);
  assert.deepEqual(s.limiting, [
    { resource: 'ram', waitMs: 34000, share: 0.618, grants: 4 },
    { resource: 'box', waitMs: 21000, share: 0.382, grants: 6 },
  ]);
  assert.equal(summarizeGrants([{ waitedMs: 1000 }, { waitedMs: 3000 }]).medianWaitMs, 2000, 'even count: mean of the middle two');
  assert.deepEqual(summarizeGrants([{ waitedMs: 4000, limiting: ['box', 'ram'] }]).limiting.map((r) => [r.resource, r.waitMs]).sort(), [['box', 2000], ['ram', 2000]],
    'a row without waitedBy splits its wait over its limiting list');
  assert.equal(summarizeGrants([]).count, 0);
});

test('grantsSummary reads the last N hours of the log (and the rotated file), and the text names the shares', () => {
  const w = makeWorld();
  try {
    const now = 10 * 3600_000 * 10;
    appendGrant(w.dir, { ts: now - 5 * 3600_000, waitedMs: 99_000, waitedBy: { box: 99_000 }, limiting: ['box'] }); // too old for 2 h
    appendGrant(w.dir, { ts: now - 3600_000, waitedMs: 60_000, waitedBy: { ram: 60_000 }, limiting: ['ram'] });
    appendGrant(w.dir, { ts: now - 60_000, waitedMs: 0, waitedBy: {}, limiting: [] });
    writeFileSync(join(w.dir, 'grants.jsonl.1'), `${JSON.stringify({ ts: now - 1800_000, waitedMs: 20_000, waitedBy: { box: 20_000 }, limiting: ['box'] })}\n{torn`);
    const g = grantsSummary({ ...w.opts, now: () => now, hours: 2 });
    assert.equal(g.ok, true);
    assert.equal(g.count, 3);
    assert.equal(g.p90WaitMs, 60_000);
    assert.deepEqual(g.limiting.map((r) => [r.resource, r.share]), [['ram', 0.75], ['box', 0.25]]);
    const text = formatGrantsSummary(g);
    assert.match(text, /last 2 h.*: 3, 2 waited/);
    assert.match(text, /limiting ram\s+75% of wait time/);
    assert.match(text, /limiting box\s+25% of wait time/);
    assert.match(formatGrantsSummary(grantsSummary({ ...w.opts, now: () => now, hours: 0.001 })), /none/);
  } finally { w.done(); }
});

test('status warns once about leases in a foreign ledger, and says nothing without them', async () => {
  const w = makeWorld();
  const old = makeWorld();
  try {
    assert.doesNotMatch(formatResourceStatus(resourceStatus({ ...w.opts, foreignDirs: [old.dir] })), /split ledger/i, 'an empty foreign ledger: no line');
    const legacy = await old.acq({ resources: { 'app-e2e': 1 }, box: 4, label: 'legacy holder', pid: 7001 });
    const st = resourceStatus({ ...w.opts, foreignDirs: [old.dir] });
    assert.deepEqual(st.foreign, { count: 1, dirs: [{ dir: old.dir, count: 1 }] });
    const lines = formatResourceStatus(st).split('\n').filter((l) => /split ledger/i.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /1 live lease in another ledger/);
    assert.ok(lines[0].includes(old.dir));
    const none = resourceStatus({ ...w.opts, foreignDirs: [] });
    assert.deepEqual(none.foreign, { count: 0, dirs: [] });
    assert.doesNotMatch(formatResourceStatus(none), /split ledger/i);
    w.dead.add(7001);
    assert.equal(resourceStatus({ ...w.opts, foreignDirs: [old.dir] }).foreign.count, 0, 'a dead pid in the old ledger no longer counts');
    legacy.release();
  } finally { w.done(); old.done(); }
});
