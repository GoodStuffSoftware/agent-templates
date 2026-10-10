// detect.mjs run outside a checkout prints no git error on stderr: the
// origin-url lookups swallow the exception but used to let the child's own
// "fatal: not a git repository" through to the parent's stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';

test('detect.mjs from a directory that is not a git repository: no "fatal:" on stderr', () => {
  const { cleanup } = makeFixture();
  const parent = mkdtempSync(join(tmpdir(), `ac-norepo-${process.pid}-`));
  try {
    const cwd = join(parent, 'empty');
    mkdirSync(cwd);
    const res = runScript('scripts/detect.mjs', [], {
      cwd, timeout: 60000,
      // a repository above the temp dir must not be found
      env: { GIT_CEILING_DIRECTORIES: dirname(cwd), CLAUDE_CODE_REMOTE_SESSION_ID: '' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.json, 'detect still prints its JSON');
    assert.doesNotMatch(res.stderr, /fatal:/);
    assert.doesNotMatch(res.stderr, /not a git repository/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    cleanup();
  }
});
