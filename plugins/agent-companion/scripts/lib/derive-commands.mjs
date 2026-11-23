// derive-commands.mjs -- propose a project's command list from its own files (scripts/project-commands.mjs derive).
// Sources, weakest first: package.json scripts, a Makefile, gradle, then commands the project's own docs
// (CLAUDE.md, README, CONTRIBUTING, docs/*.md) show in backticks, which win. Reads files only; runs nothing.
// Every proposal is checked with checkCommand (hooks/lib/project-commands.mjs); a failing one is dropped.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkCommand, COMMAND_KINDS } from '../../hooks/lib/project-commands.mjs';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function fromPackage(dir, out) {
  const txt = read(join(dir, 'package.json'));
  if (!txt) return;
  let pkg;
  try { pkg = JSON.parse(txt); } catch { return; }
  const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const put = (kind, command, source) => { if (command && !out[kind]) out[kind] = { command, source }; };
  if (pm === 'npm') put('install', existsSync(join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install', 'package.json');
  else put('install', `${pm} install`, 'package.json');
  if (scripts.test) put('suite', pm === 'npm' ? 'npm test' : `${pm} test`, 'package.json scripts.test');
  for (const s of ['lint', 'typecheck', 'check']) if (scripts[s]) { put('lint', run(s), `package.json scripts.${s}`); break; }
  if (scripts.build) put('build', run('build'), 'package.json scripts.build');
  if (deps.vitest) put('testFile', 'npx vitest run {file}', 'package.json devDependencies.vitest');
  else if (deps.jest) put('testFile', 'npx jest {file}', 'package.json devDependencies.jest');
  else if (/node\s+(?:--[\w-]+\s+)*--test/.test(scripts.test || '')) put('testFile', 'node --test {file}', 'package.json scripts.test');
}

function fromMakefile(dir, out) {
  const txt = read(join(dir, 'Makefile')) ?? read(join(dir, 'makefile'));
  if (!txt) return;
  const has = (t) => new RegExp(`^${t}\\s*:`, 'm').test(txt);
  const put = (kind, command, source) => { if (!out[kind]) out[kind] = { command, source }; };
  if (has('install')) put('install', 'make install', 'Makefile');
  if (has('test')) put('suite', 'make test', 'Makefile');
  if (has('lint')) put('lint', 'make lint', 'Makefile');
  if (has('build')) put('build', 'make build', 'Makefile');
}

function fromGradle(dir, out) {
  if (!(existsSync(join(dir, 'gradlew')) || existsSync(join(dir, 'gradlew.bat')))) return;
  if (!(existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts')) || existsSync(join(dir, 'settings.gradle')) || existsSync(join(dir, 'settings.gradle.kts')))) return;
  const put = (kind, command, source) => { if (!out[kind]) out[kind] = { command, source }; };
  put('suite', './gradlew --no-daemon test', 'gradle wrapper');
  put('build', './gradlew --no-daemon assemble', 'gradle wrapper');
}

// Commands in backticks in the project's docs, one kind each. A `<file>` / `<path>` slot becomes {file}.
const DOC_FILES = ['CLAUDE.md', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md'];
function kindOfDocCommand(c) {
  if (/^(?:npm|pnpm|yarn)\s+(?:ci|install|i)$/.test(c)) return 'install';
  if (/^(?:npm|pnpm)\s+run\s+(?:lint|typecheck|type-check|check)(?::[\w:.-]+)?$/.test(c) || /^(?:npx\s+)?(?:eslint|biome\s+check|tsc\s+--noEmit)(?:\s|$)/.test(c)) return 'lint';
  if (/^(?:npm|pnpm)\s+run\s+build\b[\w:.-]*$/.test(c)) return 'build';
  if (/\{file\}$/.test(c) && /(?:vitest|jest|node\s+(?:--[\w-]+\s+)*--test|pytest)/.test(c)) return 'testFile';
  if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::unit|:ci)?$/.test(c) || /^npx\s+vitest\s+run$/.test(c)) return 'suite';
  return null;
}
// Top-level docs win over the files above; docs/*.md only fill a kind nothing else gave.
function fromDocs(dir, out) {
  scanDocs(dir, DOC_FILES.map((f) => join(dir, f)), out, 'docs');
  const files = [];
  try {
    const d = join(dir, 'docs');
    if (existsSync(d)) for (const f of readdirSync(d).filter((x) => x.endsWith('.md')).slice(0, 20)) files.push(join(d, f));
  } catch { /* no docs folder */ }
  scanDocs(dir, files, out, 'docs2');
}
function scanDocs(dir, files, out, prefix) {
  for (const f of files) {
    if (!isFile(f)) continue;
    const txt = read(f) ?? '';
    for (const m of txt.matchAll(/`([^`\n]{3,120})`/g)) {
      const c = m[1].trim().replace(/<(?:file|path|spec)>/g, '{file}');
      const kind = kindOfDocCommand(c);
      if (kind && !out[`${prefix}:${kind}`]) out[`${prefix}:${kind}`] = { command: c, source: f.slice(dir.length + 1).replace(/\\/g, '/') };
    }
  }
}

// -> { entries: { kind: { command, source } }, dropped: [string] }. Docs win over files of the same kind.
export function deriveCommands(dir) {
  const out = {};
  fromPackage(dir, out);
  fromMakefile(dir, out);
  fromGradle(dir, out);
  fromDocs(dir, out);
  const entries = {};
  const dropped = [];
  for (const kind of COMMAND_KINDS) {
    for (const cand of [out[`docs:${kind}`], out[kind], out[`docs2:${kind}`]]) {
      if (!cand) continue;
      const bad = checkCommand(kind, cand.command);
      if (bad) { dropped.push(`${kind} "${cand.command}" (${cand.source}) ${bad}`); continue; }
      entries[kind] = cand;
      break;
    }
  }
  return { entries, dropped };
}
