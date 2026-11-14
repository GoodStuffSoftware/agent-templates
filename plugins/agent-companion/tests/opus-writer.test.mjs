// No Opus writers (0.31.54): a spawn that would run on Opus AND whose brief says it writes is rewritten, silently,
// to the Sonnet writer rung (option opus_writer_policy: "sonnet" default, "allow" = old behaviour). Plus the writer
// brief clauses: handoff wording, affected-tests wording, and the staging clause for a brief with more than 4 deliverables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import {
  OPUS_WRITING_TYPES, OPUS_NON_WRITING_TYPES, OPUS_WRITER_LOG, writerBasis, planLegSpawn,
} from '../hooks/lib/opus-writer.mjs';
import { legsOf, writeLegPair } from '../hooks/lib/legs.mjs';
import { modelTiers, resolveRoute, rungFor } from '../hooks/lib/context.mjs';
import {
  WRITER_MARKER, HANDOFF_SENTENCE, TEST_SENTENCE, STAGING_SENTENCE, countDeliverables, buildWriterClause, isWriterSpawn,
} from '../hooks/lib/writer-brief.mjs';

const RUNG = 'agent-companion:ac-sonnet-high';
const OPUS_RUNG = 'agent-companion:ac-opus-high';

// A transcript whose last assistant turn ran on `model` (the caller's own model, read for an inherited spawn).
function transcript(dir, model) {
  const f = join(dir, 'lead.jsonl');
  writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { model } })}\n`);
  return f;
}

function spawn(toolInput, { sid = 'sess-ow-1', env = {}, model = null } = {}) {
  const fx = makeFixture();
  try {
    const payload = { session_id: sid, agent_type: 'main', cwd: fx.dir, tool_input: { run_in_background: true, name: 'w', ...toolInput } };
    if (model) payload.transcript_path = transcript(fx.dir, model);
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'sonnet', ...env } });
    const rows = readJsonl(join(fx.stateDir, 'telemetry', OPUS_WRITER_LOG));
    const spawnRows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
    return { res, out: res.json, upd: res.json?.hookSpecificOutput?.updatedInput || null, rows, row: spawnRows[spawnRows.length - 1] };
  } finally {
    fx.cleanup();
  }
}

const rewritten = (r) => r.upd && r.upd.model === 'sonnet';

test('unit: the writing-type set is the writer types minus design and root-cause-only types', () => {
  assert.deepEqual([...OPUS_NON_WRITING_TYPES].sort(), ['debug-root-cause', 'novel-design']);
  for (const t of ['bounded-feature', 'integration', 'large-refactor', 'critical-change', 'long-autonomous-run', 'mechanical-edit', 'subagent-worker', 'bounded-feature-small']) {
    assert.ok(OPUS_WRITING_TYPES.includes(t), t);
  }
  for (const t of ['novel-design', 'debug-root-cause', 'code-review', 'research', 'survey', 'explore', 'lookup', 'verify', 'operate']) {
    assert.ok(!OPUS_WRITING_TYPES.includes(t), t);
  }
});

test('unit: writerBasis reads ROLE first, then TYPE only when there is no usable ROLE', () => {
  assert.equal(writerBasis('writer', null), 'role');
  assert.equal(writerBasis('fixer', 'code-review'), 'role');
  assert.equal(writerBasis('lander', null), 'role');
  assert.equal(writerBasis('reviewer', 'bounded-feature'), null, 'a stated non-writer ROLE wins over the TYPE');
  assert.equal(writerBasis('docs', null), null);
  assert.equal(writerBasis('lookup', 'integration'), null);
  assert.equal(writerBasis(null, 'integration'), 'type');
  assert.equal(writerBasis(null, 'novel-design'), null);
  assert.equal(writerBasis(null, 'debug-root-cause'), null);
  assert.equal(writerBasis(null, 'code-review'), null);
  assert.equal(writerBasis(null, null), null);
});

test('an Opus rung spawn with ROLE: writer becomes the Sonnet writer rung, with no message and one telemetry line', () => {
  const r = spawn({ subagent_type: OPUS_RUNG, prompt: 'ROLE: writer\nTYPE: bounded-feature\nbuild the thing' });
  assert.equal(r.res.status, 0, r.res.stderr);
  assert.notEqual(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(r.upd.subagent_type, RUNG);
  assert.equal(r.upd.model, 'sonnet');
  assert.equal(r.out?.systemMessage, undefined, 'silent: no message');
  assert.doesNotMatch(r.out?.hookSpecificOutput?.additionalContext || '', /opus/i, 'silent: no note either');
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.session_id, 'sess-ow-1');
  assert.equal(row.agent, 'w');
  assert.match(row.from, new RegExp(`^${OPUS_RUNG}/`));
  assert.equal(row.to, `${RUNG}/sonnet`);
  assert.equal(row.declared_type, 'bounded-feature');
  assert.ok(r.row.silent_fixes.some((s) => s.startsWith('opus_writer_rewrite:')), 'the spawn row records it');
  assert.equal(r.row.subagent_type_rewritten_to, RUNG);
});

test('ROLE: fixer and ROLE: lander count as writers; model opus on a general-purpose spawn moves to sonnet', () => {
  for (const role of ['fixer', 'lander']) {
    const r = spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: `ROLE: ${role}\nTYPE: debug-root-cause\nfix it` }, { sid: `sess-ow-${role}` });
    assert.ok(rewritten(r), `${role}: ${JSON.stringify(r.upd)}`);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].declared_role, role);
    assert.equal(r.out?.systemMessage, undefined);
  }
  const full = spawn({ subagent_type: 'general-purpose', model: 'claude-opus-5-5', prompt: 'ROLE: writer\nbuild it' }, { sid: 'sess-ow-full' });
  assert.ok(rewritten(full), 'a full claude-opus-* id counts as Opus');
});

test('no ROLE: the TYPE decides: writing types are rewritten, design and root-cause-only types are not', () => {
  for (const type of ['bounded-feature', 'integration', 'large-refactor', 'critical-change', 'long-autonomous-run']) {
    const r = spawn({ subagent_type: OPUS_RUNG, prompt: `TYPE: ${type}\ndo it` }, { sid: `sess-ow-t-${type}` });
    assert.equal(r.upd?.subagent_type, RUNG, type);
    assert.equal(r.rows.length, 1, type);
    assert.equal(r.rows[0].basis, 'type');
  }
  for (const type of ['novel-design', 'debug-root-cause']) {
    const r = spawn({ subagent_type: OPUS_RUNG, prompt: `TYPE: ${type}\nfigure it out` }, { sid: `sess-ow-n-${type}` });
    assert.notEqual(r.upd?.subagent_type, RUNG, type);
    assert.notEqual(r.upd?.model, 'sonnet', type);
    assert.equal(r.rows.length, 0, type);
  }
});

test('a reviewer, lookup, docs or operate spawn on Opus is left untouched', () => {
  const cases = [
    { prompt: 'TYPE: code-review\nWRITER: opus/xhigh\nROLE: reviewer\nreview it' },
    { prompt: 'ROLE: reviewer\nTYPE: large-refactor\nreview it' },
    { prompt: 'ROLE: lookup\nTYPE: large-refactor\nlook' },
    { prompt: 'ROLE: docs\nTYPE: large-refactor\nwrite docs' },
    { prompt: 'ROLE: operate\nTYPE: large-refactor\nrun it' },
  ];
  cases.forEach((c, i) => {
    const r = spawn({ subagent_type: OPUS_RUNG, ...c }, { sid: `sess-ow-keep-${i}` });
    assert.notEqual(r.upd?.model, 'sonnet', c.prompt);
    assert.ok(!(r.row.silent_fixes || []).some((s) => s.startsWith("opus_writer_rewrite")), c.prompt);
    assert.equal(r.rows.length, 0, c.prompt);
  });
  const exploreOnOpus = spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: explore\nlook around' }, { sid: 'sess-ow-keep-x' });
  assert.notEqual(exploreOnOpus.upd?.model, 'sonnet');
});

test('opus_writer_policy: allow keeps the old behaviour: nothing rewritten, no telemetry', () => {
  const env = { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'allow' };
  const r = spawn({ subagent_type: OPUS_RUNG, prompt: 'ROLE: writer\nTYPE: large-refactor\nbuild it' }, { env, sid: 'sess-ow-allow' });
  assert.equal(r.res.status, 0, r.res.stderr);
  assert.notEqual(r.upd?.subagent_type, RUNG);
  assert.notEqual(r.upd?.model, 'sonnet');
  assert.equal(r.rows.length, 0);
  const on = spawn({ subagent_type: OPUS_RUNG, prompt: 'ROLE: writer\nTYPE: large-refactor\nbuild it' }, { env: { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'sonnet' }, sid: 'sess-ow-sonnet' });
  assert.equal(on.upd?.subagent_type, RUNG, 'the explicit default rewrites');
  const junk = spawn({ subagent_type: OPUS_RUNG, prompt: 'ROLE: writer\nTYPE: large-refactor\nbuild it' }, { env: { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'banana' }, sid: 'sess-ow-junk' });
  assert.equal(junk.upd?.subagent_type, RUNG, 'an unknown value reads as the default');
});

test('a writer already on Sonnet (or Haiku) is not touched and writes no telemetry', () => {
  const a = spawn({ subagent_type: RUNG, prompt: 'ROLE: writer\nTYPE: large-refactor\nbuild it' }, { sid: 'sess-ow-s1' });
  assert.equal(a.rows.length, 0);
  assert.equal(a.upd?.subagent_type ?? RUNG, RUNG);
  const b = spawn({ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'ROLE: writer\nbuild it' }, { sid: 'sess-ow-s2' });
  assert.equal(b.rows.length, 0);
  // A named model parameter wins over an Opus definition: opus rung + model sonnet runs on Sonnet already.
  const c = spawn({ subagent_type: OPUS_RUNG, model: 'sonnet', prompt: 'ROLE: writer\nTYPE: bounded-feature\nbuild it' }, { sid: 'sess-ow-s3' });
  assert.equal(c.rows.length, 0);
});

test('an inherited Opus model: rewritten when the caller ran on Opus, not when it ran on Sonnet or is unknown', () => {
  const brief = 'ROLE: writer\nTYPE: bounded-feature\nbuild it';
  const opus = spawn({ subagent_type: 'general-purpose', prompt: brief }, { sid: 'sess-ow-i1', model: 'claude-opus-5-5' });
  assert.ok(rewritten(opus), JSON.stringify(opus.upd));
  assert.equal(opus.out?.systemMessage, undefined, 'silent');
  assert.equal(opus.rows.length, 1);
  assert.match(opus.rows[0].from, /inherited/);
  const sonnet = spawn({ subagent_type: 'general-purpose', prompt: brief }, { sid: 'sess-ow-i2', model: 'claude-sonnet-5-5' });
  assert.equal(sonnet.rows.length, 0);
  const unknown = spawn({ subagent_type: 'general-purpose', prompt: brief }, { sid: 'sess-ow-i3' });
  assert.equal(unknown.rows.length, 0);
});

test('a project agent whose own file pins Opus is the operator\'s tier choice: left alone', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'agents', 'acme-builder.md'), '---\nname: acme-builder\ndescription: builds\nmodel: opus\neffort: high\n---\nBuild things.\n');
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-ow-pin', agent_type: 'main', cwd: fx.dir,
      tool_input: { subagent_type: 'acme-builder', prompt: 'ROLE: writer\nTYPE: large-refactor\nbuild it', run_in_background: true, name: 'w' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(res.json?.hookSpecificOutput?.updatedInput?.model, 'sonnet');
    assert.equal(readJsonl(join(fx.stateDir, 'telemetry', OPUS_WRITER_LOG)).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('unit: countDeliverables counts the longest run of top-level items: 4 is not staged, 5 is', () => {
  const four = 'Do these:\n1. one\n2. two\n3. three\n4. four\n';
  const five = 'Do these:\n1. one\n2. two\n3. three\n4. four\n5. five\n';
  assert.equal(countDeliverables(four), 4);
  assert.equal(countDeliverables(five), 5);
  assert.equal(countDeliverables('- a\n- b\n- c\n- d\n- e\n'), 5, 'bullets count too');
  assert.equal(countDeliverables('1. a\n   - x\n   - y\n   - z\n   - w\n   - v\n2. b\n'), 2, 'nested items belong to their item');
  assert.equal(countDeliverables('Setup:\n- a\n- b\n- c\nThen:\n- d\n- e\n- f\n'), 3, 'a prose line ends the run: runs are not summed');
  assert.equal(countDeliverables('```\n1. a\n2. b\n3. c\n4. d\n5. e\n```\n'), 0, 'a code fence is not a list');
  assert.equal(countDeliverables('> 1. a\n> 2. b\n> 3. c\n> 4. d\n> 5. e\n'), 0, 'a quote is not a list');
  assert.equal(countDeliverables('- ROLE: writer\n- TYPE: integration\n- RISK: low\n- WRITER: x\n- REVIEW: lead\n- a\n'), 1, 'declaration lines are not deliverables');
  assert.equal(countDeliverables('no list here'), 0);
});

test('unit: the writer clause carries the handoff and test wording, and staging only above 4 deliverables', () => {
  const four = 'TYPE: bounded-feature\n1. a\n2. b\n3. c\n4. d\n';
  const five = 'TYPE: bounded-feature\n1. a\n2. b\n3. c\n4. d\n5. e\n';
  const c4 = buildWriterClause('bounded-feature', 'writer', four);
  const c5 = buildWriterClause('bounded-feature', 'writer', five);
  for (const c of [c4, c5]) {
    assert.ok(c.startsWith(`\n\n${WRITER_MARKER} `));
    assert.ok(c.includes(HANDOFF_SENTENCE) && c.includes(TEST_SENTENCE));
  }
  assert.ok(!c4.includes(STAGING_SENTENCE), 'four deliverables: no staging clause');
  assert.ok(c5.endsWith(STAGING_SENTENCE), 'five deliverables: staging clause appended');
  assert.match(HANDOFF_SENTENCE, /context handoff notice, finish the current step, commit and push WIP, write <task>-handoff\.md \(done \/ left \/ first next action\), and return "DONE: partial, handoff at <path>"/);
  assert.match(TEST_SENTENCE, /^While fixing, run only the affected test files; run the full suite once at the end, in the background/);
  assert.equal(STAGING_SENTENCE, 'Work in stages in the brief\'s order; commit after each stage; at the handoff notice, stop at the next stage boundary.');
  for (const c of [c4, c5]) assert.doesNotMatch(c, /15\+|edit worker|self-chosen/);
  // not a writer: nothing, however many items
  assert.equal(buildWriterClause('code-review', 'reviewer', five), '');
  assert.equal(buildWriterClause('explore', 'lookup', five), '');
  assert.equal(buildWriterClause(null, 'docs', five), '');
  assert.equal(buildWriterClause(null, null, five), '');
  // idempotent
  assert.equal(buildWriterClause('bounded-feature', 'writer', `${five}${c5}`), '');
  assert.ok(isWriterSpawn(null, 'lander') && isWriterSpawn(null, 'fixer') && !isWriterSpawn('explore', 'lander'));
});

test('the spawn guard appends the writer clause to a writer brief, and staging only for 5 deliverables; a non-writer gets nothing', () => {
  const body = (n) => `TYPE: bounded-feature\nROLE: writer\nDo these:\n${Array.from({ length: n }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n')}\n`;
  const sent = (r) => r.upd?.prompt || '';
  const four = spawn({ subagent_type: RUNG, prompt: body(4) }, { sid: 'sess-ow-c4' });
  const five = spawn({ subagent_type: RUNG, prompt: body(5) }, { sid: 'sess-ow-c5' });
  assert.ok(sent(four).includes(WRITER_MARKER) && sent(four).includes(HANDOFF_SENTENCE) && sent(four).includes(TEST_SENTENCE));
  assert.ok(!sent(four).includes(STAGING_SENTENCE));
  assert.ok(sent(five).includes(STAGING_SENTENCE));
  assert.equal(five.out?.systemMessage, undefined, 'staging is silent');
  const lookup = spawn({ subagent_type: 'agent-companion:ac-haiku', prompt: 'TYPE: explore\nROLE: lookup\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n' }, { sid: 'sess-ow-c6' });
  assert.ok(!sent(lookup).includes(WRITER_MARKER));
  assert.ok(!sent(lookup).includes(STAGING_SENTENCE));
});

test('a rewritten Opus writer also gets the writer clause (it runs as the Sonnet writer)', () => {
  const r = spawn({ subagent_type: OPUS_RUNG, prompt: 'TYPE: integration\nROLE: writer\n1. a\n2. b\n3. c\n4. d\n5. e\n' }, { sid: 'sess-ow-both' });
  assert.equal(r.upd.subagent_type, RUNG);
  assert.ok(r.upd.prompt.includes(STAGING_SENTENCE));
});
// --- Two legs (0.31.54): the Opus rung is a read-only plan leg, the write leg is ac-sonnet-high -----------------------------

const LEG_TYPES = ['debug-root-cause', 'large-refactor', 'novel-design', 'critical-change', 'long-autonomous-run'];

test('unit: every Opus-resolving writer row carries legs: an Opus plan route and a Sonnet write rung that exists', () => {
  const cfg = modelTiers();
  for (const type of LEG_TYPES) {
    const l = legsOf(type, cfg);
    assert.ok(l, `${type} has legs`);
    assert.equal(l.plan.artifact, '<task>-plan.md', type);
    assert.deepEqual(l.write, { model: 'sonnet', effort: 'high' }, type);
    assert.equal(rungFor(l.write.model, l.write.effort)?.agent, 'ac-sonnet-high', type);
    assert.equal(resolveRoute({ type, profile: false }).model, 'opus', `${type}: the row's own route is the Opus plan leg`);
    assert.deepEqual(writeLegPair(type, cfg), { model: 'sonnet', effort: 'high' }, type);
  }
  // Rows that never resolved to Opus have no legs.
  for (const type of ['bounded-feature', 'integration', 'mechanical-edit', 'code-review', 'explore']) assert.equal(legsOf(type, cfg), null, type);
});

test('unit: planLegSpawn is a type with legs whose brief does not say it writes', () => {
  assert.equal(planLegSpawn('large-refactor', 'other'), true);
  assert.equal(planLegSpawn('critical-change', 'other'), true);
  assert.equal(planLegSpawn('novel-design', null), true, 'design is non-writing with no ROLE');
  assert.equal(planLegSpawn('debug-root-cause', null), true);
  assert.equal(planLegSpawn('large-refactor', null), false, 'a writing type with no ROLE is a writer');
  assert.equal(planLegSpawn('large-refactor', 'writer'), false);
  assert.equal(planLegSpawn('debug-root-cause', 'fixer'), false);
  assert.equal(planLegSpawn('bounded-feature', 'other'), false, 'a type with no legs has no plan leg');
  assert.equal(planLegSpawn(null, 'other'), false);
});

test('the plan leg stays on its Opus rung: ROLE: other is not rewritten and carries no self-review protocol; the write leg on ac-sonnet-high does', () => {
  for (const type of LEG_TYPES) {
    const plan = spawn({ subagent_type: OPUS_RUNG, prompt: `TYPE: ${type}\nROLE: other\nWARRANT: weight 5 - plan leg\nplan it, write plan.md` }, { sid: `sess-leg-p-${type}` });
    assert.notEqual(plan.upd?.model, 'sonnet', type);
    assert.notEqual(plan.upd?.subagent_type, RUNG, type);
    assert.equal(plan.rows.length, 0, type);
    assert.equal(plan.row.self_review_expected, false, `${type}: no protocol for the read-only leg`);
    assert.equal(plan.row.self_review_injected, false, type);
    assert.doesNotMatch(plan.upd?.prompt || '', /Self-review before you return/, type);

    const write = spawn({ subagent_type: RUNG, prompt: `TYPE: ${type}\nROLE: writer\nbuild it from plan.md` }, { sid: `sess-leg-w-${type}` });
    assert.equal(write.rows.length, 0, `${type}: already on the Sonnet writer rung`);
    assert.equal(write.row.self_review_expected, true, `${type}: the write leg carries the protocol in its body`);
    assert.equal(write.row.self_review_injected, false, type);
  }
});
