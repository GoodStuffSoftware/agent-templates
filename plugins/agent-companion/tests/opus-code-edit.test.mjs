// Opus operate/other code-edit guard (0.31.61): an Opus subagent whose brief declares ROLE: operate or other is denied a
// Write or Edit of a repo source file ("code edits go to a Sonnet writer"). Never .md, detail, handoff or plan files, paths
// outside a git repo, non-Opus helpers, other roles, or the lead. opus_writer_policy "allow" turns it off.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, decisionOf } from './helpers.mjs';
import { OPUS_CODE_EDIT_REASON, isExemptFile, briefJudgedRole } from '../hooks/lib/opus-code-edit.mjs';

const SID = 'lead-oce-1';

// A helper's transcript at the real layout: <project>/<session>/subagents/agent-<id>.jsonl, the brief as its first user
// message and one assistant turn on `model`.
function helperTranscript(dir, brief, agentId, model) {
  const proj = join(dir, 'projects', 'p');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: brief }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'working' }] } }),
  ].join('\n') + '\n');
  return join(proj, `${SID}.jsonl`);
}

// Fixture directory made a git repo (an empty .git directory is enough for the check).
function repoDir(fx) {
  const d = join(fx.dir, 'repo');
  mkdirSync(join(d, '.git'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  return d;
}

function edit(fx, { brief, model = 'claude-opus-5-5', file, tool = 'Edit', agentId = 'o1', env = {}, agentType = 'agent-companion:ac-opus-medium', lead = false }) {
  const lt = helperTranscript(fx.dir, brief, agentId, model);
  const payload = {
    session_id: SID, agent_type: agentType, transcript_path: lt, cwd: fx.dir, tool_name: tool,
    tool_input: { file_path: file, ...(tool === 'Write' ? { content: 'x' } : { old_string: 'a', new_string: 'b' }) },
  };
  if (!lead) payload.agent_id = agentId;
  return runHook('hooks/opus-code-edit.mjs', payload, { env: { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'sonnet', ...env } });
}

test('opus-code-edit: an Opus helper with ROLE: operate or other is denied a source edit in a repo', () => {
  const fx = makeFixture();
  try {
    const d = repoDir(fx);
    for (const [i, role] of ['operate', 'other'].entries()) {
      for (const tool of ['Edit', 'Write']) {
        const r = edit(fx, { brief: `TYPE: debug-root-cause\nROLE: ${role}\n\nfind the cause`, file: join(d, 'src', 'a.mjs'), tool, agentId: `d${i}${tool}` });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(decisionOf(r.json), 'deny', `${role} ${tool}`);
        assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, OPUS_CODE_EDIT_REASON);
        assert.match(OPUS_CODE_EDIT_REASON, /Sonnet writer/);
      }
    }
  } finally { fx.cleanup(); }
});

test('opus-code-edit: the ac-opus agent type decides when the transcript names no model', () => {
  const fx = makeFixture();
  try {
    const d = repoDir(fx);
    const r = edit(fx, { brief: 'ROLE: operate\n\nrun it', model: undefined, file: join(d, 'src', 'a.mjs') });
    assert.equal(decisionOf(r.json), 'deny');
  } finally { fx.cleanup(); }
});

test('opus-code-edit: never denied - .md, detail, handoff and plan files, outside a git repo, Sonnet helper, other roles, the lead', () => {
  const fx = makeFixture();
  try {
    const d = repoDir(fx);
    const brief = 'TYPE: debug-root-cause\nROLE: other\n\nfind the cause';
    const ok = (what, r) => { assert.equal(r.status, 0, r.stderr); assert.equal(decisionOf(r.json), null, what); };
    ok('md', edit(fx, { brief, file: join(d, 'docs', 'notes.md'), tool: 'Write' }));
    ok('plan md', edit(fx, { brief, file: join(d, 'fix-plan.md'), tool: 'Write' }));
    ok('detail json', edit(fx, { brief, file: join(d, 'fix-detail.json'), tool: 'Write' }));
    ok('handoff', edit(fx, { brief, file: join(d, 'fix-handoff.txt'), tool: 'Write' }));
    ok('outside a repo', edit(fx, { brief, file: join(fx.dir, 'elsewhere', 'a.mjs'), tool: 'Write' }));
    ok('sonnet helper', edit(fx, { brief, model: 'claude-sonnet-5-5', agentType: 'agent-companion:ac-sonnet-high', file: join(d, 'src', 'a.mjs') }));
    ok('writer role', edit(fx, { brief: 'TYPE: bounded-feature\nROLE: writer\n\nbuild it', file: join(d, 'src', 'a.mjs') }));
    ok('reviewer role', edit(fx, { brief: 'TYPE: code-review\nROLE: reviewer\n\nreview it', file: join(d, 'src', 'a.mjs') }));
    ok('no role', edit(fx, { brief: 'fix the bug', file: join(d, 'src', 'a.mjs') }));
    ok('the lead (no agent_id)', edit(fx, { brief, file: join(d, 'src', 'a.mjs'), lead: true }));
    ok('Read-like tool', edit(fx, { brief, file: join(d, 'src', 'a.mjs'), tool: 'Read' }));
  } finally { fx.cleanup(); }
});

test('opus-code-edit: opus_writer_policy allow turns the guard off', () => {
  const fx = makeFixture();
  try {
    const d = repoDir(fx);
    const r = edit(fx, { brief: 'ROLE: operate\n\nrun it', file: join(d, 'src', 'a.mjs'), env: { CLAUDE_PLUGIN_OPTION_OPUS_WRITER_POLICY: 'allow' } });
    assert.equal(decisionOf(r.json), null);
  } finally { fx.cleanup(); }
});

test('opus-code-edit: unit - exempt files and the judged roles', () => {
  for (const f of ['a.md', 'B.MD', 'x/notes.mdx', 'x-detail.json', 'run-handoff.txt', 'task-plan.json']) assert.ok(isExemptFile(f), f);
  for (const f of ['a.mjs', 'src/plan.ts', 'x/detail.json', 'README.txt']) assert.ok(!isExemptFile(f), f);
  assert.equal(briefJudgedRole('TYPE: x\nROLE: operate\n'), 'operate');
  assert.equal(briefJudgedRole('ROLE: other'), 'other');
  assert.equal(briefJudgedRole('ROLE: writer'), null);
  assert.equal(briefJudgedRole('no role here'), null);
});

test('hooks.json registers opus-code-edit on Write and Edit', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
  const entry = cfg.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.args.some((a) => a.endsWith('/hooks/opus-code-edit.mjs'))));
  assert.ok(entry, 'registered');
  assert.equal(entry.matcher, '^(Write|Edit)$');
});
