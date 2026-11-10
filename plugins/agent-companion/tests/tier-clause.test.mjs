// Project tiers: the clause the spawn guard appends to writer and reviewer briefs (lib/tier-clause.mjs),
// unit-level and through the real spawn-guard hook. Repos are hand-built `.git` folders in a fixture dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { buildTierClause, tierKind, TIER_MARKER } from '../hooks/lib/tier-clause.mjs';
import { tiersPath } from '../hooks/lib/project-tier.mjs';

function withRepo(fn, config) {
  const fx = makeFixture();
  try {
    const repo = join(fx.dir, 'work', 'acme-app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    if (config !== undefined) writeFileSync(tiersPath(), typeof config === 'string' ? config : JSON.stringify(config));
    return fn({ ...fx, repo });
  } finally {
    fx.cleanup();
  }
}

const count = (s, needle) => s.split(needle).length - 1;

test('tierKind: writer with the protocol, REVIEW: lead leg, writer without a protocol, reviewer, lookup', () => {
  assert.equal(tierKind('bounded-feature', null, 'TYPE: bounded-feature'), 'protocol');
  assert.equal(tierKind('integration', 'writer', 'x'), 'protocol');
  assert.equal(tierKind('integration', 'writer', 'REVIEW: lead\nx'), 'leg');
  assert.equal(tierKind('mechanical-edit', null, 'x'), 'plain');
  assert.equal(tierKind('subagent-worker', null, 'x'), 'plain');
  assert.equal(tierKind(null, 'writer', 'x'), 'plain');
  assert.equal(tierKind('code-review', null, 'x'), 'reviewer');
  assert.equal(tierKind(null, 'reviewer', 'x'), 'reviewer');
  for (const t of ['lookup', 'explore', 'research', 'survey', 'verify', 'operate', 'made-up']) assert.equal(tierKind(t, null, 'x'), null, t);
  assert.equal(tierKind(null, null, 'x'), null);
  // a REVIEW: lead line inside a code fence does not opt out
  assert.equal(tierKind('integration', null, '```\nREVIEW: lead\n```\nx'), 'protocol');
});

test('writer, reviewer and REVIEW: lead briefs each get the right clause, with the project and its tier', () => withRepo(({ repo }) => {
  const w = buildTierClause('bounded-feature', 'writer', 'brief', repo);
  assert.ok(w.startsWith(`\n\n${TIER_MARKER} Project acme-app, project_tier risk (Risk-tiered).`), w);
  assert.match(w, /REVIEW: <the cell you applied>/);
  assert.match(w, /Mid: one reviewer by reading/);

  const r = buildTierClause('code-review', 'reviewer', 'brief', repo);
  assert.ok(r.startsWith(`\n\n${TIER_MARKER} Project acme-app, project_tier risk`), r);
  assert.match(r, /you may raise it, never lower it/);
  assert.match(r, /High: after reading, check the touched behaviour for real/);

  const leg = buildTierClause('integration', 'writer', 'REVIEW: lead\nbrief', repo);
  assert.match(leg, /one leg of a larger job/);
  assert.match(leg, /Run no end-to-end tests, CI or full build/);
  assert.doesNotMatch(leg, /Mid: one reviewer/);
}, { projects: { 'acme-app': 'risk' } }));

test('the assigned tier shows in the clause; reviewEveryChange changes the no-reviewer cells', () => {
  withRepo(({ repo }) => {
    const w = buildTierClause('bounded-feature', null, 'brief', repo);
    assert.match(w, /project_tier push \(Push on your word\)/);
    assert.match(w, /Low: unit tests, then push, no reviewer/);
  }, { projects: { 'acme-app': 'push' } });
  withRepo(({ repo }) => {
    const w = buildTierClause('bounded-feature', null, 'brief', repo);
    assert.match(w, /Low: unit tests, one reviewer by reading, then push/);
    assert.doesNotMatch(w, /no reviewer/);
  }, { projects: { 'acme-app': 'push' }, reviewEveryChange: true });
});

test('a second pass adds nothing: the marker makes it idempotent', () => withRepo(({ repo }) => {
  for (const [type, role, brief] of [['bounded-feature', 'writer', 'x'], ['code-review', 'reviewer', 'x'], ['integration', 'writer', 'REVIEW: lead\nx']]) {
    const once = buildTierClause(type, role, brief, repo);
    assert.equal(count(once, TIER_MARKER), 1);
    assert.equal(buildTierClause(type, role, `${brief}${once}`, repo), '');
  }
}));

test('a lookup, operate or undeclared brief gets none', () => withRepo(({ repo }) => {
  for (const t of ['lookup', 'explore', 'operate', 'verify', 'research']) assert.equal(buildTierClause(t, 'lookup', 'x', repo), '', t);
  assert.equal(buildTierClause(null, null, 'x', repo), '');
}));

test('with no config file and outside any repo it is tier risk and does not error', () => {
  const fx = makeFixture();
  try {
    const w = buildTierClause('bounded-feature', null, 'x', fx.dir);
    assert.match(w, /Project \(none: outside a repo\), project_tier risk \(Risk-tiered\)/);
    const w2 = buildTierClause('bounded-feature', null, 'x', undefined);
    assert.match(w2, /project_tier risk/);
  } finally {
    fx.cleanup();
  }
});

test('a malformed config, or a brief that is not a string, falls back and never throws', () => {
  withRepo(({ repo }) => {
    assert.match(buildTierClause('bounded-feature', null, 'x', repo), /project_tier risk/);
    assert.match(buildTierClause('bounded-feature', null, undefined, repo), /project_tier risk/);
    assert.match(buildTierClause('bounded-feature', null, { not: 'a string' }, repo), /Project/);
  }, '{ nope');
});

function spawnGuard(repo, prompt, extra = {}) {
  return runHook('hooks/spawn-guard.mjs', {
    session_id: 'sess-tier-1', agent_type: 'main', cwd: repo,
    tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', description: 'x', prompt, ...extra },
  });
}
const sentPrompt = (res) => String(res.json?.hookSpecificOutput?.updatedInput?.prompt || '');

test('spawn guard: writer, reviewer and REVIEW: lead briefs get the clause once; a lookup brief gets none', () => withRepo(({ repo }) => {
  const w = spawnGuard(repo, 'TYPE: bounded-feature\nROLE: writer\nadd the flag');
  assert.equal(w.status, 0, w.stderr);
  const wp = sentPrompt(w);
  assert.equal(count(wp, TIER_MARKER), 1, wp);
  assert.match(wp, /Project acme-app, project_tier gates \(Full gates\)/);

  const r = spawnGuard(repo, 'TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nread the diff');
  const rp = sentPrompt(r);
  assert.equal(count(rp, TIER_MARKER), 1, rp);
  assert.match(rp, /Your checks depend on the RISK the writer states/);

  const lead = spawnGuard(repo, 'TYPE: integration\nROLE: writer\nREVIEW: lead\nbuild leg A');
  const lp = sentPrompt(lead);
  assert.equal(count(lp, TIER_MARKER), 1, lp);
  assert.match(lp, /one leg of a larger job/);

  const look = spawnGuard(repo, 'TYPE: lookup\nROLE: lookup\nfind the flag');
  assert.equal(count(sentPrompt(look), TIER_MARKER), 0);

  // a second pass over the already-delivered prompt adds nothing
  const again = spawnGuard(repo, wp);
  assert.equal(count(sentPrompt(again) || wp, TIER_MARKER), 1);
}, { projects: { 'acme-app': 'gates' } }));

test('spawn guard with no config file: the clause says tier risk', () => withRepo(({ repo }) => {
  const w = spawnGuard(repo, 'TYPE: bounded-feature\nROLE: writer\nadd the flag');
  assert.equal(w.status, 0, w.stderr);
  assert.match(sentPrompt(w), /Project acme-app, project_tier risk \(Risk-tiered\)/);
}));
