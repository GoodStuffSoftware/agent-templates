// Detectors for "who reads taskTypes.<type>.override" (ADR 0003 §2: nothing
// but resolveRoute() may). Two, because each covers what the other cannot:
//
// STATIC — the token. Every occurrence of `override` (any case) in the
// plugin's code, comments and strings included, must be either inside
// resolveRoute()'s own body or on a line listed in allowlist.mjs. No attempt
// is made to tell a read from prose: a comment-stripping regex is exactly
// what multi-line destructuring, arrow-parameter destructuring, computed
// keys, Reflect.get and a `//` inside a string slipped past. So a new
// occurrence anywhere fails until someone looks at it and lists it.
//
// RUNTIME — the value. trap.mjs, preloaded with `node --import`, turns every
// `override` in any parsed config into an accessor that records the frame
// that read it. It catches a read the token cannot see ('over' + 'ride'),
// but only on the code paths a run exercises; the static scan covers every
// path, but only a literal token. Together they catch every reader shape in
// mutants.mjs.
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ALLOWED } from './allowlist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRAP = join(HERE, 'trap.mjs');

// Not plugin code: the test suite itself, and bench/fixtures (the synthetic
// repositories benchmark tasks run in — they never import the plugin).
const SKIP = new Set(['tests', 'node_modules', '.git', 'bench/fixtures']);
const CODE = /\.(mjs|cjs|js)$/;
const TOKEN = /override/i;

export function codeFiles(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) { if (!SKIP.has(name) && !SKIP.has(rel)) codeFiles(root, p, out); } else if (CODE.test(name)) out.push(p);
  }
  return out;
}

// A line as the allowlist records it: trimmed, inner whitespace collapsed —
// so re-indenting or moving a line never trips the scan; changing its text
// does.
export const normalise = (l) => l.trim().replace(/\s+/g, ' ');

// Lines of resolveRoute()'s own body in context.mjs: [first, last], 1-based.
export function resolverBody(text) {
  const start = text.indexOf('export function resolveRoute(');
  if (start < 0) return null;
  const end = text.indexOf('\n}\n', start);
  return [text.slice(0, start).split('\n').length, text.slice(0, end + 2).split('\n').length];
}

// Every token occurrence in `text` outside the exempt range, as normalised
// lines (one entry per line, however many tokens it holds).
export function tokenLines(text, exempt = null) {
  const hits = [];
  text.split('\n').forEach((l, i) => {
    const n = i + 1;
    if (exempt && n >= exempt[0] && n <= exempt[1]) return;
    if (TOKEN.test(l)) hits.push({ line: n, text: normalise(l) });
  });
  return hits;
}

// Scan a plugin tree. offenders: occurrences not on the allowlist. stale:
// allowlist lines no longer present (the list must stay exact, or it stops
// meaning "every occurrence was looked at"). Matching is by file and line
// content as a multiset, never by line number.
export function staticScan(root, allowed = ALLOWED) {
  const offenders = [];
  const stale = [];
  let resolverReads = 0;
  const seen = new Set();
  for (const file of codeFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    seen.add(rel);
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    let exempt = null;
    if (rel === 'hooks/lib/context.mjs') {
      exempt = resolverBody(text);
      if (!exempt) { offenders.push(`${rel}: resolveRoute() not found`); continue; }
      resolverReads = text.split('\n').slice(exempt[0] - 1, exempt[1]).filter((l) => TOKEN.test(l)).length;
    }
    const budget = new Map();
    for (const l of allowed[rel] || []) budget.set(l, (budget.get(l) || 0) + 1);
    for (const h of tokenLines(text, exempt)) {
      const left = budget.get(h.text) || 0;
      if (left > 0) budget.set(h.text, left - 1);
      else offenders.push(`${rel}:${h.line}: ${h.text}`);
    }
    for (const [l, left] of budget) for (let i = 0; i < left; i++) stale.push(`${rel}: ${l}`);
  }
  for (const rel of Object.keys(allowed)) if (!seen.has(rel)) stale.push(`${rel}: (file gone)`);
  return { offenders, stale, resolverReads };
}

// Run a plugin script under the trap in a hermetic state root; return the
// reads made anywhere but resolveRoute() in hooks/lib/context.mjs.
export function runtimeReads(root, script, args = [], { input, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ac-trap-'));
  const log = join(home, 'reads.jsonl');
  try {
    const e = { ...process.env, AGENT_COMPANION_HOME_OVERRIDE: home, AGENT_COMPANION_STATE_DIR: join(home, '.claude', 'agent-companion'), AC_OVERRIDE_TRAP_LOG: log, ...env };
    delete e.CLAUDE_PLUGIN_DATA;
    delete e.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(TRAP).href, join(root, script), ...args], {
      encoding: 'utf8', env: e, cwd: home, input: input ?? '', windowsHide: true, timeout: 60000,
    });
    const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const armed = rows.some((x) => x.armed);
    const reads = rows.filter((x) => !x.armed);
    const offenders = reads.filter((x) => !(x.fn === 'resolveRoute' && /\/hooks\/lib\/context\.mjs$/.test(x.file)))
      .map((x) => `${relative(root, fileURLToPath(x.file)).replace(/\\/g, '/')}:${x.line} (${x.fn}) read taskTypes.${x.type}.override`);
    return { status: r.status, stderr: r.stderr, armed, reads: reads.length, offenders };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}
