// The premium window (state/premium-window.json) is read-modify-written by
// two hook processes: the spawn guard (PreToolUse) and spawn-log
// (SubagentStart). With no lock, a parallel burst of premium spawns each read
// the same count and more than the cap were allowed (a burst of 6 fable
// spawns under a cap of 2 allowed more than 2 in 20 of 40 runs), and a guard
// and a start interleaving lost one side's entry (0.29.0 RC review R2).
// Both now hold a lock file for the whole read-count-write (context.mjs
// withStateLock, on the shared helper lib/file-lock.mjs: an owner token,
// broken only when the owner's pid is dead AND the lock is old) and write
// through a temp file and a rename. On a lock timeout the hook fails open:
// it still answers, it never throws.
//
// The held-lock cases are deterministic: the test itself holds the lock,
// changes the window while the hook must be waiting, then releases it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

// A lock as the helper writes it (lib/file-lock.mjs): owner pid, token, age
// (in the content, and as the file's mtime).
const holdLock = (fx, { pid = process.pid, ageMs = 0, token = 'test-holder' } = {}) => {
  writeFileSync(fx.lock, JSON.stringify({ pid, token, at: Date.now() - ageMs }), { flag: 'wx' });
  const then = new Date(Date.now() - ageMs);
  utimesSync(fx.lock, then, then);
};
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

// 0.29.0 final review F5: the window module (and the lock helper it loads)
// cost ~1.6 ms cold on EVERY spawn while only a premium spawn reaches the
// cap. The guard now imports it there. Proven by logging every module the
// guard process loads (a module.registerHooks preload).
test('only a premium spawn loads the premium window and the lock helper', () => {
  const fx = fixture();
  try {
    const preload = join(fx.dir, 'load-log.mjs');
    writeFileSync(preload, `
      import { registerHooks } from 'node:module';
      import { appendFileSync } from 'node:fs';
      registerHooks({ load(url, ctx, next) { if (url.startsWith('file:')) appendFileSync(process.env.AC_LOAD_LOG, url + '\\n'); return next(url, ctx); } });
    `);
    const loaded = (tag, model, prompt) => {
      const log = join(fx.dir, `${tag}.log`);
      writeFileSync(log, '');
      const payload = { ...guardPayload(fx.dir, `S-${tag}`), tool_input: { ...guardPayload(fx.dir).tool_input, model, prompt } };
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(PLUGIN_ROOT, 'hooks', 'spawn-guard.mjs')], {
        input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...fx.env, AC_LOAD_LOG: log }, windowsHide: true, timeout: 20000,
      });
      assert.equal(r.status, 0, r.stderr);
      const names = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((u) => u.split('/').pop());
      return { names, decision: JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision };
    };
    const plain = loaded('sonnet', 'sonnet', 'TYPE: bounded-feature\ngo');
    assert.ok(plain.names.includes('spawn-guard.mjs') && plain.names.includes('context.mjs'), plain.names.join(' '));
    assert.equal(plain.decision, 'allow');
    assert.equal(plain.names.includes('premium-window.mjs'), false, 'a non-premium spawn loaded the premium window');
    assert.equal(plain.names.includes('file-lock.mjs'), false, 'a non-premium spawn loaded the lock helper');
    const premium = loaded('fable', 'fable', WARRANTED);
    assert.equal(premium.decision, 'allow');
    assert.ok(premium.names.includes('premium-window.mjs') && premium.names.includes('file-lock.mjs'), premium.names.join(' '));
    assert.equal(readWindow(fx.file).length, 1, 'the premium spawn was counted');
  } finally { fx.cleanup(); }
});

test('the spawn guard waits for a held window lock and counts what the holder wrote', async () => {
  const fx = fixture();
  try {
    holdLock(fx);
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
    holdLock(fx);
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

test('an old lock of a dead owner (a crashed holder) is broken, and the guard proceeds', async () => {
  const fx = fixture();
  try {
    holdLock(fx, { pid: deadPid(), ageMs: 60_000 });
    const r = await runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'allow');
    assert.equal(readWindow(fx.file).length, 1);
    assert.equal(existsSync(fx.lock), false);
  } finally { fx.cleanup(); }
});

test('an old lock whose owner is ALIVE is never broken: the guard waits, then fails open', async () => {
  const fx = fixture();
  try {
    holdLock(fx, { ageMs: 60_000 });
    const r = await runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'allow');
    assert.equal(JSON.parse(readFileSync(fx.lock, 'utf8')).token, 'test-holder', 'a live owner\'s lock was broken');
  } finally { fx.cleanup(); }
});

test('a lock held past the wait fails open: the guard still answers within the hook timeout', async () => {
  const fx = fixture();
  try {
    holdLock(fx);
    const r = await runAsync('spawn-guard.mjs', guardPayload(fx.dir), fx.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.decision, 'allow');
    assert.ok(r.ms < 8000, `took ${r.ms} ms`);
    assert.equal(readWindow(fx.file).length, 1, 'fail-open still records the spawn');
    assert.equal(JSON.parse(readFileSync(fx.lock, 'utf8')).token, 'test-holder', 'a lock the guard never took is not its to remove');
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
