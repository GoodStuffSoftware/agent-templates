// "Strange messages from gates" (operator report, 2026-10-02). Four defects:
//   1. SessionStart inside a SUBAGENT (a worker that compacts) got the lead's
//      standing rules, the scout drift block and the capacity line.
//   2. The ladder agents' descriptions list the SHIPPED table's routes while
//      the guards route through the operator's profile: two contradictory lists.
//   3. "under-provisioned - right tier; effort medium is below high" read as a
//      contradiction.
//   4. hooks/subagent-context.mjs (a PreToolUse hook on EVERY tool call of every
//      subagent, 5 s limit) must stay bounded on a transcript of 300K tokens.
// Hermetic: every path is under makeFixture()'s temp home.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { matchRules, renderRules, rulesPath, readRules } from '../hooks/lib/rules.mjs';
import { sessionIsSubagent, evaluateFit, routeLayerTag } from '../hooks/lib/context.mjs';
import { readContextSignal } from '../hooks/lib/subagent-context.mjs';

const LEAD = { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-gm-lead', cwd: 'x' };
const WORKER = { ...LEAD, session_id: 'sess-gm-worker', agent_id: 'worker-gm-1', agent_type: 'general-purpose' };
const SS = ['--event', 'session-start'];

// --- 1. a subagent's SessionStart ---------------------------------------------

test('sessionIsSubagent: agent_id, or a transcript under .../subagents/, is a worker; a lead never is', () => {
  assert.equal(sessionIsSubagent({ agent_id: 'a1' }), true);
  assert.equal(sessionIsSubagent({ session_id: 's', transcript_path: 'C:\\p\\proj\\sess\\subagents\\agent-a1.jsonl' }), true);
  assert.equal(sessionIsSubagent({ session_id: 's', transcript_path: '/p/proj/sess/subagents/agent-a1.jsonl' }), true);
  assert.equal(sessionIsSubagent({ session_id: 's', transcript_path: '/p/proj/sess.jsonl' }), false);
  assert.equal(sessionIsSubagent({ session_id: 's' }), false);
  assert.equal(sessionIsSubagent(null), false);
});

test('standing rules: a compacting subagent gets no orchestration rule, the lead still gets all of them', () => {
  const fx = makeFixture();
  try {
    const lead = runHook('hooks/standing-rules.mjs', LEAD, { args: SS });
    const leadText = lead.json.hookSpecificOutput.additionalContext;
    assert.match(leadText, /You are an orchestrator/);
    assert.match(leadText, /Continue a worker only while its cache is warm \(under 5 minutes\) and the follow-on is short \(about 10 calls or fewer\)\. Otherwise spawn fresh with a short handoff/);
    assert.match(leadText, /One completion wait/);

    const worker = runHook('hooks/standing-rules.mjs', WORKER, { args: SS });
    assert.equal(worker.status, 0);
    assert.equal(worker.stdout.trim(), '', 'nothing a worker can act on: silent');

    // The same, recognised by the transcript path alone.
    const byPath = runHook('hooks/standing-rules.mjs', {
      ...LEAD, transcript_path: join(fx.dir, 'projects', 'p', 'sess-gm-lead', 'subagents', 'agent-worker-gm-1.jsonl'),
    }, { args: SS });
    assert.equal(byPath.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('standing rules: the lead-effort-check ask (AskUserQuestion) never reaches a worker, even enabled; an operator rule does', () => {
  const fx = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 'lead-effort-check', enabled: true },
      { id: 'house-style', scope: 'session-start', then: 'Write no emojis.' },
      { id: 'lead-only-house', scope: 'session-start', audience: 'lead', then: 'Orchestrators only.' },
    ]));
    const lead = runHook('hooks/standing-rules.mjs', LEAD, { args: SS }).json.hookSpecificOutput.additionalContext;
    assert.match(lead, /AskUserQuestion/);
    assert.match(lead, /Write no emojis\./);
    assert.match(lead, /Orchestrators only\./);

    const worker = runHook('hooks/standing-rules.mjs', WORKER, { args: SS }).json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(worker, /AskUserQuestion|orchestrator|Resume only|completion wait|Orchestrators only/);
    assert.match(worker, /Write no emojis\./, 'the operator\'s own rule reaches a worker');

    const direct = renderRules(matchRules({ scope: 'session-start', subagent: true }));
    assert.equal(direct, worker.slice(0, direct.length));
    assert.equal(readRules().rules.find((r) => r.id === 'delegate-first').audience, 'lead');
    assert.equal(readRules().rules.find((r) => r.id === 'house-style').audience, 'all');
  } finally { fx.cleanup(); }
});

test('scout block and capacity line: the lead gets them, a compacting subagent gets neither', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'state', 'scout-latest.json'), JSON.stringify({
      checkedAt: new Date().toISOString(),
      signals: [{ kind: 'spawn_activity', detail: '12 spawns in 24h', dispatch: 'none' }],
    }));
    const opts = { cwd: fx.dir };
    const leadScout = runHook('hooks/scout-surface.mjs', LEAD, opts);
    assert.match(leadScout.json.hookSpecificOutput.additionalContext, /spawn_activity/);
    assert.equal(runHook('hooks/scout-surface.mjs', WORKER, opts).stdout.trim(), '');

    const leadCap = runHook('hooks/capacity-probe.mjs', LEAD, opts);
    assert.match(leadCap.json.hookSpecificOutput.additionalContext, /capacity:/);
    assert.equal(runHook('hooks/capacity-probe.mjs', WORKER, opts).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

// --- 2. one list of rungs, with its source --------------------------------------

const ISO_DAY = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
function writeProfile(fx, rows) {
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  const row = (model, effort) => ({
    state: 'trial', model, effort, cacheTtl: null, source: 'operator-observed', since: ISO_DAY(-1), reviewBy: ISO_DAY(80),
    waivesFloor: null, note: null, provenance: null,
  });
  writeFileSync(join(fx.stateDir, 'config', 'routing-profile.json'), JSON.stringify({
    schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 3,
    basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null,
    types: {}, rows: Object.fromEntries(Object.entries(rows).map(([t, [m, e]]) => [t, row(m, e)])),
  }));
}
const guardPayload = (fx, n) => ({
  session_id: 'sess-gm-guard', transcript_path: join(fx.dir, 'projects', 'repo', 'sess-gm-guard.jsonl'), cwd: fx.dir,
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `toolu_${n}`, effort: { level: 'xhigh' },
});
function guardText(fx) {
  const env = {
    CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'block', CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2',
  };
  runHook('hooks/delegation-guard.mjs', guardPayload(fx, 1), { env });
  const r = runHook('hooks/delegation-guard.mjs', guardPayload(fx, 2), { env });
  return r.json?.hookSpecificOutput?.permissionDecisionReason || '';
}

test('delegation guard: a type the routing profile moved is listed apart and says so; the shipped route says nothing', () => {
  const fx = makeFixture();
  try {
    const shipped = guardText(fx);
    assert.match(shipped, /Rungs now: /);
    assert.doesNotMatch(shipped, /your routing profile/, 'no profile: nothing to attribute');
  } finally { fx.cleanup(); }
  const fx2 = makeFixture();
  try {
    writeProfile(fx2, { 'bounded-feature': ['sonnet', 'high'] });
    const text = guardText(fx2);
    const line = /Rungs now: (.*?)\. Other types/s.exec(text)?.[1] || '';
    assert.match(line, /agent-companion:ac-sonnet-high for bounded-feature \(your routing profile\)/, line);
    assert.doesNotMatch(line, /ac-opus-medium for[^;]*bounded-feature/, 'the base-table rung is not claimed for it');
  } finally { fx2.cleanup(); }
});

test('routeLayerTag names the profile, and nothing for the shipped grid or trial (the agent descriptions include both)', () => {
  assert.equal(routeLayerTag('profile'), ' (your routing profile)');
  assert.equal(routeLayerTag('trial'), '');
  assert.equal(routeLayerTag('grid'), '');
  assert.equal(routeLayerTag(undefined), '');
});

test('every ladder agent description that claims a base default says the routing profile may differ', () => {
  const fx = makeFixture();
  try {
    let claims = 0;
    for (const f of ['ac-haiku', 'ac-sonnet-low', 'ac-sonnet-medium', 'ac-sonnet-high', 'ac-sonnet-xhigh', 'ac-opus-low', 'ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh', 'ac-opus-max']) {
      const desc = readFileSync(join(PLUGIN_ROOT, 'agents', `${f}.md`), 'utf8').match(/^description:\s*"?(.*?)"?$/m)[1];
      // A rung no task type routes to by default makes no claim and carries no caveat (0.31.9).
      if (/[Bb]ase default/.test(desc)) {
        claims += 1;
        assert.match(desc, /profile may differ/, f);
      }
      assert.doesNotMatch(desc, /Currently the default routing/, f);
    }
    assert.ok(claims >= 4, `${claims} rungs claim a base default`);
  } finally { fx.cleanup(); }
});

// --- 3. fit wording -------------------------------------------------------------

test('right model, effort too low: said as that, not as "under-provisioned - right tier"', () => {
  const fx = makeFixture();
  try {
    const fit = evaluateFit({ model: 'opus', effort: 'medium', expected: { model: 'opus', effort: 'high' } });
    assert.equal(fit.verdict, 'under');
    assert.equal(fit.reason, 'right model, effort too low: medium where the table says high');
    assert.doesNotMatch(fit.reason, /right tier/);
    // A wrong model keeps its own wording; a matching pair is still a fit.
    assert.match(evaluateFit({ model: 'sonnet', effort: 'high', expected: { model: 'opus', effort: 'high' } }).reason, /tier\(s\) below/);
    assert.equal(evaluateFit({ model: 'opus', effort: 'high', expected: { model: 'opus', effort: 'high' } }).verdict, 'fit');
  } finally { fx.cleanup(); }
});

// --- 4. subagent-context.mjs stays bounded ----------------------------------------

test('subagent-context.mjs on a ~300K-token, ~64 MB subagent transcript: tail-bounded, well under its 5 s limit', () => {
  const fx = makeFixture();
  try {
    const SID = 'sess-gm-big';
    const AGENT = 'worker-big-1';
    const proj = join(fx.dir, 'projects', 'proj-big');
    const sub = join(proj, SID, 'subagents');
    mkdirSync(sub, { recursive: true });
    const lead = join(proj, `${SID}.jsonl`);
    writeFileSync(lead, '');
    const file = join(sub, `agent-${AGENT}.jsonl`);
    const turn = (i, ctx) => `${JSON.stringify({
      type: 'assistant', requestId: `r${i}`,
      message: { id: `m${i}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'y'.repeat(2000) }], usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
    })}\n`;
    const result = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(30000) } })}\n`;
    writeFileSync(file, '');
    let size = 0;
    let chunk = '';
    for (let i = 0; size < 64 * 1024 * 1024; i += 1) {
      const piece = turn(i, 40000 + Math.floor(i * 140)) + result; // climbs to ~300K by the end
      chunk += piece; size += piece.length;
      if (chunk.length > 4 * 1024 * 1024) { appendFileSync(file, chunk); chunk = ''; }
    }
    appendFileSync(file, chunk + turn('last', 310000));

    const t0 = Date.now();
    const sig = readContextSignal(file);
    const readMs = Date.now() - t0;
    assert.equal(sig.ctx, 310000);
    assert.equal(sig.partial, true, 'only the tail was read');
    assert.ok(readMs < 500, `readContextSignal took ${readMs} ms on a ${Math.round(size / 1048576)} MB file`);

    const payload = {
      hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
      agent_id: AGENT, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1',
    };
    const t1 = Date.now();
    const r = runHook('hooks/subagent-context.mjs', payload, { env: { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' } });
    const hookMs = Date.now() - t1;
    assert.equal(r.status, 0);
    assert.match(r.json.hookSpecificOutput.additionalContext, /past 300,000 tokens/);
    assert.ok(hookMs < 2500, `the hook took ${hookMs} ms (limit 5000) on a ${Math.round(size / 1048576)} MB transcript`);

    // The steady state, which is nearly every call: nothing to say.
    const t2 = Date.now();
    const quiet = runHook('hooks/subagent-context.mjs', payload, { env: { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' } });
    const quietMs = Date.now() - t2;
    assert.equal(quiet.stdout.trim(), '');
    assert.ok(quietMs < 2500, `the quiet path took ${quietMs} ms`);
  } finally { fx.cleanup(); }
});
