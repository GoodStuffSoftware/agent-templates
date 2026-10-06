// UI and browser work after the ladder rungs dropped the browser servers.
//
// The numbered ladder rungs no longer carry the browser (config ladderTools),
// so: a general-purpose spawn whose brief names the browser is NOT swapped for
// a rung; a ladder spawn that names it is told where to go; the browser
// variants (ac-browser, ac-browser-opus) are counted as ladder agents by the
// guards and are never told it; the delegation guard's advice and
// recommend.mjs --browser name them. Fixture state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';
import { briefNeedsDroppedTools } from '../hooks/lib/context.mjs';

function guard(dir, sessionId, toolInput) {
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sessionId, agent_type: 'main', cwd: dir,
    tool_input: { run_in_background: true, name: 'w', ...toolInput },
  });
  assert.equal(res.status, 0, res.stderr);
  return res;
}
function seedStart(stateDir, sessionId, agentType) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'subagent-starts.jsonl'),
    `${JSON.stringify({ v: 2, at: new Date().toISOString(), session_id: sessionId, agent_type: agentType })}\n`, { flag: 'a' });
}
const updated = (res) => res.json?.hookSpecificOutput?.updatedInput || null;
const msgOf = (res) => res.json?.systemMessage || '';

test('briefNeedsDroppedTools: tool names and unmistakable phrases, never a bare "UI"', () => {
  assert.equal(briefNeedsDroppedTools('use mcp__Claude_Browser__navigate to open the page').browser, true);
  assert.equal(briefNeedsDroppedTools('Drive the browser and screenshot the result').browser, true);
  assert.equal(briefNeedsDroppedTools('browser verification of the fix').browser, true);
  assert.equal(briefNeedsDroppedTools('Fix the UI layout bug in Header.vue').browser, false);
  assert.equal(briefNeedsDroppedTools('refactor the browserslist config').browser, false);
  assert.equal(briefNeedsDroppedTools('publish an Artifact with the results').other, true);
  assert.equal(briefNeedsDroppedTools('write the Artifacts section of the doc').other, false);
  assert.equal(briefNeedsDroppedTools('call mcp__ccd_session__mark_chapter').other, true);
});

test('general-purpose + browser brief + a started ladder: NOT rewritten to a rung (it would lose the browser); the advisory names the browser variant', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-b1', 'agent-companion:ac-sonnet-low');
    const res = guard(dir, 'sess-b1', { subagent_type: 'general-purpose', prompt: 'TYPE: bounded-feature\nUse mcp__Claude_Browser to check the page.' });
    const u = updated(res);
    assert.notEqual(u?.subagent_type, 'agent-companion:ac-opus-medium');
    assert.equal(u?.subagent_type, 'general-purpose', 'subagent_type left as general-purpose');
    assert.match(msgOf(res), /effort not pinned/);
    assert.match(msgOf(res), /agent-companion:ac-browser-opus/);
    assert.match(msgOf(res), /the brief names the browser/);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === 'sess-b1').pop();
    assert.equal(row.subagent_type_rewritten_to, null);
  } finally { cleanup(); }
});

test('general-purpose + an Artifact brief: not rewritten either, and the advisory does not point at the browser', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-b2', 'agent-companion:ac-sonnet-low');
    const res = guard(dir, 'sess-b2', { subagent_type: 'general-purpose', prompt: 'TYPE: bounded-feature\nPublish an Artifact with the report.' });
    assert.equal(updated(res)?.subagent_type, 'general-purpose');
    assert.match(msgOf(res), /Artifact or a desktop-only tool/);
    assert.doesNotMatch(msgOf(res), /ac-browser/);
  } finally { cleanup(); }
});

test('control: the same spawn without a browser or Artifact brief is still rewritten to the rung', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-b3', 'agent-companion:ac-sonnet-low');
    const res = guard(dir, 'sess-b3', { subagent_type: 'general-purpose', prompt: 'TYPE: bounded-feature\nFix the layout bug.' });
    assert.equal(updated(res)?.subagent_type, 'agent-companion:ac-opus-medium');
  } finally { cleanup(); }
});

test('a numbered rung spawned with a browser brief gets a note naming the browser variant; a browser variant is never told', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const rung = guard(dir, 'sess-b4', { subagent_type: 'agent-companion:ac-sonnet-high', prompt: 'TYPE: debug-root-cause\nReproduce it with the browser tool and screenshot.', model: 'sonnet' });
    assert.match(msgOf(rung), /names the browser, which the ladder workers drop/);
    assert.match(msgOf(rung), /agent-companion:ac-browser/);
    const variant = guard(dir, 'sess-b5', { subagent_type: 'agent-companion:ac-browser', prompt: 'TYPE: debug-root-cause\nReproduce it with the browser tool and screenshot.' });
    assert.doesNotMatch(msgOf(variant), /ladder workers drop/);
    // and it is a ladder spawn: model and effort come from its file, so no rule-1 note and no autofill over it
    assert.doesNotMatch(msgOf(variant), /SPAWNING RULE 1/);
    assert.equal(updated(variant)?.model, undefined);
  } finally { cleanup(); }
});

test('a ladder rung with an Artifact brief gets the Artifact note', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = guard(dir, 'sess-b6', { subagent_type: 'agent-companion:ac-sonnet-medium', prompt: 'TYPE: bounded-feature\nPublish an Artifact of the table.' });
    assert.match(msgOf(res), /names Artifact or a desktop-only tool/);
  } finally { cleanup(); }
});

test('recommend.mjs --browser points UI work at the browser variant on the routed model; no flag prints the hint', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--browser', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.ok(j.browser, 'browser block present');
  assert.equal(j.browser.agent, j.model === 'opus' ? 'ac-browser-opus' : 'ac-browser');
  assert.equal(j.spawnAgentNamespaced, `agent-companion:${j.browser.agent}`);
  const text = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause']);
  assert.match(text.stdout, /UI or browser work: add --browser/);
  const haiku = runScript('scripts/recommend.mjs', ['--type', 'explore', '--browser']);
  assert.match(haiku.stdout, /no browser variant for this route/);
});
