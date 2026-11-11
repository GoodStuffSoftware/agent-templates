// Project tiers: the clause the spawn guard appends to writer and reviewer briefs (lib/tier-clause.mjs),
// unit-level and through the real spawn-guard hook. Repos are hand-built `.git` folders in a fixture dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, readJsonl, childEnv, PLUGIN_ROOT } from './helpers.mjs';
import { buildTierClause, applyTierClause, tierKind, TIER_MARKER, REPLACES_SENTENCE } from '../hooks/lib/tier-clause.mjs';
import { REVIEWER_TELL } from '../hooks/lib/tier-text.mjs';
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
  assert.equal(tierKind('bounded-feature', null, 'TYPE: bounded-feature', true), 'protocol');
  assert.equal(tierKind('integration', 'writer', 'x', true), 'protocol');
  // the protocol kind needs the spawn to really carry the protocol: without it the same writer gets the plain kind
  assert.equal(tierKind('bounded-feature', null, 'TYPE: bounded-feature'), 'plain');
  assert.equal(tierKind('integration', 'writer', 'x', false), 'plain');
  assert.equal(tierKind('integration', 'writer', 'x', null), 'plain');
  assert.equal(tierKind('integration', 'writer', 'REVIEW: lead\nx', true), 'leg');
  assert.equal(tierKind('integration', 'writer', 'REVIEW: lead\nx'), 'leg');
  assert.equal(tierKind('mechanical-edit', null, 'x'), 'plain');
  assert.equal(tierKind('subagent-worker', null, 'x'), 'plain');
  assert.equal(tierKind(null, 'writer', 'x'), 'plain');
  assert.equal(tierKind('code-review', null, 'x'), 'reviewer');
  assert.equal(tierKind(null, 'reviewer', 'x'), 'reviewer');
  for (const t of ['lookup', 'explore', 'research', 'survey', 'verify', 'operate', 'made-up']) assert.equal(tierKind(t, null, 'x'), null, t);
  assert.equal(tierKind(null, null, 'x'), null);
  // a REVIEW: lead line inside a code fence does not opt out
  assert.equal(tierKind('integration', null, '```\nREVIEW: lead\n```\nx', true), 'protocol');
});

test('writer, reviewer and REVIEW: lead briefs each get the right clause, with the project and its tier', () => withRepo(({ repo }) => {
  const w = buildTierClause('bounded-feature', 'writer', 'brief', repo, { protocol: true });
  assert.ok(w.startsWith(`\n\n${TIER_MARKER} Project acme-app, project_tier risk (Risk-tiered).`), w);
  assert.match(w, /REVIEW: <the cell you applied>/);
  assert.match(w, /Mid: one reviewer by reading/);

  const r = buildTierClause('code-review', 'reviewer', 'brief', repo);
  assert.ok(r.startsWith(`\n\n${TIER_MARKER} Project acme-app, project_tier risk`), r);
  assert.match(r, /you may raise it, never lower it/);
  assert.match(r, /High: after reading, check the touched behaviour for real/);

  const leg = buildTierClause('integration', 'writer', 'REVIEW: lead\nbrief', repo);
  assert.match(leg, /one leg of a larger job/);
  assert.match(leg, /no full suite, e2e, CI or full build/);
  assert.doesNotMatch(leg, /Mid: one reviewer/);
}, { projects: { 'acme-app': 'risk' } }));

test('the assigned tier shows in the clause; reviewEveryChange changes the no-reviewer cells', () => {
  withRepo(({ repo }) => {
    const w = buildTierClause('bounded-feature', null, 'brief', repo, { protocol: true });
    assert.match(w, /project_tier push \(Push on your word\)/);
    assert.match(w, /Low: unit tests, then push, no reviewer/);
  }, { projects: { 'acme-app': 'push' } });
  withRepo(({ repo }) => {
    const w = buildTierClause('bounded-feature', null, 'brief', repo, { protocol: true });
    assert.match(w, /Low: unit tests, one reviewer by reading, then push/);
    assert.doesNotMatch(w, /no reviewer/);
  }, { projects: { 'acme-app': 'push' }, reviewEveryChange: true });
});

test('a second pass adds nothing: the marker makes it idempotent', () => withRepo(({ repo }) => {
  for (const [type, role, brief] of [['bounded-feature', 'writer', 'x'], ['code-review', 'reviewer', 'x'], ['integration', 'writer', 'REVIEW: lead\nx']]) {
    const once = buildTierClause(type, role, brief, repo, { protocol: true });
    assert.equal(count(once, TIER_MARKER), 1);
    assert.equal(buildTierClause(type, role, `${brief}${once}`, repo, { protocol: true }), '');
  }
}));

test('a spawn that neither writes code nor reviews it gets none: every such ROLE and TYPE, with or without the other', () => withRepo(({ repo }) => {
  for (const t of ['lookup', 'explore', 'operate', 'verify', 'research', 'survey']) {
    for (const role of [null, 'lookup', 'docs', 'operate', 'other', 'writer', 'reviewer']) {
      assert.equal(buildTierClause(t, role, 'x', repo, { protocol: true }), '', `TYPE ${t} ROLE ${role}`);
    }
  }
  for (const role of ['docs', 'lookup', 'operate', 'other']) assert.equal(buildTierClause(null, role, 'x', repo, { protocol: true }), '', `ROLE ${role}`);
  assert.equal(buildTierClause(null, null, 'x', repo), '');
  assert.equal(buildTierClause('made-up', 'writer', 'x', repo), '');
}));

test('with no config file and outside any repo it is tier risk and does not error', () => {
  const fx = makeFixture();
  try {
    const w = buildTierClause('bounded-feature', null, 'x', fx.dir, { protocol: true });
    assert.match(w, /Project not resolved from the session folder or the brief \(default tier applies\), project_tier risk \(Risk-tiered\)/);
    assert.ok(!w.includes('outside a repo'), 'the clause no longer claims the worker is outside a repo');
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

// ---- Round 0.31.50 fixes: reviewer clause is replaced not stacked, protocol kind only where the protocol is carried, diet, none ----

const TIERS3 = ['push', 'risk', 'gates'];
const RISKS = ['low', 'mid', 'high'];
const clauseOf = (p) => p.slice(p.lastIndexOf(TIER_MARKER)).split('\n')[0];
const writerBrief = (extra = '') => `TYPE: bounded-feature\nROLE: writer\n${extra}add the flag`;

test('B1: a reviewer brief that embeds a writer clause ends with exactly one reviewer clause, in every tier and RISK, and a second pass changes nothing', () => {
  for (const tier of TIERS3) {
    for (const risk of RISKS) {
      withRepo(({ repo }) => {
        const writerSent = sentPrompt(spawnGuard(repo, writerBrief()));
        assert.equal(count(writerSent, TIER_MARKER), 1, `${tier}: writer clause present`);
        // the writer hands its reviewer the whole brief it was given, clause included
        const reviewerBrief = `TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: ${risk}\nThe brief, verbatim:\n${writerSent}\nRead the diff.`;
        const r = spawnGuard(repo, reviewerBrief);
        assert.equal(r.status, 0, r.stderr);
        const rp = sentPrompt(r);
        assert.equal(count(rp, TIER_MARKER), 1, `${tier}/${risk}: one marker\n${rp}`);
        assert.equal(count(rp, REVIEWER_TELL), 1, `${tier}/${risk}: reviewer clause present`);
        assert.ok(!rp.includes('REVIEW: <the cell you applied>'), `${tier}/${risk}: no writer text left`);
        assert.ok(rp.lastIndexOf(TIER_MARKER) > rp.indexOf('Read the diff.'), 'the clause comes after the brief');
        if (tier === 'push') assert.match(rp, /High: read only in this tier\./);
        // a second pass over the hook's own output keeps exactly the one clause (other hooks' suffixes are not this test's business)
        const ap = sentPrompt(spawnGuard(repo, rp));
        assert.equal(count(ap, TIER_MARKER), 1, `${tier}/${risk}: second pass keeps one marker`);
        assert.equal(clauseOf(ap), clauseOf(rp), `${tier}/${risk}: second pass leaves the clause alone`);
      }, { projects: { 'acme-app': tier } });
    }
  }
});

test('B1: an embedded writer clause that cannot be stripped exactly is replaced by a sentence saying so; a second pass is a no-op', () => withRepo(({ repo }) => {
  const writer = buildTierClause('bounded-feature', 'writer', 'x', repo, { protocol: true }).trim();
  for (const embedded of [`> ${writer}`, `Earlier note: ${writer}`, `    ${writer}`]) {
    const brief = `TYPE: code-review\nROLE: reviewer\nThe writer was told:\n${embedded}\nRead the diff.`;
    const first = applyTierClause('code-review', 'reviewer', brief, repo, {});
    assert.ok(first.clause.includes(REPLACES_SENTENCE), embedded.slice(0, 20));
    assert.ok(first.clause.includes(REVIEWER_TELL));
    const sent = `${first.brief}${first.clause}`;
    const second = applyTierClause('code-review', 'reviewer', sent, repo, {});
    assert.equal(second.clause, '', 'second pass adds no clause');
    assert.equal(second.brief, sent, 'second pass leaves the brief alone');
  }
  // a strippable one (marker alone at the start of its line) is removed, not described
  const brief = `TYPE: code-review\nROLE: reviewer\nThe writer was told:\n\n${writer}\n\nRead the diff.`;
  const first = applyTierClause('code-review', 'reviewer', brief, repo, {});
  assert.ok(!first.clause.includes(REPLACES_SENTENCE));
  assert.equal(count(`${first.brief}${first.clause}`, TIER_MARKER), 1);
}));

test('S1: the protocol clause goes only to a writer that really carries the protocol', () => withRepo(({ repo }) => {
  // general-purpose cannot carry the protocol: the plain clause (no reviewer), never the one that says to spawn one
  const gp = spawnGuard(repo, writerBrief(), { subagent_type: 'general-purpose' });
  assert.equal(gp.status, 0, gp.stderr);
  const gpp = sentPrompt(gp);
  assert.equal(count(gpp, TIER_MARKER), 1);
  assert.match(gpp, /You spawn no reviewer/);
  assert.doesNotMatch(gpp, /REVIEW: <the cell you applied>/);
  // the rung that carries the protocol gets the protocol clause
  const rp = sentPrompt(spawnGuard(repo, writerBrief()));
  assert.match(rp, /REVIEW: <the cell you applied>/);
  assert.doesNotMatch(rp, /You spawn no reviewer/);
  // an opt-out is the leg kind
  const leg = sentPrompt(spawnGuard(repo, writerBrief('REVIEW: lead\n')));
  assert.match(leg, /one leg of a larger job/);
  assert.doesNotMatch(leg, /REVIEW: <the cell you applied>/);
}));

test('diet: the plain and leg clauses stay inside 300 and 450 characters through the real hook, with no floors prose and no floor command', () => {
  for (const tier of TIERS3) {
    withRepo(({ repo }) => {
      const plain = sentPrompt(spawnGuard(repo, writerBrief(), { subagent_type: 'general-purpose' }));
      const leg = sentPrompt(spawnGuard(repo, writerBrief('REVIEW: lead\n')));
      const pc = clauseOf(plain);
      const lc = clauseOf(leg);
      assert.ok(pc.length <= 300, `${tier} plain ${pc.length}`);
      assert.ok(lc.length <= 450, `${tier} leg ${lc.length}`);
      for (const c of [pc, lc]) {
        assert.ok(!c.includes('floors:') && !c.includes('project-tiers.mjs'), 'no floors prose, no floor command');
        assert.match(c, /Project acme-app, project_tier /);
        assert.match(c, /RISK: low\|mid\|high with the reason/);
        assert.match(c, /unit tests for what you touch/i);
      }
    }, { projects: { 'acme-app': tier } });
  }
});

test('none: spawns that neither write code nor review it get no clause, through the real hook', () => withRepo(({ repo }) => {
  const briefs = [
    'TYPE: lookup\nROLE: lookup\nfind it', 'TYPE: research\nROLE: docs\nread', 'TYPE: survey\nfind', 'TYPE: explore\nfind',
    'TYPE: verify\nROLE: operate\nrun', 'TYPE: operate\nrun', 'ROLE: docs\nupdate the readme', 'ROLE: other\nx', 'ROLE: lookup\nx', 'ROLE: operate\nx',
  ];
  for (const b of briefs) assert.equal(count(sentPrompt(spawnGuard(repo, b)), TIER_MARKER), 0, b);
  // a writer still gets one
  assert.equal(count(sentPrompt(spawnGuard(repo, writerBrief())), TIER_MARKER), 1);
}));

test('landing: through the real hook the protocol and plain clauses carry the sentence; the leg clause does not', () => {
  const D = 'No pull requests in this project: commit and push to the branch the brief names.';
  const P = 'Land through a pull request.';
  const cases = [[{ projects: { 'acme-app': { tier: 'risk', landing: 'direct' } } }, D], [{ landing: 'pr', projects: {} }, P], [{ projects: { 'acme-app': 'risk' } }, null]];
  for (const [config, sentence] of cases) {
    withRepo(({ repo }) => {
      const plain = clauseOf(sentPrompt(spawnGuard(repo, writerBrief(), { subagent_type: 'general-purpose' })));
      const proto = clauseOf(sentPrompt(spawnGuard(repo, writerBrief())));
      const leg = clauseOf(sentPrompt(spawnGuard(repo, writerBrief('REVIEW: lead\n'))));
      for (const c of [plain, proto]) assert.equal(c.trimEnd().endsWith(sentence || 'x-none'), !!sentence, c);
      if (!sentence) { assert.ok(!plain.includes('pull request') && !proto.includes('pull request')); assert.ok(plain.length <= 300); }
      assert.ok(!leg.includes('pull request'), 'the leg clause never changes');
    }, config);
  }
});

// ---- 0.31.51: the project from the brief, through the real hook ----

const UNRESOLVED = /Project not resolved from (the session folder or the brief \(default tier applies\)|folder\/brief; default tier\.)/;
const spawnRows = (fx) => readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
const slashes = (p) => p.replace(/\\/g, '/');

// A session folder that is not a repo (`ws`), holding two child repos `acme-app` and `beta-app`.
function withWorkspace(fn, config) {
  const fx = makeFixture();
  try {
    const ws = join(fx.dir, 'ws');
    const repo = join(ws, 'repos', 'acme-app');
    const second = join(ws, 'repos', 'beta-app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });
    if (config !== undefined) writeFileSync(tiersPath(), JSON.stringify(config));
    return fn({ ...fx, ws, repo, second });
  } finally {
    fx.cleanup();
  }
}

test('brief project, through the spawn guard: a writer brief naming a child repo gets that project and its tier, the floor command names the repo, and the row says brief', () => withWorkspace((fx) => {
  const { ws, repo } = fx;
  const proto = spawnGuard(ws, `${writerBrief()}\nWork in ${slashes(repo)}.`);
  assert.equal(proto.status, 0, proto.stderr);
  const pp = sentPrompt(proto);
  assert.equal(count(pp, TIER_MARKER), 1, pp);
  assert.match(pp, /Project acme-app, project_tier gates \(Full gates\)\./);
  assert.ok(pp.includes(`project-tiers.mjs" floor <base>..<head> --repo "${slashes(repo)}"`), pp);
  assert.ok(!pp.includes('outside a repo') && !UNRESOLVED.test(pp));
  const plain = sentPrompt(spawnGuard(ws, `${writerBrief()}\nWork in ${slashes(repo)}.`, { subagent_type: 'general-purpose' }));
  assert.match(clauseOf(plain), /^\[agent-companion: tier\] Project acme-app, project_tier gates\. You spawn no reviewer/);
  const leg = sentPrompt(spawnGuard(ws, `${writerBrief('REVIEW: lead\n')}\nWork in ${slashes(repo)}.`));
  assert.match(clauseOf(leg), /Project acme-app, project_tier gates\. You are one leg/);
  const rows = spawnRows(fx);
  assert.ok(rows.length >= 3);
  for (const row of rows) assert.deepEqual([row.project_tier, row.tier_source, row.project_source], ['gates', 'assigned', 'brief']);
}, { projects: { 'acme-app': 'gates', 'beta-app': 'push' } }));

test('brief project, through the spawn guard: a reviewer brief naming a worktree of the child repo gets the reviewer clause for that project', () => withWorkspace((fx) => {
  const { ws, repo } = fx;
  const wt = join(ws, 'worktrees', 'feat-1');
  const gitdir = join(repo, '.git', 'worktrees', 'n1');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${slashes(gitdir)}\n`);
  const r = spawnGuard(ws, `TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: mid\nRead the diff in ${slashes(wt)}.`);
  assert.equal(r.status, 0, r.stderr);
  const rp = sentPrompt(r);
  assert.equal(count(rp, TIER_MARKER), 1, rp);
  assert.match(clauseOf(rp), /Project acme-app, project_tier push \(Push on your word\)\. Your checks depend on the RISK/);
  assert.ok(clauseOf(rp).includes(`floor <base>..<head> --repo "${slashes(wt)}"`), "a worktree the brief names stays a worktree: HEAD in the range is its HEAD");
  assert.ok(!clauseOf(rp).includes(`--repo "${slashes(repo)}"`));
  const row = spawnRows(fx).at(-1);
  assert.deepEqual([row.declared_risk, row.project_tier, row.tier_source, row.project_source], ['mid', 'push', 'assigned', 'brief']);
  // the reviewer brief a writer builds from its own received brief (clause included) resolves the same way and ends with one clause
  const writerSent = sentPrompt(spawnGuard(ws, `${writerBrief()}\nWork in ${slashes(repo)}.`));
  const rev = sentPrompt(spawnGuard(ws, `TYPE: code-review\nROLE: reviewer\nThe brief, verbatim:\n${writerSent}\nRead the diff.`));
  assert.equal(count(rev, TIER_MARKER), 1, rev);
  assert.match(clauseOf(rev), /Project acme-app, project_tier push/);
}, { projects: { 'acme-app': 'push' } }));

test('brief project, through the spawn guard: nothing named, two repos named, or a session folder inside a repo', () => withWorkspace((fx) => {
  const { ws, repo, second } = fx;
  const lastRow = () => spawnRows(fx).at(-1);
  // nothing named: the unresolved wording, no claim about being outside a repo, source none
  const np = sentPrompt(spawnGuard(ws, writerBrief()));
  assert.match(clauseOf(np), /^\[agent-companion: tier\] Project not resolved from the session folder or the brief \(default tier applies\), project_tier risk \(Risk-tiered\)\./);
  assert.ok(!np.includes('outside a repo'));
  assert.ok(!clauseOf(np).includes('--repo'));
  assert.deepEqual([lastRow().project_tier, lastRow().tier_source, lastRow().project_source], ['risk', 'none', 'none']);
  // the short kinds stay inside their limits with the new wording
  const plain = clauseOf(sentPrompt(spawnGuard(ws, writerBrief(), { subagent_type: 'general-purpose' })));
  const leg = clauseOf(sentPrompt(spawnGuard(ws, writerBrief('REVIEW: lead\n'))));
  assert.ok(plain.length <= 300 && leg.length <= 450, `${plain.length} / ${leg.length}`);
  assert.match(plain, UNRESOLVED);
  assert.match(leg, UNRESOLVED);
  // a reviewer with nothing named
  const rev = sentPrompt(spawnGuard(ws, 'TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: low\nread it'));
  assert.match(clauseOf(rev), /Project not resolved from the session folder or the brief \(default tier applies\), project_tier risk/);
  assert.equal(lastRow().project_source, 'none');
  // two repos named: unresolved
  const two = sentPrompt(spawnGuard(ws, `${writerBrief()}\n${slashes(repo)} and ${slashes(second)}`));
  assert.match(clauseOf(two), UNRESOLVED);
  assert.equal(lastRow().project_source, 'none');
  // a session folder inside a repo: the brief is not consulted, the row says cwd
  const inside = sentPrompt(spawnGuard(second, `${writerBrief()}\nWork in ${slashes(repo)}.`));
  assert.match(clauseOf(inside), /Project beta-app, project_tier push/);
  assert.ok(!clauseOf(inside).includes('--repo'));
  assert.deepEqual([lastRow().tier_source, lastRow().project_source], ['assigned', 'cwd']);
}, { projects: { 'acme-app': 'gates', 'beta-app': 'push' } }));

test('brief project, through the spawn guard: a 3 MB brief is handled promptly', () => withWorkspace((fx) => {
  const { ws, repo } = fx;
  // runHook caps the child's output at 1 MB (the hook echoes the whole brief back), so this one spawns the hook itself.
  const prompt = `${writerBrief()}\n${slashes(repo)}\n${'/x/y/z and some words '.repeat(150_000)}`;
  assert.ok(prompt.length > 3_000_000);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'spawn-guard.mjs')], {
    input: JSON.stringify({ session_id: 'sess-tier-big', agent_type: 'main', cwd: ws, tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', description: 'x', prompt } }),
    encoding: 'utf8', env: childEnv(), cwd: fx.dir, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const sent = String(JSON.parse(r.stdout).hookSpecificOutput?.updatedInput?.prompt || '');
  assert.match(clauseOf(sent), /Project acme-app, project_tier risk/);
  assert.equal(spawnRows(fx).at(-1).project_source, 'brief');
  assert.ok(ms < 10000, `took ${ms} ms`);
}));
