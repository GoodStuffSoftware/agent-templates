// Per-project command lists: validation against the gate, the loader, the spawn-brief block and the gate's deny pointer.
// Project names and paths are invented; repositories are throwaway folders under a fixture temp dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  checkCommand, loadCommands, commandsPath, commandsFor, buildCommandsBlock, listedCommandFor, wantsCommands,
  COMMANDS_MARKER, COMMANDS_MAX_CHARS,
} from '../hooks/lib/project-commands.mjs';
import { gateDecision } from '../hooks/lib/resource-gate.mjs';
import { deriveCommands } from '../scripts/lib/derive-commands.mjs';

function withFixture(fn) {
  const fx = makeFixture();
  const run = async () => { try { return await fn(fx); } finally { fx.cleanup(); } };
  return run();
}
const mainRepo = (root, name) => { const d = join(root, name); mkdirSync(join(d, '.git'), { recursive: true }); return d; };
const writeCmds = (obj) => writeFileSync(commandsPath(), JSON.stringify(obj));
const LIST = { install: 'npm ci', testFile: 'npx vitest run {file}', suite: 'npm test', lint: 'npm run lint', build: 'npm run build' };

test('checkCommand: plain commands pass', () => {
  for (const [kind, c] of Object.entries(LIST)) assert.equal(checkCommand(kind, c), null, `${kind}: ${c}`);
  assert.equal(checkCommand('suite', './gradlew --no-daemon test'), null);
});

test('checkCommand: the shapes the gate denies are refused', () => {
  const bad = [
    ['install', 'cd app && npm ci'], ['install', 'cd app'], ['lint', 'npm run lint && npm test'], ['lint', 'npm run lint || true'],
    ['suite', 'npm test &'], ['suite', 'npm test; npm run lint'], ['suite', 'npm test | tail'], ['build', 'cat <<EOF\nx\nEOF'],
    ['build', 'echo $(npm run build)'], ['install', 'RESOURCE_QUEUE=0 npm ci'], ['install', ''], ['install', '   '], ['install', 5],
    ['testFile', 'npx vitest run'], ['suite', 'npx vitest run {file}'], ['nope', 'npm ci'],
  ];
  for (const [kind, c] of bad) assert.ok(checkCommand(kind, c), `${kind}: ${JSON.stringify(c)} should be refused`);
});

test('loadCommands: bad commands are dropped and flagged, good ones kept; missing and broken files are tolerated', () => withFixture(({ dir }) => {
  assert.deepEqual(loadCommands().entries, []);
  writeFileSync(commandsPath(), '{ not json');
  assert.match(loadCommands().problems[0], /not valid JSON/);
  writeCmds({ projects: { 'acme-app': { install: 'npm ci', lint: 'cd x && npm run lint', build: 'npm run build', cwd: 'web' }, 'empty-app': { lint: 'a && b' } } });
  const c = loadCommands();
  assert.equal(c.entries.length, 1);
  assert.deepEqual(c.entries[0].cmds, { install: 'npm ci', build: 'npm run build' });
  assert.equal(c.entries[0].cwd, 'web');
  assert.ok(c.problems.some((p) => /acme-app.*lint/.test(p)));
  assert.ok(c.problems.some((p) => /empty-app.*lint/.test(p)));
}));

test('commandsFor: name key, path key, worktree of the main repo, path beats name, no match', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const other = mainRepo(join(dir, 'work'), 'other-app');
  const gitdir = join(main, '.git', 'worktrees', 'w1');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..');
  const wt = join(dir, 'wt', 'w1');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`);
  writeCmds({ projects: { 'acme-app': { suite: 'npm test' } } });
  assert.equal(commandsFor(main).cmds.suite, 'npm test');
  assert.equal(commandsFor(wt).project, 'acme-app'); // a worktree matches its parent repo
  assert.equal(commandsFor(other), null);
  assert.equal(commandsFor(join(dir, 'nowhere')), null);
  writeCmds({ projects: { 'acme-app': { suite: 'npm test' }, [main.replace(/\\/g, '/')]: { suite: 'npm run test:all' } } });
  assert.equal(commandsFor(wt).cmds.suite, 'npm run test:all');
}));

test('buildCommandsBlock: roles and types that get it, project match, no list, size, no double append', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const bare = mainRepo(join(dir, 'work'), 'unlisted-app');
  writeCmds({ projects: { 'acme-app': { ...LIST, cwd: 'web' } } });
  for (const role of ['writer', 'fixer', 'lander']) {
    const b = buildCommandsBlock(undefined, role, 'do it', main);
    assert.ok(b.startsWith(`\n\n${COMMANDS_MARKER}`), role);
    assert.match(b, /install: npm ci/);
    assert.match(b, /test a file: npx vitest run \{file\}/);
    assert.match(b, /from web/);
    assert.ok(b.length <= COMMANDS_MAX_CHARS + 2, `block is ${b.length} chars`);
  }
  assert.ok(buildCommandsBlock('e2e', undefined, 'x', main));
  assert.ok(buildCommandsBlock('verify', 'lookup', 'x', main));
  for (const role of ['reviewer', 'docs', 'lookup', 'operate', undefined]) assert.equal(buildCommandsBlock('research', role, 'x', main), '', String(role));
  assert.equal(buildCommandsBlock(undefined, 'writer', 'x', bare), ''); // project without a list
  assert.equal(buildCommandsBlock(undefined, 'writer', 'x', join(dir, 'nowhere')), '');
  assert.equal(buildCommandsBlock(undefined, 'writer', `x ${COMMANDS_MARKER}`, main), '');
  assert.equal(wantsCommands('bounded-feature', 'writer'), true);
  assert.equal(wantsCommands('bounded-feature', 'reviewer'), false);
}));

test('buildCommandsBlock: an invalid command never reaches the brief', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  writeCmds({ projects: { 'acme-app': { install: 'cd web && npm ci', lint: 'npm run lint' } } });
  const b = buildCommandsBlock(undefined, 'writer', 'x', main);
  assert.match(b, /lint: npm run lint/);
  assert.doesNotMatch(b, /install/);
}));

test('gate deny text names the project listed command for the denied class', () => withFixture(async ({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const other = mainRepo(join(dir, 'work'), 'unlisted-app');
  writeCmds({ projects: { 'acme-app': { install: 'npm ci --ignore-scripts', lint: 'npm run lint:changed' } } });
  const rules = { classes: [{ id: 'install', box: 2 }, { id: 'lint', box: 2 }, { id: 'build', box: 2 }], claudeHome: '/nonexistent-home' };
  const opts = (cwd) => ({ cwd, mode: 'deny', rulesInline: rules, env: { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home' } });
  const d = await gateDecision('npm install', opts(main));
  assert.equal(d.action, 'deny');
  assert.match(d.text, /lists its install command as: npm ci --ignore-scripts/);
  const l = await gateDecision('npx eslint .', opts(main));
  assert.match(l.text, /lists its lint command as: npm run lint:changed/);
  const b = await gateDecision('npm run build', opts(main)); // listed project, but no build entry
  assert.equal(b.action, 'deny');
  assert.doesNotMatch(b.text, /lists its/);
  const u = await gateDecision('npm install', opts(other)); // project without a list
  assert.equal(u.action, 'deny');
  assert.doesNotMatch(u.text, /lists its/);
}));

test('listedCommandFor: class to kind mapping', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  writeCmds({ projects: { 'acme-app': LIST } });
  assert.match(listedCommandFor(['vitest-dir'], main), /test a file command as: npx vitest run \{file\}/);
  assert.match(listedCommandFor(['node-test-full'], main), /suite command as: npm test/);
  assert.match(listedCommandFor(['gradle'], main), /build command as: npm run build/);
  assert.equal(listedCommandFor(['push-gate'], main), '');
  assert.equal(listedCommandFor([], main), '');
}));

test('deriveCommands: package.json, Makefile and docs; every proposal passes the gate check', () => withFixture(({ dir }) => {
  const repo = join(dir, 'derive-app');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'vite build' }, devDependencies: { vitest: '1' } }));
  writeFileSync(join(repo, 'package-lock.json'), '{}');
  writeFileSync(join(repo, 'CLAUDE.md'), 'Lint with `npm run lint:changed`. Test one file: `npx vitest run <file>`. Bad: `cd web && npm ci`.\n');
  const { entries } = deriveCommands(repo);
  assert.equal(entries.install.command, 'npm ci');
  assert.equal(entries.suite.command, 'npm test');
  assert.equal(entries.lint.command, 'npm run lint:changed'); // the docs win
  assert.equal(entries.lint.source, 'CLAUDE.md');
  assert.equal(entries.testFile.command, 'npx vitest run {file}');
  assert.equal(entries.build.command, 'npm run build');
  const mk = join(dir, 'make-app');
  mkdirSync(mk, { recursive: true });
  writeFileSync(join(mk, 'Makefile'), 'test:\n\techo hi\nbuild:\n\techo b\n');
  assert.deepEqual(Object.keys(deriveCommands(mk).entries).sort(), ['build', 'suite']);
  assert.deepEqual(deriveCommands(join(dir, 'empty')).entries, {});
}));
