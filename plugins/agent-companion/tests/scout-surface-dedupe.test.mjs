// scout-surface.mjs says each drift-signal kind once, with a count when it
// repeats (a measured session start listed routing_trial_review_due and
// model_benchmark_suggested four times each in one 15-signal line).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';

test('repeated scout signal kinds are listed once with a count; the total stays honest', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const kinds = ['spawn_activity', 'routing_trial_review_due', 'model_benchmark_suggested', 'routing_trial_review_due',
      'model_benchmark_suggested', 'routing_trial_review_due', 'session_outdated'];
    const f = stateFile('scout-latest.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ checkedAt: new Date().toISOString(), signals: kinds.map((kind) => ({ kind, detail: 'd' })) }));
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-dedupe', cwd: dir }, { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /7 drift signal\(s\)/, 'the total counts every signal');
    assert.match(ctx, /routing_trial_review_due x3/);
    assert.match(ctx, /model_benchmark_suggested x2/);
    assert.equal(ctx.split('routing_trial_review_due').length - 1, 1, 'each kind appears once');
    assert.match(ctx, /spawn_activity, /);
    assert.doesNotMatch(ctx, /spawn_activity x/);
  } finally { cleanup(); }
});
