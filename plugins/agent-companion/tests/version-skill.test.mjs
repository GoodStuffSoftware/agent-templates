// The `version` skill and everything that points at it: the skill itself, the
// user-level `/ac` forwarder the setup skill installs, the setup skill's list of
// subcommands, the scout routine's signal table, the README, the release doc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

const read = (...p) => readFileSync(join(PLUGIN_ROOT, ...p), 'utf8');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  assert.ok(m, 'no frontmatter');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

test('skills/version/SKILL.md: named version, triggers on the four phrases', () => {
  const src = read('skills', 'version', 'SKILL.md');
  const fm = frontmatter(src);
  assert.equal(fm.name, 'version');
  for (const phrase of ['what version', 'which agent-companion version', 'is the plugin up to date', '/ac version']) {
    assert.ok(fm.description.includes(phrase), `description must trigger on "${phrase}"`);
  }
});

test('the skill runs version.mjs from its own base directory and reports in 3 to 5 lines', () => {
  const src = read('skills', 'version', 'SKILL.md');
  assert.match(src, /<base directory>\/\.\.\/\.\.\/scripts\/version\.mjs/);
  assert.match(src, /3 to 5 plain lines/);
  assert.match(src, /all copies current/);
  assert.match(src, /STALE: <copy> is <ver>, latest is <ver>/);
  // It must tell the two kinds of session apart and name a fix for each.
  assert.match(src, /Desktop Code-tab sessions/);
  assert.match(src, /claude plugin marketplace update/);
  assert.match(src, /claude plugin update agent-companion@agent-templates/);
  assert.match(src, /disable, then re-enable,\s+agent-companion in the desktop app's plugin manager/);
  assert.match(src, /not `claude plugin\s+uninstall`/);
  assert.match(src, /idle desktop sessions pick up the current copy on\s+their next turn/);
  assert.match(src, /mid-turn\s+picks it up after that turn/);
  assert.match(src, /[Cc]onfirm\s+with\s+`\/ac version`/);
  assert.match(src, /runs the CLI cache copy,\s+so a later `claude plugin update` covers it/);
  assert.match(src, /When the app has none, desktop sessions\s+use the CLI cache copy/);
  assert.doesNotMatch(src, /not verified|untested/i);
  assert.match(src, /names an rpm path that version\.mjs does not list/);
  assert.match(src, /predates the\s+copy's removal/);
  assert.match(src, /On 2026-10-02 the desktop copy was 0\.29\.22/);
});

test('the path the skill documents resolves: <skill dir>/../../scripts/version.mjs exists and runs', () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, 'skills', 'version', '..', '..', 'scripts', 'version.mjs')));
  const fx = makeFixture();
  try {
    const res = runScript('scripts/version.mjs', [], { cwd: fx.dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^THIS copy:/);
    assert.match(res.stdout, /Verdict:/);
  } finally { fx.cleanup(); }
});

test('the /ac forwarder routes `version` to the skill, with the script as its fallback', () => {
  const shim = read('shims', 'ac', 'SKILL.md');
  assert.ok(frontmatter(shim).description.includes('"/ac version"'));
  assert.match(shim, /\| `version` \| `agent-companion:version` \| `node "\$AC\/scripts\/version\.mjs" <args>` \(reports the marketplace clone as THIS copy/);
});

test('the setup skill installs that forwarder from shims/ac and lists /ac version', () => {
  const setup = read('skills', 'setup', 'SKILL.md');
  assert.ok(setup.includes('cp "$AC/shims/ac/SKILL.md" "$HOME/.claude/skills/ac/SKILL.md"'), 'the install copy step');
  assert.match(setup, /`\/ac version`/);
  assert.ok(existsSync(join(PLUGIN_ROOT, 'shims', 'ac', 'SKILL.md')));
});

test('every skill the forwarder names exists as a plugin skill', () => {
  const shim = read('shims', 'ac', 'SKILL.md');
  const names = [...shim.matchAll(/`agent-companion:([a-z-]+)`/g)].map((m) => m[1]);
  const skills = new Set(readdirSync(join(PLUGIN_ROOT, 'skills')));
  assert.ok(names.includes('version'));
  for (const n of new Set(names)) assert.ok(skills.has(n), `forwarder names agent-companion:${n}, which is not a skill`);
});

test('the scout routine, README and release doc all know about the new pieces', () => {
  const routine = read('routines', 'calibration-scout-daily.md');
  assert.match(routine, /`plugin_copy_stale`/);
  assert.match(routine, /\| `plugin_copy_stale` \|/, 'a dispatch row for the signal');
  assert.match(routine, /desktop-plugin-refresh/);
  const readme = read('README.md');
  assert.match(readme, /\| `version` \| `\/ac version` \|/);
  assert.match(readme, /scripts\/version\.mjs/);
  const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /version\.mjs/);
  assert.match(contributing, /landed for CLI sessions/);
  assert.match(contributing, /Record the desktop copy's state separately/);
});
