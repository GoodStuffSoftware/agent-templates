// Self-review (operator request 2026-09-28): architect-class writers spawn
// their own reviewer. Covers the four pieces:
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

test('config: selfReview lists the four architect-class types, one fix round, and the REVIEW: lead opt-out', () => {
  const sr = selfReviewConfig(SHIPPED);
  assert.deepEqual(sr.types, ['novel-design', 'large-refactor', 'critical-change', 'long-autonomous-run']);
  assert.equal(sr.fixRounds, 1);
  assert.equal(sr.optOut.line, 'REVIEW: lead');
  assert.equal(sr.updated, '2026-09-28');
  assert.ok(sr.rationale.length > 100);
  // It sits with the task types, so it moves with the table.
  const keys = Object.keys(SHIPPED);
  assert.equal(keys.indexOf('selfReview'), keys.indexOf('taskTypes') + 1);
});

test('committed rungs: ac-opus-xhigh (the default for every selfReview type today) carries the block, and no other rung does', () => {
  for (const rung of SHIPPED.ladder) {
    const block = blockOf(join(PLUGIN_ROOT, 'agents', `${rung.agent}.md`));
    if (rung.agent === 'ac-opus-xhigh') {
      assert.ok(block, 'ac-opus-xhigh carries the protocol');
      assert.match(block, /subagent_type: "agent-companion:ac-opus-xhigh"/);
      assert.match(block, /^ {3}TYPE: code-review$/m);
      assert.match(block, /^ {3}WRITER: opus\/xhigh$/m);
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
  const rung = SHIPPED.ladder.find((r) => r.agent === 'ac-opus-xhigh');
  assert.equal(blockOf(join(PLUGIN_ROOT, 'agents', 'ac-opus-xhigh.md')), selfReviewBlock(rung, selfReviewConfig(SHIPPED)));
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
    const high = join(agentsDir, 'ac-opus-high.md');
    const xOrig = readFileSync(xhigh, 'utf8');
    const hOrig = readFileSync(high, 'utf8');
    const block = readSelfReviewBlock(xOrig).block;
    writeFileSync(xhigh, setSelfReviewBlock(xOrig, null));
    writeFileSync(high, setSelfReviewBlock(hOrig, block));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-xhigh \[self-review-drift\][\s\S]*actual:\s+\(absent\)/);
    assert.match(res.stderr, /ac-opus-high \[self-review-drift\][\s\S]*expected: no self-review protocol block/);
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
    assert.match(res.stderr, /ac-opus-high \[self-review-drift\][\s\S]*novel-design, large-refactor, long-autonomous-run/);

    const syncRes = sync(agentsDir);
    assert.equal(syncRes.status, 0, syncRes.stderr);
    assert.equal(blockOf(join(agentsDir, 'ac-opus-xhigh.md')), null, 'the old rung lost the block');
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
    assert.match(r.msg, /its writer was inferred from the subagent spawning it: "agent-companion:ac-opus-xhigh" pins opus\/xhigh/);
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
      assert.equal(r.row.self_review, true, id);
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
    const helper = h.sub('rev', XHIGH, bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: explore\nfind the call sites' }));
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
    const r = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: explore\nfind it' }), { tool_use_id: 'toolu_E' });
    for (const k of ['tool_use_id', 'parent_agent_id', 'inferred_writer', 'self_review', 'self_review_expected', 'caller_row_found', 'caller_declared_type']) {
      assert.ok(k in r.row, `${k} on the row`);
    }
    assert.equal(r.row.tool_use_id, 'toolu_E');
    assert.equal(r.row.parent_agent_id, null, 'main thread');
    assert.equal(r.row.self_review, false);
    assert.equal(r.row.self_review_expected, null, 'explore is not a selfReview type');
    assert.equal(r.row.caller_row_found, null);
    // No payload id: null, never invented.
    const none = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: explore\nfind it' }));
    assert.equal(none.row.tool_use_id, null);
    const s = h.sub('p1', XHIGH, bg({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: explore\nx' }));
    assert.equal(s.row.parent_agent_id, 'p1');
    assert.equal(s.row.caller_agent_id, 'p1');
  } finally { h.cleanup(); }
});

test('self_review_expected: true on the rung carrying the protocol; false with REVIEW: lead (no note) or on a rung without it (note); null for another agent file', () => {
  const h = harness();
  try {
    const on = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: large-refactor\nsplit the module' }));
    assert.equal(on.row.self_review_expected, true);
    assert.doesNotMatch(on.msg, /self-review\)/);

    const optOut = h.lead(bg({ subagent_type: XHIGH, prompt: 'TYPE: large-refactor\nREVIEW: lead\nsplit the module' }));
    assert.equal(optOut.row.self_review_expected, false);
    assert.doesNotMatch(optOut.msg, /self-review/i, 'an opt-out is deliberate: no note');

    const off = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-high', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - test\ndesign it' }));
    assert.equal(off.row.self_review_expected, false);
    assert.match(off.msg, /agent-companion \(self-review\): TYPE: novel-design is a self-reviewing type, but "agent-companion:ac-opus-high" carries no self-review protocol/);
    assert.match(off.msg, /Spawn agent-companion:ac-opus-xhigh/);

    h.agent('proj-architect', 'model: opus\neffort: xhigh');
    const proj = h.lead(bg({ subagent_type: 'proj-architect', prompt: 'TYPE: novel-design\ndesign it' }));
    assert.equal(proj.row.self_review_expected, null, 'a project agent may carry its own wording');
    assert.doesNotMatch(proj.msg, /self-review\)/);
  } finally { h.cleanup(); }
});

test('no self-review path for a writer type that is not listed; every self-review path either denies or sets no decision (never "allow")', () => {
  const h = harness();
  try {
    const r = h.lead(bg({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: bounded-feature\nadd the flag' }));
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
      h.lead(bg({ subagent_type: 'agent-companion:ac-opus-high', prompt: 'TYPE: novel-design\nWARRANT: weight 5 - t\nbuild' })),
      h.sub('w', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // self-review, inferred
      h.sub('x', 'general-purpose', bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // inference fails
      h.sub('y', 'proj-architect', bg({ subagent_type: XHIGH, prompt: REVIEW(null) })), // project caller
    ];
    for (const o of outs) assert.equal(o.decision, 'proceed', o.reason);
    const denied = h.sub('r', XHIGH, bg({ subagent_type: XHIGH, prompt: REVIEW(null) }));
    assert.equal(denied.decision, 'deny');
  } finally { h.cleanup(); }
});
