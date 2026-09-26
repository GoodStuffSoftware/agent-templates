#!/usr/bin/env node
// agent-companion-reinject.mjs — OPTIONAL user-level SessionStart hook
// (matcher "compact") that re-injects a session's saved state after a
// compaction, so the post-compact context does not start cold.
//
// NOT part of the plugin's hooks.json: it is inert until the operator says
// yes in `/ac setup`, which runs scripts/install-reinject-hook.mjs to copy
// this file to ~/.claude/hooks/ and add one SessionStart entry for it.
// `--uninstall` on that script removes both.
//
// Candidate files are tried in order; the first readable, non-empty one
// wins. Each candidate is a template; placeholders:
//   {cwd}         the session's working directory
//   {session_id}  the session id
//   {scratchpad}  <tmpdir>/claude/<project dir>/<session_id>/scratchpad, where
//                 <project dir> is the folder of the hook input's
//                 transcript_path (the harness's own encoding of the session's
//                 ORIGINAL cwd), else the cwd with every non-alphanumeric
//                 character replaced by '-'
//   {home}        the user's home directory
// Defaults (replaced by one or more `--file <template>` args):
//   {scratchpad}/SESSION-STATE.md, {cwd}/HANDOFF.md, {cwd}/.claude/HANDOFF.md
// `--max-chars <n>` caps the injected text (default and ceiling 9500: Claude
// Code caps additionalContext at 10,000 chars and replaces anything longer
// with a file path plus a preview of the HEAD). Over the cap the
// END of the file is kept (notes are appended there) behind a marker line.
//
// MUST NEVER throw or exit non-zero, and prints nothing when there is
// nothing to inject: a broken re-inject hook must not break compaction.

import { readFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, isAbsolute, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FILES = [
  '{scratchpad}/SESSION-STATE.md',
  '{cwd}/HANDOFF.md',
  '{cwd}/.claude/HANDOFF.md',
];
// Claude Code caps a hook's additionalContext at 10,000 characters
// (code.claude.com/docs/en/hooks); stay safely below it, marker included.
export const HARNESS_CAP = 10000;
export const DEFAULT_MAX_CHARS = 9500;

export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectDir(cwd, transcriptPath) {
  if (typeof transcriptPath === 'string' && transcriptPath) {
    const d = basename(dirname(transcriptPath));
    if (d && d !== '.' && !/^[\\/]$/.test(d)) return d;
  }
  return encodeCwd(cwd);
}

export function parseArgs(argv) {
  const files = [];
  let maxChars = DEFAULT_MAX_CHARS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) files.push(argv[++i]);
    else if (argv[i] === '--max-chars' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 200) maxChars = Math.min(Math.floor(n), DEFAULT_MAX_CHARS);
    }
  }
  return { files: files.length ? files : DEFAULT_FILES, maxChars };
}

export function expand(template, { cwd, sessionId, transcriptPath, tmp = tmpdir(), home = homedir() }) {
  const scratchpad = join(tmp, 'claude', projectDir(cwd, transcriptPath), sessionId, 'scratchpad');
  const out = template
    .replace(/\{scratchpad\}/g, scratchpad)
    .replace(/\{session_id\}/g, sessionId)
    .replace(/\{cwd\}/g, cwd)
    .replace(/\{home\}/g, home);
  return isAbsolute(out) ? resolve(out) : resolve(cwd, out);
}

// Returns the additionalContext text, or '' when there is nothing to inject.
export function buildContext(input, { files, maxChars }, env = {}) {
  if (!input || typeof input !== 'object') return '';
  // Belt and braces: the settings entry already matches "compact", but a
  // hand-edited entry without a matcher must not inject on every startup.
  if (input.source !== undefined && input.source !== 'compact') return '';
  const { session_id: sessionId, cwd, transcript_path: transcriptPath } = input;
  if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) return '';
  for (const tpl of files) {
    let path;
    try { path = expand(tpl, { cwd, sessionId, transcriptPath, ...env }); } catch { continue; }
    let content;
    try {
      if (!statSync(path).isFile()) continue;
      content = readFileSync(path, 'utf8');
    } catch { continue; }
    if (!content.trim()) continue;
    const header = `[agent-companion: re-injected after compaction from ${path}]\n`;
    if (header.length + content.length <= maxChars) return header + content;
    const marker = `[... truncated: kept the last part of ${content.length} chars ...]\n`;
    const budget = Math.max(0, maxChars - header.length - marker.length);
    let start = content.length - budget;
    // Never start on the low half of a surrogate pair.
    const c = content.charCodeAt(start);
    if (c >= 0xDC00 && c <= 0xDFFF) start += 1;
    return header + marker + content.slice(start);
  }
  return '';
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  if (!raw.trim()) return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const text = buildContext(input, parseArgs(process.argv.slice(2)));
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}

const isMain = (() => {
  try { return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  try { main(); } catch { /* never throw */ }
  process.exit(0);
}
