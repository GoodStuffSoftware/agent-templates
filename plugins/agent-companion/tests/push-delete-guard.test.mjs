// push-delete guard: a git push that deletes remote refs needs the destructive-git ack.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { runHook, decisionOf } from './helpers.mjs';
import { pushDeleteHits, pushDeleteGuard, PUSH_DELETE_MSG } from '../hooks/lib/push-delete-guard.mjs';

const guard = (command, guardInstalled = () => false) => pushDeleteGuard({ tool_name: 'Bash', tool_input: { command } }, { guardInstalled });

// [command, denied?]
const TABLE = [
  ['git push origin :refs/heads/topic', true],
  ['git push origin :topic', true],
  ['git push origin +:topic', true],
  ["git push origin ':topic'", true],
  ['git push origin "+:refs/heads/topic"', true],
  ['git push -q origin main :old', true],
  ['git push origin --delete topic', true],
  ['git push --delete origin topic', true],
  ['git push -d origin topic', true],
  ['git push -fd origin topic', true],
  ['git push --prune origin', true],
  ['git push --mirror backup-remote', true],
  ['git -C /work/repo push origin :topic', true],
  ['cd repo && git push origin :topic', true],
  ['M=; git push origin :refs/heads/topic', true],
  ["bash -c 'git push origin :topic'", true],
  ['env GIT_TRACE=1 git push origin -d topic', true],
  ['git push -- origin :topic', true],
  ['if true; then git push origin :topic; fi', true],
  ['! git push origin -d topic', true],
  ['git push origin -- --dry-run :topic', true],
  ['git push --dry-run origin :topic', false],
  ['git push -n origin --delete topic', false],
  // allowed
  ['git push', false],
  ['git push origin main', false],
  ['git push -u origin feature/x', false],
  ['git push origin HEAD:refs/heads/x', false],
  ['git push origin $SHA:refs/heads/x', false],
  ['git push origin "${SHA}:refs/heads/x"', false],
  ['git push origin +main', false],
  ['git push origin :', false],
  ['git push -o ci.skip origin main', false],
  ['git push --force-with-lease=main:abc origin main', false],
  ['echo "git push origin :topic"', false],
  ['git commit -m "push origin :topic"', false],
  ['git push origin :topic # guard-ack: destructive-git', false],
  ['git push origin --delete topic  # guard-ack: destructive-git', false],
];

test('guard: deletes need the ack; ordinary pushes and variable sources pass', () => {
  for (const [cmd, denied] of TABLE) {
    const r = guard(cmd);
    assert.equal(Boolean(r), denied, `${denied ? 'deny' : 'allow'}: ${cmd}`);
    if (r) { assert.equal(r.mode, 'deny'); assert.equal(r.message, PUSH_DELETE_MSG); }
  }
});

test('guard: hits name the form', () => {
  assert.equal(pushDeleteHits('git push origin +:x'), 'empty-source +:x');
  assert.equal(pushDeleteHits('git push origin --delete x'), '--delete');
  assert.equal(pushDeleteHits('git push -d origin x'), '-d');
  assert.equal(pushDeleteHits('ls'), null);
});

test('guard: the merged-branch clean-up form is left to the command guard only when it is installed', () => {
  const cmd = 'git -C C:/work/repo push origin --delete topic';
  assert.ok(guard(cmd, () => false), 'no command guard: denied');
  assert.equal(guard(cmd, () => true), null, 'command guard installed: it decides');
  assert.equal(guard('git -C C:/work/repo push origin :topic', () => true), null);
  assert.ok(guard('git -C C:/work/repo push origin --delete topic && echo x', () => true), 'not the whole command: denied');
});

const hook = (command) => runHook('hooks/poll-guard.mjs', { tool_name: 'Bash', tool_input: { command }, session_id: 's-pd' });

test('hook: an empty-source push is denied, an acked one and a normal one are not', () => {
  const r = hook('git push origin :refs/heads/topic');
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /guard-ack: destructive-git/);
  assert.notEqual(decisionOf(hook('git push origin :refs/heads/topic # guard-ack: destructive-git').json), 'deny');
  assert.notEqual(decisionOf(hook('git push origin HEAD:refs/heads/topic').json), 'deny');
});
