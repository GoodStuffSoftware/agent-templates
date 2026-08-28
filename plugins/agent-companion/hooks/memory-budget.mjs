// Feature 4 — Memory budget monitor.
//
// Always-loaded instruction files are a fixed tax on every single session in a
// project, and they only ever grow. Anthropic's published guidance is to keep a
// CLAUDE.md under 200 lines; nothing enforces the same discipline on a MEMORY.md
// index, which is why one was measured at 4,791 tokens — 2.7x the global
// CLAUDE.md it sits alongside.
//
// This does not block anything. It warns, and it writes a ready-to-run refactor
// prompt so the fix is one paste away instead of a task you keep deferring.

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readStdin, opt, dataDir, passthrough } from './lib/context.mjs';

const est = (s) => Math.ceil(s.length / 4); // ~4 chars/token, good enough for a budget alarm

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

  if (over.length === 0) passthrough();

  const worst = over.sort((a, b) => b.tokens - a.tokens)[0];
  const promptFile = join(dataDir(), 'refactor-prompt.md');

  const prompt = [
    `# Refactor an oversized always-loaded instruction file`,
    ``,
    `\`${worst.file}\` is ~${worst.tokens} tokens across ${worst.lines} lines, over the ${budget}-token`,
    `budget. It loads on EVERY session in this project, so every token here is paid repeatedly`,
    `and forever, and adherence drops as the file grows.`,
    ``,
    `Do this:`,
    `1. Read the file and group its entries by kind: workflow/process rules, facts and gotchas,`,
    `   session-start constants, and anything already recorded elsewhere in the repo.`,
    `2. Move workflow and process detail OUT into a skill. Leave a one-line pointer behind.`,
    `3. Delete entries the codebase, git history, or CLAUDE.md already documents.`,
    `4. Merge duplicates and anything superseded. Keep the newest true version only.`,
    `5. Keep what remains under ${budget} tokens, each entry one line, newest-relevant first.`,
    ``,
    `Report before/after token counts and list what you moved, merged, and deleted.`,
    `Do not delete anything whose only copy is in this file without showing it to me first.`,
  ].join('\n');

  try { writeFileSync(promptFile, prompt); } catch { /* fail open */ }

  const summary = over
    .map((o) => `${o.label} ~${o.tokens} tok (${o.lines} lines)`)
    .join('; ');

  process.stdout.write(JSON.stringify({
    systemMessage:
      `agent-companion: instruction budget exceeded — ${summary}. ` +
      `Budget is ${budget} tokens per file. A refactor prompt was written to ${promptFile}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[agent-companion] This project loads oversized instruction files on every session: ` +
        `${summary}. If the user asks about context cost, slow sessions, or rule adherence, ` +
        `mention that a prepared refactor prompt is available at ${promptFile}. Do not act on ` +
        `it unprompted.`,
    },
  }));
  process.exit(0);
} catch {
  passthrough();
}
