// The ci-budget suites must give the same answers on any host. 0.31.23 went red
// on the 4-core Linux runner only: the fake worlds injected a cpu sampler but
// not a core count, so the load guard's threshold (cores - reserve) came from
// the real machine. 5 busy cores is "loaded" on 4 cores and not on 32, so the
// grants differed. This file re-runs those suites under a preload that makes
// the process look like that runner (4 cores, non-zero loadavg, 3 cores busy),
// so the same leak fails here, on the Windows box, before it reaches CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(HERE, 'fixtures', 'small-linux-host.mjs')).href;

function node(args) {
  return spawnSync(process.execPath, ['--import', PRELOAD, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 180_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}

test('the small-host preload really looks like a 4-core Linux runner with load', () => {
  const r = node(['-e', [
    "import('node:os').then((os) => console.log(JSON.stringify({",
    '  cores: os.availableParallelism(), cpus: os.cpus().length, load: os.loadavg()[0] })))',
  ].join('')]);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim());
  assert.deepEqual([seen.cores, seen.cpus], [4, 4]);
  assert.ok(seen.load > 0, 'loadavg is non-zero, as on Linux');
});

test('the ci-budget suites pass unchanged on a simulated 4-core Linux runner', () => {
  // ci-budget-headroom.test.mjs pins its own 32-core world, so it is left out to keep this run short.
  const files = ['ci-budget.test.mjs', 'ci-budget-fixes.test.mjs'].map((f) => join(HERE, f));
  const r = node(['--test', '--test-concurrency=1', '--test-reporter=tap', ...files]);
  const failed = (r.stdout.match(/^not ok .*$/gm) || []).join('\n');
  assert.equal(r.status, 0, `failed on the simulated small host:\n${failed}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, /^# fail 0$/m);
});
