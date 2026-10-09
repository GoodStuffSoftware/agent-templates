// ROLE: brief line (0.31.3, tagging only). The spawn guard reads a `ROLE:`
// line, records it as declared_role, and NUDGES (non-blocking context) when
// it is missing. It must never deny, change routing, or touch the model. The
// writer's self-review protocol makes its reviewer carry `ROLE: reviewer`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { briefDeclarations, declarationValue, BRIEF_ROLES } from '../hooks/lib/brief-directives.mjs';
import { selfReviewBlock } from '../hooks/lib/self-review.mjs';

const ROLE_SRC = `(${BRIEF_ROLES.join('|')})\\b`;
const roleOf = (text) => declarationValue(briefDeclarations(text), 'ROLE', ROLE_SRC)?.[1]?.toLowerCase() ?? null;

function spawn(prompt, sid, env = {}) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt, run_in_background: true, name: 'w' },
    }, { env });
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    return { res, row: rows[rows.length - 1], out: res.json };
  } finally {
    cleanup();
  }
}

test('unit: ROLE is read like the other brief lines (first wins, code and quotes ignored)', () => {
  assert.equal(roleOf('ROLE: reviewer\nTYPE: code-review'), 'reviewer');
  assert.equal(roleOf('TYPE: x\n- **ROLE:** Writer'), 'writer');
  assert.equal(roleOf('```\nROLE: lander\n```\nROLE: docs'), 'docs');
  assert.equal(roleOf('> ROLE: lander\nROLE: lookup'), 'lookup');
  assert.equal(roleOf('ROLE: banana\nROLE: writer'), null, 'an invalid first value declares nothing');
  assert.equal(roleOf('ROLE-OF: branch@sha\nTYPE: code-review'), null, 'ROLE-OF is a different line');
  assert.equal(roleOf('no role here'), null);
  for (const r of BRIEF_ROLES) assert.equal(roleOf(`ROLE: ${r}`), r);
});

test('a brief with ROLE: records declared_role and carries no nudge', () => {
  const { res, row, out } = spawn('ROLE: fixer\nTYPE: explore\nfix the thing', 'sess-role-1');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(row.declared_role, 'fixer');
  assert.ok(!JSON.stringify(out || {}).includes('no `ROLE:` line'), 'no nudge when the line is present');
});

test('a brief without ROLE: is allowed, nudged in additionalContext, and nothing else changes', () => {
  const withRole = spawn('ROLE: writer\nTYPE: explore\ndo it', 'sess-role-2a');
  const without = spawn('TYPE: explore\ndo it', 'sess-role-2b');
  assert.equal(without.res.status, 0, without.res.stderr);
  assert.notEqual(without.out?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(without.row.declared_role, null);
  const ctx = without.out?.hookSpecificOutput?.additionalContext || '';
  assert.match(ctx, /no `ROLE:` line/);
  assert.match(ctx, /Not blocking/);
  // The role line changes no routing or decision.
  for (const k of ['declared_type', 'route_layer', 'fit', 'fit_expected', 'denied']) {
    assert.deepEqual(without.row[k], withRole.row[k], k);
  }
  assert.equal(withRole.out?.hookSpecificOutput?.additionalContext, undefined);
});

test('an invalid ROLE value nudges and records null; it never denies', () => {
  const { res, row, out } = spawn('ROLE: janitor\nTYPE: explore\ndo it', 'sess-role-3');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(row.declared_role, null);
  assert.match(out?.hookSpecificOutput?.additionalContext || '', /no `ROLE:` line/);
  assert.notEqual(out?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('role_line_nudge off silences the nudge but still records the role', () => {
  const env = { CLAUDE_PLUGIN_OPTION_ROLE_LINE_NUDGE: '0' };
  const a = spawn('TYPE: explore\ndo it', 'sess-role-4a', env);
  assert.equal(a.out?.hookSpecificOutput?.additionalContext, undefined);
  const b = spawn('ROLE: lookup\nTYPE: explore\ndo it', 'sess-role-4b', env);
  assert.equal(b.row.declared_role, 'lookup');
});

test('a denied spawn is still denied for its own reason, with or without a ROLE line', () => {
  // fable with no warrant is denied by the premium-warrant guard, not by the role line.
  for (const [i, p] of [['ROLE: writer\ndo it'], ['do it']].entries()) {
    const { dir, cleanup } = makeFixture();
    try {
      const res = runHook('hooks/spawn-guard.mjs', {
        session_id: `sess-role-5${i}`, agent_type: 'main', cwd: dir,
        tool_input: { subagent_type: 'general-purpose', model: 'fable', prompt: p[0] ?? p, run_in_background: true, name: 'w' },
      });
      assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout);
      assert.doesNotMatch(String(res.json?.hookSpecificOutput?.permissionDecisionReason || ''), /ROLE/);
    } finally {
      cleanup();
    }
  }
});

test('the self-review protocol makes the writer\'s reviewer carry ROLE: reviewer', () => {
  const block = selfReviewBlock({ model: 'sonnet', effort: 'high', agent: 'ac-sonnet-high' });
  assert.match(block, /TYPE: code-review\n\s+WRITER: sonnet\/high\n\s+ROLE: reviewer\n/);
  for (const f of ['ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh']) {
    const body = readFileSync(join(PLUGIN_ROOT, 'agents', `${f}.md`), 'utf8');
    assert.match(body, /TYPE: code-review\r?\n\s+WRITER: opus\/[a-z]+\r?\n\s+ROLE: reviewer\r?\n/, f);
  }
});

test('recommend prints a ROLE suggestion by task type', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (type) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'recommend.mjs'), '--type', type, ...(type === 'code-review' ? ['--writer', 'opus/xhigh'] : []), '--json'],
    { windowsHide: true, encoding: 'utf8' });
  const role = (type) => JSON.parse(run(type).stdout).role;
  assert.equal(role('code-review'), 'reviewer');
  assert.equal(role('bounded-feature'), 'writer');
  assert.equal(role('explore'), 'lookup');
  assert.equal(role('operate'), 'operate');
});
