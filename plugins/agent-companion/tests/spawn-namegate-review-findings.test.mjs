// Adversarial review findings for track "namegate" (wip/ac-cache-namegate),
// filed on the review track (wip/ac-cache-namegate-review). These tests are
// EXPECTED TO FAIL against the writer's code as shipped — they exist to
// prove the findings by execution, per the review brief's "Try to refute, by
// EXECUTION" charge. See the review track's own report for the full write-up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, readJsonl, runHook, PLUGIN_ROOT } from './helpers.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

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

// FINDING 1 (HIGH): namegate's uniqueness check has no equivalent of the
// wx-marker exclusive-write mechanism hooks/spawn-log.mjs already uses for
// the identical read-check-append shape (see race.test.mjs, same repo,
// noteAgentType()) — sessionSpawnNames() reads spawns.jsonl for peers, and
// the telemetry appendLog() write for THIS spawn happens later in the same
// hook run, so two truly-concurrent hook invocations (the parallel-Agent-
// calls-in-one-message shape this plugin's own docs recommend) each see the
// same pre-existing peer set and can both autofill the SAME name. Proven by
// two async (not spawnSync) child processes fired via Promise.all with an
// IDENTICAL payload (same session, cwd, subagent_type, description) — the
// existing "two collision-shaped spawns" test in spawn-namegate.test.mjs
// only proves this works when the spawns are SEQUENTIAL (spawnSync, one
// fully exits before the next starts), which never exercises the race.
test('FINDING 1: two TRULY CONCURRENT background+no-name spawns, identical shape, must not autofill the same name', async () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const script = join(PLUGIN_ROOT, 'hooks', 'spawn-guard.mjs');
    const env = { ...process.env, ...baseEnv(dir) };
    const payload = {
      session_id: 'sess-ng-race-finding',
      agent_type: 'main',
      cwd: join(dir, 'proj'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'same task', prompt: 'do a bounded task',
      },
    };

    const [r1, r2] = await Promise.all([
      runAsync(script, payload, env),
      runAsync(script, payload, env),
    ]);
    assert.equal(r1.code, 0, `run 1 exited ${r1.code}: ${r1.err}`);
    assert.equal(r2.code, 0, `run 2 exited ${r2.code}: ${r2.err}`);

    const name1 = JSON.parse(r1.out.trim())?.hookSpecificOutput?.updatedInput?.name;
    const name2 = JSON.parse(r2.out.trim())?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name1, 'run 1 must autofill a name');
    assert.ok(name2, 'run 2 must autofill a name');

    assert.notEqual(
      name1, name2,
      'RACE: two concurrent background spawns with the same type+description autofilled the ' +
      'IDENTICAL name. A later SendMessage to that name resumes whichever process the harness ' +
      'happens to route it to — the other spawn is unreachable by the name namegate itself just ' +
      'gave it. sessionSpawnNames()/makeUnique() in hooks/lib/namegate.mjs read spawns.jsonl with ' +
      'no lock and no reservation of the chosen name before this hook process exits; ' +
      'hooks/spawn-log.mjs (noteAgentType, see race.test.mjs) already solved the identical shape ' +
      'in this same plugin with a wx-marker exclusive-create file — namegate has no equivalent.'
    );

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))
      .filter((r) => r.session_id === 'sess-ng-race-finding');
    assert.equal(rows.length, 2);
  } finally {
    cleanup();
  }
});

// FINDING 2 (MEDIUM): the review brief's own test matrix calls out reserved
// names ("main", "team-lead") as something the slug scheme must never
// collide with. "main" is unreachable only as a structural SIDE EFFECT of
// buildCandidateName() always joining >= 2 non-empty segments with "-"
// (deriveTypeSlug() never returns '' — it falls back to "agent") — not a
// documented or tested invariant, so a future refactor could reopen it
// silently. "team-lead" has NO such protection and is trivially reachable:
// a project/worktree directory literally named "team" (plausible in a
// monorepo or a team-scoped checkout) plus any spawn typed or described as
// "lead" and no description collapses straight to the literal string
// "team-lead", with no reserved-word exclusion anywhere in
// hooks/lib/namegate.mjs.
test('FINDING 2: an autofilled name must never collide with the reserved name "team-lead"', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-reserved',
      agent_type: 'main',
      cwd: join(dir, 'team'), // basename(cwd) === "team"
      tool_input: {
        subagent_type: 'lead', model: 'sonnet', run_in_background: true,
        prompt: 'do a bounded task', // no description -> hint segment is empty
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    const name = res.json?.hookSpecificOutput?.updatedInput?.name;
    assert.notEqual(name, 'team-lead',
      `namegate autofilled the literal reserved name "team-lead" for cwd="team" + subagent_type="lead" + no ` +
      'description — no reserved-word exclusion exists in hooks/lib/namegate.mjs\'s buildCandidateName()/makeUnique().'
    );
  } finally {
    cleanup();
  }
});
