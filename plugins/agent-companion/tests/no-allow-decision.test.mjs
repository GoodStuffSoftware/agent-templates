// No hook in this plugin answers a tool call with permissionDecision "allow".
//
// "allow" does not just let a call through: it SKIPS the permission prompt
// (deny and ask rules still apply). The spawn guard, poll guard and resume
// guard all used to emit it on paths that only meant "not blocked, here is a
// note", so a hint silently pre-approved an Agent spawn, a ScheduleWakeup or
// a SendMessage the permission mode would have asked about. A hook that lets
// a call through now prints nothing, or JSON with no permissionDecision (a
// systemMessage, additionalContext, or an updatedInput — which Claude Code
// applies with no decision: verified in the 2.1.280 and 2.1.281 binaries).
// The per-hook behavioural tests: poll-guard.test.mjs and
// resume-guard.test.mjs (their hint paths), spawn-guard below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT, decisionOf } from './helpers.mjs';
import { CONTRACT_MARKER } from '../hooks/lib/brevity.mjs';

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('no hook source emits permissionDecision "allow" (or the legacy decision "approve")', () => {
  const files = sources(join(PLUGIN_ROOT, 'hooks'));
  assert.ok(files.length > 10, 'found the hooks');
  for (const f of files) {
    // Code only: the comments that explain why say the word.
    const src = readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /permissionDecision['"]?\s*:\s*['"]allow['"]/, `${f} emits permissionDecision "allow"`);
    assert.doesNotMatch(src, /\bdecision['"]?\s*:\s*['"]approve['"]/, `${f} emits decision "approve"`);
  }
  const ctx = readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs'), 'utf8');
  assert.doesNotMatch(ctx, /export function allow\(/, 'context.mjs must not offer an allow() helper');
});

test('spawn-guard: a cheap spawn it lets through and rewrites carries updatedInput and NO permissionDecision', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-no-allow', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { model: 'claude-haiku-4-5', subagent_type: 'general-purpose', prompt: 'TYPE: explore\nfind the config reader' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(decisionOf(res.json), 'proceed', JSON.stringify(res.json));
    assert.equal('permissionDecision' in res.json.hookSpecificOutput, false);
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(String(res.json.hookSpecificOutput.updatedInput?.prompt || '').includes(CONTRACT_MARKER),
      'the rewrite still rides on updatedInput');
  } finally { cleanup(); }
});
