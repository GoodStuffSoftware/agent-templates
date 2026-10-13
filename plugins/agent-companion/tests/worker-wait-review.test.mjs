// Regression: worker-wait detector blind spots and false positives.
import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { workerWaitPattern } from '../hooks/lib/poll-guard.mjs';

test('plan table still holds', () => {
  for (const c of ['gh pr checks 31', 'gh run watch 123', 'until gh pr checks 31 | grep -q pass; do sleep 20; done', 'sleep 60 && gh pr view 31', 'Start-Sleep -Seconds 30']) assert.ok(workerWaitPattern(c), c);
  for (const c of ['echo "sleep 5"', 'sleep 1', 'git log --grep=sleep', 'node scripts/pr-wait.mjs 31', 'npm test', 'gh pr view 31 --json title']) assert.equal(workerWaitPattern(c), null, c);
  assert.equal(workerWaitPattern('gh run watch 1', { background: true }), null);
});

test('sleep units are read in seconds', () => {
  for (const c of ['sleep 2m', 'sleep 1m && gh pr view 31 --json state', 'sleep 1h', 'sleep 1d', 'sleep 5s', 'sleep 5']) assert.ok(workerWaitPattern(c), c);
  for (const c of ['sleep 1', 'sleep 2s', 'sleep 0.5', 'sleep 4s']) assert.equal(workerWaitPattern(c), null, c);
});

test('wrapper bodies are scanned, quoted echo is not', () => {
  assert.ok(workerWaitPattern("timeout 600 bash -c 'until gh pr checks 31; do sleep 20; done'"));
  assert.ok(workerWaitPattern('sh -c "sleep 30"'));
  assert.ok(workerWaitPattern('powershell -Command "Start-Sleep 30"'));
  assert.ok(workerWaitPattern('pwsh -NoProfile -Command "Start-Sleep -Seconds 30"'));
  assert.ok(workerWaitPattern('ssh host "sleep 30"'));
  assert.ok(workerWaitPattern("ssh -p 22 host 'gh pr checks 3'"));
  assert.equal(workerWaitPattern('echo "sleep 5"'), null);
  assert.equal(workerWaitPattern("bash -c 'echo hi'"), null);
  assert.equal(workerWaitPattern('ssh host "ls -la"'), null);
});

test('while-read batch loops are not wait loops unless they sleep or poll', () => {
  assert.equal(workerWaitPattern('while read f; do gh issue close $f; done < ids.txt'), null);
  assert.equal(workerWaitPattern('while IFS= read -r f; do curl -s $f; done < urls.txt'), null);
  assert.ok(workerWaitPattern('while read f; do sleep 30; done < ids.txt'));
  assert.ok(workerWaitPattern('while read f; do gh pr checks $f; done < ids.txt'));
});

test('heredoc body lines are not commands', () => {
  assert.equal(workerWaitPattern("cat > run.sh <<'EOF'\nsleep 30\nEOF"), null);
  assert.equal(workerWaitPattern('cat <<EOF > x\ngh pr checks 1\nEOF'), null);
  assert.ok(workerWaitPattern("cat > run.sh <<'EOF'\nx\nEOF\nsleep 30"));
});
