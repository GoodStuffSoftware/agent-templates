// Gate 4 (namegate) on hooks/spawn-guard.mjs: track "namegate", operator
// decision 2026-09-25 — "every background worker gets a name". Scope: a
// MAIN-session spawn that runs in the background (explicit
// run_in_background: true — see spawn-guard.mjs's own comment on why an
// absent field is not treated as background) with no name. Never blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { makeUnique, reserveUniqueName, isReservedName } from '../hooks/lib/namegate.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

// Async (not spawnSync) child launch — needed to get truly overlapping hook
// processes for the stress test below; spawnSync would serialize them and
// prove nothing about the race the fix closes (see spawn-namegate-review-
// findings.test.mjs's own note on this same distinction).
function runAsync(script, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('namegate: background + no name -> hint AND autofill (default on)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-autofill',
      agent_type: 'main',
      cwd: join(dir, 'my-project'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'probe thing', prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', 'namegate never blocks');
    assert.match(res.json?.systemMessage || '', /namegate/i);

    const assignedName = res.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(assignedName, 'updatedInput.name must be set');
    assert.match(assignedName, /^[A-Za-z0-9._-]+$/, 'name must be sanitised to the safe character set');
    assert.match(assignedName, /^my-project-general-purpose-probe-thing/);

    // Brief boilerplate: names the worker itself, main as lead, peers.
    const prompt = res.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt, new RegExp(`worker \`${assignedName}\``));
    assert.match(prompt, /lead is `main`/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, true);
    assert.equal(row.gate4_action, 'autofill');
    assert.equal(row.name_autofilled, true);
    assert.equal(row.name_effective, assignedName);
  } finally {
    cleanup();
  }
});

test('namegate: background + name already set -> untouched', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-named',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, name: 'already-named',
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    // The reporting-contract feature (unrelated to namegate) sets
    // updatedInput on every spawn regardless; what must be untouched here is
    // specifically the `name` — namegate must never override one already given.
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, 'already-named');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
    assert.equal(row.name_autofilled, false);
    assert.equal(row.name_effective, 'already-named');
  } finally {
    cleanup();
  }
});

test('namegate: foreground (no run_in_background field at all) + no name -> untouched', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-foreground',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'foreground work' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false, 'an absent run_in_background field is never treated as background');
    assert.equal(row.gate4_action, 'none');
    assert.equal(row.name_autofilled, false);
  } finally {
    cleanup();
  }
});

test('namegate: subagent-origin caller is out of scope, even background + no name', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-subcaller',
      agent_type: 'subagent',
      agent_id: 'agent-caller-1',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, prompt: 'nested spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.caller_is_subagent, true);
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
  } finally {
    cleanup();
  }
});

test('namegate: two collision-shaped spawns in the same session get distinct names, and the second lists the first as a peer', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const makePayload = () => ({
      session_id: 'sess-ng-collision',
      agent_type: 'main',
      cwd: join(dir, 'proj'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'same task', prompt: 'do a bounded task',
      },
    });
    const res1 = runHook('hooks/spawn-guard.mjs', makePayload(), { env: baseEnv(dir) });
    const name1 = res1.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name1);

    const res2 = runHook('hooks/spawn-guard.mjs', makePayload(), { env: baseEnv(dir) });
    const name2 = res2.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name2);
    assert.notEqual(name1, name2, 'uniqueness within the session: the second spawn must not collide with the first');
    assert.match(name2, /-2$/, 'first collision resolves to a -2 suffix');

    const prompt2 = res2.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt2, new RegExp(name1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'peer list names the first worker');
  } finally {
    cleanup();
  }
});

test('namegate: slug sanitising — special characters and length are capped to [A-Za-z0-9._-]', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-sanitise',
      agent_type: 'main',
      cwd: join(dir, 'a weird/project name!!'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'a VERY long description with lots of words that keeps going and going and going well past any reasonable cap #$%^&*()',
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    const name = res.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name);
    assert.match(name, /^[A-Za-z0-9._-]+$/);
    assert.ok(name.length <= 60, `name must be capped in length, got ${name.length}: ${name}`);
  } finally {
    cleanup();
  }
});

test('namegate: namegate_autofill=false gives the hint only, never rewrites', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-hint-only',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_NAMEGATE_AUTOFILL: 'false' },
    });
    assert.equal(res.status, 0);
    assert.match(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined, 'hint-only must not set a name');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, true);
    assert.equal(row.gate4_action, 'hint');
    assert.equal(row.name_autofilled, false);
  } finally {
    cleanup();
  }
});

test('namegate: namegate=false disables the whole gate (no hint, no autofill)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-off',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_NAMEGATE: 'false' },
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
  } finally {
    cleanup();
  }
});

// Fix round (review finding 1) — the primary regression the review filed:
// tests/spawn-namegate-review-findings.test.mjs proves 2 concurrent spawns no
// longer collide. This is the "8 concurrent spawns" stress variant the fix
// brief additionally asks for, and — per the lead's correction — it uses an
// IDENTICAL payload (same session, cwd, subagent_type, description) for all
// 8, because that is the exact shape that used to collide: distinct payloads
// never raced in the first place and would prove nothing about the fix.
test('namegate: 8 truly concurrent background+no-name spawns, IDENTICAL payload, all get distinct names', async () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const script = join(PLUGIN_ROOT, 'hooks', 'spawn-guard.mjs');
    const env = { ...process.env, ...baseEnv(dir) };
    const payload = {
      session_id: 'sess-ng-stress-8',
      agent_type: 'main',
      cwd: join(dir, 'proj'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'same task', prompt: 'do a bounded task',
      },
    };
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => runAsync(script, payload, env)));
    const names = results.map((r, i) => {
      assert.equal(r.code, 0, `run ${i} exited ${r.code}: ${r.err}`);
      const n = JSON.parse(r.out.trim())?.hookSpecificOutput?.updatedInput?.name;
      assert.ok(n, `run ${i} must autofill a name`);
      return n;
    });
    assert.equal(new Set(names).size, N, `expected ${N} distinct names, got: ${names.join(', ')}`);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))
      .filter((r) => r.session_id === 'sess-ng-stress-8');
    assert.equal(rows.length, N);
  } finally {
    cleanup();
  }
});

// Fix round (review finding 2) — explicit, tested invariant at the SOURCE OF
// TRUTH (the naming functions themselves), not just an incidental property
// of today's slug assembly. Before this fix, "main" was only unreachable as
// a side effect of buildCandidateName() always joining >= 2 segments
// (deriveTypeSlug() never returns '') — nothing stated or asserted the
// invariant, so a future refactor (e.g. allowing a single-segment name when
// project/type coincide) could reopen it silently with no test catching the
// regression. Testing makeUnique()/reserveUniqueName() directly with
// candidate="main" proves the exclusion holds regardless of how a future
// buildCandidateName() might assemble its input — the end-to-end hook tests
// above and the review's own finding-2 regression test prove "team-lead" is
// excluded through the full pipeline; this proves "main" is excluded at the
// layer that actually enforces it, both case-insensitively.
test('namegate: makeUnique()/reserveUniqueName() never return the reserved name "main", case-insensitively', () => {
  assert.equal(isReservedName('main'), true);
  assert.equal(isReservedName('MAIN'), true);
  assert.equal(isReservedName('Main'), true);
  assert.notEqual(makeUnique('main', []), 'main');
  assert.notEqual(makeUnique('MAIN', []).toLowerCase(), 'main');

  const { cleanup } = makeFixture();
  try {
    const picked = reserveUniqueName('sess-ng-unit-reserved', 'main', []);
    assert.notEqual(picked.toLowerCase(), 'main');
  } finally {
    cleanup();
  }
});

// Fix round (review "coverage gap", not a bug): the review's own live check
// confirmed gate3_fired flips to false on the SAME row Gate 4 autofills a
// name for, but no test asserted this directly — the only existing Gate 3
// coverage change was disabling namegate in the OLD Gate 3 test, not a new
// assertion on the interaction itself. This closes that gap on the primary
// autofill test's own telemetry row.
test('namegate: an autofilled spawn never also fires Gate 3 (it now has an address)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-gate3-interaction',
      agent_type: 'main',
      cwd: join(dir, 'my-project'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'probe thing', prompt: 'do a bounded task',
        // deliberately no name, no isolation: the exact shape that used to fire Gate 3
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    assert.ok(res.json?.hookSpecificOutput?.updatedInput?.name, 'Gate 4 must have autofilled a name');
    assert.doesNotMatch(res.json?.systemMessage || '', /no address to re-brief it later/,
      'Gate 3\'s message must not fire once Gate 4 has assigned this same spawn a name');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_action, 'autofill');
    assert.equal(row.gate3_fired, false, 'gate3_fired must be false on the same row Gate 4 autofilled');
  } finally {
    cleanup();
  }
});
