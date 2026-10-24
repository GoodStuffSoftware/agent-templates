// New-file tripwire (token bleed guard, phase 2, part D). A helper that Writes a path that does
// not exist yet, when the brief (the first user message of its transcript) does not name that
// file, has built something beyond the ask. The guard counts those files per helper:
//
//   lookup-kind helper (lookup, research, survey, explore, verify): denied at the first one
//   writer-kind helper: a one-time note at the third, denied at the fourth and every one after
//
// Kinds come from the brief's TYPE (else ROLE) through lib/scope-rule.mjs, the same selection
// the scope clause uses. A brief with no TYPE or ROLE, a review, an operate task: never counted.
// The lead's own session is never counted (the hook runs for a payload with agent_id only).
//
// Never counted: a file the brief names (full path, path from the working directory, file name,
// or a directory the brief names with a trailing slash), a <task>-detail.* or *handoff* file (the
// reporting contract and the context-ceiling note ask for those), and anything under the
// helper's scratchpad directory. Fails open at every step: nothing readable means nothing counted.

import { existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve, relative, basename, dirname, join } from 'node:path';
import { stateDir, readJson, writeJsonAtomic } from './context.mjs';
import { firstUserText, briefBody } from './brief-match.mjs';
import { briefDeclarations, declarationValue, BRIEF_ROLES } from './brief-directives.mjs';
import { scopeKind } from './scope-rule.mjs';
import { resolveAgentTranscript } from './runaway.mjs';

export const LOOKUP_DENY_REASON = 'Your brief asks for no new files: report the proposal instead.';
export const WRITER_DENY_REASON = 'Check in with the lead before building more beyond the brief.';
export const WRITER_NOTE = 'Scope check: this is the third new file the brief does not name. Build only what the brief asks; one more beyond it will be refused, so check in with the lead first.';
export const DEFAULTS = Object.freeze({ lookupDeny: 1, writerNote: 3, writerDeny: 4 });
const STATE_TTL_MS = 7 * 86400000;

const norm = (s) => String(s || '').replace(/\\/g, '/');
const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

function dirFor() {
  const d = join(stateDir(), 'scope-tripwire');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

function prune(dir, now) {
  try {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// 'writer' | 'lookup' | null for a brief's text.
export function briefScopeKind(text) {
  try {
    const decls = briefDeclarations(String(text || ''));
    const tm = declarationValue(decls, 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
    const rm = declarationValue(decls, 'ROLE', `(${BRIEF_ROLES.join('|')})\\b`);
    return scopeKind(tm ? tm[1].toLowerCase() : null, rm ? rm[1].toLowerCase() : null);
  } catch { return null; }
}

// Is the file one the brief names, or one the contract always allows?
export function isNamedOrExempt(filePath, cwd, brief, scratchDir = '') {
  const abs = norm(isAbsolute(filePath) ? filePath : resolve(cwd || process.cwd(), filePath));
  const base = basename(abs);
  if (/-detail\.[A-Za-z0-9]+$/i.test(base) || /handoff/i.test(base)) return true;
  if (scratchDir) {
    const sd = norm(resolve(scratchDir)).replace(/\/+$/, '');
    if (abs.toLowerCase().startsWith(`${sd.toLowerCase()}/`)) return true;
  }
  const text = norm(briefBody(brief) || brief).toLowerCase();
  const rel = cwd ? norm(relative(cwd, abs)) : '';
  const cands = [abs.toLowerCase()];
  if (rel && !rel.startsWith('..')) cands.push(rel.toLowerCase());
  if (base.length >= 3) cands.push(base.toLowerCase());
  if (cands.some((c) => text.includes(c))) return true;
  // A directory the brief names ("write the output under docs/out/").
  if (rel && !rel.startsWith('..')) {
    let d = norm(dirname(rel));
    while (d && d !== '.' && d !== '/') {
      if (text.includes(`${d.toLowerCase()}/`)) return true;
      const up = norm(dirname(d));
      if (up === d) break;
      d = up;
    }
  }
  return false;
}

// What the hook does for one PreToolUse Write payload: { action: 'pass' | 'note' | 'deny', ... }.
export function checkNewFile(p, { opts = DEFAULTS, now = Date.now() } = {}) {
  const pass = { action: 'pass' };
  try {
    const filePath = p && p.tool_input && p.tool_input.file_path;
    if (!p || !p.agent_id || typeof filePath !== 'string' || !filePath) return pass;
    const cwd = p.cwd || process.cwd();
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    if (existsSync(abs)) return pass; // an overwrite, not a new file
    const brief = firstUserText(resolveAgentTranscript(p));
    if (!brief) return pass;
    const kind = briefScopeKind(brief);
    if (!kind) return pass;
    if (isNamedOrExempt(abs, cwd, brief, p.scratchpad_dir || '')) return pass;

    const dir = dirFor();
    const f = join(dir, `${safe(p.agent_id)}.json`);
    const st = readJson(f, null);
    const paths = Array.isArray(st && st.paths) ? st.paths : [];
    const key = norm(abs).toLowerCase();
    if (!paths.includes(key)) paths.push(key);
    const n = paths.length;
    const noted = !!(st && st.noted);
    let action = 'pass';
    if (kind === 'lookup') {
      if (n >= opts.lookupDeny) action = 'deny';
    } else if (n >= opts.writerDeny) action = 'deny';
    else if (n >= opts.writerNote && !noted) action = 'note';
    writeJsonAtomic(f, { paths, noted: noted || action === 'note', kind, at: new Date(now).toISOString() });
    prune(dir, now);
    const row = { kind, count: n, file: key, agent_id: String(p.agent_id), agent_type: p.agent_type || null };
    if (action === 'deny') return { action, reason: kind === 'lookup' ? LOOKUP_DENY_REASON : WRITER_DENY_REASON, row };
    if (action === 'note') return { action, note: WRITER_NOTE, row };
    return { ...pass, row };
  } catch { return pass; }
}
