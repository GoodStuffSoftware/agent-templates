// 0.31.18 assembly: importing the decision register (as every hook that uses it does) must not load the
// usage config or runner modules. Evaluating a scenario trigger reads result files with light readers;
// only validating a scenario trigger loads the usage config, lazily. A fresh node process per check, with
// a module-load recorder, so module state is clean.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import { usagePaths, RESULT_SCHEMA } from '../scripts/lib/usage/runner.mjs';

const REG = pathToFileURL(join(PLUGIN_ROOT, 'scripts', 'lib', 'decision-register.mjs')).href;

// Runs `body` (module code; `R` is the register namespace) in a fresh node and returns the file URLs
// the ESM loader loaded, plus stdout.
function loadedAfter(fx, body) {
  const dir = join(fx.dir, 'probe');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'loaded.txt');
  writeFileSync(join(dir, 'loader.mjs'), `import { appendFileSync } from 'node:fs';
export async function load(url, ctx, next) { appendFileSync(${JSON.stringify(log)}, url + '\\n'); return next(url, ctx); }
`);
  writeFileSync(join(dir, 'hook.mjs'), `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(join(dir, 'loader.mjs')).href)});
`);
  writeFileSync(join(dir, 'run.mjs'), `const R = await import(${JSON.stringify(REG)});\n${body}\n`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'hook.mjs')).href, join(dir, 'run.mjs')], {
    env: { ...process.env, AGENT_COMPANION_STATE_DIR: fx.stateDir }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  const urls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { urls, stdout: r.stdout };
}

const usageMods = (urls) => urls.filter((u) => /\/scripts\/lib\/usage\/(config|runner)\.mjs$/.test(u));

test('importing the decision register loads neither the usage config nor the usage runner', () => {
  const fx = makeFixture();
  try {
    const { urls } = loadedAfter(fx, '');
    assert.ok(urls.some((u) => u.endsWith('/scripts/lib/decision-register.mjs')), 'the recorder sees the register load');
    assert.deepEqual(usageMods(urls), []);
  } finally { fx.cleanup(); }
});

test('evaluating a scenario trigger reads results without loading the usage config or runner', () => {
  const fx = makeFixture();
  try {
    const { urls } = loadedAfter(fx, `
      R.evalScenario({ trigger: { kind: 'scenario', scenario: 'x', comparison: 'trailing-7', on: 'regression' }, history: [], decision: { decided: '2026-10-01' } });
    `);
    assert.deepEqual(usageMods(urls), []);
  } finally { fx.cleanup(); }
});

test('validating a scenario trigger still checks the id against the usage config, loaded lazily', () => {
  const fx = makeFixture();
  try {
    // (require(esm) bypasses the async loader recorder, so the proof of the lazy load is the answer itself.)
    const { stdout } = loadedAfter(fx, `
      const reg = { schema: 'agent-companion/decision-register', version: 1, decisions: [{
        id: 'd1', title: 'T', status: 'active', decided: '2026-10-01', decision: 'x', reverse: 'y',
        premises: [{ id: 'p1', text: 't', label: 'M' }],
        triggers: [{ id: 't1', premise: 'p1', kind: 'scenario', scenario: 'no.such.scenario', comparison: 'trailing-7', on: 'regression' }] }] };
      const v = R.validateRegister(reg);
      console.log(JSON.stringify(v.errors || v));
    `);
    assert.match(stdout, /not in the usage-analysis config/);
  } finally { fx.cleanup(); }
});

test('the register keeps the runner file layout and result schema in step', () => {
  assert.equal(RESULT_SCHEMA, 'agent-companion/usage-analysis-result');
  const p = usagePaths('/r');
  assert.equal(p.resultsDir.replace(/\\/g, '/'), '/r/state/usage-analysis');
  assert.equal(p.status.replace(/\\/g, '/'), '/r/state/usage-analysis-status.json');
  const src = readFileSync(join(PLUGIN_ROOT, 'scripts', 'lib', 'decision-register.mjs'), 'utf8');
  assert.ok(src.includes(`'${RESULT_SCHEMA}'`));
  assert.ok(!/^import .*usage\/(config|runner)\.mjs/m.test(src), 'no static import of the usage config or runner');
});
