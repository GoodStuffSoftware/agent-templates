// ADR 0003 §2: "Nothing else reads taskTypes.*.override ... and a test greps
// for any other reader." resolveRoute() in hooks/lib/context.mjs is the one
// place a shipped trial is read, so it is floored and explained the same way
// everywhere.
//
// Two detectors (tests/fixtures/route-readers/scan.mjs has the details):
//   static  — every occurrence of the token "override" in plugin code
//             (comments and strings included) is inside resolveRoute() or on
//             a line listed in fixtures/route-readers/allowlist.mjs, keyed by
//             file and line content;
//   runtime — the shipped entry points, run with a preload that traps every
//             read of a trial, read it only from resolveRoute().
// Then every reader shape in fixtures/route-readers/mutants.mjs, injected
// into a scratch copy of the plugin, must turn at least one of them red.
//
// A config-validation TEST reading the raw data is not routing and is out of
// scope (tests/ is not scanned).
//
// KNOWN LIMIT (0.29.0 RC review F9, accepted, not fixed): a reader that never
// spells the token and reads outside the runtime trap evades both detectors,
// e.g. importing config/model-tiers.json as a JSON module (not through
// modelTiers()), or eval / new Function with a computed key ("over" + "ride")
// on a path the shipped entry points do not run. This gate catches the
// shapes in mutants.mjs; code review remains the backstop for deliberate
// evasion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLUGIN_ROOT } from './helpers.mjs';
import { staticScan, runtimeReads } from './fixtures/route-readers/scan.mjs';
import { ANCHOR, MUTANTS } from './fixtures/route-readers/mutants.mjs';

const HOW = 'read the trial through resolveRoute() (its stack carries the trial entry and metadata); '
  + 'if the line does not read a task type\'s trial, list it in tests/fixtures/route-readers/allowlist.mjs';

test('static: every "override" token in plugin code is inside resolveRoute() or allowlisted by content', () => {
  const { offenders, stale, resolverReads } = staticScan(PLUGIN_ROOT);
  assert.ok(resolverReads > 0, 'resolveRoute() should itself be the reader');
  assert.deepEqual(offenders, [], HOW);
  assert.deepEqual(stale, [], 'allowlist entries whose line is gone or reworded — update tests/fixtures/route-readers/allowlist.mjs');
});

// Every shipped entry point that resolves a route, run for real.
const HOOK_PAYLOAD = (prompt, model) => JSON.stringify({
  session_id: 'readers-trap', agent_type: 'main', hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: 'w', description: 'd', prompt },
});
const RUNS = [
  ['scripts/recommend.mjs', ['--type', 'explore']],
  ['scripts/recommend.mjs', ['--type', 'integration', '--explain', '--json']],
  ['scripts/recommend.mjs', ['--type', 'debug-root-cause', '--weight', '3', '--explain']],
  ['scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'opus/xhigh']],
  ['scripts/recommend.mjs', ['--list']],
  ['scripts/evaluate.mjs', ['--model', 'opus', '--effort', 'low', '--type', 'explore', '--json']],
  ['scripts/routing-table.mjs', []],
  ['scripts/routing-table.mjs', ['--json']],
  ['scripts/routing-table.mjs', ['--task-type-block']],
  ['scripts/detect.mjs', ['--json']],
  ['hooks/spawn-guard.mjs', [], { input: HOOK_PAYLOAD('TYPE: explore\ngo', 'opus') }],
  ['hooks/spawn-guard.mjs', [], { input: HOOK_PAYLOAD('TYPE: integration\nWEIGHT: 3\ngo', 'sonnet') }],
];

test('runtime: the shipped entry points read a trial only from resolveRoute()', () => {
  let armed = 0;
  let reads = 0;
  const offenders = [];
  for (const [script, args, opts] of RUNS) {
    const r = runtimeReads(PLUGIN_ROOT, script, args, opts);
    assert.ok(r.status !== null, `${script} ${args.join(' ')} did not finish: ${r.stderr}`);
    if (r.armed) armed += 1;
    reads += r.reads;
    offenders.push(...r.offenders.map((o) => `${script} ${args.join(' ')}: ${o}`));
  }
  // The trap really saw the config and really saw resolveRoute() read it.
  assert.equal(armed, RUNS.length, 'every run should load the config under the trap');
  assert.ok(reads > 0, 'no trial read was observed at all — the trap is not working');
  assert.deepEqual(offenders, [], HOW);
});

test('every reader shape in mutants.mjs is caught (and the unmutated copy is clean)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ac-readers-mut-'));
  const root = join(scratch, 'agent-companion');
  try {
    cpSync(PLUGIN_ROOT, root, { recursive: true, filter: (src) => !/[\\/](tests|bench|node_modules|\.git)$/.test(src) });
    const target = join(root, 'scripts', 'recommend.mjs');
    const orig = readFileSync(target, 'utf8');
    assert.equal(orig.split(ANCHOR).length, 2, 'mutant anchor must occur exactly once in recommend.mjs');
    const probe = (label) => {
      const s = staticScan(root);
      const r = runtimeReads(root, 'scripts/recommend.mjs', ['--type', 'explore']);
      return { label, staticHits: s.offenders.length, runtimeHits: r.offenders.length, status: r.status, stderr: r.stderr };
    };
    writeFileSync(target, orig);
    const base = probe('unmutated');
    // bench/ is not copied, so its allowlist entries read as stale here; only
    // offenders matter for the copy.
    assert.deepEqual([base.staticHits, base.runtimeHits, base.status], [0, 0, 0], base.stderr);
    const missed = [];
    for (const [name, code] of Object.entries(MUTANTS)) {
      writeFileSync(target, orig.replace(ANCHOR, `${ANCHOR}\n${code}`));
      const p = probe(name);
      assert.equal(p.status, 0, `mutant "${name}" must still run: ${p.stderr}`);
      if (p.staticHits === 0 && p.runtimeHits === 0) missed.push(name);
      // Each detector must also hold up on its own: the token scan on every
      // shape that spells the token, the trap on every shape (each mutant
      // runs on recommend's path).
      if (/override/i.test(code)) assert.ok(p.staticHits > 0, `static scan missed "${name}"`);
      assert.ok(p.runtimeHits > 0, `runtime trap missed "${name}"`);
    }
    assert.deepEqual(missed, [], 'reader shapes that passed both detectors');
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});
