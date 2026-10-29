// spawn-guard helpers: allowWith, combineNotes, the ladder-rewrite target, the common type routes and the definition pin.
// Moved verbatim from hooks/spawn-guard.mjs (module-level helpers).

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  agentDefinition, classifyEffort, classifyModel, claudeDir, isLadderAgentName, ownAgentsDir,
  projectAgentRoots, resolveRoute, routeLayerTag, rungFor, tailRecords, telemetryDir,
} from './context.mjs';
import { mergeLeadEffort } from './lead-effort-live.mjs';
import { mergeRedoAlert } from './redo-alert.mjs';

// The Agent tool's input fields. Claude Code 2.1.300 and later validates a hook's
// updatedInput like its own tool input: keys outside the schema are dropped and
// input that fails validation is denied, so a stray key or a bad value in a
// rewrite must never reach the harness. `team_name` is deprecated but still a field.
export const AGENT_INPUT_KEYS = Object.freeze([
  'description', 'prompt', 'subagent_type', 'model', 'effort', 'run_in_background',
  'name', 'isolation', 'mode', 'team_name',
]);
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'lower', 'higher']);

// Keep only schema keys, and drop a value of the wrong shape (a dropped value
// leaves the spawn as the caller wrote it, which is always valid).
export function sanitizeAgentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out = {};
  for (const k of AGENT_INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = input[k];
    if (v === undefined || v === null) continue;
    if (k === 'run_in_background') { if (typeof v !== 'boolean') continue; }
    else if (k === 'effort') { if (!EFFORT_VALUES.has(v)) continue; }
    else if (typeof v !== 'string') continue;
    else if ((k === 'model' || k === 'subagent_type') && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

// Let the spawn through — optionally saying something to the user, and/or
// rewriting the tool input (`updatedInput` is how a PreToolUse hook fills in a
// model the spawn left blank). The guard never blocks the cheap direction, but
// neither direction passes in silence once the brief has declared a weight.
//
// NO permissionDecision. "allow" would skip the permission prompt for the
// spawn (the Agent tool asks in some permission modes), which is not this
// guard's call to make. Claude Code applies updatedInput with no decision
// (verified in the 2.1.280 and 2.1.281 binaries: a hook result carrying
// updatedInput and no permissionBehavior yields hookUpdatedInput), so the
// model fill-in does not need one.
export function allowWith(systemMessage, updatedInput, additionalContext) {
  if (updatedInput) updatedInput = sanitizeAgentInput(updatedInput);
  ({ systemMessage, additionalContext } = mergeLeadEffort(systemMessage, additionalContext)); // lead-effort live check (text only)
  additionalContext = mergeRedoAlert(additionalContext); // redo alert (text only; lib/redo-alert.mjs)
  // Text that is empty or only whitespace is no text. When there is nothing at
  // all to say or change, emit nothing: a bare {hookSpecificOutput:
  // {hookEventName}} object shows the lead an empty "PreToolUse:Agent says:".
  const msg = typeof systemMessage === 'string' && systemMessage.trim() ? systemMessage : null;
  const ctx = typeof additionalContext === 'string' && additionalContext.trim() ? additionalContext : null;
  if (!msg && !updatedInput && !ctx) process.exit(0);
  process.stdout.write(JSON.stringify({
    ...(msg ? { systemMessage: msg } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(updatedInput ? { updatedInput } : {}),
      ...(ctx ? { additionalContext: ctx } : {}),
    },
  }));
  process.exit(0);
}

// Several independent features each have their own opinion about the ONE
// systemMessage this hook may emit (the best-fit note below, and the three
// spawn-shape gates). Combined in one place so a second note added later
// does not silently clobber the first the way a second updatedInput would.
export function combineNotes(...parts) {
  const joined = parts.filter(Boolean).join('\n\n');
  return joined || null;
}

// Evidence that THIS session's harness registered the ladder: SubagentStarts
// (hooks/spawn-log.mjs -> subagent-starts.jsonl) of ladder rungs in this same
// session, since it last loaded its plugins (loadedAtMs, when known: a
// /reload-plugins can break registration, which is the 2026-09-24 incident
// flow, so a start from before it proves nothing now). Registration cannot be
// queried from a hook, and a rewrite to an unregistered type fails the spawn
// with "Agent type not found", so the rewrite target must be one the harness
// has shown it registered:
//   - the plugin-namespaced rung ("<plugin>:<rung>") once ANY namespaced
//     ladder agent has started: plugin agents register together, from one
//     agents/ folder; this is the preferred form;
//   - the bare rung only when that EXACT bare name has started here AND its
//     file exists at project or user scope (<cwd>/.claude/agents or
//     ~/.claude/agents). Outside this plugin's own repo a bare name
//     registers only from those, and a partial user-level install is common;
//   - otherwise nothing, and the guard gives its advisory.
// `spawnedType`, when the call being rewritten is itself a plugin-namespaced
// ladder rung, counts as that evidence too (0.31.41): the call names a sibling
// from the same agents/ folder, so the rewrite can fail only where the spawn as
// written would fail as well. Without it, the first ladder spawn after a
// plugin load was never rewritten (the haiku_fit_leak rows). The autofill
// path passes none: its spawn names a built-in type, which proves nothing.
// Returns { target, why }; `why` explains a null target. Bounded tail read;
// never throws.
export function ladderRewriteTarget(sid, rungAgent, cwd, loadedAtMs, spawnedType = null) {
  let namespacedPrefix = null;
  let bareExact = false;
  let anyBare = false;
  try {
    const rows = tailRecords(join(telemetryDir(), 'subagent-starts.jsonl'), {
      bytes: 65536,
      filter: (line) => line.includes(String(sid)),
    });
    for (const r of rows) {
      if (!r || r.session_id !== sid || !isLadderAgentName(r.agent_type)) continue;
      if (typeof loadedAtMs === 'number') {
        const at = Date.parse(r.at || '');
        if (!(at >= loadedAtMs)) continue;
      }
      const t = String(r.agent_type);
      if (t.includes(':')) namespacedPrefix = `${t.slice(0, t.indexOf(':'))}:`;
      else { anyBare = true; if (t === rungAgent) bareExact = true; }
    }
  } catch { /* no evidence */ }
  if (namespacedPrefix === null && spawnedType && String(spawnedType).includes(':') && isLadderAgentName(spawnedType)) {
    const t = String(spawnedType);
    namespacedPrefix = `${t.slice(0, t.indexOf(':'))}:`;
  }
  if (namespacedPrefix !== null) {
    const target = `${namespacedPrefix}${rungAgent}`;
    const d = agentDefinition(target, cwd);
    if (d && d.model) return { target, def: d, why: null };
  }
  if (bareExact) {
    for (const root of [cwd && join(cwd, '.claude', 'agents'), join(claudeDir(), 'agents')].filter(Boolean)) {
      if (existsSync(join(root, `${rungAgent}.md`))) {
        const d = agentDefinition(rungAgent, cwd);
        if (d && d.model) return { target: rungAgent, def: d, why: null };
      }
    }
  }
  const since = typeof loadedAtMs === 'number' ? ' since it last loaded its plugins' : '';
  const why = anyBare
    ? `only bare ladder names have started in this session${since}, and "${rungAgent}" itself has not started here ` +
      'from a user- or project-level file, so a bare rewrite could name an unregistered type'
    : `no ladder agent has started in this session${since}, so the harness has not shown it registered the ladder here`;
  return { target: null, def: null, why };
}

// "explore -> haiku (agent-companion:ac-haiku); ..." — the current
// routes of a few common task types, read through the same resolver the
// guard uses (routing profile included), for the deny texts that tell a
// spawner how to route instead. Read at deny time only, so the advice
// follows the table. '' when the table cannot be read.
export function commonTypeRoutes(names = ['lookup', 'bounded-feature', 'debug-root-cause', 'novel-design']) {
  const out = [];
  for (const n of names) {
    try {
      const r = resolveRoute({ type: n });
      if (!r.model) continue;
      // haiku has no effort: its rung is the one with none (rungFor wants null)
      const rung = rungFor(r.model, r.effort || null);
      out.push(`${n} -> ${r.model}${r.effort ? '/' + r.effort : ''}${rung ? ` (agent-companion:${rung.agent})` : ''}${routeLayerTag(r.layer)}`);
    } catch { /* skip this type */ }
  }
  return out.join('; ');
}

// Whether an opus model pinned by the running definition keeps the spawn out
// of the premium fan-out cap (operator decision 2026-09-27, narrowed after
// the 0.29.19 review). Exempt, as a deliberate choice of tier:
//   - this plugin's own ac-opus-* ladder rungs, except ac-opus-max (the top
//     rung, "large cost for small gain", stays counted);
//   - a project agent (<cwd>/.claude/agents) or a user agent
//     (~/.claude/agents): both are the operator's own files.
// Still counted: another plugin's agent (its author chose the tier, not the
// operator), a definition named like a built-in type (a project
// `general-purpose.md` pinning opus reads as the built-in to anyone reading
// the spawn), and ac-opus-max wherever it resolves. Fable is never exempt
// (the caller checks the alias is opus). Decided by the directory the
// definition was read from, the same file agentDefinition() returned.
export const BUILTIN_AGENT_NAMES = new Set(['general-purpose', 'explore', 'plan', 'claude-code-guide', 'statusline-setup']);
export function definitionPinExempt(type, def, cwd) {
  if (!def || !def.file || !type) return false;
  const t = String(type);
  const namespaced = t.includes(':');
  const bare = namespaced ? t.slice(t.indexOf(':') + 1) : t;
  if (BUILTIN_AGENT_NAMES.has(bare.toLowerCase()) || bare === 'ac-opus-max') return false;
  const norm = (d) => {
    const r = resolve(d);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  let from;
  try { from = norm(dirname(def.file)); } catch { return false; }
  const is = (d) => { try { return !!d && norm(d) === from; } catch { return false; } };
  if (is(ownAgentsDir())) return isLadderAgentName(bare);
  if (namespaced) return false;
  return projectAgentRoots(cwd).some(is);
}

// Whether a spawn is PROJECT-PINNED: a bare-named project or user agent (not a
// built-in type, not a ladder rung, not another plugin's `<plugin>:<agent>`)
// whose definition file sets a model the tier table knows and/or an effort
// level it knows. The operator chose that tier for that agent, so the guard
// does not judge it by task weight (see `pinned` in the main body). The scope
// is the folder the definition was read from: a project agents folder (the
// cwd's or a parent's up to the project root) or the user's.
// { pinned, scope: 'project' | 'user' | null, fields: 'model' | 'effort' | 'model+effort' | null }
export function pinInfo(type, def, cwd) {
  const none = { pinned: false, scope: null, fields: null };
  try {
    if (!def || !def.file || !type) return none;
    const t = String(type);
    if (t.includes(':') || BUILTIN_AGENT_NAMES.has(t.toLowerCase()) || isLadderAgentName(t)) return none;
    const norm = (d) => {
      const r = resolve(d);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const from = norm(dirname(def.file));
    const roots = projectAgentRoots(cwd);
    // roots: the cwd's own folder first (project), its parents (project), the
    // user's last. A cwd that is the user's own folder reads as project.
    const at = roots.findIndex((r) => norm(r) === from);
    if (at < 0) return none;
    const scope = (at === roots.length - 1 && !(at === 0 && cwd)) ? 'user' : 'project';
    const model = String(def.model || '').trim();
    const hasModel = !!model && !/^inherit$/i.test(model) && classifyModel(model).known;
    const hasEffort = !!def.effort && classifyEffort(def.effort).known;
    if (!hasModel && !hasEffort) return none;
    return { pinned: true, scope, fields: hasModel && hasEffort ? 'model+effort' : hasModel ? 'model' : 'effort' };
  } catch { return none; }
}
