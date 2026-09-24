// Pins the reachability claim behind route-golden's floor carve-out: the 34
// carved cases (a trial type given a consequence WITHOUT consequenceExplicit)
// are unreachable from shipped callers, because recommend, evaluate and the
// spawn guard always flag a supplied consequence as explicit — which sends it
// to the grid, exactly as before resolveRoute() existed.
//
// Two layers of pinning:
//   1. behavioural — each caller, given a consequence that DEPARTS from a
//      trial type's preset, answers from the grid (no trial), where the
//      non-explicit shape would have answered from the floored trial;
//   2. static — every resolveRoute()/resolveExpected() call site in the
//      plugin source that passes `consequence` also passes
//      `consequenceExplicit`, so a new caller cannot quietly reopen it.
// Plus the slice-1 caller surface: --explain, and the spawns.jsonl fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PLUGIN_ROOT, makeFixture, runScript, runHook, readJsonl } from './helpers.mjs';

// debug-root-cause: preset 4/diagnostic/routine, trial opus/low.
// Explicit elevated -> grid 4/diagnostic/elevated = sonnet/xhigh.
// (Non-explicit elevated would be the floored trial, opus/high.)
const TYPE = 'debug-root-cause';
const GRID_ELEVATED = 'sonnet/xhigh';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

test('recommend: a supplied --consequence is explicit, so it resolves from the grid', () => {
  const { cleanup } = makeFixture();
  try {
    const res = runScript('scripts/recommend.mjs', ['--type', TYPE, '--consequence', 'elevated', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(`${res.json.model}/${res.json.effort}`, GRID_ELEVATED);
    assert.equal(res.json.trial, undefined);
  } finally { cleanup(); }
});

test('evaluate: a supplied --consequence is explicit, so the expected route is the grid', () => {
  const { cleanup } = makeFixture();
  try {
    const res = runScript('scripts/evaluate.mjs', ['--model', 'sonnet', '--effort', 'xhigh', '--type', TYPE, '--consequence', 'elevated', '--json']);
    assert.equal(`${res.json.expected.model}/${res.json.expected.effort}`, GRID_ELEVATED, JSON.stringify(res.json));
    assert.equal(res.json.expected.trial, null);
    assert.equal(res.json.verdict, 'fit');
  } finally { cleanup(); }
});

test('spawn guard: a CONSEQUENCE: line is explicit, so the fit route is the grid', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-reach-consequence', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, name: 'w', prompt: `TYPE: ${TYPE}\nCONSEQUENCE: elevated\nfind it` },
    }, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.fit_expected, GRID_ELEVATED);
    assert.equal(row.fit_trial, false);
    assert.equal(row.route_layer, 'grid');
  } finally { cleanup(); }
});

// --- static: every call site flags a supplied consequence ------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!['tests', 'node_modules', '.git'].includes(name)) walk(p, out); } else if (/\.(mjs|cjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

// The argument text of each `name(` call, by paren matching.
function callArgs(text, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (/function\s+$/.test(before)) continue; // the definition itself
    let depth = 1; let i = m.index + m[0].length;
    for (; i < text.length && depth; i += 1) { if (text[i] === '(') depth += 1; else if (text[i] === ')') depth -= 1; }
    out.push({ at: text.slice(0, m.index).split('\n').length, args: text.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

test('static: every resolveRoute()/resolveExpected() call that passes consequence also passes consequenceExplicit', () => {
  const offenders = [];
  let calls = 0;
  for (const file of walk(PLUGIN_ROOT)) {
    const rel = relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    for (const name of ['resolveRoute', 'resolveExpected']) {
      for (const c of callArgs(text, name)) {
        if (rel === 'hooks/lib/context.mjs' && name === 'resolveRoute' && /consequenceExplicit/.test(c.args)) continue; // the wrapper forwards the flag
        calls += 1;
        if (/\bconsequence\b/.test(c.args) && !/\bconsequenceExplicit\b/.test(c.args)) offenders.push(`${rel}:${c.at} ${name}(${c.args.replace(/\s+/g, ' ').slice(0, 120)})`);
      }
    }
  }
  assert.ok(calls >= 6, `expected at least 6 call sites, found ${calls}`);
  assert.deepEqual(offenders, []);
});

// --- recommend --explain -----------------------------------------------------

test('recommend --explain prints the full stack, the winner, the floors and a provenance line', () => {
  const { cleanup } = makeFixture();
  try {
    const res = runScript('scripts/recommend.mjs', ['--type', TYPE, '--explain']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /EXPLAIN/);
    assert.match(res.stdout, /profile\s+absent\s+-/);
    assert.match(res.stdout, /trial\s+won\s+opus\/low/);
    assert.match(res.stdout, /grid\s+shadowed\s+sonnet\/xhigh/);
    assert.match(res.stdout, /winner:\s+trial -> opus\/low/);
    assert.match(res.stdout, /floors:\s+none fired/);
    assert.match(res.stdout, /provenance: shipped trial/);

    const dep = runScript('scripts/recommend.mjs', ['--type', TYPE, '--weight', '3', '--explain']);
    assert.match(dep.stdout, /trial\s+skipped\s+opus\/low\s+\(explicit weight departs/);
    assert.match(dep.stdout, /winner:\s+grid/);

    const j = runScript('scripts/recommend.mjs', ['--type', TYPE, '--explain', '--json']).json;
    assert.equal(j.route.layer, 'trial');
    assert.equal(j.route.profileRevision, null);
    assert.deepEqual(j.route.floorsApplied, []);

    // Without --explain the output is unchanged: no route block.
    assert.equal(runScript('scripts/recommend.mjs', ['--type', TYPE, '--json']).json.route, undefined);
  } finally { cleanup(); }
});

// --- spawns.jsonl: declared_type, route_layer, route_profile_rev -------------

test('spawns.jsonl carries declared_type, route_layer and route_profile_rev, and the fit note names the layer', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const spawn = (sid, prompt, model) => runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: 'w', prompt },
    }, { env: baseEnv(dir) });
    spawn('sess-tel-trial', `TYPE: ${TYPE}\ngo`, 'opus');
    spawn('sess-tel-grid', 'WEIGHT: 3\ngo', 'sonnet');
    spawn('sess-tel-none', 'no declaration at all', 'sonnet');
    const under = spawn('sess-tel-under', `TYPE: ${TYPE}\ngo`, 'haiku');
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const by = Object.fromEntries(rows.map((r) => [r.session_id, r]));
    assert.deepEqual([by['sess-tel-trial'].declared_type, by['sess-tel-trial'].route_layer, by['sess-tel-trial'].route_profile_rev], [TYPE, 'trial', null]);
    assert.deepEqual([by['sess-tel-grid'].declared_type, by['sess-tel-grid'].route_layer, by['sess-tel-grid'].route_profile_rev], [null, 'grid', null]);
    assert.deepEqual([by['sess-tel-none'].route_layer, by['sess-tel-none'].route_profile_rev], [null, null]);
    for (const r of rows) {
      assert.ok('route_layer' in r && 'route_profile_rev' in r && 'declared_type' in r, JSON.stringify(r));
    }
    assert.match(under.json?.systemMessage || '', /under-provisioned .*\[route layer: shipped trial\]/);
  } finally { cleanup(); }
});
