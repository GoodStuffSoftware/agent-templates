// Token bleed guard, phase 1: the scope clause the spawn guard appends to a
// brief, the self-review step, and the maxTurns backstop on every shipped
// agent definition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, runHook } from './helpers.mjs';
import {
  SCOPE_MARKER, SCOPE_WRITER_CLAUSE, SCOPE_LOOKUP_CLAUSE, scopeKind, buildScopeClause,
} from '../hooks/lib/scope-rule.mjs';
import { selfReviewBlock } from '../hooks/lib/self-review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEP = 'List anything you built that the brief did not ask for; remove it or flag it to the lead.';

test('clause text is the approved wording', () => {
  assert.equal(SCOPE_WRITER_CLAUSE, 'Build the smallest change that meets the ask. Before creating a script, workflow, module, test file or feature the brief does not name, stop and report the proposal to the lead instead of building it.');
  assert.equal(SCOPE_LOOKUP_CLAUSE, 'Create no new files beyond the requested output and the <task>-detail.md detail file.');
});

test('selection by TYPE', () => {
  for (const t of ['bounded-feature', 'integration', 'debug-root-cause', 'large-refactor', 'novel-design', 'critical-change', 'mechanical-edit']) {
    assert.equal(scopeKind(t, null), 'writer', t);
  }
  for (const t of ['lookup', 'research', 'explore', 'survey', 'verify']) assert.equal(scopeKind(t, null), 'lookup', t);
  for (const t of ['code-review', 'operate', 'made-up-type']) assert.equal(scopeKind(t, 'writer'), null, t);
});

test('selection by ROLE when there is no TYPE', () => {
  assert.equal(scopeKind(null, 'writer'), 'writer');
  assert.equal(scopeKind(null, 'fixer'), 'writer');
  assert.equal(scopeKind(null, 'lookup'), 'lookup');
  assert.equal(scopeKind(null, 'reviewer'), null);
  assert.equal(scopeKind(null, null), null);
});

test('buildScopeClause: marker, no double append, empty when none', () => {
  const w = buildScopeClause('bounded-feature', null, 'brief');
  assert.ok(w.includes(SCOPE_MARKER) && w.includes(SCOPE_WRITER_CLAUSE));
  assert.ok(buildScopeClause('lookup', null, 'brief').includes(SCOPE_LOOKUP_CLAUSE));
  assert.equal(buildScopeClause('bounded-feature', null, `brief ${SCOPE_MARKER}`), '');
  assert.equal(buildScopeClause('code-review', null, 'brief'), '');
});

function spawnGuard(dir, prompt) {
  return runHook('hooks/spawn-guard.mjs', {
    session_id: 'sess-scope-1', agent_type: 'main', cwd: dir,
    tool_input: { subagent_type: 'agent-companion:ac-sonnet-low', model: 'sonnet', description: 'x', prompt },
  });
}

test('spawn guard appends the writer clause to a writer brief and the lookup clause to a lookup brief', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const w = spawnGuard(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the flag');
    assert.equal(w.status, 0, w.stderr);
    const wp = String(w.json?.hookSpecificOutput?.updatedInput?.prompt || '');
    assert.ok(wp.includes(SCOPE_WRITER_CLAUSE), wp);
    assert.ok(!wp.includes(SCOPE_LOOKUP_CLAUSE));
    const l = spawnGuard(dir, 'TYPE: lookup\nROLE: lookup\nfind the flag');
    const lp = String(l.json?.hookSpecificOutput?.updatedInput?.prompt || '');
    assert.ok(lp.includes(SCOPE_LOOKUP_CLAUSE), lp);
    assert.ok(!lp.includes(SCOPE_WRITER_CLAUSE));
  } finally {
    cleanup();
  }
});

test('the self-review step is in the generated block and in every rung that carries the block', () => {
  const rung = { agent: 'ac-sonnet-high', model: 'sonnet', effort: 'high' };
  assert.ok(selfReviewBlock(rung).includes(STEP));
  let carried = 0;
  for (const f of readdirSync(join(ROOT, 'agents'))) {
    const t = readFileSync(join(ROOT, 'agents', f), 'utf8');
    if (t.includes('self-review protocol BEGIN')) { carried += 1; assert.ok(t.includes(STEP), f); }
  }
  assert.ok(carried >= 1);
});

test('every shipped agent definition carries maxTurns: 150 in its frontmatter', () => {
  const files = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'));
  assert.ok(files.some((f) => f.startsWith('ac-browser')) && files.some((f) => f.startsWith('ac-sonnet')));
  for (const f of files) {
    const t = readFileSync(join(ROOT, 'agents', f), 'utf8').replace(/\r\n/g, '\n');
    const fm = t.split('\n---\n')[0];
    assert.match(fm, /^maxTurns: 150$/m, f);
  }
});
