// Opus operate/other code-edit guard (0.31.61, usage audit 2026-11-21). The spawn guard's Opus-writer rewrite
// (lib/opus-writer.mjs) moves a spawn off Opus when its brief says it writes. A brief that declares ROLE: operate or
// ROLE: other (a plan leg, a run-it task) slips past that, and the audit found such Opus workers editing code anyway.
// This check runs at the Write or Edit itself: an Opus-model SUBAGENT whose brief declares ROLE: operate or other, writing a
// source file inside a git repo, is denied with "code edits go to a Sonnet writer".
//
// Never denied: a .md file, a <task>-detail.* file, a *handoff*.md file, a *-plan.(md|json|txt) file, a path outside a git repo, a non-Opus subagent,
// a brief with another or no ROLE line of its own (the guard's inserted "ROLE: x (inferred)" line is not the brief's), the lead (no agent_id). opus_writer_policy "allow" turns it off. Fails open.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve, basename, dirname, join } from 'node:path';
import { firstUserText } from './brief-match.mjs';
import { briefDeclarations, declarationValue, BRIEF_ROLES } from './brief-directives.mjs';
import { resolveAgentTranscript } from './runaway.mjs';
import { lastAssistantMeta, classifyModel } from './context.mjs';

export const OPUS_CODE_EDIT_ROLES = ['operate', 'other'];
export const OPUS_CODE_EDIT_REASON = 'Code edits go to a Sonnet writer: report what needs changing, or ask the lead to spawn ac-sonnet-high for the edit.';

// 'operate' | 'other' | null: the ROLE the brief declares, when it is one this guard judges.
export function briefJudgedRole(brief) {
  try {
    const rm = declarationValue(briefDeclarations(String(brief || '')), 'ROLE', `(${BRIEF_ROLES.join('|')})\\b(?![ \\t]*\\(inferred\\))`);
    const role = rm ? rm[1].toLowerCase() : null;
    return OPUS_CODE_EDIT_ROLES.includes(role) ? role : null;
  } catch { return null; }
}

// Is the file one an Opus worker may always write (notes, plans, handoffs)?
export function isExemptFile(abs) {
  const base = basename(String(abs));
  return /\.mdx?$/i.test(base) || /-detail\.[A-Za-z0-9]+$/i.test(base) || /handoff[^/\\]*\.md$/i.test(base) || /-plan\.(md|json|txt)$/i.test(base);
}

// Is the path inside a git work tree (a .git directory or file in it or an ancestor)?
export function inGitRepo(abs) {
  try {
    let d = dirname(String(abs));
    for (let i = 0; i < 64; i += 1) {
      if (existsSync(join(d, '.git'))) return true;
      const up = dirname(d);
      if (up === d) return false;
      d = up;
    }
  } catch { /* fail open */ }
  return false;
}

// Did the subagent run on Opus? Its own transcript's last assistant turn, else its agent type (an ac-opus-* rung).
export function subagentOnOpus(p, transcriptPath) {
  try {
    const m = lastAssistantMeta(transcriptPath)?.model;
    if (m) return classifyModel(m).alias === 'opus';
  } catch { /* fall through to the agent type */ }
  return /(^|:)ac-opus-/i.test(String(p?.agent_type || ''));
}

// { action: 'pass' | 'deny', reason?, row? } for one PreToolUse Write or Edit payload.
export function checkOpusCodeEdit(p) {
  const pass = { action: 'pass' };
  try {
    const filePath = p && p.tool_input && (p.tool_input.file_path || p.tool_input.notebook_path);
    if (!p || !p.agent_id || typeof filePath !== 'string' || !filePath) return pass;
    const abs = isAbsolute(filePath) ? filePath : resolve(p.cwd || process.cwd(), filePath);
    if (isExemptFile(abs) || !inGitRepo(abs)) return pass;
    const tp = resolveAgentTranscript(p);
    const role = briefJudgedRole(firstUserText(tp));
    if (!role) return pass;
    if (!subagentOnOpus(p, tp)) return pass;
    return {
      action: 'deny', reason: OPUS_CODE_EDIT_REASON,
      row: { role, file: String(abs).replace(/\\/g, '/'), agent_id: String(p.agent_id), agent_type: p.agent_type || null },
    };
  } catch { return pass; }
}
