// The "Shared resources:" session line (hooks/lib/resource-line.mjs): what the
// machine-wide resource queue holds, shown to every agent. Rendered from the real
// resourceStatus() of a temp ledger; one hook-level run of advisory-b.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceStatus, reserveResource, sweepLedger } from '../scripts/ci-budget.mjs';
import {
  renderSharedResources, resourceSignature, sharedResourcesNote, LINE_MAX_CHARS, CLEARED_WINDOW_MS,
} from '../hooks/lib/resource-line.mjs';
import { makeWorld, settle } from './resource-queue-world.mjs';
import { runHook } from './helpers.mjs';

const H = 3600_000;
const status = (w) => resourceStatus({ ...w.opts });
const sigFile = () => join(mkdtempSync(join(tmpdir(), 'rl-sig-')), 'sig');
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('nothing held: no line, empty signature', () => {
  const w = makeWorld({ budget: 8 });
  try {
    const st = status(w);
    assert.equal(st.ok, true);
    assert.equal(renderSharedResources(st, { now: w.t }), null);
    assert.equal(resourceSignature(st, w.t), '');
  } finally { w.done(); }
});

test('held: names the resource, the count, the holder and its project', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    await w.acq({ box: 2, label: 'ci-run', project: 'proj-a' });
    const line = renderSharedResources(status(w), { now: w.t });
    assert.match(line, /^Shared resources: box 2\/8: ci-run@proj-a /);
    assert.ok(line.endsWith('.'));
  } finally { w.done(); }
});

test('queued: waiters are listed in queue order with the resource they wait for', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    const held = await w.acq({ resources: { 'app-e2e': 1 }, label: 'holder' });
    const p1 = w.acq({ resources: { 'app-e2e': 1 }, label: 'first', pid: 801 });
    await settle();
    w.t += 10;
    const p2 = w.acq({ resources: { 'app-e2e': 1 }, label: 'second', pid: 802 });
    await settle();
    const line = renderSharedResources(status(w), { now: w.t });
    assert.match(line, /queue: 1\) first\S* \S+ for app-e2e, 2\) second/);
    assert.match(line, /for app-e2e/);
    held.release();
    (await p1).release();
    (await p2).release();
  } finally { w.done(); }
});

test('stale or dead holder is flagged', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    await w.acq({ box: 1, label: 'gone', pid: 901 });
    w.dead.add(901);
    assert.match(renderSharedResources(status(w), { now: w.t }), /gone@\S+ \d+s DEAD/);
  } finally { w.done(); }
  const w2 = makeWorld({ budget: 8, staleMs: 90_000 });
  try {
    await w2.acq({ box: 1, label: 'quiet', pid: 902 });
    w2.t += 10 * 60_000;
    assert.match(renderSharedResources(status(w2), { now: w2.t }), /quiet@\S+ \S+ STALE/);
  } finally { w2.done(); }
});

test('reserved: resource, group and time left, from reservations[]', () => {
  const w = makeWorld({ budget: 8 });
  try {
    reserveResource({ ...w.opts, resource: 'pool', forGroup: 'train', until: w.t + 2 * H, ownerPid: 5000 });
    const st = status(w);
    assert.equal(st.reservations.length, 1);
    assert.match(renderSharedResources(st, { now: w.t }), /reserved: pool for train 2h left/);
    const syn = { ok: true, resources: [], queue: [], recentClears: [], reservations: [{ id: 'r1', resource: 'app-e2e', forGroup: 'rel', expiresAt: w.t + 30 * 60_000 }] };
    assert.match(renderSharedResources(syn, { now: w.t }), /reserved: app-e2e for rel 30m left/);
  } finally { w.done(); }
});

test('recently cleared: shown inside the 15-minute window, gone after it', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    await w.acq({ box: 1, label: 'dying', pid: 950 });
    w.dead.add(950);
    w.t += 120_000;
    // the next reader reclaims the dead lease, which writes the clear
    (await w.acq({ box: 1, label: 'next', pid: 951 })).release();
    const st = status(w);
    assert.ok(st.recentClears.length >= 1);
    assert.match(renderSharedResources(st, { now: w.t }), /cleared \d+[sm] ago: /);
    assert.equal(renderSharedResources(st, { now: w.t + CLEARED_WINDOW_MS + 60_000 }), null);
  } finally { w.done(); }
});

test('the line stays within 300 characters', () => {
  const holders = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, label: `long-holder-label-${i}`, project: 'a-long-project', ageMs: 5000 }));
  const st = {
    ok: true,
    resources: [{ name: 'box', capacity: 16, held: 12, holders }, { name: 'pool', capacity: 1, held: 1, holders: [holders[0]] }],
    queue: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, label: `waiter-with-long-name-${i}`, project: 'proj', waitedMs: 1000, blockedBy: ['box', 'pool'] })),
    reservations: [{ id: 'r', resource: 'x'.repeat(30), forGroup: 'y'.repeat(30), expiresAt: Date.now() + H }],
    recentClears: [],
  };
  const line = renderSharedResources(st, { now: Date.now() });
  assert.ok(line.length <= LINE_MAX_CHARS, `length ${line.length}`);
  assert.ok(line.startsWith('Shared resources: '));
});

test('per-prompt signature: unchanged state shows nothing, a change shows the line', async () => {
  const w = makeWorld({ budget: 8 });
  const f = sigFile();
  const note = (mode) => sharedResourcesNote({ session_id: 's1' }, { mode, now: w.t, status: status(w), sigFile: f });
  try {
    const a = await w.acq({ box: 1, label: 'one', pid: 960 });
    assert.match(await note('change'), /^Shared resources:/);
    w.t += 5 * 60_000; // the clock moves, the state does not: ages differ, the signature must not
    assert.equal(await note('change'), null);
    assert.match(await note('start'), /^Shared resources:/);
    const b = await w.acq({ box: 1, label: 'two', pid: 961 });
    assert.match(await note('change'), /two/);
    a.release(); b.release();
    assert.equal(await note('change'), null);
  } finally { w.done(); }
});

test('advisory-b hook: one real lease shows the line at session start, then nothing unchanged per prompt', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    const lease = await w.acq({ box: 2, label: 'hook-holder', project: 'proj-h', pid: process.pid });
    const env = { CI_BUDGET_DIR: w.dir };
    const sid = `rl-hook-${process.pid}`;
    const r1 = runHook('hooks/advisory-b.mjs', { session_id: sid }, { args: ['--event', 'session-start'], env });
    assert.equal(r1.status, 0);
    assert.match(ctxOf(r1), /Shared resources: box 2\/\d+: hook-holder@proj-h /);
    const r2 = runHook('hooks/advisory-b.mjs', { session_id: sid }, { args: ['--event', 'user-prompt'], env });
    assert.equal(r2.status, 0);
    assert.doesNotMatch(ctxOf(r2), /Shared resources/);
    const off = runHook('hooks/advisory-b.mjs', { session_id: `${sid}-off` }, { args: ['--event', 'session-start'], env: { ...env, CLAUDE_PLUGIN_OPTION_SHARED_RESOURCES_LINE: '0' } });
    assert.doesNotMatch(ctxOf(off), /Shared resources/);
    // A cloud session has no shared box: the same lease on disk produces no line there.
    const cloud = runHook('hooks/advisory-b.mjs', { session_id: `${sid}-cloud` }, { args: ['--event', 'session-start'], env: { ...env, CLAUDE_CODE_REMOTE: 'true' } });
    assert.equal(cloud.status, 0);
    assert.doesNotMatch(ctxOf(cloud), /Shared resources/);
    lease.release();
    assert.deepEqual(readdirSync(w.dir).filter((n) => /^lease-/.test(n)), []);
  } finally { w.done(); }
});

test('a holder that is over time and idle shows both flags, and the line names the release command within 300 characters', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    const a = await w.acq({
      resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000, idleMs: 30_000, minHoldMs: 0 }, monitored: true, label: 'gate', project: 'proj-a',
    });
    w.t += 120_000;
    a.recordActivity(w.t, w.t - 100_000);
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    const st = status(w);
    const line = renderSharedResources(st, { now: w.t });
    assert.match(line, /app-e2e 1\/1: gate@proj-a [^;]*IDLE\? OVER/);
    assert.ok(line.includes(`resource-queue.mjs release ${a.id}`), 'the manual release command with the lease id');
    assert.match(line, /release a flagged one by hand: node ~\/\.claude\/agent-companion\/bin\/resource-queue\.mjs release [0-9a-f]{12}\.$/);
    assert.ok(line.length <= LINE_MAX_CHARS, `${line.length} chars`);
    // A status that carries only overTime.activity "idle" (no idleFlag) reads the same.
    const only = JSON.parse(JSON.stringify(st));
    for (const r of only.resources) for (const h of r.holders) h.idleFlag = null;
    assert.match(renderSharedResources(only, { now: w.t }), /IDLE\? OVER/);
    // Over time and still working: OVER only.
    const busy = JSON.parse(JSON.stringify(st));
    for (const r of busy.resources) for (const h of r.holders) { h.idleFlag = null; h.overTime.activity = 'active'; }
    const bl = renderSharedResources(busy, { now: w.t });
    assert.match(bl, /gate@proj-a \S+ OVER\./);
    assert.doesNotMatch(bl, /IDLE\?/);
    // A crowded line still fits, with the hint kept.
    for (let i = 0; i < 30; i += 1) busy.queue.push({ id: `q${i}`, label: `waiter-number-${i}`, project: 'some-long-project-name', waitedMs: 1000, blockedBy: ['app-e2e'] });
    const crowded = renderSharedResources(busy, { now: w.t });
    assert.ok(crowded.length <= LINE_MAX_CHARS);
    assert.match(crowded, /release a flagged one by hand: .* release [0-9a-f]{12}\.$/);
    a.release();
  } finally { w.done(); }
});

test('fail soft: a missing or corrupt ledger shows no line and no error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rl-bad-'));
  try {
    const missing = join(base, 'nope');
    const corrupt = join(base, 'corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'lease-deadbeef.json'), '{not json');
    writeFileSync(join(corrupt, 'ticket-deadbeef.json'), '\u0000\u0000');
    writeFileSync(join(corrupt, 'clears.jsonl'), 'garbage\n{"at":\n');
    for (const d of [missing, corrupt]) {
      const r = runHook('hooks/advisory-b.mjs', { session_id: 'rl-bad' }, { args: ['--event', 'session-start'], env: { CI_BUDGET_DIR: d } });
      assert.equal(r.status, 0);
      assert.doesNotMatch(ctxOf(r), /Shared resources/);
      assert.equal(r.stderr.trim(), '');
    }
    assert.equal(await sharedResourcesNote({ session_id: 'x' }, { status: { ok: false, error: 'boom' }, sigFile: sigFile() }), null);
    assert.equal(renderSharedResources(null), null);
    assert.equal(renderSharedResources({ ok: false }), null);
    assert.equal(renderSharedResources(undefined), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a live holder flagged IDLE? shows it in the line and changes the signature', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { idleMs: 300_000, minHoldMs: 0 }, monitored: true, label: 'gate', project: 'proj-a' });
    const before = resourceSignature(status(w), w.t);
    w.t += 400_000;
    a.recordActivity(w.t, w.t - 350_000);
    const st = status(w);
    assert.match(renderSharedResources(st, { now: w.t }), /app-e2e 1\/1: gate@proj-a [^;]*IDLE\?/);
    assert.notEqual(resourceSignature(st, w.t), before);
    a.release();
  } finally { w.done(); }
});
