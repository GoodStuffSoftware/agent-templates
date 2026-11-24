// Auto handoff record (0.31.67): hooks/lib/auto-handoff.mjs, called from hooks/subagent-context.mjs at the first hand-off notice
// (written once) and refreshed at the first hard-stop deny (the worker's next-steps lines are kept). Fixture transcripts, invented names;
// the git state comes from a temp repo with a bare temp origin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { redact, briefOutputDir, autoHandoffPath, buildRecord, writeAutoHandoff, scanTranscript, AUTO_HANDOFF_MAX_BYTES, NEXT_STEPS_HEADING } from '../hooks/lib/auto-handoff.mjs';

const SID = 'sess-auto';
const AGENT = 'worker-auto-test-1';
const ON = {
  CLAUDE_PLUGIN_OPTION_SUBAGENT_AUTO_HANDOFF: 'true', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '150000',
  CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_REPEAT_TOKENS: '15000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '110000',
  CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_HIGH_TOKENS: '110000',
};
const OFF = { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_AUTO_HANDOFF: 'false' };

const usage = (ctx) => ({ input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 });
const line = (o) => `${JSON.stringify(o)}\n`;
const user = (t) => line({ type: 'user', message: { role: 'user', content: t } });
const asst = (id, ctx, content) => line({ type: 'assistant', requestId: id, message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: usage(ctx), content } });
const say = (id, ctx, t) => asst(id, ctx, [{ type: 'text', text: t }]);
const use = (id, ctx, name, input) => asst(`r_${id}`, ctx, [{ type: 'tool_use', id, name, input }]);
const result = (id, content, isError = false) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });

function layout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-a');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  return { lead, agentFile: join(sub, `agent-${AGENT}.jsonl`) };
}
const pre = (lead, cwd) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd, permission_mode: 'default',
  agent_id: AGENT, agent_type: 'ac-sonnet-high', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1',
});
const run = (lead, cwd, env = ON) => runHook('hooks/subagent-context.mjs', pre(lead, cwd), { env });
const ctxText = (r) => String(r.json?.hookSpecificOutput?.additionalContext || '');
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

// A bare origin with main, a clone on a feature branch with one commit ahead and one uncommitted file.
function makeRepo(fx) {
  const origin = join(fx.dir, 'origin.git');
  const work = join(fx.dir, 'work');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-b', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-m', 'base commit');
  git(work, 'push', '-u', 'origin', 'main');
  git(work, 'switch', '-c', 'feat/auto');
  writeFileSync(join(work, 'b.txt'), 'two\n');
  git(work, 'add', '.'); git(work, 'commit', '-m', 'feature commit alpha');
  writeFileSync(join(work, 'dirty.txt'), 'wip\n');
  return work;
}

const BRIEF = (dir) => `GOAL: build the widget.\nWrite your handoff to ${dir}/widget-handoff.md and your detail to ${dir}/widget-detail.md. Exact brief marker: ZETA-42.`;

function writeTranscript(agentFile, dir, extra = '') {
  writeFileSync(agentFile,
    user(BRIEF(dir))
    + say('a1', 40000, 'I will start with the parser.')
    + use('t_edit', 41000, 'Edit', { file_path: 'C:/proj/src/parser.mjs', old_string: 'a', new_string: 'b' }) + result('t_edit', 'ok')
    + use('t_bad', 41500, 'Edit', { file_path: 'C:/proj/src/never.mjs', old_string: 'a', new_string: 'b' }) + result('t_bad', 'String not found', true)
    + use('t_w', 42000, 'Write', { file_path: 'C:/proj/src/new.mjs', content: 'x' }) + result('t_w', 'ok')
    + use('t_test', 60000, 'Bash', { command: 'node --test tests/parser.test.mjs' })
    + result('t_test', 'Exit code 1\n# tests 3\n# pass 2\n# fail 1\nnot ok 3 - parses empty input', true)
    + say('a2', 80000, 'The empty-input case fails; fixing next.')
    + extra
    + say('a3', 118000, 'Parser fix drafted, tests still red on one case.'));
}

test('the record is written at the first hand-off notice, once, with every section', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const dir = join(fx.dir, 'tasks', 'x').replace(/\\/g, '/');
    const cwd = makeRepo(fx);
    writeTranscript(agentFile, dir);
    const r = run(lead, cwd);
    const rec = join(dir, 'widget-' + AGENT.slice(0, 8) + '-auto-handoff.md');
    assert.equal(existsSync(rec), true, 'the record is at the brief\'s directory');
    const t = ctxText(r);
    assert.ok(t.includes(rec.replace(/\\/g, '/')) || t.includes(rec), 'the notice names the record');
    assert.match(t, /the record is at /);
    const body = readFileSync(rec, 'utf8');
    assert.ok(body.includes(BRIEF(dir)), 'brief verbatim');
    assert.match(body, /- branch: feat\/auto/);
    assert.match(body, /- HEAD: [0-9a-f]{40}/);
    assert.match(body, /commits ahead of origin\/main: 1/);
    assert.match(body, /feature commit alpha/);
    assert.match(body, /b\.txt/);
    assert.match(body, /uncommitted files: 1/);
    assert.match(body, /\?\? dirty\.txt/);
    assert.match(body, /upstream: none \(NOT pushed\)/);
    assert.match(body, /Files edited or written \(2\)/);
    assert.match(body, /- C:\/proj\/src\/parser\.mjs/);
    assert.match(body, /- C:\/proj\/src\/new\.mjs/);
    assert.doesNotMatch(body, /never\.mjs/, 'a failed edit is not listed');
    assert.match(body, /`node --test tests\/parser\.test\.mjs`: fail \(exit 1\)/);
    assert.match(body, /not ok 3 - parses empty input/);
    assert.match(body, /The empty-input case fails; fixing next\./);
    assert.match(body, /Parser fix drafted, tests still red/);
    assert.ok(body.trimEnd().endsWith(NEXT_STEPS_HEADING), 'empty next-steps heading last');
    // Once: a worker edit survives, a later call at the same size neither rewrites nor re-announces.
    writeFileSync(rec, `${body.trimEnd()}\n- first step I added\n`);
    const before = readFileSync(rec, 'utf8');
    const again = run(lead, cwd);
    assert.equal(readFileSync(rec, 'utf8'), before, 'not rewritten');
    assert.equal(again.stdout.trim(), '', 'no repeat below +15K');
  } finally { fx.cleanup(); }
});

test('the hard-stop refresh keeps the worker\'s next-steps lines and the deny names the record', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const dir = join(fx.dir, 'tasks', 'x').replace(/\\/g, '/');
    writeTranscript(agentFile, dir);
    run(lead, fx.dir);
    const rec = join(dir, 'widget-' + AGENT.slice(0, 8) + '-auto-handoff.md');
    writeFileSync(rec, `${readFileSync(rec, 'utf8').trimEnd()}\n- NEXT: fix the empty-input case in parser.mjs line 40\n`);
    writeFileSync(agentFile, readFileSync(agentFile, 'utf8') + say('a4', 155000, 'Still working.'));
    const r = run(lead, fx.dir);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(reason(r).includes('auto-handoff.md'), 'the deny reason names the record');
    const body = readFileSync(rec, 'utf8');
    assert.match(body, /NEXT: fix the empty-input case in parser\.mjs line 40/);
    assert.match(body, /Context 155K/, 'the record itself is refreshed');
    assert.equal((body.match(/## Next steps \(worker adds\)/g) || []).length, 1);
  } finally { fx.cleanup(); }
});

test('the record stays within 12 KB with an oversized brief and many messages', () => {
  const fx = makeFixture();
  try {
    const { agentFile } = layout(fx);
    const dir = join(fx.dir, 'tasks', 'x').replace(/\\/g, '/');
    let s = user(`${BRIEF(dir)}\n${'filler line of the brief. '.repeat(3000)}`);
    for (let i = 0; i < 30; i++) s += say(`m${i}`, 50000 + i, `message ${i} ${'long words '.repeat(200)}`);
    writeFileSync(agentFile, s);
    const file = writeAutoHandoff({ agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir }, { transcript: agentFile, sig: { ctx: 118000 }, threshold: 110000, hard: 150000, brief: BRIEF(dir) });
    assert.ok(file);
    const size = statSync(file).size;
    assert.ok(size <= AUTO_HANDOFF_MAX_BYTES, `size ${size}`);
    assert.ok(readFileSync(file, 'utf8').trimEnd().endsWith(NEXT_STEPS_HEADING));
    // a refresh with a big worker tail still fits
    writeFileSync(file, `${readFileSync(file, 'utf8')}${'worker line\n'.repeat(1000)}`);
    writeAutoHandoff({ agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir }, { transcript: agentFile, sig: { ctx: 155000 }, threshold: 110000, hard: 150000, brief: BRIEF(dir), refresh: true });
    assert.ok(statSync(file).size <= AUTO_HANDOFF_MAX_BYTES);
  } finally { fx.cleanup(); }
});

test('fail-open: missing transcript, a cwd that is not a git repo, an unwritable directory', () => {
  const fx = makeFixture();
  try {
    const p = { agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir };
    const dir = join(fx.dir, 'tasks', 'y').replace(/\\/g, '/');
    // missing transcript: the record is still written
    const f1 = writeAutoHandoff(p, { transcript: join(fx.dir, 'nope.jsonl'), sig: { ctx: 118000 }, threshold: 110000, hard: 150000, brief: BRIEF(dir) });
    assert.ok(f1 && existsSync(f1));
    assert.match(readFileSync(f1, 'utf8'), /ZETA-42/, 'the brief the caller holds is used when the transcript cannot be read');
    assert.match(buildRecord(p, { transcript: join(fx.dir, 'nope.jsonl'), sig: { ctx: 1 }, threshold: 1, hard: 2 }), /not available: the transcript could not be read/);
    // not a git repository
    const b = buildRecord(p, { transcript: join(fx.dir, 'nope.jsonl'), sig: { ctx: 1 }, threshold: 1, hard: 2 });
    assert.match(b, /not a git repository/);
    // a nonexistent cwd
    assert.match(buildRecord({ ...p, cwd: join(fx.dir, 'gone') }, { transcript: '', sig: null }), /cwd unavailable/);
    // an unwritable directory (a file where the directory should be): null, no throw
    const blocker = join(fx.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const bad = writeAutoHandoff(p, { transcript: '', sig: { ctx: 1 }, threshold: 1, hard: 2, brief: `see ${blocker.replace(/\\/g, '/')}/sub/widget-handoff.md` });
    assert.equal(bad, null);
    // no agent id: null
    assert.equal(writeAutoHandoff({ agent_type: 'x' }, { transcript: '', sig: null, brief: '' }), null);
    // the real hook with a nonexistent cwd and a missing transcript exits cleanly
    const { lead, agentFile } = layout(fx);
    writeTranscript(agentFile, dir);
    const r = run(lead, join(fx.dir, 'gone'));
    assert.equal(r.status, 0);
    assert.match(ctxText(r), /Context at 118K/);
  } finally { fx.cleanup(); }
});

test('redaction: secret-looking values are not copied into the record', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const dir = join(fx.dir, 'tasks', 'x').replace(/\\/g, '/');
    const secrets = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt', 'ghp_0123456789abcdefghijABCDEFGHIJ0123', 'abc123hunter2', 'Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh',
      'swordfish99', 'xoxb-1234567890-abcdefghij', 'eyJhbGciOiJIUzI1NiIsInR5cCI6.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw', 'AKIAIOSFODNN7EXAMPLE',
    ];
    const brief = `${BRIEF(dir)}\nAPI_KEY=abc123hunter2 and the token ${secrets[0]} and ${secrets[1]}.\nAuthorization: ${secrets[3]}\nUse https://deploy:swordfish99@host.example/repo.git\n${secrets[5]} ${secrets[6]} ${secrets[7]}`;
    writeFileSync(agentFile,
      user(brief)
      + use('t1', 50000, 'Bash', { command: 'npm test -- --password=swordfish99 && curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh"' })
      + result('t1', 'Exit code 1\nlogin failed password: swordfish99', true)
      + say('a1', 118000, `Set GITHUB_TOKEN=${secrets[1]} then ran it. client_secret: swordfish99`));
    run(lead, fx.dir);
    const rec = join(dir, 'widget-' + AGENT.slice(0, 8) + '-auto-handoff.md');
    const body = readFileSync(rec, 'utf8');
    for (const s of ['sk-ant-api03', 'ghp_0123', 'abc123hunter2', 'eyJhbGciOiJIUzI1NiJ9abcdefgh', 'swordfish99', 'xoxb-1234', 'SflKxwRJSMeKKF2QT4fw', 'AKIAIOSFODNN7EXAMPLE']) {
      assert.ok(!body.includes(s), `leaked: ${s}`);
    }
    assert.match(body, /\[redacted/);
    // unit cases
    assert.equal(redact('API_KEY=abc123'), 'API_KEY=[redacted]');
    assert.equal(redact('token: plainvalue99'), 'token: [redacted]');
    assert.match(redact('mysql://root:pw123@db/x'), /mysql:\/\/\[redacted\]@db\/x/);
    const sha = Array.from({ length: 40 }, (_, i) => ((i * 7) % 16).toString(16)).join('');
    assert.equal(redact(`commit ${sha} ok`), `commit ${sha} ok`, 'a git sha stays');
    assert.equal(redact('plain prose about nothing'), 'plain prose about nothing');
  } finally { fx.cleanup(); }
});

test('path convention: the brief\'s directory, a tasks path, else the state directory; the stem from the brief or the agent type', () => {
  const p = { agent_id: 'zebra-quill-9', agent_type: 'agent-companion:ac-sonnet-high' };
  // /tmp paths are absolute and recognised as paths on both Linux and Windows (a drive-letter path is not absolute on Linux)
  const W = '/tmp/w';
  const R = '/tmp/repo';
  assert.equal(briefOutputDir('write ' + W + '/tasks/a/foo-detail.md'), W + '/tasks/a');
  const claudeTasks = ['', 'tmp', 'work', '.claude', 'tasks', 'b'].join('/');
  assert.equal(briefOutputDir(`files go in ${claudeTasks}/ please`), claudeTasks);
  assert.equal(briefOutputDir('write ' + W + '/tasks/a/foo-verdict.md'), W + '/tasks/a');
  // a bare `tasks` folder (a source tree) is never the output directory
  assert.equal(briefOutputDir('read ' + R + '/src/tasks/runner.mjs and fix it'), null);
  assert.equal(briefOutputDir('files go in ' + W + '/tasks/b/ please'), null);
  assert.equal(briefOutputDir('see ' + R + '/src/tasks/x.ts'), null);
  assert.equal(briefOutputDir('see ' + W + '/tasks/../../etc/x-handoff.md'), null, 'no ..');
  assert.equal(briefOutputDir('relative/path/x-handoff.md and nothing else'), null);
  assert.equal(briefOutputDir(''), null);
  const norm = (s) => s.replace(/\\/g, '/');
  assert.equal(norm(autoHandoffPath(p, 'write ' + W + '/tasks/a/foo-handoff.md')), W + '/tasks/a/foo-zebra-qu-auto-handoff.md');
  const fb = norm(autoHandoffPath(p, 'no paths here'));
  assert.ok(fb.startsWith(norm(join(stateDir(), 'auto-handoff'))) && fb.endsWith('/ac-sonnet-high-zebra-qu-auto-handoff.md'), fb);
  assert.equal(autoHandoffPath({ agent_type: 'x' }, ''), null, 'no agent id');
});

test('scanTranscript reads a transcript with a tool-less brief array and survives garbage lines', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.dir, 't.jsonl');
    writeFileSync(f, 'not json {"tool_use"\n' + line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array brief' }] } }) + say('a', 10, 'hello'));
    const s = scanTranscript(f);
    assert.equal(s.brief, 'array brief');
    assert.deepEqual(s.messages, ['hello']);
    assert.equal(scanTranscript(join(fx.dir, 'none.jsonl')).readable, false);
  } finally { fx.cleanup(); }
});

test('option subagent_auto_handoff off: the 0.31.66 wording and no record', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const dir = join(fx.dir, 'tasks', 'x').replace(/\\/g, '/');
    writeTranscript(agentFile, dir);
    const r = run(lead, fx.dir, OFF);
    const t = ctxText(r);
    assert.match(t, /write a handoff file <task>-handoff\.md next to your detail file/);
    assert.doesNotMatch(t, /the record is at/);
    assert.equal(existsSync(dir), false, 'nothing written next to the brief');
    assert.equal(existsSync(join(stateDir(), 'auto-handoff')), false);
    assert.deepEqual(readdirSync(fx.dir).filter((n) => n === 'tasks'), []);
    assert.ok(dirname(dir));
  } finally { fx.cleanup(); }
});

test('redaction stays linear: 200 KB of adversarial unbroken runs finishes well under a second, in redact() and in the record', () => {
  const fx = makeFixture();
  try {
    for (const run1 of ['a-'.repeat(100000), 'ab.'.repeat(70000), 'A_B-'.repeat(50000)]) {
      const t0 = Date.now();
      redact(run1);
      assert.ok(Date.now() - t0 < 1000, `redact took ${Date.now() - t0} ms`);
    }
    // the same through a transcript: a huge brief and a huge last message
    const f = join(fx.dir, 'big.jsonl');
    const blob = 'a-'.repeat(100000);
    writeFileSync(f, user(`GOAL: x\n${blob}`) + say('a1', 1000, blob));
    const t1 = Date.now();
    const rec = buildRecord({ agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir }, { transcript: f, sig: { ctx: 1 }, threshold: 1, hard: 2 });
    assert.ok(Date.now() - t1 < 1000, `buildRecord took ${Date.now() - t1} ms`);
    assert.match(rec, /GOAL: x/);
    assert.ok(Buffer.byteLength(rec) <= AUTO_HANDOFF_MAX_BYTES);
  } finally { fx.cleanup(); }
});

test('redaction covers Stripe, Slack app, GitLab, DigitalOcean tokens, _KEY names, --key, -u user:pass and X-Auth headers', () => {
  const cases = [
    ['sk_live_abcdefghij0123456789', 'abcdefghij0123456789'],
    ['sk_test_abcdefghij0123456789', 'abcdefghij0123456789'],
    ['rk_live_abcdefghij0123456789', 'abcdefghij0123456789'],
    [['xapp', '1', 'Qwxzy' + 'KLMNPT', '4567', 'qrstuv'].join('-'), 'Qwxzy' + 'KLMNPT'],
    ['glpat-abcdefghij0123456789', 'abcdefghij0123456789'],
    ['dop_v1_' + 'q7w8e9r0' + 't1y2u3i4' + 'o5p6a1', 'q7w8e9r0' + 't1y2u3i4' + 'o5p6a1'],
    ['STRIPE_KEY=whsec9981zz', 'whsec9981zz'],
    ['deploy --key abc123zz now', 'abc123zz'],
    ['curl -u admin:hunter2 https://x.example/api', 'hunter2'],
    ['X-Auth: opensesame77', 'opensesame77'],
    ['GITHUB_PAT=ghx77pat', 'ghx77pat'],
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `leaked ${secret} in: ${out}`);
    assert.match(out, /\[redacted/);
  }
  assert.equal(redact('keep the monkey and the key point'), 'keep the monkey and the key point');
});

test('a transcript too large to scan from the start: the brief comes from the caller, and the record says so honestly', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.dir, 'huge.jsonl');
    const pad = Buffer.alloc(49 * 1024 * 1024, 'x');
    pad[pad.length - 1] = 10;
    writeFileSync(f, Buffer.concat([Buffer.from(user('GOAL: the real brief ZETA-77')), pad, Buffer.from(say('a1', 1000, 'late message here'))]));
    const p = { agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir };
    const withBrief = buildRecord(p, { transcript: f, sig: { ctx: 1 }, threshold: 1, hard: 2, briefFallback: 'GOAL: the real brief ZETA-77' });
    assert.match(withBrief, /ZETA-77/);
    assert.match(withBrief, /late message here/);
    const without = buildRecord(p, { transcript: f, sig: { ctx: 1 }, threshold: 1, hard: 2 });
    assert.match(without, /too large to scan/);
    assert.doesNotMatch(without, /transcript could not be read/);
  } finally { fx.cleanup(); }
});

test('the record is not written into a source tree named tasks, and no .tmp file is left behind', () => {
  const fx = makeFixture();
  try {
    const src = join(fx.dir, 'repo', 'src', 'tasks').replace(/\\/g, '/');
    const p = { agent_id: AGENT, agent_type: 'ac-sonnet-high', cwd: fx.dir };
    const file = autoHandoffPath(p, `fix ${src}/runner.mjs`);
    assert.ok(!file.replace(/\\/g, '/').startsWith(src), file);
    assert.equal(existsSync(src), false, 'the source tree directory was not created');
    // a rename that fails (the target is a directory) leaves no .tmp file and returns null
    const out = join(fx.dir, 'out').replace(/\\/g, '/');
    const brief = `write ${out}/job-handoff.md`;
    const target = autoHandoffPath(p, brief);
    mkdirSync(target, { recursive: true });
    assert.equal(writeAutoHandoff(p, { transcript: '', sig: { ctx: 1 }, threshold: 1, hard: 2, brief }), null);
    assert.deepEqual(readdirSync(out).filter((n) => n.endsWith('.tmp')), []);
  } finally { fx.cleanup(); }
});
