// Feature 4 — Memory budget + unreachable-memory monitor.
//
// Two different problems, one hook:
//
// 1. SIZE. Always-loaded instruction files are a fixed tax on every session in
//    a project, and they only ever grow. Anthropic's guidance is to keep a
//    CLAUDE.md under 200 lines; nothing enforces the same on a memory index.
//
// 2. REACHABILITY. The index is the source of truth for what is persisted, so
//    a memory file the index does not link can never be recalled. For a dated
//    finding that is harmless. For a standing RULE it is a correctness bug: it
//    is believed to be in effect and silently is not.
//
// This blocks nothing. It warns, and writes a ready-to-run fix.

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readStdin, opt, dataDir, passthrough } from './lib/context.mjs';

const est = (s) => Math.ceil(s.length / 4); // ~4 chars/token; fine for an alarm

function encodeProjectDir(cwd) {
  return cwd.replace(/[:\/]/g, '-');
}

function findMemoryIndex(cwd) {
  const base = join(homedir(), '.claude', 'projects');
  const direct = join(base, encodeProjectDir(cwd), 'memory', 'MEMORY.md');
  if (existsSync(direct)) return direct;
  try {
    const leaf = cwd.split(/[\/]/).filter(Boolean).pop();
    for (const d of readdirSync(base)) {
      if (leaf && d.endsWith(leaf)) {
        const p = join(base, d, 'memory', 'MEMORY.md');
        if (existsSync(p)) return p;
      }
    }
  } catch { /* fail open */ }
  return null;
}

// Deliberately substring-based rather than a regex. A link is "(filename.md)"
// and checking for that literal needs no escaping — which matters, because an
// earlier regex version of this check was subtly wrong about parentheses.
function countUnreachable(indexPath) {
  try {
    const idx = readFileSync(indexPath, 'utf8');
    const historical = (process.env.CLAUDE_PLUGIN_OPTION_memory_archive_prefixes
      || 'findings_,bugs,handoff-').split(',').map((s) => s.trim()).filter(Boolean);
    return readdirSync(dirname(indexPath))
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .filter((f) => !historical.some((p) => f.startsWith(p)))
      .filter((f) => !idx.includes(`(${f})`))
      .length;
  } catch {
    return 0; // fail open
  }
}

try {
  const p = readStdin();
  if (!opt('memory_budget', true)) passthrough();

  const budget = Math.max(500, opt('memory_budget_tokens', 3000));
  const cwd = p.cwd || process.cwd();

  const candidates = [
    ['project CLAUDE.md', join(cwd, 'CLAUDE.md')],
    ['global CLAUDE.md', join(homedir(), '.claude', 'CLAUDE.md')],
  ];
  const mem = findMemoryIndex(cwd);
  if (mem) candidates.push(['memory index', mem]);

  const over = [];
  for (const [label, file] of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const tokens = est(text);
    const lines = text.split('\n').length;
    if (tokens > budget) over.push({ label, file, tokens, lines });
  }

  const unreachable = (mem && opt('memory_doctor', true)) ? countUnreachable(mem) : 0;

  if (over.length === 0 && unreachable === 0) passthrough();

  const promptFile = join(dataDir(), 'refactor-prompt.md');
  const worst = over.length ? over.sort((a, b) => b.tokens - a.tokens)[0] : null;

  const prompt = [];
  if (worst) {
    prompt.push(
      '# Refactor an oversized always-loaded instruction file',
      '',
      `\`${worst.file}\` is ~${worst.tokens} tokens across ${worst.lines} lines, over the ${budget}-token`,
      'budget. It loads on EVERY session in this project, so every token here is paid repeatedly',
      'and forever, and adherence drops as the file grows.',
      '',
      'Do this:',
      '1. Group its entries by kind: workflow/process rules, facts and gotchas, session-start',
      '   constants, and anything already recorded elsewhere in the repo.',
      '2. Move workflow and process detail OUT into a skill. Leave a one-line pointer behind.',
      '3. Delete entries the codebase, git history, or CLAUDE.md already documents.',
      '4. Merge duplicates and anything superseded. Keep the newest true version only.',
      `5. Keep what remains under ${budget} tokens, each entry one line, newest-relevant first.`,
      '',
      'Report before/after token counts and list what you moved, merged, and deleted.',
      'Do not delete anything whose only copy is in this file without showing it to me first.',
      '',
    );
  }
  if (unreachable > 0) {
    prompt.push(
      '# Unreachable memory rules',
      '',
      `${unreachable} memory file(s) exist on disk but are NOT linked from the index, so they can`,
      'never be recalled. These are not dated findings — they read as standing rules, which means',
      'they are believed to be in effect and silently are not.',
      '',
      'Repair is non-destructive (archives historical files, re-links live rules, deletes nothing):',
      '',
      '  node <plugin-root>/scripts/memory-doctor.mjs --fix',
      '',
      'Then review the "Recovered by memory-doctor" block it appends and fold those entries into',
      'the right sections of the index by hand.',
      '',
    );
  }

  try { writeFileSync(promptFile, prompt.join('\n')); } catch { /* fail open */ }

  const parts = over.map((o) => `${o.label} ~${o.tokens} tok (${o.lines} lines)`);
  if (unreachable > 0) {
    parts.push(`${unreachable} UNREACHABLE memory rule(s) — on disk but absent from the index`);
  }
  const summary = parts.join('; ');

  process.stdout.write(JSON.stringify({
    systemMessage: `agent-companion: ${summary}. A prepared fix was written to ${promptFile}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[agent-companion] Instruction-budget status for this project: ${summary}. ` +
        'If the user asks about context cost, slow sessions, or rules not being followed, ' +
        `mention the prepared fix at ${promptFile}. Do not act on it unprompted.`,
    },
  }));
  process.exit(0);
} catch {
  passthrough();
}
