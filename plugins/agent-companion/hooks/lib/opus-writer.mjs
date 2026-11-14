// No Opus writers (0.31.54). Opus designs, root-causes and reviews; Sonnet writes.
//
// Operator data, 2026-11-13: Opus subagents were doing their own edits, tests, builds and git, at Opus
// prices and with large contexts; execution calls were 37% of Opus worker cost. So a spawn that would
// run on Opus AND whose brief says it writes is rewritten, silently, to the Sonnet writer rung.
//
// WHICH SPAWNS (both must hold):
//   1. It would run on Opus: the call's `model` names an Opus model (opus, claude-opus-*); or the call
//      names none and its definition (an ac-opus-* rung, another agent file) pins Opus; or the call
//      names none, the definition pins none, and the CALLER's own last turn ran on Opus (an inherited
//      model: the same reading the inherit guard uses; unknown reads as not Opus).
//   2. Its brief says it writes: `ROLE: writer`, `ROLE: fixer` or `ROLE: lander`. With a usable ROLE:
//      line of another value (reviewer, docs, lookup, operate, other) the spawn is never touched. With
//      NO usable ROLE: line, the TYPE: decides: OPUS_WRITING_TYPES below.
//
// OPUS_WRITING_TYPES = the routing table's writer types (the same list the scope rule and the ROLE
// inference use for "builds or changes something": scope-rule.mjs SCOPE_WRITER_TYPES) MINUS the two
// types whose job is not the edit itself: novel-design (design) and debug-root-cause (root-causing; the
// fix is a separate spawn with ROLE: fixer, or the brief says ROLE: fixer). code-review, research,
// survey, explore, lookup, verify and operate are not writer types at all.
//
// WHAT HAPPENS: subagent_type and model become the Sonnet writer rung (agent-companion:ac-sonnet-high,
// model sonnet), through updatedInput, with no note and no message. Where the type cannot be swapped
// safely (a project or other plugin's agent, a brief that needs tools the ladder drops, a session where
// an earlier ladder rewrite was ignored, a rung not shown registered) only the `model` parameter
// changes to sonnet, which wins over the definition. A project or user agent whose own file pins Opus
// is the operator's deliberate tier and is left alone unless the call itself names Opus.
//
// OPTION opus_writer_policy: "sonnet" (default, rewrite) or "allow" (the old behaviour: nothing rewritten).
// One telemetry line per rewrite: telemetry/opus-writer-rewrites.jsonl (docs/TELEMETRY.md).

import {
  appendLog, agentDefinition, briefNeedsDroppedTools, callerIsSubagent, callerTranscriptPath,
  canonicalTaskType, classifyModel, effortSupported, isLadderAgentName, ladderVariants, lastAssistantMeta,
  opt, readJson, rungFor, sessionLoadedAt, stateFile,
} from './context.mjs';
import { BRIEF_ROLES, briefDeclarations, declarationValue } from './brief-directives.mjs';
import { SCOPE_WRITER_TYPES } from './scope-rule.mjs';
import { ladderRewriteTarget, pinInfo } from './sg-helpers.mjs';
import { legsOf } from './legs.mjs';

export const OPUS_WRITER_ROLES = ['writer', 'fixer', 'lander'];
export const OPUS_NON_WRITING_TYPES = ['novel-design', 'debug-root-cause'];
export const OPUS_WRITING_TYPES = SCOPE_WRITER_TYPES.filter((t) => !OPUS_NON_WRITING_TYPES.includes(t));
export const OPUS_WRITER_LOG = 'opus-writer-rewrites.jsonl';

// 'role' | 'type' | null: why this brief counts as a writer's. `role` and `type` are as declared (lower-case, canonical).
export function writerBasis(role, type) {
  if (role) return OPUS_WRITER_ROLES.includes(role) ? 'role' : null;
  return type && OPUS_WRITING_TYPES.includes(type) ? 'type' : null;
}

// A spawn of a type that has legs (hooks/lib/legs.mjs) whose brief does NOT say it writes is the type's read-only PLAN leg:
// ROLE: other (or any usable non-writer role), or, with no ROLE line, one of the non-writing types above. It writes
// <task>-plan.md and carries no self-review protocol (the write leg does).
export function planLegSpawn(type, role) {
  return !!type && !!legsOf(type) && !writerBasis(role, type);
}

// The caller's own last turn ran on Opus. A subagent whose own transcript cannot be found falls back to the
// lead's, which says nothing about the subagent's model: unknown.
function callerOnOpus(p) {
  try {
    const path = callerTranscriptPath(p);
    if (!path) return false;
    if (callerIsSubagent(p) && path === p.transcript_path) return false;
    const m = lastAssistantMeta(path)?.model;
    return !!m && classifyModel(m).alias === 'opus';
  } catch { return false; }
}

// Why this spawn would run on Opus: 'opus_model' (the call's model), 'opus_agent' (its definition), 'inherited', or null.
function opusVia(p, input, def, pinned) {
  const declared = String(input.model || '').trim();
  if (declared) return classifyModel(declared).alias === 'opus' ? 'opus_model' : null;
  if (def?.model && !/^inherit$/i.test(String(def.model))) return classifyModel(def.model).alias === 'opus' ? (pinned ? null : 'opus_agent') : null;
  return callerOnOpus(p) ? 'inherited' : null;
}

// Did the harness ignore a ladder rewrite in this session? Read from the state file directly: lib/ladder-rewrite.mjs pulls in the
// premium window, which a plain spawn must not load (tests/premium-window-lock.test.mjs).
function sessionIgnoredRewrite(sid) {
  try { return Boolean(readJson(stateFile('ladder-rewrites.json'), null)?.[String(sid)]?.ignored); } catch { return false; }
}

// { input, ladderRewrite, record, via } when this spawn is rewritten; null when it is not (or the policy is "allow").
export function opusWriterRewrite(p, input, sid) {
  try {
    if (String(opt('opus_writer_policy', 'sonnet')).toLowerCase() === 'allow') return null;
    const brief = String(input.prompt || '');
    if (!brief.trim()) return null;
    const decls = briefDeclarations(brief);
    const rm = declarationValue(decls, 'ROLE', `(${BRIEF_ROLES.join('|')})\\b`);
    const role = rm ? rm[1].toLowerCase() : null;
    const tm = declarationValue(decls, 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
    const typeRaw = tm ? tm[1].toLowerCase() : null;
    const type = typeRaw ? (canonicalTaskType(typeRaw)?.name || typeRaw) : null;
    const basis = writerBasis(role, type);
    if (!basis) return null;

    const origType = String(input.subagent_type || '');
    const def = agentDefinition(origType, p.cwd);
    const pin = pinInfo(origType, def, p.cwd);
    const pinned = pin.pinned && opt('project_pins', true);
    const via = opusVia(p, input, def, pinned);
    if (!via) return null;

    const rung = rungFor('sonnet', 'high');
    if (!rung) return null;
    const next = { ...input, model: 'sonnet' };

    // The type swap: only where it loses nothing. A ladder rung (not a browser variant) or a general-purpose / unnamed
    // spawn whose brief needs no tool the ladder drops, in a session where the harness has not ignored a rewrite.
    const bare = origType.includes(':') ? origType.slice(origType.indexOf(':') + 1) : origType;
    const isRung = isLadderAgentName(origType) && !ladderVariants().some((v) => v.agent === bare);
    const swappable = isRung || !origType || origType === 'general-purpose';
    const needs = briefNeedsDroppedTools(brief);
    let ladderRewrite = null;
    if (swappable && !needs.browser && !needs.other && !needs.skill && !sessionIgnoredRewrite(sid) && opt('fit_autofill_ladder', true)) {
      const pick = ladderRewriteTarget(sid, rung.agent, p.cwd, sessionLoadedAt(sid), origType || null);
      if (pick.target) {
        next.subagent_type = pick.target;
        if (pick.target !== origType) ladderRewrite = { from: origType || null, to: pick.target };
      }
    }
    // An explicit effort set for Opus stays only where Sonnet takes it.
    if (next.effort && !effortSupported('sonnet', String(next.effort)).ok) delete next.effort;

    const fromLabel = `${origType || '(none)'}/${input.model || (def?.model ? def.model : 'inherited')}`;
    const toLabel = `${next.subagent_type || '(none)'}/sonnet`;
    return {
      input: next, ladderRewrite, via,
      record: {
        session_id: sid, agent: input.name || input.description || null, from: fromLabel, to: toLabel,
        declared_type: type, declared_role: role, basis, via,
      },
    };
  } catch { return null; }
}

// One telemetry line per rewrite (docs/TELEMETRY.md). Never throws.
export function writeOpusWriterRow(record) {
  try {
    if (!opt('spawn_telemetry', true)) return;
    appendLog(OPUS_WRITER_LOG, { at: new Date().toISOString(), ...record });
  } catch { /* fail open */ }
}