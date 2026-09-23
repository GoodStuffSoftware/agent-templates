// Publication-leak sweep — the scout's after-the-fact backstop.
//
// A pre-push gate (or a person) is supposed to catch a real-name leak before
// it reaches origin. This sweep assumes that sometimes fails, and checks what
// is actually PUBLISHED: it fetches each configured repo's default branch AS
// IT SITS ON ORIGIN (never the local working tree, which may hold an
// unpushed fix or an unpushed leak that doesn't matter yet) into a throwaway
// clone, then runs THAT repo's OWN scripts/leak-check.mjs against it — not
// this plugin's copy, because the point is to sweep what a reader of the
// published repo would see, with whatever guard version that repo actually
// ships.
//
// Zero dependencies beyond `git` on PATH and Node builtins. Every repo is
// swept independently; one repo's failure (network, missing script, bad
// path) is recorded as an error and never stops the others.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 60000,
    ...opts,
  });
}

// A repo entry is either a local path to a checkout (which must have an
// `origin` remote — we read ITS url so we clone from the real origin, never
// from the possibly-ahead-of-origin local branch) or a git URL / local bare
// repo path used directly as the clone source.
function resolveCloneSource(entry) {
  const looksLocal = existsSync(entry);
  if (looksLocal && statSync(entry).isDirectory()) {
    const originUrl = run('git', ['-C', entry, 'remote', 'get-url', 'origin']);
    if (originUrl.status === 0 && originUrl.stdout.trim()) {
      return originUrl.stdout.trim();
    }
    // No origin remote readable (e.g. the path IS a bare "origin" itself, as
    // in the canary): use the path directly as the clone source.
    return entry;
  }
  return entry; // a URL (https://, git@, ssh://, …)
}

// Parse leak-check's human-readable hit lines. Exact format, from
// scripts/leak-check.mjs: `  ${rel}:${line}  [${label}]  ${token}  ::  ${text}`
const HIT_RE = /^ {2}(\S.*?):(\d+) {2}\[([^\]]+)\] {2}(.*?) {2}:: {2}(.*)$/;

function parseHits(output) {
  const hits = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const m = HIT_RE.exec(rawLine);
    if (!m) continue;
    const [, rel, line, label, token, text] = m;
    hits.push({ rel, line: Number(line), label, token, text });
  }
  return hits;
}

// Fingerprint deliberately excludes the leaked token text itself — the
// baseline that stores this is state, and a fingerprint should identify
// "this spot flagged again", not carry the leaked value around a second
// time. rel + line + label is stable across runs of the same content and
// changes if the leak moves or a different class fires at that spot.
export function fingerprintHit(repo, hit) {
  return createHash('sha256').update(`${repo}\u0000${hit.rel}\u0000${hit.line}\u0000${hit.label}`).digest('hex').slice(0, 24);
}

// hits (already fingerprinted) filtered down to ones NOT in `seen` (a Set or
// array of fingerprint strings). Pure function — no I/O — so it is usable
// identically by detect.mjs (against the real baseline) and by tests/canary
// (against a throwaway one).
export function filterNew(hits, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(seen || []);
  return hits.filter((h) => !seenSet.has(h.fingerprint));
}

// Sweep ONE repo entry. Returns { repo, hits: [{rel,line,label,token,text,fingerprint}], error }.
// `reduced`: pass --no-derived to the target's own leak-check (no dev root
// here to derive real project names from — the cloud routine's situation).
// `env`: extra env vars merged over process.env for the CHILD leak-check
// process only (LEAK_CHECK_DEV_ROOT / LEAK_CHECK_TOKEN_FILE overrides,
// used by tests/canary; production passes none and lets the target script
// derive from THIS machine as usual).
export async function sweepRepo(repoEntry, { reduced = false, env = {}, timeout = 120000 } = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-pubsweep-'));
  const cloneDir = join(tmpRoot, 'repo');
  try {
    const source = resolveCloneSource(repoEntry);
    const clone = run('git', ['clone', '--quiet', '--depth', '1', source, cloneDir], { timeout });
    if (clone.status !== 0) {
      return { repo: repoEntry, hits: [], error: `clone failed: ${(clone.stderr || clone.error?.message || 'unknown error').split('\n')[0]}` };
    }
    const leakCheck = join(cloneDir, 'scripts', 'leak-check.mjs');
    if (!existsSync(leakCheck)) {
      return { repo: repoEntry, hits: [], error: 'no scripts/leak-check.mjs in the published tree — cannot sweep' };
    }
    const args = [leakCheck, '--root', cloneDir];
    if (reduced) args.push('--no-derived');
    const scan = run(process.execPath, args, {
      timeout,
      env: { ...process.env, ...env },
    });
    // exit 0 = clean, 1 = hits, 2 = bad invocation (treat as error, not hits).
    if (scan.status !== 0 && scan.status !== 1) {
      return { repo: repoEntry, hits: [], error: `leak-check invocation failed (exit ${scan.status}): ${(scan.stderr || '').split('\n')[0] || 'unknown error'}` };
    }
    const hits = parseHits(`${scan.stdout || ''}\n${scan.stderr || ''}`)
      .map((h) => ({ ...h, fingerprint: fingerprintHit(repoEntry, h) }));
    return { repo: repoEntry, hits, error: null };
  } catch (err) {
    return { repo: repoEntry, hits: [], error: err.message || String(err) };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort cleanup */ }
  }
}

// Sweep every configured repo. Returns { results: [sweepRepo() result, …] }.
// Never throws — a bad entry becomes that entry's `.error`, and the caller
// decides what a non-empty error list means (detect.mjs turns it into its
// own signal; the canary turns it into a hard failure).
export async function sweepAll(repos, opts = {}) {
  const results = [];
  for (const repo of repos) {
    // Sequential on purpose: this runs once a day from a scout, not a hot
    // path, and sequential clones are far easier to reason about (and to
    // bound with a single overall timeout budget) than parallel ones.
    // eslint-disable-next-line no-await-in-loop
    results.push(await sweepRepo(repo, opts));
  }
  return { results };
}
