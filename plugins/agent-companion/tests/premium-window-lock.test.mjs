// The premium window (state/premium-window.json) is read-modify-written by
// two hook processes: the spawn guard (PreToolUse) and spawn-log
// (SubagentStart). With no lock, a parallel burst of premium spawns each read
// the same count and more than the cap were allowed (a burst of 6 fable
// spawns under a cap of 2 allowed more than 2 in 20 of 40 runs), and a guard
// and a start interleaving lost one side's entry (0.29.0 RC review R2).
// Both now hold an O_EXCL lock file for the whole read-count-write
// (context.mjs withStateLock) and write through a temp file and a rename.
// On a lock timeout the hook fails open: it still answers, it never throws.
//
// The held-lock cases are deterministic: the test itself holds the lock,
// changes the window while the hook must be waiting, then releases it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, makeFixture } from './helpers.mjs';

const WARRANTED = 'WARRANT: frontier reasoning\ndo the work';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runAsync(hook, payload, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ch = spawn(process.execPath, [join(PLUGIN_ROOT, 'hooks', hook)], { env: { ...process.env, ...env }, cwd: PLUGIN_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out.trim()); } catch { /* no decision */ }
      resolve({ code, ms: Date.now() - t0, err, decision: json?.hookSpecificOutput?.permissionDecision || null });
    });
    ch.stdin.end(JSON.stringify(payload));
  });
}

function fixture() {
  const fx = makeFixture();
  const stateSub = join(fx.stateDir, 'state');
  mkdirSync(stateSub, { recursive: true });
  const env = {
    AGENT_COMPANION_HOME_OVERRIDE: fx.dir,
    AGENT_COMPANION_STATE_DIR: fx.stateDir,
    CLAUDE_PLUGIN_DATA: join(fx.dir, 'pdata'),
    CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '2',
  };
  const file = join(stateSub, 'premium-window.json');
  return { ...fx, env, file, lock: `${file}.lock`, stateSub };
}
const guardPayload = (dir, sid = 'S1') => ({
  session_id: sid, agent_type: 'main', cwd: dir,
  tool_input: { subagent_type: 'general-purpose', model: 'fable', run_in_background: true, name: 'w', isolation: 'worktree', prompt: WARRANTED },
});
const startPayload = (sid = 'S1') => ({ session_id: sid, agent_id: 'a1', agent_type: 'general-purpose', hook_event_name: 'SubagentStart' });
const readWindow = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);

test('the spawn guard waits for a held window lock and counts what the holder wrote', async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.lock, '', { flag: 'wx' });
    const run = runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    await sleep(600);
    // The holder's update lands while the guard must still be waiting.
    const now = Date.now();
    writeFileSync(fx.file, JSON.stringify([{ t: now, sid: 'other', confirmed: true }, { t: now, sid: 'other', confirmed: true }]));
    unlinkSync(fx.lock);
    const r = await run;
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'deny', 'the guard read the window before the lock was released');
    assert.equal(readWindow(fx.file).length, 2);
    assert.equal(existsSync(fx.lock), false, 'the guard must release its own lock');
  } finally { fx.cleanup(); }
});

test('SubagentStart waits for a held window lock before confirming', async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.lock, '', { flag: 'wx' });
    const run = runAsync('spawn-log.mjs', startPayload(), fx.env);
    await sleep(600);
    writeFileSync(fx.file, JSON.stringify([{ t: Date.now(), sid: 'S1', confirmed: false }]));
    unlinkSync(fx.lock);
    const r = await run;
    assert.equal(r.code, 0, r.err);
    const w = readWindow(fx.file);
    assert.equal(w.length, 1);
    assert.equal(w[0].confirmed, true, 'spawn-log read the window before the lock was released');
  } finally { fx.cleanup(); }
});

test('a stale lock (a crashed holder) is broken, and the guard proceeds', async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.lock, '', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(fx.lock, old, old);
    const r = await runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'allow');
    assert.equal(readWindow(fx.file).length, 1);
    assert.equal(existsSync(fx.lock), false);
  } finally { fx.cleanup(); }
});

test('a lock held past the wait fails open: the guard still answers within the hook timeout', async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.lock, '', { flag: 'wx' });
    const r = await runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'allow');
    assert.ok(r.ms < 8000, `took ${r.ms} ms`);
    assert.equal(readWindow(fx.file).length, 1, 'fail-open still records the spawn');
    assert.equal(existsSync(fx.lock), true, 'a lock the guard never took is not its to remove');
  } finally { fx.cleanup(); }
});

test('a concurrent burst of premium spawns allows exactly the cap, and every write is whole', async () => {
  const N = 8;
  for (let round = 0; round < 3; round += 1) {
    const fx = fixture();
    try {
      const rs = await Promise.all(Array.from({ length: N }, (_, i) => runAsync('spawn-guard.mjs', guardPayload(fx.dir, `S${i}`), fx.env)));
      for (const r of rs) assert.equal(r.code, 0, r.err);
      const allowed = rs.filter((r) => r.decision === 'allow').length;
      assert.equal(allowed, 2, `round ${round}: ${allowed} of ${N} allowed under a cap of 2`);
      assert.equal(readWindow(fx.file).length, 2);
      const leftovers = readdirSync(fx.stateSub).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock'));
      assert.deepEqual(leftovers, []);
    } finally { fx.cleanup(); }
  }
});

test('a guard and a SubagentStart racing on the window never lose an entry', async () => {
  for (const delay of [0, 20, 60, 120]) {
    for (let t = 0; t < 3; t += 1) {
      const fx = fixture();
      try {
        writeFileSync(fx.file, JSON.stringify([{ t: Date.now(), sid: 'S1', confirmed: false }]));
        const g = runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
        await sleep(delay);
        const l = runAsync('spawn-log.mjs', startPayload(), fx.env);
        const [gr] = await Promise.all([g, l]);
        assert.equal(gr.decision, 'allow');
        const w = readWindow(fx.file);
        assert.equal(w.length, 2, `delay ${delay}: an entry was lost`);
        assert.equal(w.filter((e) => e.confirmed).length, 1, `delay ${delay}: the start was not confirmed exactly once`);
      } finally { fx.cleanup(); }
    }
  }
});
