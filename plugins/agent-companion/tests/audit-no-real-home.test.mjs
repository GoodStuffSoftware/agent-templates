import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';

// A full `audit.mjs` run (every check, no --only filter) must never read from
// or print a path under the REAL operator home, even though several checks
// (memory-index, memory-store-forks, memory-near-duplicates,
// instruction-budget) resolve a `.claude`-relative path internally. This
// guards the exact bug found in review: memory-index.mjs's memoryRoot() used
// raw homedir() instead of claudeDir(), so ctx.memoryDir (built
// unconditionally by audit.mjs on every run) silently read the operator's
// real ~/.claude/projects tree.
//
// The assertion is made on CAPTURED STDOUT ONLY — this test never logs the
// audit output itself, so a real path (or real memory content) that DID leak
// through would not itself be printed into the test's own report.
test('audit.mjs --json (all checks) touches nothing under the real os.homedir()', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const auditScript = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
    const out = execFileSync(process.execPath, [auditScript, '--dir', PLUGIN_ROOT, '--json'], {
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
      timeout: 60000,
    });

    // Normalise separators on both sides before comparing — Windows paths can
    // appear with either slash style depending on which function built them.
    const norm = (s) => String(s).split('\\').join('/');
    const realHome = norm(homedir());
    const normOut = norm(out);

    const leaked = normOut.includes(realHome);
    assert.equal(leaked, false, 'audit.mjs output must not contain a path under the real os.homedir() (content withheld from this assertion message on purpose)');

    // Also confirm the report is well-formed JSON with at least the checks we
    // expect to have run, so a silently-empty/broken audit doesn't pass this
    // test by accident.
    const report = JSON.parse(out);
    assert.ok(Array.isArray(report.results) && report.results.length > 5, 'expected a full multi-check audit report');
  } finally {
    cleanup();
  }
});
