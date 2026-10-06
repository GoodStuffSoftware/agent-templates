// Self-review (operator request 2026-09-28, widened to every writer type
// 2026-10-06 by the lean worker shape): writers spawn their own reviewer and
// land their own work. Covers the four pieces:
//   1. config/model-tiers.json `selfReview` -> the protocol block generated
//      into the body of every ladder rung that is the current default for a
//      listed type (scripts/routing-table.mjs --sync/--check-agent-descriptions),
//      including after a table move;
//   2. WRITER inferred from a subagent caller's own definition;
//   3. the recursion guard: a code-review spawned by an agent whose own spawn
//      row (found by agent_id -> sidecar toolUseId -> row tool_use_id) is a
//      code-review is DENIED; anything short of that positive match allows;
//   4. the new spawns.jsonl fields, and the `REVIEW: lead` opt-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT, decisionOf } from './helpers.mjs';
import {
  selfReviewConfig, optedOut, setSelfReviewBlock, readSelfReviewBlock, selfReviewBlock,
  SELF_REVIEW_BEGIN, SELF_REVIEW_END, callerSidecarPath,
} from '../hooks/lib/self-review.mjs';

const SHIPPED = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

// --- 1. Protocol text: generated, synced, drift-checked -----------------------

function fixtureAgentsDir(dir) {
  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'agents'), agentsDir, { recursive: true });
  return agentsDir;
}
function writeOverride(stateDir, obj) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify(obj));
}
const check = (agentsDir) => runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], { env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir } });
const sync = (agentsDir) => runScript('scripts/routing-table.mjs', ['--sync-agent-descriptions'], { env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir } });
const blockOf = (file) => readSelfReviewBlock(readFileSync(file, 'utf8')).block;

const WRITER_TYPES = ['bounded-feature', 'integration', 'debug-root-cause', 'large-refactor', 'novel-design', 'critical-change', 'long-autonomous-run'];
const SELF_REVIEW_RUNGS = ['ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh'];

test('config: selfReview lists every stand-alone writer type (lean worker shape, 2026-10-06), one fix round, and the REVIEW: lead opt-out', () => {
  const sr = selfReviewConfig(SHIPPED);
  assert.deepEqual(sr.types, WRITER_TYPES);
  // The edit workers a writer spawns sit under their parent's review; read-only and parity types stay out.
  for (const t of ['mechanical-edit', 'subagent-worker', 'explore', 'verify', 'operate', 'code-review']) {
    assert.equal(sr.types.includes(t), false, t);
  }
  assert.equal(sr.fixRounds, 1);
  assert.equal(sr.optOut.line, 'REVIEW: lead');
  assert.equal(sr.updated, '2026-10-06');
  assert.ok(sr.rationale.length > 100);
  // It sits with the task types, so it moves with the table.
  const keys = Object.keys(SHIPPED);
  assert.equal(keys.indexOf('selfReview'), keys.indexOf('taskTypes') + 1);
});

test('committed rungs: ac-opus-medium, ac-opus-high and ac-opus-xhigh (the defaults for the selfReview types today) carry the block, and no other rung does', () => {
  for (const rung of SHIPPED.ladder) {
    const block = blockOf(join(PLUGIN_ROOT, 'agents', `${rung.agent}.md`));
    if (SELF_REVIEW_RUNGS.includes(rung.agent)) {
      assert.ok(block, `${rung.agent} carries the protocol`);
      assert.match(block, new RegExp(`subagent_type: "agent-companion:${rung.agent}"`));
      assert.match(block, /^ {3}TYPE: code-review$/m);
      assert.match(block, new RegExp(`^ {3}WRITER: ${rung.model}/${rung.effort}$`, 'm'));
      assert.match(block, /Land your own work/);
      assert.match(block, /Every release gate stays/);
      assert.match(block, /`REVIEW: lead`/);
      assert.match(block, /Do one fix round/);
      assert.match(block, /Never re-review/);
      assert.match(block, /never spawn a reviewer/);
      assert.match(block, /the lead's original brief, verbatim/);
      assert.match(block, /VERDICT: PASS/);
      assert.match(block, /verdict line verbatim/);
    } else {
      assert.equal(block, null, `${rung.agent} must not carry the protocol`);
    }
  }
});

test('the committed block is byte-identical to a fresh generation (and --check passes on the real files)', () => {
  for (const agent of SELF_REVIEW_RUNGS) {
    const rung = SHIPPED.ladder.find((r) => r.agent === agent);
    assert.equal(blockOf(join(PLUGIN_ROOT, 'agents', `${agent}.md`)), selfReviewBlock(rung, selfReviewConfig(SHIPPED)), agent);
  }
  const res = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('drift: a hand-edited block fails the check as self-review-drift, and --sync restores it', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-xhigh.md');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('Do one fix round', 'Do two fix rounds, then re-review'));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-xhigh \[self-review-drift\]/);
    assert.match(res.stderr, /differs from the generated one/);
    assert.equal(sync(agentsDir).status, 0);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(check(agentsDir).status, 0);
  } finally { cleanup(); }
});

test('drift: a block deleted from its rung, or pasted onto another rung, fails the check; --sync fixes both', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const xhigh = join(agentsDir, 'ac-opus-xhigh.md');
    const high = join(agentsDir, 'ac-sonnet-high.md');
    const xOrig = readFileSync(xhigh, 'utf8');
    const hOrig = readFileSync(high, 'utf8');
    const block = readSelfReviewBlock(xOrig).block;
    writeFileSync(xhigh, setSelfReviewBlock(xOrig, null));
    writeFileSync(high, setSelfReviewBlock(hOrig, block));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-xhigh \[self-review-drift\][\s\S]*actual:\s+\(absent\)/);
    assert.match(res.stderr, /ac-sonnet-high \[self-review-drift\][\s\S]*expected: no self-review protocol block/);
    assert.equal(sync(agentsDir).status, 0);
    assert.equal(readFileSync(xhigh, 'utf8'), xOrig);
    assert.equal(readFileSync(high, 'utf8'), hOrig, 'removing the block restores the rung byte for byte');
    assert.equal(check(agentsDir).status, 0);
  } finally { cleanup(); }
});

test('table move: when the selfReview types route to another rung, --check fails on the rung that lost them AND the one that gained them; --sync moves the block', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    // Route every selfReview type's writer to opus/high: shift each trial
    // override (and add one where the type has none) to high. critical-change
    // is grid-floored to opus/xhigh (F1), so it leaves the list for this move.
    const taskTypes = JSON.parse(JSON.stringify(SHIPPED.taskTypes));
    for (const t of ['novel-design', 'large-refactor', 'long-autonomous-run']) {
      taskTypes[t].override = { ...(taskTypes[t].override || {}), model: 'opus', effort: 'high', trialVersion: 9, overridesKindDelta: true, reason: 'test move', trialSince: '2026-09-28', reviewBy: '2026-12-31' };
    }
    writeOverride(stateDir, { taskTypes, selfReview: { ...SHIPPED.selfReview, types: ['novel-design', 'large-refactor', 'long-autonomous-run'] } });
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-xhigh \[self-review-drift\][\s\S]*expected: no self-review protocol block/);
    assert.match(res.stderr, /ac-opus-medium \[self-review-drift\][\s\S]*expected: no self-review protocol block/);
    assert.match(res.stderr, /ac-opus-high \[self-review-drift\][\s\S]*novel-design, large-refactor, long-autonomous-run/);

    const syncRes = sync(agentsDir);
    assert.equal(syncRes.status, 0, syncRes.stderr);
    assert.equal(blockOf(join(agentsDir, 'ac-opus-xhigh.md')), null, 'the old rung lost the block');
    assert.equal(blockOf(join(agentsDir, 'ac-opus-medium.md')), null, 'a rung whose types are no longer listed lost it too');
    const moved = blockOf(join(agentsDir, 'ac-opus-high.md'));
    assert.ok(moved, 'the new rung gained it');
    assert.match(moved, /subagent_type: "agent-companion:ac-opus-high"/);
    assert.match(moved, /^ {3}WRITER: opus\/high$/m);
    const recheck = check(agentsDir);
    assert.equal(recheck.status, 0, recheck.stdout + recheck.stderr);
    // Idempotent.
    assert.match(sync(agentsDir).stdout, /no agent descriptions needed updating/);
  } finally { cleanup(); }
});

test('config edits flow into the text: fixRounds and the opt-out line are generated, never typed', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeOverride(stateDir, { selfReview: { ...SHIPPED.selfReview, fixRounds: 2, optOut: 'SELF-REVIEW: off' } });
    assert.equal(check(agentsDir).status, 1);
    assert.equal(sync(agentsDir).status, 0);
    const block = blockOf(join(agentsDir, 'ac-opus-xhigh.md'));
    assert.match(block, /Do at most 2 fix rounds/);
    assert.match(block, /`SELF-REVIEW: off`/);
    assert.doesNotMatch(block, /REVIEW: lead/);
    assert.equal(check(agentsDir).status, 0);
  } finally { cleanup(); }
});

test('an empty selfReview.types (the documented reverse) removes the block everywhere', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeOverride(stateDir, { selfReview: { ...SHIPPED.selfReview, types: [] } });
    assert.equal(check(agentsDir).status, 1);
    assert.equal(sync(agentsDir).status, 0);
    for (const rung of SHIPPED.ladder) assert.equal(blockOf(join(agentsDir, `${rung.agent}.md`)), null, rung.agent);
    assert.equal(check(agentsDir).status, 0);
  } finally { cleanup(); }
});

test('config problems fail the check: an unknown type, and a parity type (reviewers never self-review)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeOverride(stateDir, { selfReview: { ...SHIPPED.selfReview, types: [...SHIPPED.selfReview.types, 'code-review', 'frobnicate'] } });
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /selfReview \[self-review-config\][\s\S]*"code-review", a parity-sized review type/);
    assert.match(res.stderr, /"frobnicate", which is not a task type/);
  } finally { cleanup(); }
});

test('malformed markers are reported and never rewritten by --sync', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-xhigh.md');
    const broken = readFileSync(file, 'utf8').replace(SELF_REVIEW_END, '');
    writeFileSync(file, broken);
    const res = check(agentsDir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ac-opus-xhigh \[self-review-malformed\]/);
    assert.equal(sync(agentsDir).status, 0);
    assert.equal(readFileSync(file, 'utf8'), broken, 'sync never guesses where a block ends');
  } finally { cleanup(); }
});

test('setSelfReviewBlock: append, replace, remove round-trip, CRLF preserved', () => {
  const body = '---\nname: x\n---\n\nbody text\n';
  const b1 = `${SELF_REVIEW_BEGIN}\none\n${SELF_REVIEW_END}`;
  const b2 = `${SELF_REVIEW_BEGIN}\ntwo\n${SELF_REVIEW_END}`;
  const added = setSelfReviewBlock(body, b1);
  assert.equal(added, `${body}\n${b1}\n`);
  assert.equal(setSelfReviewBlock(added, b1), added, 'idempotent');
  assert.equal(setSelfReviewBlock(added, b2), `${body}\n${b2}\n`);
  assert.equal(setSelfReviewBlock(added, null), body);
  assert.equal(setSelfReviewBlock(body, null), body);
  const crlf = body.replace(/\n/g, '\r\n');
  const addedCrlf = setSelfReviewBlock(crlf, b1);
  assert.ok(!/[^\r]\n/.test(addedCrlf), 'no bare LF in a CRLF file');
  assert.equal(readSelfReviewBlock(addedCrlf).block, b1);
  assert.equal(setSelfReviewBlock(addedCrlf, null), crlf);
});

// --- 5. The REVIEW: lead opt-out -------------------------------------------------

test('optedOut: a REVIEW: lead line of its own opts out; prose, code, quotes and other values do not', () => {
  const sr = selfReviewConfig(SHIPPED);
  for (const yes of ['TYPE: novel-design\nREVIEW: lead\nbuild it', '- **REVIEW:** lead', 'review: Lead (the hub reviews)', 'REVIEW: `lead`']) {
    assert.equal(optedOut(yes, sr), true, yes);
  }
  for (const no of [
    'TYPE: novel-design\nbuild it',
    'the lead will REVIEW: lead the way', // mid-sentence
    '```\nREVIEW: lead\n```', // fenced code
    '> REVIEW: lead', // quoted
    '<!-- REVIEW: lead -->',
    'REVIEW: leader',
    'REVIEW: self',
    'REVIEW: self\nREVIEW: lead', // the first REVIEW line decides
  ]) {
    assert.equal(optedOut(no, sr), false, no);
  }
});

// --- 2-4. The spawn guard ---------------------------------------------------------

function harness(extraEnv = {}) {
  const fx = makeFixture();
  const env = {
    CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '50',
    ...extraEnv,
  };
  const sid = 'sess-self-review';
  const projDir = join(fx.dir, 'projects', 'proj');
  mkdirSync(projDir, { recursive: true });
  const leadTranscript = join(projDir, `${sid}.jsonl`);
  writeFileSync(leadTranscript, '');
  const subDir = join(projDir, sid, 'subagents');
  mkdirSync(subDir, { recursive: true });
  // The harness's sidecar for a spawned agent: names the Agent call's id.
  const sidecar = (agentId, meta) => writeFileSync(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  // A spawn from the main thread (the lead).
  const lead = (toolInput, extra = {}) => run({ session_id: sid, cwd: fx.dir, transcript_path: leadTranscript, ...extra, tool_input: toolInput });
  // A spawn from a subagent: the LEAD's session_id and transcript_path, plus
  // the caller's own agent_id and agent_type.
  const sub = (agentId, agentType, toolInput, extra = {}) => run({
    session_id: sid, cwd: fx.dir, transcript_path: leadTranscript, agent_id: agentId,
    ...(agentType === undefined ? {} : { agent_type: agentType }), ...extra, tool_input: toolInput,
  });
  function run(payload) {
    const res = runHook('hooks/spawn-guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', ...payload }, { env });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
    return {
      json: res.json,
      decision: decisionOf(res.json),
      reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '',
      msg: res.json?.systemMessage || '',
      prompt: res.json?.hookSpecificOutput?.updatedInput?.prompt ?? null,
      row: rows[rows.length - 1] || null,
      rows,
    };
  }
  const denials = () => readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl')).map((d) => d.guard);
  const agent = (name, fm) => {
    mkdirSync(join(fx.dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'agents', `${name}.md`), `---\nname: ${name}\n${fm}\n---\nbody\n`);
  };
  return { ...fx, sid, env, lead, sub, sidecar, denials, agent, leadTranscript, subDir };
}

const XHIGH = 'agent-companion:ac-opus-xhigh';
const REVIEW = (writer) => `TYPE: code-review\n${writer ? `WRITER: ${writer}\n` : ''}review the diff on wip/x`;
const bg = (o) => ({ run_in_background: false, ...o });

test('WRITER inference: a subagent spawning TYPE: code-review with no WRITER line is sized to its own definition, with a note', () => {
  const h = harness();
  try {
    const r = h.sub('a1', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }), { tool_use_id: 'toolu_r1' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.row.inferred_writer, 'opus/xhigh');
    assert.equal(r.row.declared_writer, null, 'nothing was declared');
    assert.equal(r.row.fit, 'fit');
    assert.equal(r.row.fit_expected, 'opus/xhigh');
    assert.equal(r.row.routed, true);
    assert.match(r.msg, /its writer was inferred from the subagent spawning it: "agent-companion:ac-opus-xhigh" runs at opus\/xhigh/);
    assert.doesNotMatch(r.msg, /names no usable writer/);
    assert.equal('permissionDecision' in (r.json.hookSpecificOutput || {}), false, 'no hook answers "allow"');

    // Inference judges parity like a declared writer: a reviewer below the
    // caller is said to be below it.
    const low = h.sub('a1', XHIGH, bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW(null) }));
    assert.equal(low.row.fit, 'under');
    assert.match(low.msg, /It is BELOW its writer, opus\/xhigh/);
  } finally { h.cleanup(); }
});

test('WRITER inference: a project-agent caller is read from its own definition; one with no effort is checked on the model', () => {
  const h = harness();
  try {
    h.agent('proj-architect', 'model: sonnet\neffort: high');
    const r = h.sub('a2', 'proj-architect', bg({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW(null) }));
    assert.equal(r.row.inferred_writer, 'sonnet/high');
    assert.equal(r.row.fit, 'fit');

    h.agent('no-effort-architect', 'model: opus');
    const n = h.sub('a3', 'no-effort-architect', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(n.row.inferred_writer, 'opus');
    assert.match(n.msg, /states no effort, so parity is checked on the model alone/);
  } finally { h.cleanup(); }
});

test('WRITER inference never guesses: a built-in caller, a missing agent_type, the main thread, or a WRITER line all infer nothing', () => {
  const h = harness();
  try {
    const builtin = h.sub('b1', 'general-purpose', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(builtin.row.inferred_writer, null);
    assert.equal(builtin.row.route_layer, null, 'no writer, no parity route');
    assert.match(builtin.msg, /could not be inferred from the subagent spawning it: the caller's agent type "general-purpose" has no definition file/);

    const Explore = h.sub('b2', 'Explore', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(Explore.row.inferred_writer, null);

    const missing = h.sub('b3', undefined, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(missing.row.inferred_writer, null);
    assert.match(missing.msg, /names no agent_type/);

    // An --agent session's main thread carries agent_type but no agent_id:
    // the lead names its writer; nothing is inferred.
    const main = h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW(null) }), { agent_type: XHIGH });
    assert.equal(main.row.inferred_writer, null);
    assert.doesNotMatch(main.msg, /inferred/);

    // A WRITER line, usable or not, always wins.
    const declared = h.sub('b4', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/high') }));
    assert.equal(declared.row.declared_writer, 'opus/high');
    assert.equal(declared.row.inferred_writer, null);
    const bad = h.sub('b5', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('gpt/high') }));
    assert.equal(bad.row.inferred_writer, null);
    assert.match(bad.msg, /the WRITER line \("gpt\/high"\) was ignored/);
  } finally { h.cleanup(); }
});

test('recursion guard: a code-review spawned by an agent whose own spawn row is a code-review is DENIED (positive match by tool_use_id)', () => {
  const h = harness();
  try {
    // The lead spawns reviewer R (Agent call toolu_R); the harness writes R's sidecar.
    const spawnR = h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    assert.equal(spawnR.decision, 'proceed', spawnR.reason);
    assert.equal(spawnR.row.tool_use_id, 'toolu_R');
    assert.equal(spawnR.row.declared_type, 'code-review');
    h.sidecar('rrr1', { agentType: XHIGH, toolUseId: 'toolu_R', spawnDepth: 1 });

    // R then tries to spawn a reviewer of its own.
    const nested = h.sub('rrr1', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_RR' });
    assert.equal(nested.decision, 'deny');
    assert.match(nested.reason, /Reviewers never spawn reviewers/);
    assert.match(nested.reason, /itself spawned as TYPE: code-review/);
    assert.deepEqual(h.denials(), ['review-recursion']);
    // The row is still written (every spawn is), and says why.
    assert.equal(nested.row.caller_row_found, true);
    assert.equal(nested.row.caller_declared_type, 'code-review');
    assert.equal(nested.row.self_review, false);
    assert.equal(nested.row.parent_agent_id, 'rrr1');
  } finally { h.cleanup(); }
});

test('recursion guard: a writer reviewing its own work is allowed and recorded as self_review', () => {
  const h = harness();
  try {
    const spawnW = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: novel-design\nbuild the bus' }), { tool_use_id: 'toolu_W' });
    assert.equal(spawnW.row.self_review_expected, true);
    h.sidecar('www1', { agentType: XHIGH, toolUseId: 'toolu_W', spawnDepth: 1 });
    const r = h.sub('www1', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }), { tool_use_id: 'toolu_WR' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.row.caller_row_found, true);
    assert.equal(r.row.caller_declared_type, 'novel-design');
    assert.equal(r.row.self_review, true);
    assert.equal(r.row.inferred_writer, 'opus/xhigh');
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('recursion guard: unknown always allows (no sidecar, no toolUseId, no row with that id, another session, a pre-field row)', () => {
  const h = harness();
  try {
    // A reviewer row exists, but the chain to it is broken in each case below.
    h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    const cases = [
      ['u1', null], // no sidecar at all
      ['u2', { agentType: XHIGH }], // sidecar names no toolUseId
      ['u3', { agentType: XHIGH, toolUseId: 'toolu_nobody' }], // no row carries that id
    ];
    for (const [id, meta] of cases) {
      if (meta) h.sidecar(id, meta);
      const r = h.sub(id, XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }));
      assert.equal(r.decision, 'proceed', `${id}: ${r.reason}`);
      assert.equal(r.row.caller_row_found, false, id);
      assert.equal(r.row.self_review, false, `${id}: not positively a self-reviewing writer`);
      assert.equal(r.row.review_by_subagent, true, id);
    }
    // The id exists, but in another session's row.
    const other = runHook('hooks/spawn-guard.mjs', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 'sess-other', cwd: h.dir, tool_use_id: 'toolu_O',
      tool_input: bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }),
    }, { env: h.env });
    assert.equal(other.status, 0);
    h.sidecar('u4', { agentType: XHIGH, toolUseId: 'toolu_O' });
    const cross = h.sub('u4', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }));
    assert.equal(cross.decision, 'proceed', cross.reason);
    assert.equal(cross.row.caller_row_found, false);
    // A row written before rows carried tool_use_id cannot be found by it.
    writeFileSync(join(h.stateDir, 'telemetry', 'spawns.jsonl'),
      `${JSON.stringify({ v: 2, session_id: h.sid, declared_type: 'code-review', subagent_type: XHIGH })}\n`, { flag: 'a' });
    h.sidecar('u5', { agentType: XHIGH, toolUseId: 'toolu_old' });
    const old = h.sub('u5', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }));
    assert.equal(old.decision, 'proceed', old.reason);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('recursion guard: only the sidecar named for THIS agent_id is read; a reviewer spawning a non-review is not looked up', () => {
  const h = harness();
  try {
    h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    h.sidecar('rev', { agentType: XHIGH, toolUseId: 'toolu_R' });
    // agent_transcript_path naming ANOTHER agent's transcript is ignored.
    assert.equal(callerSidecarPath({ agent_id: 'me', agent_transcript_path: join(h.subDir, 'agent-rev.jsonl'), transcript_path: h.leadTranscript }),
      join(h.subDir, 'agent-me.meta.json'));
    const me = h.sub('me', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { agent_transcript_path: join(h.subDir, 'agent-rev.jsonl') });
    assert.equal(me.decision, 'proceed', me.reason);
    // The reviewer itself may still spawn helpers that are not reviews.
    const helper = h.sub('rev', XHIGH, bg({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: bounded-feature\nfind the call sites' }));
    assert.equal(helper.decision, 'proceed', helper.reason);
    assert.equal(helper.row.caller_row_found, null, 'no lookup for a non-review spawn');
    assert.equal(helper.row.self_review, false);
  } finally { h.cleanup(); }
});

test('recursion guard: review_recursion_guard false allows the positive match, and still records it', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_REVIEW_RECURSION_GUARD: 'false' });
  try {
    h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    h.sidecar('rrr1', { agentType: XHIGH, toolUseId: 'toolu_R' });
    const r = h.sub('rrr1', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }));
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.row.caller_declared_type, 'code-review');
    assert.equal(r.row.self_review, false);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('telemetry: every row carries tool_use_id, parent_agent_id, inferred_writer, self_review, self_review_expected, caller_row_found, caller_declared_type', () => {
  const h = harness();
  try {
    const r = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: bounded-feature\nfind it' }), { tool_use_id: 'toolu_E' });
    for (const k of ['tool_use_id', 'parent_agent_id', 'inferred_writer', 'self_review', 'self_review_expected', 'caller_row_found', 'caller_declared_type']) {
      assert.ok(k in r.row, `${k} on the row`);
    }
    assert.equal(r.row.tool_use_id, 'toolu_E');
    assert.equal(r.row.parent_agent_id, null, 'main thread');
    assert.equal(r.row.self_review, false, 'the spawn is not itself a review');
    assert.equal(r.row.self_review_expected, true, 'bounded-feature is a selfReview type (lean worker shape)');
    assert.equal(r.row.caller_row_found, null);
    const edit = h.lead(bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'TYPE: mechanical-edit\nrename it' }));
    assert.equal(edit.row.self_review_expected, null, 'mechanical-edit is an edit worker under its parent\'s review, not a selfReview type');
    // No payload id: null, never invented.
    const none = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: bounded-feature\nfind it' }));
    assert.equal(none.row.tool_use_id, null);
    const s = h.sub('p1', XHIGH, bg({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: bounded-feature\nx' }));
    assert.equal(s.row.parent_agent_id, 'p1');
    assert.equal(s.row.caller_agent_id, 'p1');
  } finally { h.cleanup(); }
});

test('self_review_expected: true on the rung carrying the protocol (nothing appended); false with REVIEW: lead (no note); null for another agent file', () => {
  const h = harness();
  try {
    const on = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: critical-change\nsplit the module' }));
    assert.equal(on.row.self_review_expected, true);
    assert.equal(on.row.self_review_injected, false, 'the rung carries it already');
    assert.doesNotMatch(on.prompt || '', /Self-review before you return/);
    assert.doesNotMatch(on.msg, /self-review\)/);

    const optOut = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: critical-change\nREVIEW: lead\nsplit the module' }));
    assert.equal(optOut.row.self_review_expected, false);
    assert.doesNotMatch(optOut.msg, /self-review/i, 'an opt-out is deliberate: no note');

    h.agent('proj-architect', 'model: opus\neffort: xhigh');
    const proj = h.lead(bg({ subagent_type: 'proj-architect', prompt: 'TYPE: novel-design\ndesign it' }));
    assert.equal(proj.row.self_review_expected, null, 'a project agent may carry its own wording');
    assert.equal(proj.row.self_review_injected, false);
    assert.doesNotMatch(proj.msg, /self-review\)/);
  } finally { h.cleanup(); }
});

test('a self-reviewing TYPE on a ladder rung WITHOUT the block gets the generated protocol appended to its brief, sized to that rung', () => {
  const h = harness();
  try {
    const r = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - test\ndesign it' }));
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.row.self_review_expected, true);
    assert.equal(r.row.self_review_injected, true);
    assert.match(r.prompt, /^TYPE: novel-design\nWARRANT: weight 5 - test\ndesign it\n\n---\n\(agent-companion: your definition does not carry the self-review protocol/);
    assert.match(r.prompt, /## Self-review before you return/);
    assert.match(r.prompt, /subagent_type: "agent-companion:ac-opus-max"/);
    assert.match(r.prompt, /^ {3}WRITER: opus\/max$/m);
    assert.match(r.prompt, /Land your own work/);
    assert.doesNotMatch(r.prompt, /self-review protocol (BEGIN|END)/, 'file markers stay out of a brief');
    assert.ok(r.prompt.indexOf('Self-review before you return') < r.prompt.indexOf('Put your ENTIRE report') || !r.prompt.includes('Put your ENTIRE report'),
      'task instructions before the reporting contract');
    assert.match(r.msg, /"agent-companion:ac-opus-max" does not carry the protocol in its definition, so it was appended to the brief/);

    // The rung that matches what will RUN: a model named on the spawn wins.
    const s = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-low', model: 'sonnet', prompt: 'TYPE: novel-design\nrefactor it' }));
    assert.equal(s.row.self_review_injected, true);
    assert.match(s.prompt, /subagent_type: "agent-companion:ac-sonnet-low"/);
    assert.match(s.prompt, /^ {3}WRITER: sonnet\/low$/m);

    // REVIEW: lead: nothing appended.
    const o = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'TYPE: novel-design\nREVIEW: lead\nWARRANT: weight 5 - test\ndesign it' }));
    assert.equal(o.row.self_review_injected, false);
    assert.doesNotMatch(o.prompt || '', /Self-review before you return/);

    // Not a listed type: nothing appended.
    const b = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'TYPE: mechanical-edit\nWARRANT: weight 2 - test\nrename it' }));
    assert.equal(b.row.self_review_injected, false);
    assert.doesNotMatch(b.prompt || '', /Self-review before you return/);
  } finally { h.cleanup(); }
});

test('a built-in writer (effort not pinned) gets no protocol, and a note that names a rung only when its installed file carries the block', () => {
  const h = harness();
  try {
    const g = h.lead(bg({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: novel-design\ndesign it' }));
    assert.equal(g.row.self_review_expected, false);
    assert.equal(g.row.self_review_injected, false);
    assert.doesNotMatch(g.prompt || '', /Self-review before you return/);
    assert.match(g.msg, /"general-purpose" carries no self-review protocol and is no ladder rung it can be added to/);
    assert.match(g.msg, /Spawn agent-companion:ac-opus-xhigh \(its routed rung\) for a self-reviewed result/);
  } finally { h.cleanup(); }
  // A state override moves novel-design to opus/max; the installed ac-opus-max
  // has no block, so the note must not send the lead there "for the protocol".
  const h2 = harness();
  try {
    const taskTypes = JSON.parse(JSON.stringify(SHIPPED.taskTypes));
    taskTypes['novel-design'].override = { ...(taskTypes['novel-design'].override || {}), model: 'opus', effort: 'max', trialVersion: 9, overridesKindDelta: true, reason: 'test move', trialSince: '2026-09-28', reviewBy: '2026-12-31' };
    writeOverride(h2.stateDir, { taskTypes });
    const g = h2.lead(bg({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - test\ndesign it' }));
    assert.match(g.msg, /carries no self-review protocol/);
    assert.doesNotMatch(g.msg, /Spawn agent-companion:/, 'no rung whose installed file carries it');
    // ...and ac-opus-max itself, spawned under that override, gets the text appended.
    const m = h2.lead(bg({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - frontier\ndesign it' }));
    assert.equal(m.row.self_review_injected, true, m.reason);
    assert.match(m.prompt, /^ {3}WRITER: opus\/max$/m);
  } finally { h2.cleanup(); }
});

test('WRITER inference checks the definition against what the caller was seen running (review round)', () => {
  const h = harness();
  try {
    h.agent('proj-sonnet', 'model: sonnet\neffort: high');
    const own = join(h.subDir, 'agent-s1.jsonl');
    // The caller's OWN transcript says its last turn ran on opus: a model set
    // on its spawn overrode the definition, so the definition is not its writer.
    writeFileSync(own, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } })}\n`);
    const over = h.sub('s1', 'proj-sonnet', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(over.row.inferred_writer, null);
    assert.match(over.msg, /is defined on sonnet, but its last turn ran on claude-opus-5-5/);
    assert.equal(over.json?.hookSpecificOutput?.updatedInput?.model, undefined, 'no model autofilled from a guess');

    // Same alias: inference stands.
    writeFileSync(own, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } })}\n`);
    const same = h.sub('s1', 'proj-sonnet', bg({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW(null) }));
    assert.equal(same.row.inferred_writer, 'sonnet/high');

    // No own transcript: the lead's transcript is NOT read as the caller's model.
    writeFileSync(h.leadTranscript, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } })}\n`);
    const lead = h.sub('s2', 'proj-sonnet', bg({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW(null) }));
    assert.equal(lead.row.inferred_writer, 'sonnet/high');

    // A definition with no effort takes the effort the caller runs at.
    h.agent('opus-noeffort', 'model: opus');
    const e = h.sub('s3', 'opus-noeffort', bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW(null) }), { effort: { level: 'xhigh' } });
    assert.equal(e.row.inferred_writer, 'opus/xhigh');
    assert.equal(e.row.fit, 'under', 'an opus/low reviewer is below an xhigh writer');
    assert.match(e.msg, /xhigh is the effort it was seen running at/);

    // Failure reasons say what actually happened.
    const plug = h.sub('s4', 'someplugin:thing', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.match(plug.msg, /a plugin agent that is not installed here/);
    h.agent('inheritor', 'model: inherit\neffort: high');
    const inh = h.sub('s5', 'inheritor', bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.match(inh.msg, /sets `model: inherit`/);
  } finally { h.cleanup(); }
});

test('a self-reviewing writer that names a WRITER below itself gets a note; a critical-change writer\'s review is floored by F1', () => {
  const h = harness();
  try {
    h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: critical-change\nrotate the keys' }), { tool_use_id: 'toolu_C' });
    h.sidecar('c', { toolUseId: 'toolu_C' });
    const low = h.sub('c', XHIGH, bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: REVIEW('sonnet/low') }));
    assert.equal(low.decision, 'proceed', low.reason);
    assert.equal(low.row.self_review, true);
    assert.equal(low.row.consequence_from_caller, true);
    assert.equal(low.row.declared_consequence, 'critical');
    assert.equal(low.row.fit_expected, 'opus/xhigh', 'F1 floors a critical review');
    assert.equal(low.row.fit, 'under');
    assert.match(low.msg, /the WRITER line names sonnet\/low, but the agent spawning this review \("agent-companion:ac-opus-xhigh", spawned as TYPE: critical-change\) runs at opus\/xhigh/);
    assert.equal(low.row.caller_tool_use_id, 'toolu_C', 'joins the review row to its writer row');

    const ok = h.sub('c', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(ok.row.fit, 'fit');
    assert.doesNotMatch(ok.msg, /the WRITER line names/);

    // A brief's own CONSEQUENCE line wins over the caller's.
    const own = h.sub('c', XHIGH, bg({ subagent_type: XHIGH, prompt: 'TYPE: code-review\nCONSEQUENCE: routine\nreview it' }));
    assert.equal(own.row.consequence_from_caller, false);
    assert.equal(own.row.declared_consequence, 'routine');

    // A found writer of a type NOT in selfReview.types (an edit worker): a
    // review by a subagent, not a self-review.
    h.lead(bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'TYPE: mechanical-edit\nrename it' }), { tool_use_id: 'toolu_B' });
    h.sidecar('bf', { toolUseId: 'toolu_B' });
    const bf = h.sub('bf', 'agent-companion:ac-sonnet-low', bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: REVIEW(null) }));
    assert.equal(bf.row.self_review, false);
    assert.equal(bf.row.review_by_subagent, true);
    assert.equal(bf.row.consequence_from_caller, false);
  } finally { h.cleanup(); }
});

test('the recursion deny tells a re-tasked agent to return to the lead', () => {
  const h = harness();
  try {
    h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    h.sidecar('r', { toolUseId: 'toolu_R' });
    const d = h.sub('r', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /return to the lead with the work and the reason: the lead can spawn the review itself/);
  } finally { h.cleanup(); }
});

test('recommend.mjs says when the writer reviews itself, so the lead does not review twice', () => {
  const nd = runScript('scripts/recommend.mjs', ['--type', 'novel-design']);
  assert.equal(nd.status, 0, nd.stderr);
  assert.match(nd.stdout, /self-review: +the writer spawns that reviewer itself \(protocol in agent-companion:ac-opus-xhigh's body\), runs one fix round/);
  assert.match(nd.stdout, /unless the brief carries `REVIEW: lead`/);
  const js = JSON.parse(runScript('scripts/recommend.mjs', ['--type', 'novel-design', '--json']).stdout);
  assert.deepEqual(js.selfReview, { protocol: 'rung', fixRounds: 1, optOut: 'REVIEW: lead' });
  assert.match(nd.stdout, /lands its own work/);
  const me = runScript('scripts/recommend.mjs', ['--type', 'mechanical-edit']);
  assert.doesNotMatch(me.stdout, /self-review:/);
});

test('every stand-alone writer type self-reviews (the 2026-10-02 narrowing is reversed); edit workers and read-only types do not', () => {
  for (const type of WRITER_TYPES) {
    const r = runScript('scripts/recommend.mjs', ['--type', type]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /self-review:/, type);
    const js = JSON.parse(runScript('scripts/recommend.mjs', ['--type', type, '--json']).stdout);
    assert.equal(js.selfReview.fixRounds, 1, type);
    assert.equal(SHIPPED.selfReview.types.includes(type), true, type);
  }
  for (const type of ['mechanical-edit', 'subagent-worker', 'explore', 'verify', 'operate']) {
    const r = runScript('scripts/recommend.mjs', ['--type', type]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /self-review:/, type);
    assert.equal(SHIPPED.selfReview.types.includes(type), false, type);
  }
});

test('the protocol tells the writer where its reviewer works', () => {
  const rung = SHIPPED.ladder.find((r) => r.agent === 'ac-opus-xhigh');
  assert.match(selfReviewBlock(rung, selfReviewConfig(SHIPPED)), /where to work: its own checkout of that sha \(for example `git worktree add --detach <path> <sha>`, run from your working tree\), never your working tree/);
});

test('no self-review path for a type that is not listed (an edit worker); every self-review path either denies or sets no decision (never "allow")', () => {
  const h = harness();
  try {
    const r = h.lead(bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'TYPE: mechanical-edit\nrename the flag' }));
    assert.equal(r.row.self_review_expected, null);
    assert.doesNotMatch(r.msg, /self-review/i);

    h.agent('proj-architect', 'model: opus\neffort: xhigh');
    const W = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: novel-design\nbuild' }), { tool_use_id: 'toolu_W' });
    h.sidecar('w', { toolUseId: 'toolu_W' });
    const R = h.lead(bg({ subagent_type: XHIGH, prompt: REVIEW('opus/xhigh') }), { tool_use_id: 'toolu_R' });
    h.sidecar('r', { toolUseId: 'toolu_R' });
    const outs = [
      r, W, R,
      h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: novel-design\nREVIEW: lead\nbuild' })),
      h.lead(bg({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - t\nbuild' })),
      h.sub('w', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // self-review, inferred
      h.sub('x', 'general-purpose', bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // inference fails
      h.sub('y', 'proj-architect', bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // project caller
    ];
    for (const o of outs) assert.equal(o.decision, 'proceed', o.reason);
    const denied = h.sub('r', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(denied.decision, 'deny');
  } finally { h.cleanup(); }
});

// --- Lean worker shape (0.31.2): every writer type self-reviews and lands -----

test('a bounded-feature writer reviewing its own work is classified self_review, and the reviewer-spawns-reviewer guard still denies the reviewer', () => {
  const MED = 'agent-companion:ac-opus-medium';
  const h = harness();
  try {
    const W = h.lead(bg({ subagent_type: MED, prompt: 'TYPE: bounded-feature\nadd the flag' }), { tool_use_id: 'toolu_BF' });
    assert.equal(W.row.self_review_expected, true);
    assert.equal(W.row.self_review_injected, false, 'ac-opus-medium carries the protocol in its body');
    h.sidecar('bfw', { agentType: MED, toolUseId: 'toolu_BF', spawnDepth: 1 });
    const R = h.sub('bfw', MED, bg({ subagent_type: MED, prompt: REVIEW(null) }), { tool_use_id: 'toolu_BFR' });
    assert.equal(R.decision, 'proceed', R.reason);
    assert.equal(R.row.caller_declared_type, 'bounded-feature');
    assert.equal(R.row.self_review, true);
    assert.equal(R.row.inferred_writer, 'opus/medium');
    h.sidecar('bfr', { agentType: MED, toolUseId: 'toolu_BFR', spawnDepth: 2 });
    const deep = h.sub('bfr', MED, bg({ subagent_type: MED, prompt: REVIEW(null) }));
    assert.equal(deep.decision, 'deny', 'a reviewer never spawns a reviewer');
    assert.match(deep.reason, /Reviewers never spawn reviewers/);
    assert.doesNotMatch(deep.reason, /fixer/);
  } finally { h.cleanup(); }
});

test('an edit worker (mechanical-edit) spawned by a writer is not itself a self-reviewing type', () => {
  const h = harness();
  try {
    h.lead(bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'TYPE: mechanical-edit\nrename it' }), { tool_use_id: 'toolu_ME' });
    h.sidecar('me', { toolUseId: 'toolu_ME' });
    const r = h.sub('me', 'agent-companion:ac-sonnet-low', bg({ subagent_type: 'agent-companion:ac-sonnet-low', prompt: REVIEW(null) }));
    assert.equal(r.row.self_review, false);
    assert.equal(r.row.review_by_subagent, true);
  } finally { h.cleanup(); }
});

test('the generated docs say the writer lands and the lead settles disputes', () => {
  const routing = readFileSync(join(PLUGIN_ROOT, 'docs', 'ROUTING.md'), 'utf8');
  assert.match(routing, /The writer lands and verifies its own work/);
  assert.doesNotMatch(routing, /The lead still lands and merges the work/);
  assert.match(routing, /## Self-review \(every writer\)/);
});
