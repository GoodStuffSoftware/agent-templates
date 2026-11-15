// recommend.mjs legs output: the plan and write legs also show the API-worker command form.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());

test('recommend legs: the plan leg line appends the --mode plan API form, the write leg the --mode write form', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'large-refactor']);
  assert.equal(res.status, 0, res.stderr);
  const plan = res.stdout.split('\n').find((l) => l.startsWith('plan leg:'));
  const write = res.stdout.split('\n').find((l) => l.startsWith('write leg:'));
  assert.ok(plan && write, res.stdout);
  assert.match(plan, /read-only, writes <task>-plan\.md; brief TYPE: large-refactor \+ ROLE: other/, 'existing text kept');
  assert.match(plan, /api-worker\.mjs run --mode plan --plan-file <task>-plan\.md \.\.\./);
  assert.match(write, /works from that plan; brief TYPE: large-refactor \+ ROLE: /, 'existing text kept');
  assert.match(write, /api-worker\.mjs run --mode write \.\.\./);
});
