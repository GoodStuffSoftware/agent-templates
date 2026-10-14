import './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitClean } from '../scripts/lib/git-env.mjs';
import {
  loadConfig, validateLayer, resolveLayers, explain, renderExplain, listScenarios, discoverProjects,
  mainWorktreeOf, sanitizeLabel, invalidSignalPath, userConfigPath, SHIPPED_DEFAULTS_PATH, CAPS,
} from '../scripts/lib/usage/config.mjs';
import { main as cli } from '../scripts/usage-config.mjs';

const made = [];
const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ac-usagecfg-${p}-`))); made.push(d); return d; };
after(() => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

const BASE = { schema: 'agent-companion/usage-analysis', schemaVersion: 1 };
const sc = (id, over = {}) => ({ id, metric: 'day.units', compare: ['prior-day'], threshold: { direction: 'up-is-worse', relPct: 25 }, severity: 'info', ...over });
const writeJson = (path, obj) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

// A shipped file of our own, so the matrix does not depend on the real defaults.
function shippedFile(dir, scenarios = [sc('lead.unitsPerPrompt'), sc('day.units')], extra = {}) {
  const p = join(dir, 'shipped.json');
  writeJson(p, { ...BASE, defaults: { threshold: { relPct: 25, minSample: 15, minDays: 1 } }, scenarios, ...extra });
  return p;
}
function repo(name, projectFile) {
  const d = join(tmp('repo'), name);
  mkdirSync(d, { recursive: true });
  gitClean(['init', '-q', d]);
  if (projectFile !== undefined) writeJson(join(d, '.claude', 'agent-companion', 'usage-analysis.json'), projectFile);
  return d.replace(/\\/g, '/');
}
const load = (root, shippedPath, cwds = [], more = {}) => loadConfig({ root, shippedPath, cwds, ...more });
const userFile = (root, obj) => writeJson(userConfigPath(root), obj);

test('shipped defaults validate clean, carry only global scenarios, and name no machine-specific thing', () => {
  const root = tmp('root');
  const cfg = load(root, SHIPPED_DEFAULTS_PATH);
  assert.equal(cfg.shipped.status, 'ok');
  assert.deepEqual(cfg.problems, []);
  const raw = readFileSync(SHIPPED_DEFAULTS_PATH, 'utf8');
  const j = JSON.parse(raw);
  assert.equal(j.environment, undefined);
  assert.ok(j.windows === undefined && j.exclusions === undefined && j.overrides === undefined && j.disable === undefined);
  assert.ok(j.scenarios.length >= 30);
  for (const s of j.scenarios) assert.ok(!s.id.startsWith('u.') && !s.id.includes(':'), s.id);
  assert.equal(new Set(j.scenarios.map((s) => s.id)).size, j.scenarios.length);
  assert.ok(!/sessionId|titlePattern|weeklyLimitUnits|2677/.test(raw));
});

test('example.json loads as a user layer with no problems and its overrides win', () => {
  const root = tmp('root');
  const ex = JSON.parse(readFileSync(join(SHIPPED_DEFAULTS_PATH, '..', 'usage-analysis.example.json'), 'utf8'));
  ex.environment.projects['my-repo'].paths = []; // the path in the example does not exist here
  delete ex.environment.projects['my-repo'];
  userFile(root, ex);
  const cfg = load(root, SHIPPED_DEFAULTS_PATH);
  assert.deepEqual(cfg.problems, []);
  assert.equal(cfg.resolved.scenarios.get('lead.unitsPerPrompt').def.threshold.relPct, 30);
  assert.equal(cfg.resolved.scenarios.get('u.leadsXhighVsHigh').layer, 'user');
  assert.equal(cfg.resolved.scenarios.get('spawn.simpleRuns').state, 'disabled');
  assert.equal(cfg.resolved.environment.plan.weeklyLimitUnits, 2677);
});

test('precedence matrix: user overrides > project (own ids) > shipped, field by field', () => {
  const root = tmp('root');
  const dir = tmp('s');
  const shipped = shippedFile(dir, [sc('lead.unitsPerPrompt', { title: 'Shipped title', threshold: { direction: 'up-is-worse', relPct: 25, minSample: 15 } })]);
  const r = repo('proj-a', {
    ...BASE,
    scenarios: [sc('mine', { title: 'Project title', threshold: { relPct: 40, minSample: 5 } })],
    overrides: { mine: { threshold: { relPct: 35 } } },
  });
  userFile(root, { ...BASE, overrides: { 'lead.unitsPerPrompt': { threshold: { relPct: 30 } }, 'project:proj-a/mine': { title: 'User title' } } });
  const cfg = load(root, shipped, [r]);
  assert.deepEqual(cfg.problems, []);
  const lead = cfg.resolved.scenarios.get('lead.unitsPerPrompt');
  assert.equal(lead.def.threshold.relPct, 30);
  assert.equal(lead.def.threshold.minSample, 15); // untouched field keeps the shipped value
  assert.equal(lead.def.title, 'Shipped title');
  const mine = cfg.resolved.scenarios.get('project:proj-a/mine');
  assert.equal(mine.def.threshold.relPct, 35); // project override beats the project scenario
  assert.equal(mine.def.threshold.minSample, 5);
  assert.equal(mine.def.title, 'User title'); // user beats project
  assert.equal(mine.fields.title.source, 'user overrides');
  assert.equal(mine.fields['threshold.relPct'].source, 'project proj-a overrides');
  const ex = renderExplain(explain(cfg, 'lead.unitsPerPrompt'));
  assert.match(ex, /threshold\.relPct = 30 \(user overrides; shipped 25\)/);
});

test('arrays are replaced, objects merge, disable is a union', () => {
  const root = tmp('root');
  const dir = tmp('s');
  const shipped = shippedFile(dir, [sc('a.one', { cohort: { class: ['lead'], model: ['x*'] }, compare: ['prior-day', 'trailing-7'] })]);
  const r = repo('proj-b', { ...BASE, scenarios: [sc('p')], disable: ['p'] });
  userFile(root, { ...BASE, disable: ['a.one'], overrides: { 'a.one': { cohort: { class: ['worker'] }, compare: ['same-weekday-4'] } } });
  const cfg = load(root, shipped, [r]);
  const a = cfg.resolved.scenarios.get('a.one');
  assert.deepEqual(a.def.cohort.class, ['worker']);
  assert.deepEqual(a.def.cohort.model, ['x*']);
  assert.deepEqual(a.def.compare, ['same-weekday-4']);
  assert.deepEqual([...cfg.resolved.disabled].sort(), ['a.one', 'project:proj-b/p']);
  assert.equal(a.state, 'disabled');
});

test('user layer: new ids need u., overrides cannot change id or metric, unknown override target warns', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  userFile(root, {
    ...BASE,
    scenarios: [sc('lead.unitsPerPrompt'), sc('u.fine')],
    overrides: { 'lead.unitsPerPrompt': { metric: 'day.units' }, 'nope.nothing': { severity: 'off' } },
  });
  const cfg = load(root, shipped);
  assert.ok(cfg.resolved.scenarios.has('u.fine'));
  assert.equal(cfg.resolved.scenarios.get('lead.unitsPerPrompt').layer, 'shipped');
  const msgs = cfg.problems.flatMap((p) => p.messages).join('\n');
  assert.match(msgs, /must start with "u\."/);
  assert.match(msgs, /id and metric cannot be overridden/);
  assert.ok(cfg.resolved.warnings.some((w) => /unknown scenario "nope\.nothing"/.test(w)));
});

test('a project file cannot set environment keys: refused with a reason, no effect', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const r = repo('proj-c', {
    ...BASE,
    environment: { llm: { enabled: true, maxUnitsPerRun: 999 }, plan: { weeklyLimitUnits: 1 }, day: { boundaryUtcHour: 3 } },
    defaults: { threshold: { relPct: 1 } },
    metrics: { 'u.x': { ratio: ['count.a', 'count.b'] } },
    scenarios: [sc('ok')],
  });
  const cfg = load(root, shipped, [r]);
  const proj = cfg.projects[0];
  assert.equal(proj.status, 'ok');
  const paths = proj.refusals.map((x) => x.path).sort();
  assert.deepEqual(paths, ['defaults', 'environment', 'metrics']);
  assert.match(proj.refusals.find((x) => x.path === 'environment').message, /environment key in committed file/);
  assert.equal(cfg.resolved.environment.llm.enabled, false);
  assert.equal(cfg.resolved.environment.day.boundaryUtcHour, 8);
  assert.equal(cfg.resolved.environment.plan, undefined);
  assert.equal(cfg.resolved.thresholdDefaults.relPct, 25);
  assert.ok(cfg.resolved.scenarios.has('project:proj-c/ok')); // the rest still loads
  assert.match(renderExplain(explain(cfg, 'environment')), /project proj-c: environment refusal \(environment key in committed file\)/);
  assert.ok(cfg.problems.length > 0);
});

test('a project file cannot hold a regex, a session id, a foreign project, or reach another layer', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const r = repo('proj-d', {
    ...BASE,
    windows: {
      okTag: { from: 'tag:v1.0.0', to: '2026-10-01' },
      badRollout: { from: 'rollout:x' },
      badDecision: { from: 'decision:y' },
    },
    exclusions: {
      words: { titleAny: ['redesign', 'mock'] },
      bySession: { sessionId: ['ab12cd'] },
      byRule: { rule: 'anything' },
      byRegexWord: { titleAny: ['(a+)+$'] },
    },
    scenarios: [
      sc('pattern', { cohort: { titlePattern: '^design' } }),
      sc('session', { cohort: { sessionId: ['ab12cd'] } }),
      sc('otherProject', { cohort: { project: ['someone-else'] } }),
      sc('regexWord', { cohort: { titleAny: ['a|b'] } }),
      sc('foreignExclusion', { excludeSets: ['fable-tree'] }),
      sc('foreignWindow', { compare: [{ window: 'leads-xhigh', vs: 'pre-window' }] }),
      sc('prefixed', { id: 'project:other/x' }),
      sc('good', { excludeSets: ['words'], compare: [{ window: 'okTag', vs: 'pre-window' }], cohort: { titleAny: ['design'] } }),
    ],
    disable: ['lead.unitsPerPrompt', 'good'],
    overrides: { 'lead.unitsPerPrompt': { severity: 'off' }, good: { severity: 'alert' } },
  });
  userFile(root, { ...BASE, windows: { 'leads-xhigh': { from: '2026-10-10' } }, exclusions: { 'fable-tree': { model: ['claude-fable-*'] } } });
  const cfg = load(root, shipped, [r]);
  const proj = cfg.projects[0];
  assert.equal(proj.status, 'ok');
  assert.deepEqual(proj.scenarios.map((s) => s.id), ['project:proj-d/good']);
  assert.deepEqual(Object.keys(proj.windows), ['project:proj-d/okTag']);
  assert.deepEqual(Object.keys(proj.exclusions), ['project:proj-d/words']);
  const refused = proj.refusals.map((x) => `${x.id || ''}:${x.path}`).join('\n');
  for (const needle of ['pattern', 'session', 'otherProject', 'regexWord', 'foreignExclusion', 'foreignWindow']) assert.ok(refused.includes(needle), needle);
  assert.ok(proj.refusals.some((x) => /regex refused/.test(x.message)));
  assert.ok(proj.refusals.some((x) => /session ids are refused/.test(x.message)));
  // the user's own layer and the shipped scenario are untouched
  assert.equal(cfg.resolved.scenarios.get('lead.unitsPerPrompt').def.severity, 'info');
  assert.ok(!cfg.resolved.disabled.has('lead.unitsPerPrompt'));
  assert.deepEqual(cfg.resolved.disabled.has('project:proj-d/good'), true);
  assert.equal(cfg.resolved.windows['leads-xhigh'].from, '2026-10-10');
  assert.equal(cfg.resolved.scenarios.get('project:proj-d/good').def.cohort.project[0], 'proj-d');
});

test('project ids are namespaced, so a project scenario cannot collide with a shipped id', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const r = repo('proj-e', { ...BASE, scenarios: [sc('lead.unitsPerPrompt'), sc('day.units')].map((s) => ({ ...s, id: s.id.replace(/\./g, '_') })) });
  const r2 = repo('proj-f', { ...BASE, scenarios: [sc('same')] });
  const r3 = repo('proj-g', { ...BASE, scenarios: [sc('same')] });
  const cfg = load(root, shipped, [r, r2, r3]);
  const ids = [...cfg.resolved.scenarios.keys()].sort();
  assert.deepEqual(ids, ['day.units', 'lead.unitsPerPrompt', 'project:proj-e/day_units', 'project:proj-e/lead_unitsPerPrompt', 'project:proj-f/same', 'project:proj-g/same']);
  assert.equal(cfg.resolved.scenarios.get('lead.unitsPerPrompt').layer, 'shipped');
  const dotted = validateLayer({ ...BASE, scenarios: [sc('a.b')] }, 'project', { label: 'x' });
  assert.equal(dotted.scenarios.length, 1);
  const colon = validateLayer({ ...BASE, scenarios: [sc('project:y/a')] }, 'project', { label: 'x' });
  assert.equal(colon.scenarios.length, 0);
});

test('a higher major version is ignored whole, lower layers load, and the signal file is written then cleared', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const r = repo('proj-h', { ...BASE, schemaVersion: 2, scenarios: [sc('future')] });
  userFile(root, { ...BASE, scenarios: [sc('u.alive')] });
  const cfg = load(root, shipped, [r]);
  assert.equal(cfg.projects[0].status, 'higher-major');
  assert.ok(!cfg.resolved.scenarios.has('project:proj-h/future'));
  assert.ok(cfg.resolved.scenarios.has('u.alive'));
  assert.ok(cfg.resolved.scenarios.has('lead.unitsPerPrompt'));
  const sig = JSON.parse(readFileSync(invalidSignalPath(root), 'utf8'));
  assert.equal(sig.signal, 'usage_analysis_config_invalid');
  assert.equal(sig.problems[0].kind, 'higher-major');
  assert.ok(invalidSignalPath(root).replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/')));
  // a higher-major USER file falls back to the shipped layer
  userFile(root, { ...BASE, schemaVersion: 7, scenarios: [sc('u.alive')] });
  const cfg2 = load(root, shipped);
  assert.equal(cfg2.user.status, 'higher-major');
  assert.ok(!cfg2.resolved.scenarios.has('u.alive'));
  assert.ok(cfg2.resolved.scenarios.has('lead.unitsPerPrompt'));
  // fixing the file clears the marker
  userFile(root, { ...BASE, scenarios: [sc('u.alive')] });
  const cfg3 = load(root, shipped);
  assert.deepEqual(cfg3.problems, []);
  assert.equal(existsSync(invalidSignalPath(root)), false);
});

test('a bad project file (unparseable, wrong schema, oversized) leaves the user layer working', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  userFile(root, { ...BASE, scenarios: [sc('u.alive')], overrides: { 'lead.unitsPerPrompt': { severity: 'alert' } } });
  for (const bad of ['{ not json', JSON.stringify({ schema: 'something/else', schemaVersion: 1 }), JSON.stringify({ ...BASE, pad: 'x'.repeat(CAPS.projectBytes + 10) }), '[]']) {
    const r = repo('proj-bad', bad);
    const cfg = load(root, shipped, [r], { writeSignal: false });
    assert.equal(cfg.projects[0].status, 'invalid', bad.slice(0, 20));
    assert.ok(cfg.resolved.scenarios.has('u.alive'));
    assert.equal(cfg.resolved.scenarios.get('lead.unitsPerPrompt').def.severity, 'alert');
    assert.ok(cfg.problems.length > 0);
  }
});

test('unknown keys are kept and ignored; a scenario keeps unknown fields under extra', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  userFile(root, { ...BASE, futureKey: { a: 1 }, scenarios: [{ ...sc('u.x'), flavour: 'new', cohort: { class: ['lead'], newFilter: ['q'] } }], environment: { newSection: { z: 1 }, day: { boundaryUtcHour: 8, extraBit: true } } });
  const cfg = load(root, shipped);
  assert.deepEqual(cfg.problems, []);
  assert.deepEqual(cfg.user.unknown, { futureKey: { a: 1 } });
  assert.equal(cfg.resolved.scenarios.get('u.x').extra.flavour, 'new');
  assert.deepEqual(cfg.resolved.scenarios.get('u.x').def.cohort.newFilter, ['q']);
  assert.equal(cfg.resolved.environment.newSection.z, 1);
  assert.equal(cfg.resolved.environment.day.extraBit, true);
  assert.equal(cfg.resolved.environment.day.boundaryUtcHour, 8);
});

test('caps: long strings, deep nesting, regex length and form, prototype keys, bad ranges', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const cases = [
    [{ ...BASE, scenarios: [sc('u.a', { title: 'x'.repeat(CAPS.string + 1) })] }, /longer than/],
    [{ ...BASE, a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }, /nesting deeper/],
    [JSON.stringify(BASE).replace('{', '{"__proto__":{"polluted":1},'), /forbidden key/],
    [{ ...BASE, scenarios: [sc('u.a', { cohort: { titlePattern: 'a'.repeat(CAPS.regex + 1) } })] }, /at most 200/],
    [{ ...BASE, scenarios: [sc('u.a', { cohort: { titlePattern: '(a+)+$' } })] }, /catastrophic/],
    [{ ...BASE, scenarios: [sc('u.a', { cohort: { titlePattern: '([' } })] }, /does not compile/],
    [{ ...BASE, scenarios: [sc('u.a', { threshold: { relPct: -1 } })] }, /relPct/],
    [{ ...BASE, scenarios: [sc('u.a', { severity: 'loud' })] }, /severity/],
    [{ ...BASE, environment: { day: { boundaryUtcHour: 24 } } }, /boundaryUtcHour/],
    [{ ...BASE, environment: { week: { resetUtc: 'Friday 4pm' } } }, /resetUtc/],
    [{ ...BASE, scenarios: [sc('u.a'), sc('u.a')] }, /duplicate/],
  ];
  for (const [body, re] of cases) {
    userFile(root, body);
    const cfg = load(root, shipped, [], { writeSignal: false });
    assert.match(cfg.problems.flatMap((p) => p.messages).join('\n'), re);
    assert.ok(cfg.resolved.scenarios.has('lead.unitsPerPrompt'));
  }
  assert.equal({}.polluted, undefined);
  // a sane regex IS accepted in the user layer
  userFile(root, { ...BASE, scenarios: [sc('u.a', { cohort: { titlePattern: '^(redesign|mock)\\b' } })] });
  assert.deepEqual(load(root, shipped, [], { writeSignal: false }).problems, []);
});

test('metric registry (when supplied) rejects unknown metrics and undeclared params', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  userFile(root, { ...BASE, scenarios: [sc('u.a', { metric: 'no.such' }), sc('u.b', { params: { taskMinChars: 60 } }), sc('u.c', { params: { bogus: 1 } })] });
  const cfg = load(root, shipped, [], { writeSignal: false, metrics: { 'day.units': { params: { defaults: { taskMinChars: 60 } } }, 'lead.unitsPerPrompt': {} } });
  const ids = [...cfg.resolved.scenarios.keys()];
  assert.ok(ids.includes('u.b') && !ids.includes('u.a') && !ids.includes('u.c'));
});

test('windows and exclusions: undefined references make a scenario a gap, never silently ignored', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  userFile(root, { ...BASE, scenarios: [sc('u.a', { excludeSets: ['ghost'], compare: [{ window: 'nowhere', vs: 'pre-window' }] })] });
  const cfg = load(root, shipped, [], { writeSignal: false });
  const row = listScenarios(cfg).find((r) => r.id === 'u.a');
  assert.equal(row.state, 'gap');
  assert.match(row.why, /exclusion "ghost" is not defined/);
  assert.match(row.why, /window "nowhere" is not defined/);
});

test('discovery: linked worktrees map to the main worktree; labels; autoload off; configured paths; cache', () => {
  const main = repo('Main Repo');
  gitClean(['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = join(tmp('wt'), 'linked').replace(/\\/g, '/');
  gitClean(['-C', main, 'worktree', 'add', '-q', '-b', 'side', wt]);
  const cache = new Map();
  assert.equal(mainWorktreeOf(wt, { cache }), main);
  assert.equal(mainWorktreeOf(main, { cache }), main);
  const d = discoverProjects({ cwds: [wt, main, tmp('plain')], cache });
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].label, 'main-repo');
  assert.equal(d.projects[0].file, `${main}/.claude/agent-companion/usage-analysis.json`);
  assert.ok(d.skipped.some((s) => /not inside a git repository/.test(s.reason)));
  assert.equal(discoverProjects({ cwds: [wt], environment: { projects: { autoload: false } }, cache }).projects.length, 0);
  const named = discoverProjects({ cwds: [wt], environment: { projects: { autoload: false, mine: { paths: [main] } } }, cache });
  assert.deepEqual(named.projects.map((p) => p.label), ['mine']);
  // git is asked once per cwd
  let calls = 0;
  const git = (...a) => { calls++; return gitClean(...a); };
  const c2 = new Map();
  mainWorktreeOf(wt, { cache: c2, git }); mainWorktreeOf(wt, { cache: c2, git });
  assert.equal(calls, 1);
  assert.equal(sanitizeLabel('Best Thing_2'), 'best-thing_2');
  assert.equal(sanitizeLabel('...'), null);
});

test('discovery: two worktrees claiming one label keep the first and report the second', () => {
  const a = repo('same-name');
  const b = join(tmp('other'), 'same-name').replace(/\\/g, '/');
  mkdirSync(b, { recursive: true });
  gitClean(['init', '-q', b]);
  const d = discoverProjects({ cwds: [a, b], cache: new Map() });
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].mainWorktree, a);
  assert.ok(d.skipped.some((s) => /already used/.test(s.reason)));
});

test('a project file that is a symbolic link is refused', (t) => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const r = repo('proj-sym');
  const real = join(tmp('real'), 'x.json');
  writeJson(real, { ...BASE, scenarios: [sc('sneaky')] });
  mkdirSync(join(r, '.claude', 'agent-companion'), { recursive: true });
  try { symlinkSync(real, join(r, '.claude', 'agent-companion', 'usage-analysis.json')); } catch { t.skip('symlinks not permitted here'); return; }
  const cfg = load(root, shipped, [r], { writeSignal: false });
  assert.equal(cfg.projects[0].status, 'invalid');
  assert.ok(!cfg.resolved.scenarios.has('project:proj-sym/sneaky'));
});

test('CLI: check exits 0 clean and 1 on problems; explain and list print; nothing outside --root is written', () => {
  const root = tmp('root');
  const shipped = shippedFile(tmp('s'));
  const lines = [];
  const out = (s) => lines.push(s);
  const nowhere = tmp('nowhere');
  assert.equal(cli(['check', '--root', root, '--shipped', shipped], { out, cwd: nowhere }), 0);
  assert.match(lines.join('\n'), /ok$/);
  userFile(root, { ...BASE, environment: { llm: { enabled: 'yes' } } });
  lines.length = 0;
  assert.equal(cli(['check', '--root', root, '--shipped', shipped], { out, cwd: nowhere }), 1);
  assert.match(lines.join('\n'), /FAIL/);
  assert.equal(existsSync(invalidSignalPath(root)), true);
  userFile(root, { ...BASE, overrides: { 'lead.unitsPerPrompt': { threshold: { relPct: 30 } } } });
  lines.length = 0;
  assert.equal(cli(['explain', 'lead.unitsPerPrompt', '--root', root, '--shipped', shipped], { out, cwd: nowhere }), 0);
  assert.match(lines.join('\n'), /threshold\.relPct = 30 \(user overrides; shipped 25\)/);
  lines.length = 0;
  assert.equal(cli(['explain', 'nope', '--root', root, '--shipped', shipped], { out, cwd: nowhere }), 1);
  lines.length = 0;
  assert.equal(cli(['list', '--json', '--root', root, '--shipped', shipped], { out, cwd: nowhere }), 0);
  assert.deepEqual(JSON.parse(lines[0]).map((r) => r.id), ['day.units', 'lead.unitsPerPrompt']);
  assert.equal(cli(['bogus'], { out, cwd: nowhere }), 2);
  assert.equal(existsSync(invalidSignalPath(root)), false);
});

test('source hygiene: no direct child_process, no claude invocation, no shell windows', () => {
  for (const f of ['../scripts/lib/usage/config.mjs', '../scripts/usage-config.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/node:child_process|from 'child_process'/.test(src), f);
    assert.ok(!/['"`]claude['"`]/.test(src), f);
  }
  assert.match(readFileSync(new URL('../scripts/lib/proc.mjs', import.meta.url), 'utf8'), /windowsHide: true/); // gitClean spawns through it
});

test('resolveLayers tolerates every layer being absent', () => {
  const r = resolveLayers({ shipped: { status: 'absent' }, user: { status: 'absent' }, projects: [] });
  assert.equal(r.scenarios.size, 0);
  assert.equal(r.environment.day.boundaryUtcHour, 8);
  assert.equal(r.thresholdDefaults.relPct, 25);
});
