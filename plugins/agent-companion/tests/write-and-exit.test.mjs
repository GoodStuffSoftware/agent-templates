// writeAndExit (hooks/lib/context.mjs): a hook's reply reaches a piped reader whole, whatever its size,
// and the process still exits 0 without running any code after the call.
//
// Node writes to a pipe asynchronously on Linux and macOS and process.exit() drops what is still queued, so
// the old process.stdout.write() + process.exit(0) cut a reply over the pipe buffer (64 KB on Linux) short.
// Windows pipes are synchronous, so only Linux CI can show the old defect; these tests hold the fix everywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, realTmpdir } from './helpers.mjs';

const CONTEXT_URL = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs')).href;

// A reply of about `bytes` bytes of valid JSON, with multi-byte characters in it so byte and character counts differ.
function replyOf(bytes) {
  const unit = 'aé€😀 line\n';
  const prompt = unit.repeat(Math.max(1, Math.ceil(bytes / Buffer.byteLength(unit))));
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { prompt } } });
}

// Runs a child that reads the reply from a file, hands it to writeAndExit and then (if it ever got there) writes a
// marker file. stdout is piped; `readDelayMs` holds the parent's reading back so a large reply fills the pipe first.
function run(reply, { readDelayMs = 0, destroyStdout = false } = {}) {
  const dir = mkdtempSync(join(realTmpdir(), `ac-write-and-exit-${process.pid}-`));
  const replyFile = join(dir, 'reply.json');
  const marker = join(dir, 'after-marker');
  const script = join(dir, 'probe.mjs');
  writeFileSync(replyFile, reply);
  writeFileSync(script, [
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `import { writeAndExit } from ${JSON.stringify(CONTEXT_URL)};`,
    `writeAndExit(readFileSync(process.argv[2], 'utf8'));`,
    `writeFileSync(process.argv[3], 'ran');`,
  ].join('\n'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, replyFile, marker], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    if (destroyStdout) child.stdout.destroy();
    else {
      child.stdout.on('data', (d) => chunks.push(d));
      if (readDelayMs) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), readDelayMs); }
    }
    const killer = setTimeout(() => { child.kill(); reject(new Error('probe timed out')); }, 60000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(killer);
      const out = Buffer.concat(chunks);
      const afterRan = existsSync(marker);
      rmSync(dir, { recursive: true, force: true });
      resolve({ status, out, stderr, afterRan });
    });
  });
}

for (const [label, bytes] of [['1 KB', 1024], ['100 KB', 100 * 1024], ['3 MB', 3 * 1024 * 1024]]) {
  test(`writeAndExit: a ${label} reply arrives whole, byte for byte, as JSON`, async () => {
    const reply = replyOf(bytes);
    const r = await run(reply);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.length, Buffer.byteLength(reply));
    assert.ok(r.out.equals(Buffer.from(reply, 'utf8')), 'bytes differ from what the hook sent');
    assert.equal(JSON.parse(r.out.toString('utf8')).hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.afterRan, false, 'code after writeAndExit() ran');
  });
}

test('writeAndExit: a 3 MB reply survives a reader that starts late (the pipe is full first)', async () => {
  const reply = replyOf(3 * 1024 * 1024);
  const r = await run(reply, { readDelayMs: 1500 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.out.equals(Buffer.from(reply, 'utf8')), `got ${r.out.length} of ${Buffer.byteLength(reply)} bytes`);
  assert.equal(r.afterRan, false, 'code after writeAndExit() ran');
});

test('writeAndExit: a reader that has gone away does not turn into a failure (exit 0, nothing after the call runs)', async () => {
  const r = await run(replyOf(3 * 1024 * 1024), { destroyStdout: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.afterRan, false, 'code after writeAndExit() ran');
});

test('writeAndExit: an empty reply writes nothing and still exits 0', async () => {
  const r = await run('');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.length, 0);
  assert.equal(r.afterRan, false);
});

// Windows pipes are synchronous, so the behaviour tests above cannot show a site that went back to
// stdout.write() + process.exit() (only Linux CI can). This pins the routing: the sites whose reply can
// carry the caller's prompt or command must send it through writeAndExit and keep no stdout.write of their own.
test('the replies that can grow with caller input go through writeAndExit, not stdout.write + exit', () => {
  for (const rel of ['hooks/lib/sg-helpers.mjs', 'hooks/bash-tail.mjs', 'hooks/poll-guard.mjs', 'hooks/lib/context.mjs']) {
    const src = readFileSync(join(PLUGIN_ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // code only, not comments
    assert.ok(/writeAndExit\(/.test(src), `${rel} does not call writeAndExit`);
    assert.ok(!/process\.stdout\.write\(/.test(src), `${rel} writes to process.stdout directly`);
  }
});
