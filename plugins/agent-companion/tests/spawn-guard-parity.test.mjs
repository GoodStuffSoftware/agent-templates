// Spawn-guard parity track (0.29.19): the WRITER line, reviewer parity at
// spawn time, the writer-less code-review message, the premium cap's
// routing-choice exemptions and its rewritten deny text, `routed` on every
// spawns.jsonl row, and the inherit_guard option.
//
// Parity is judged in NOTES only in this release: a reviewer below, above or
// beside its writer is never denied on parity grounds, and a reviewer on its
// writer's model is route-exempt for the WARRANT and the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT, decisionOf } from './helpers.mjs';
import { writerFromDeclaration } from '../hooks/lib/context.mjs';

function harness(extraEnv = {}) {
  const fx = makeFixture();
  const env = {
    CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '2',
    ...extraEnv,
  };
  let n = 0;
  const spawn = (toolInput, { sid = 'sess-parity', transcript = null, cwd = fx.dir } = {}) => {
    n += 1;
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd,
      ...(transcript ? { transcript_path: transcript } : {}),
      tool_input: { run_in_background: true, name: `w${n}`, isolation: 'worktree', ...toolInput },
    }, { env });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
    return {
      decision: decisionOf(res.json),
      reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '',
      msg: res.json?.systemMessage || '',
      updated: res.json?.hookSpecificOutput?.updatedInput || null,
      row: rows[rows.length - 1] || null,
    };
  };
  const window = () => {
    try { return JSON.parse(readFileSync(join(fx.stateDir, 'state', 'premium-window.json'), 'utf8')).length; } catch { return 0; }
  };
  const denials = () => readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl')).map((d) => d.guard);
  const agent = (name, fm) => {
    mkdirSync(join(fx.dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'agents', `${name}.md`), `---\nname: ${name}\n${fm}\n---\nbody\n`);
  };
  const lead = (model, effort) => {
    const p = join(fx.dir, `lead-${model}-${effort}.jsonl`);
    writeFileSync(p, `${JSON.stringify({
      type: 'assistant', effort, timestamp: '2026-09-27T10:00:00.000Z',
      message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
    })}\n`);
    return p;
  };
  return { ...fx, env, spawn, window, denials, agent, lead };
}

const REVIEW = (writer) => `TYPE: code-review\n${writer ? `WRITER: ${writer}\n` : ''}review the diff`;

// --- 1. WRITER parsing ------------------------------------------------------

test('WRITER: <model>/<effort>, <agent-name> (bare, namespaced, project) and a bare model all resolve', () => {
  const h = harness();
  try {
    h.agent('rev-writer', 'model: opus\neffort: high');
    const ok = (v) => { const r = writerFromDeclaration(v, h.dir); assert.equal(r.ok, true, `${v}: ${r.reason}`); return r; };
    assert.equal(ok('opus/xhigh').label, 'opus/xhigh');
    assert.equal(ok('Sonnet/HIGH').label, 'sonnet/high');
    assert.equal(ok('ac-opus-xhigh').label, 'opus/xhigh');
    assert.equal(ok('agent-companion:ac-opus-xhigh').label, 'opus/xhigh');
    const proj = ok('rev-writer');
    assert.equal(proj.label, 'opus/high');
    assert.equal(proj.via, 'agent');
    assert.equal(ok('haiku').label, 'haiku');
    for (const bad of ['gpt/high', 'no-such-agent', 'my-opus-helper', 'my-opus-helper/high', 'the opus agent', '']) {
      assert.equal(writerFromDeclaration(bad, h.dir).ok, false, bad);
    }
  } finally { h.cleanup(); }
});

test('WRITER forms: space, "at", "@" and a version all read the effort; the model must BE an alias token', () => {
  const h = harness();
  try {
    const read = (v) => writerFromDeclaration(v, h.dir);
    for (const v of ['opus/xhigh', 'opus xhigh', 'opus at xhigh', 'Opus 5.5 xhigh', 'Claude Opus 5.5 at xhigh',
      'opus @ xhigh', 'claude-opus-5-5/xhigh', 'opus-5.5 xhigh', '**`opus/xhigh`**', 'opus xhigh (the lead)']) {
      const r = read(v);
      assert.equal(r.ok, true, `${v}: ${r.reason}`);
      assert.equal(r.label, 'opus/xhigh', v);
      assert.equal(r.effortIssue, null, v);
    }
    // A recognised model with a word that is not an effort level: the model
    // is kept, the effort is reported as not understood (never dropped
    // silently, and never a reason to discard the model).
    const turbo = read('opus/turbo');
    assert.equal(turbo.ok, true);
    assert.equal(turbo.label, 'opus');
    assert.equal(turbo.effortIssue, 'not-understood');
    assert.equal(turbo.effortToken, 'turbo');
    assert.equal(read('opus').effortIssue, 'none');
    assert.equal(read('haiku').effortIssue, null, 'haiku takes no effort, so none is missing');
    // Substring is not a match: my-opus-helper is an agent name, and when it
    // exists it is read through its own definition, never as opus.
    h.agent('my-opus-helper', 'model: sonnet\neffort: high');
    const helper = read('my-opus-helper/high');
    assert.equal(helper.ok, true);
    assert.equal(helper.via, 'agent');
    assert.equal(helper.label, 'sonnet/high');
    // An agent with no effort in its definition: an effort after its name
    // counts; with none, the gap is reported.
    h.agent('no-effort-writer', 'model: opus');
    assert.equal(read('no-effort-writer/xhigh').label, 'opus/xhigh');
    assert.equal(read('no-effort-writer').effortIssue, 'agent-none');
    // A pinned effort in the definition wins over one on the line.
    assert.equal(read('ac-opus-medium/xhigh').label, 'opus/medium');
  } finally { h.cleanup(); }
});

test('WRITER: opus xhigh (space-separated) sizes the review like opus/xhigh: the below note fires', () => {
  const h = harness();
  try {
    for (const w of ['opus xhigh', 'Opus 5.5 at xhigh']) {
      const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW(w) });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.equal(r.row.declared_writer, 'opus/xhigh', w);
      assert.equal(r.row.fit, 'under', w);
      assert.match(r.msg, /It is BELOW its writer, opus\/xhigh — effort low is below xhigh/, w);
      assert.doesNotMatch(r.msg, /WRITER effort not understood|names no effort/, w);
    }
  } finally { h.cleanup(); }
});

test('a WRITER effort that is not understood, or missing, is said out loud; the model half is still checked', () => {
  const h = harness();
  try {
    let r = h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW('opus extreme') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.row.declared_writer, 'opus');
    assert.match(r.msg, /WRITER effort not understood — in "opus extreme", "extreme" is not an effort level/);
    assert.match(r.msg, /parity is checked on the model alone/);
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW('opus') });
    assert.match(r.msg, /the WRITER line \("opus"\) names no effort, so only the model half of reviewer parity is checked/);
    assert.match(r.msg, /WRITER: opus\/<effort>/);
    h.agent('no-effort-writer', 'model: opus');
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: REVIEW('no-effort-writer') });
    assert.match(r.msg, /WRITER agent "no-effort-writer" states no effort in its definition/);
    // The model half still judges: a sonnet reviewer is below an opus writer.
    r = h.spawn({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW('opus extreme') });
    assert.equal(r.row.fit, 'under');
    assert.match(r.msg, /BELOW its writer, opus — sonnet is 1 tier\(s\) below opus/);
  } finally { h.cleanup(); }
});

test('a prose "Writer:" line on a review never moves the model: no autofill from a line only partly read', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: code-review\nWriter: haiku did the mechanical part\nreview it' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.updated?.model, undefined, 'no model filled in from a partly-read WRITER line');
    assert.equal(r.row.model_autofilled, false);
    assert.match(r.msg, /WRITER effort not understood/);
    assert.match(r.msg, /was only partly understood, so the guard did not fill the model in from it/);
    // A clean line still autofills.
    const clean = h.spawn({ subagent_type: 'general-purpose', prompt: REVIEW('haiku') });
    assert.equal(clean.updated?.model, 'haiku');
  } finally { h.cleanup(); }
});

test('WRITER is read only on a parity-sized TYPE: elsewhere it is ignored in silence, and never routes', () => {
  const h = harness();
  try {
    let r = h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: mechanical-edit\nWriter: keep the tone plain\nedit it' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.doesNotMatch(r.msg, /WRITER/);
    assert.equal(r.row.declared_writer, null);
    // A model-shaped WRITER on a non-review brief is not a route either: the
    // autofill comes from the type's own route.
    r = h.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: mechanical-edit\nWRITER: haiku\nedit it' });
    assert.equal(r.row.declared_writer, null);
    assert.notEqual(r.updated?.model, 'haiku');
    assert.doesNotMatch(r.msg, /WRITER/);
  } finally { h.cleanup(); }
});

test('the first WRITER line wins, a list-marked bold one counts, and a fenced one is not a declaration', () => {
  const h = harness();
  try {
    let r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: 'TYPE: code-review\nWRITER: sonnet/high\nWRITER: opus/xhigh\nreview' });
    assert.equal(r.row.declared_writer, 'sonnet/high');
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: 'TYPE: code-review\n- **WRITER:** `opus/xhigh`\nreview' });
    assert.equal(r.row.declared_writer, 'opus/xhigh');
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: 'TYPE: code-review\n```\nWRITER: opus/xhigh\n```\nreview' });
    assert.equal(r.row.declared_writer, null);
  } finally { h.cleanup(); }
});

test('an unparseable WRITER line is ignored, and the note says so; the spawn is not denied', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: 'TYPE: code-review\nWRITER: the refactor agent\nreview' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /the WRITER line \("the refactor agent"\) was ignored/);
    assert.match(r.msg, /WRITER: <model>\/<effort>/);
    assert.equal(r.row.declared_writer, null);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

// --- 2. Reviewer parity at spawn time ---------------------------------------

test('(i) TYPE: code-review + WRITER: opus/xhigh on ac-opus-medium: a below-writer note naming both tiers and the rung, no deny', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: REVIEW('opus/xhigh') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /reviewer parity/);
    assert.match(r.msg, /reviews at opus\/medium for a writer at opus\/xhigh/);
    assert.match(r.msg, /BELOW its writer/);
    assert.match(r.msg, /spawn agent-companion:ac-opus-xhigh \(opus\/xhigh\) instead/);
    assert.doesNotMatch(r.msg, /no TYPE or WEIGHT/);
    assert.equal(r.row.fit, 'under');
    assert.equal(r.row.fit_expected, 'opus/xhigh');
    assert.equal(r.row.routed, true);
    assert.equal(h.window(), 0, 'a reviewer on its writer\'s model is not counted');
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('(ii) TYPE: code-review + WRITER: opus/xhigh on ac-opus-xhigh: no parity note, not counted by the cap', () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: REVIEW('opus/xhigh') });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.doesNotMatch(r.msg, /reviewer parity|Premium warrant|no WARRANT line/);
      assert.equal(r.row.fit, 'fit');
      assert.equal(r.row.routed, true);
    }
    assert.equal(h.window(), 0);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('WRITER: <agent-name> sizes the reviewer from that agent\'s own definition', () => {
  const h = harness();
  try {
    h.agent('rev-writer', 'model: opus\neffort: high');
    let r = h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: REVIEW('rev-writer') });
    assert.match(r.msg, /for a writer at opus\/high \("rev-writer"\)/);
    assert.match(r.msg, /agent-companion:ac-opus-high/);
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: REVIEW('agent-companion:ac-opus-xhigh') });
    assert.equal(r.row.declared_writer, 'opus/xhigh');
    assert.match(r.msg, /BELOW its writer/);
  } finally { h.cleanup(); }
});

test('trap: a general-purpose opus reviewer with no WARRANT whose model matches its writer is not denied (warrant, fit or cap)', () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW('opus/xhigh') });
      assert.equal(r.decision, 'proceed', r.reason);
      // Effort is inherited on a built-in type: parity cannot be verified.
      assert.match(r.msg, /states no effort, so it runs at the session's effort/);
      assert.match(r.msg, /spawn agent-companion:ac-opus-xhigh to pin opus\/xhigh/);
      assert.doesNotMatch(r.msg, /SPAWNING RULE 1/, 'the parity note replaces the generic no-effort note');
      assert.equal(r.row.routed, true);
    }
    assert.equal(h.window(), 0);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('a reviewer ABOVE its writer gets a note, not a deny, even as a premium tier with no WARRANT', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-high', prompt: REVIEW('sonnet/high') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /Its model is ABOVE its writer, sonnet\/high/);
    assert.match(r.msg, /spawn agent-companion:ac-sonnet-high \(sonnet\/high\) instead/);
    assert.match(r.msg, /premium tier its parity route \(sonnet\/high\) does not name/);
    assert.doesNotMatch(r.msg, /no TYPE or WEIGHT/);
    assert.equal(r.row.fit, 'over');
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('the above-writer note claims a cap count only when the cap counts the spawn (one shared predicate)', () => {
  const h = harness();
  try {
    // An opus rung above its writer is exempt from the cap: no claim, no count.
    for (let i = 0; i < 4; i += 1) {
      const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-xhigh', prompt: REVIEW('sonnet/high') });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.match(r.msg, /ABOVE its writer/);
      assert.doesNotMatch(r.msg, /counts toward the premium cap/);
    }
    assert.equal(h.window(), 0);
    // A built-in type given opus per spawn IS counted, and the note says so.
    const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW('sonnet/high') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /counts toward the premium cap/);
    assert.equal(h.window(), 1);
  } finally { h.cleanup(); }
  // premium_cap off: nothing is counted, so nothing is claimed.
  const off = harness({ CLAUDE_PLUGIN_OPTION_PREMIUM_CAP: 'false' });
  try {
    const r = off.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW('sonnet/high') });
    assert.doesNotMatch(r.msg, /counts toward the premium cap/);
  } finally { off.cleanup(); }
});

test('a reviewer below its writer\'s MODEL gets the below note with the rung to use', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW('opus/xhigh') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /BELOW its writer, opus\/xhigh — sonnet is 1 tier\(s\) below opus\./);
    assert.match(r.msg, /A reviewer below its writer waves through the errors the writer would make/);
    assert.match(r.msg, /agent-companion:ac-opus-xhigh/);
    assert.equal(r.row.fit, 'under');
  } finally { h.cleanup(); }
});

test('a critical review is floored by F1 even when the writer is sonnet; the note names the floor, not the writer', () => {
  const h = harness();
  try {
    // The reviewer equals its writer; it is below the F1 floor, not below its writer.
    let r = h.spawn({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: 'TYPE: code-review\nCONSEQUENCE: critical\nWRITER: sonnet/high\nreview' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /the parity route is opus\/xhigh \(the writer's sonnet\/high, after floor F1: a critical review is at least opus\/xhigh\)/);
    assert.match(r.msg, /It is BELOW the F1 floor for critical reviews, opus\/xhigh — sonnet is 1 tier\(s\) below opus/);
    assert.match(r.msg, /A critical review is never sized below opus\/xhigh, whatever its writer/);
    assert.doesNotMatch(r.msg, /BELOW its writer/);
    assert.equal(r.row.fit_expected, 'opus/xhigh');
    // Effort above the writer's, below F1's: the floor's effort is named, not the writer's.
    r = h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'TYPE: code-review\nCONSEQUENCE: critical\nWRITER: opus/low\nreview' });
    assert.match(r.msg, /It is BELOW the F1 floor for critical reviews, opus\/xhigh — effort medium is below xhigh/);
    assert.doesNotMatch(r.msg, /below the writer's/);
  } finally { h.cleanup(); }
});

test('a fable reviewer of a fable writer with a WARRANT is noted, not fit-denied; without one the warrant still denies', () => {
  const h = harness();
  try {
    let r = h.spawn({ subagent_type: 'general-purpose', model: 'fable', prompt: `${REVIEW('fable/high')}\nWARRANT: weight 5 — reviewing a fable writer` });
    assert.equal(r.decision, 'proceed', r.reason);
    // The reviewer IS on its writer's model; F2 capped the route to opus.
    assert.match(r.msg, /Its model is ABOVE its parity route, opus\/high/);
    assert.doesNotMatch(r.msg, /ABOVE (the|its) writer/);
    assert.match(r.msg, /the parity route is opus\/high \(the writer's fable\/high, after floor F2: fable is never a routing destination\)/);
    assert.match(r.msg, /counts toward the premium cap/);
    assert.equal(r.row.routed, false, 'nothing routes to fable');
    assert.equal(h.window(), 1, 'fable is always counted');
    r = h.spawn({ subagent_type: 'general-purpose', model: 'fable', prompt: REVIEW('fable/high') });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Premium warrant/);
  } finally { h.cleanup(); }
});

test('a writer-sized review naming no model is autofilled to the parity route', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'general-purpose', prompt: REVIEW('opus/xhigh') });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.equal(r.updated?.model, 'opus');
    assert.match(r.msg, /from the routing table for TYPE code-review sized to its writer opus\/xhigh \(opus\/xhigh\)/);
    assert.equal(r.row.model_autofilled, true);
    assert.equal(r.row.routed, true);
  } finally { h.cleanup(); }
});

// --- 3. TYPE: code-review with no WRITER --------------------------------------

test('(iii) TYPE: code-review with no WRITER: the new message, never "no TYPE or WEIGHT"', () => {
  const h = harness();
  try {
    let r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW(null) });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /TYPE: code-review is sized from its writer/);
    assert.match(r.msg, /WRITER: <model>\/<effort>/);
    assert.match(r.msg, /WRITER: <agent-name>/);
    assert.doesNotMatch(r.msg, /no TYPE or WEIGHT/);
    // A cheap reviewer gets the same pointer, as a note.
    r = h.spawn({ subagent_type: 'agent-companion:ac-sonnet-high', prompt: REVIEW(null) });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /TYPE: code-review is sized from its writer/);
    assert.doesNotMatch(r.msg, /no TYPE or WEIGHT/);
  } finally { h.cleanup(); }
});

test('a writer-less review whose only weight is its WARRANT\'s is not fit-denied against the grid (0.29.18 denied it with an empty route)', () => {
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: code-review\nWARRANT: weight 2 — deep review\nreview' });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /TYPE: code-review is sized from its writer/);
    assert.equal(r.row.fit, null);
    assert.deepEqual(h.denials(), []);
    // A real WEIGHT: line is a deliberate departure, and is still judged.
    const w = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: code-review\nWEIGHT: 2\nreview' });
    assert.equal(w.decision, 'deny');
    assert.match(w.reason, /Best fit/);
  } finally { h.cleanup(); }
});

// --- 4. Premium fan-out cap -------------------------------------------------

test('(iv) three ac-opus-medium spawns with NO TYPE line in 10 minutes: none denied by the cap', () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: 'do the change' });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.equal(r.row.routed, true);
    }
    assert.equal(h.window(), 0);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('a project agent whose definition pins opus is not counted, TYPE line or not', () => {
  const h = harness();
  try {
    h.agent('proj-architect', 'model: opus\neffort: xhigh');
    for (let i = 0; i < 3; i += 1) assert.equal(h.spawn({ subagent_type: 'proj-architect', prompt: 'design it' }).decision, 'proceed');
    assert.equal(h.window(), 0);
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('a reviewer matching its writer is exempt from the cap even with no route (fit_guard off)', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_FIT_GUARD: 'false' });
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: `${REVIEW('opus/xhigh')}\nWARRANT: weight 4 — review` });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.equal(r.row.routed, true);
    }
    assert.equal(h.window(), 0);
  } finally { h.cleanup(); }
});

test('(v) three general-purpose opus spawns with no TYPE: the third is denied, with the routing advice and no "run at sonnet"', () => {
  const h = harness();
  try {
    assert.equal(h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'do it' }).decision, 'proceed');
    assert.equal(h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'do it' }).decision, 'proceed');
    const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'do it' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Premium fan-out cap: 2 premium-tier agents/);
    assert.match(r.reason, /TYPE: <task type>/);
    assert.match(r.reason, /explore -> opus\/low \(agent-companion:ac-opus-low\)/);
    assert.match(r.reason, /debug-root-cause -> opus\/medium/);
    assert.match(r.reason, /agent-companion:ac-opus-medium/);
    assert.match(r.reason, /wait for the in-flight premium agents/);
    assert.doesNotMatch(r.reason, /sonnet/i);
    assert.equal(r.row.routed, false);
    assert.deepEqual(h.denials(), ['premium-cap']);
  } finally { h.cleanup(); }
});

test('(vi) fable is still capped, and its deny says it cannot be routed around', () => {
  const h = harness();
  try {
    // A WARRANT with no weight: a stated weight would route (to opus) and the
    // fit check would deny fable before the cap is reached.
    const f = () => h.spawn({ subagent_type: 'general-purpose', model: 'fable', prompt: 'WARRANT: frontier problem, opus fell short\ndo it' });
    assert.equal(f().decision, 'proceed');
    assert.equal(f().decision, 'proceed');
    const r = f();
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Premium fan-out cap/);
    assert.match(r.reason, /Fable is never a routing destination/);
    assert.deepEqual(h.denials(), ['premium-cap']);
  } finally { h.cleanup(); }
});

test('a writer-less opus review counts, and its cap deny asks for the WRITER line', () => {
  const h = harness();
  try {
    h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW(null) });
    h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW(null) });
    const r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: REVIEW(null) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /TYPE: code-review is sized from its writer/);
    assert.match(r.reason, /WRITER: <model>\/<effort>/);
  } finally { h.cleanup(); }
});

// --- 5. `routed` on every row -----------------------------------------------

test('(viii) routed is on every row and true only for a routing choice', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_PREMIUM_CAP: 'false' });
  try {
    h.agent('proj-sonnet', 'model: sonnet\neffort: high');
    const cases = [
      [{ subagent_type: 'agent-companion:ac-opus-low', prompt: 'x' }, true, 'ladder rung, no TYPE'],
      [{ subagent_type: 'proj-sonnet', prompt: 'x' }, true, 'project agent pin'],
      [{ subagent_type: 'proj-sonnet', model: 'opus', prompt: 'x' }, false, 'pin overridden per-spawn, no route'],
      [{ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: integration\nx' }, true, 'route names the model'],
      [{ subagent_type: 'general-purpose', prompt: 'TYPE: integration\nx' }, true, 'autofilled from the route'],
      [{ subagent_type: 'general-purpose', model: 'opus', prompt: 'x' }, false, 'per-spawn opus, no TYPE'],
      [{ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'TYPE: integration\nx' }, false, 'per-spawn model the route does not name'],
      [{ subagent_type: 'general-purpose', prompt: 'x' }, false, 'inherited'],
      [{ subagent_type: 'Explore', prompt: 'x' }, false, 'inherited, built-in type'],
    ];
    for (const [input, want, label] of cases) {
      const r = h.spawn(input);
      assert.ok(r.row && Object.prototype.hasOwnProperty.call(r.row, 'routed'), `${label}: no routed field`);
      assert.equal(r.row.routed, want, label);
    }
  } finally { h.cleanup(); }
});

// --- 6. inherit_guard ---------------------------------------------------------

test('(vii) inherit_guard block denies model+effort inherited from an opus lead with no TYPE; warn does not', () => {
  const warn = harness();
  try {
    const t = warn.lead('claude-opus-5-5', 'xhigh');
    const r = warn.spawn({ subagent_type: 'general-purpose', prompt: 'look around' }, { transcript: t });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.match(r.msg, /SPAWNING RULE 1/);
    assert.match(r.msg, /names no model, and its definition/);
    assert.match(r.msg, /inherit the lead's model AND effort \(opus\/xhigh now\)/);
    assert.match(r.msg, /TYPE: <task type>/);
    assert.deepEqual(warn.denials(), []);
  } finally { warn.cleanup(); }

  const block = harness({ CLAUDE_PLUGIN_OPTION_INHERIT_GUARD: 'block' });
  try {
    const t = block.lead('claude-opus-5-5', 'xhigh');
    let r = block.spawn({ subagent_type: 'general-purpose', prompt: 'look around' }, { transcript: t });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Inherit guard/);
    assert.match(r.reason, /opus\/xhigh/);
    assert.match(r.reason, /TYPE: <task type>/);
    assert.match(r.reason, /agent-companion:ac-opus-low/);
    assert.deepEqual(block.denials(), ['inherit']);
    // Explore names no model either.
    r = block.spawn({ subagent_type: 'Explore', prompt: 'find it' }, { transcript: t });
    assert.equal(r.decision, 'deny');
    // What the deny asks for lifts it.
    r = block.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: explore\nlook around' }, { transcript: t });
    assert.equal(r.decision, 'proceed', r.reason);
    r = block.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'look around' }, { transcript: t });
    assert.equal(r.decision, 'proceed', r.reason);
    // A model on the spawn is not the both-inherited shape.
    r = block.spawn({ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'look around' }, { transcript: t });
    assert.equal(r.decision, 'proceed', r.reason);
  } finally { block.cleanup(); }
});

test('inherit_guard block never fires for a sonnet lead, or when the lead cannot be read', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_INHERIT_GUARD: 'block' });
  try {
    const t = h.lead('claude-sonnet-5', 'high');
    assert.equal(h.spawn({ subagent_type: 'general-purpose', prompt: 'x' }, { transcript: t }).decision, 'proceed');
    assert.equal(h.spawn({ subagent_type: 'general-purpose', prompt: 'x' }).decision, 'proceed');
    assert.deepEqual(h.denials(), []);
  } finally { h.cleanup(); }
});

test('inherit_guard block: an unknown TYPE does not lift it, any premium lead triggers it, a known TYPE or WEIGHT lifts it', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_INHERIT_GUARD: 'block' });
  try {
    const opus = h.lead('claude-opus-5-5', 'xhigh');
    let r = h.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: frobnicate\nlook around' }, { transcript: opus });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /TYPE: frobnicate is not a task type the table knows, so it routes nothing/);
    // mythos is a premium tier in the table: blocked like opus and fable.
    const mythos = h.lead('claude-mythos-1', 'high');
    r = h.spawn({ subagent_type: 'general-purpose', prompt: 'look around' }, { transcript: mythos });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Inherit guard/);
    // A lead model the table cannot classify is never blocked (fail open).
    const odd = h.lead('some-unlisted-model', 'high');
    assert.equal(h.spawn({ subagent_type: 'general-purpose', prompt: 'look around' }, { transcript: odd }).decision, 'proceed');
    // A known TYPE lifts it, even one that routes only with a writer; so does a WEIGHT.
    assert.equal(h.spawn({ subagent_type: 'Explore', prompt: 'TYPE: code-review\nreview it' }, { transcript: opus }).decision, 'proceed');
    assert.equal(h.spawn({ subagent_type: 'Explore', prompt: 'WEIGHT: 2\nfind it' }, { transcript: opus }).decision, 'proceed');
    assert.deepEqual(h.denials(), ['inherit', 'inherit']);
  } finally { h.cleanup(); }
});

test('the missing-model note names the real reason no route set the model', () => {
  const off = harness({ CLAUDE_PLUGIN_OPTION_FIT_GUARD: 'false' });
  try {
    const r = off.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: explore\nlook around' });
    assert.match(r.msg, /TYPE: explore did not route it because fit_guard is off/);
    assert.doesNotMatch(r.msg, /not a (known )?task type|fit_autofill/);
  } finally { off.cleanup(); }
  const noFill = harness({ CLAUDE_PLUGIN_OPTION_FIT_AUTOFILL: 'false' });
  try {
    const r = noFill.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: explore\nlook around' });
    assert.match(r.msg, /the routing table sends this to opus\/low, but fit_autofill is off/);
    assert.doesNotMatch(r.msg, /not a (known )?task type|fit_guard/);
  } finally { noFill.cleanup(); }
  const h = harness();
  try {
    const r = h.spawn({ subagent_type: 'general-purpose', prompt: 'TYPE: frobnicate\nlook around' });
    assert.match(r.msg, /TYPE: frobnicate is not a task type the table knows/);
    assert.doesNotMatch(r.msg, /fit_autofill|fit_guard/);
  } finally { h.cleanup(); }
});

test('routed and the reviewer cap exemption compare the reviewer with the FLOORED parity route', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_PREMIUM_CAP: 'false' });
  try {
    // A sonnet reviewer of a sonnet writer is below its F1 route (opus/xhigh): not routed.
    let r = h.spawn({ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'TYPE: code-review\nCONSEQUENCE: critical\nWRITER: sonnet/high\nreview' });
    assert.equal(r.row.fit, 'under');
    assert.equal(r.row.routed, false);
    // A WEIGHT line departs from parity to the grid: an opus reviewer matching
    // its writer is not routed there, and is fit-denied.
    r = h.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: 'TYPE: code-review\nWRITER: opus/xhigh\nWEIGHT: 2\nreview' });
    assert.equal(r.row.routed, false);
    assert.equal(r.decision, 'deny');
  } finally { h.cleanup(); }
  // fit_guard off: the parity route is still resolved for the cap, so an opus
  // reviewer of a fable writer (F2 caps its route to opus) is exempt either way.
  const off = harness({ CLAUDE_PLUGIN_OPTION_FIT_GUARD: 'false' });
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = off.spawn({ subagent_type: 'general-purpose', model: 'opus', prompt: `${REVIEW('fable/high')}\nWARRANT: weight 4 — review` });
      assert.equal(r.decision, 'proceed', r.reason);
      assert.equal(r.row.routed, true);
    }
    assert.equal(off.window(), 0);
  } finally { off.cleanup(); }
});

test('the definition-pin cap exemption: ac-opus rungs below max, project and user agents; everything else is counted', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '20' });
  try {
    const def = (dir, name, fm) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${fm}\n---\nbody\n`);
    };
    const proj = join(h.dir, 'proj');
    const projAgents = join(proj, '.claude', 'agents');
    const userAgents = join(h.dir, '.claude', 'agents'); // home is the fixture dir
    def(projAgents, 'proj-architect', 'model: opus\neffort: xhigh');
    def(userAgents, 'user-architect', 'model: opus\neffort: xhigh');
    def(projAgents, 'general-purpose', 'model: opus');
    def(projAgents, 'Explore', 'model: opus');
    def(projAgents, 'proj-fable', 'model: fable\neffort: high');
    const install = join(h.dir, '.claude', 'plugins', 'cache', 'mp', 'other-plugin', '1.0.0');
    def(join(install, 'agents'), 'architect', 'model: opus\neffort: high');
    writeFileSync(join(h.dir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'other-plugin@mp': [{ scope: 'user', version: '1.0.0', installPath: install, lastUpdated: '2026-09-24T00:00:00.000Z' }] },
    }));

    for (const t of ['agent-companion:ac-opus-low', 'ac-opus-medium', 'agent-companion:ac-opus-xhigh', 'proj-architect', 'user-architect']) {
      const r = h.spawn({ subagent_type: t, prompt: 'do it' }, { cwd: proj });
      assert.equal(r.decision, 'proceed', `${t}: ${r.reason}`);
      assert.equal(r.row.model, 'opus', t);
      assert.equal(h.window(), 0, `${t} must not be counted`);
    }
    let want = 0;
    for (const t of ['agent-companion:ac-opus-max', 'other-plugin:architect', 'general-purpose', 'Explore']) {
      const r = h.spawn({ subagent_type: t, prompt: 'do it' }, { cwd: proj });
      assert.equal(r.decision, 'proceed', `${t}: ${r.reason}`);
      assert.equal(r.row.model, 'opus', t);
      want += 1;
      assert.equal(h.window(), want, `${t} must be counted`);
    }
    // `routed` stays a provenance fact: a rung or plugin pin is a routing
    // choice even where the cap still counts it.
    assert.equal(h.spawn({ subagent_type: 'agent-companion:ac-opus-max', prompt: 'do it' }, { cwd: proj }).row.routed, true);
    want += 1;
    // Fable pinned by the operator's own project agent is still counted.
    const f = h.spawn({ subagent_type: 'proj-fable', prompt: 'WARRANT: frontier problem\ndo it' }, { cwd: proj });
    assert.equal(f.decision, 'proceed', f.reason);
    assert.equal(h.window(), want + 1);
  } finally { h.cleanup(); }
});

test('spawn-audit counts reviewer-parity rows apart from weight rows', () => {
  const h = harness();
  try {
    h.spawn({ subagent_type: 'agent-companion:ac-opus-medium', prompt: REVIEW('opus/xhigh') }); // parity, under
    h.spawn({ subagent_type: 'agent-companion:ac-opus-low', prompt: 'TYPE: explore\nlook' });   // type preset, fit
    const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'audit.mjs'), '--only', 'spawn-audit', '--json'], {
      windowsHide: true, encoding: 'utf8', cwd: PLUGIN_ROOT, env: { ...process.env, ...h.env }, timeout: 30000,
    });
    const findings = JSON.parse(out).results.find((r) => r.id === 'spawn-audit').findings;
    assert.ok(findings.some((x) => /^fit where a weight or task type was declared: over=0 under=0 fit=1 of 1$/.test(x)), JSON.stringify(findings));
    assert.ok(findings.some((x) => /^fit of reviewers sized to their writer \(reviewer parity\): over=0 under=1 fit=0 of 1/.test(x)), JSON.stringify(findings));
    assert.ok(!findings.some((x) => /fit where weight was declared/.test(x)));
  } finally { h.cleanup(); }
});
