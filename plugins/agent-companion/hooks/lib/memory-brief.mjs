// Deliverable 2 — targeted memory pointers appended to a spawn brief.
//
// This is a PURE FUNCTION, not a second PreToolUse hook on ^Agent$.
// spawn-guard.mjs already returns hookSpecificOutput.updatedInput on that
// matcher, to autofill `model` from the routing table (its fit_autofill
// path). A second hook on the same matcher returning its own updatedInput
// could silently clobber that — one PreToolUse response wins, the other's
// updatedInput is simply dropped, and a live cost-control feature (the model
// autofill) goes quiet with no error anywhere. So this lives here instead:
// spawn-guard.mjs calls buildMemoryBrief() and merges the result into the
// SAME updatedInput object that carries the model change. Exactly one
// updatedInput per spawn, carrying both.
//
// Silence is the default state. ~77 spawns/24h on this machine is a lot of
// chances to be noise, so nothing is appended unless the top hit clears
// minScore, and the function fails open (returns no block) on anything it
// cannot do quickly — including a stale index, which it will happily serve
// rather than block the spawn to rebuild.

import { basename } from 'node:path';
import { loadOrBuildIndex, search, memoryRoot } from './memory-index.mjs';

const MAX_BLOCK_CHARS = 1200;
const SNIPPET_CHARS = 150;
const LOCAL_PROJECT_BOOST = 1.5; // prefer the caller's own project, don't exclude the rest

// minScore's default lives in plugin.json (userConfig.memory_brief_min_score),
// not here — this fallback only applies when a caller invokes this function
// directly without going through opt(). See that key's description for the
// calibration finding: raw BM25 score correlates with QUERY LENGTH almost as
// much as with topical relevance on this operator's real corpus, because a
// longer brief simply accumulates more incidentally-rare shared words. There
// is no threshold that cleanly separates "genuinely about a documented topic"
// from "long text that happens to share a few rare tokens" — the default is
// set high on purpose, to keep silence the norm at the cost of some misses.

function snippet(text, max = SNIPPET_CHARS) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// cwd is a full path (WSL or Windows); the project match is a best-effort
// substring check against the last path segment, same leniency the --project
// CLI flag already uses. There is no reliable inverse of the harness's own
// project-dir encoding available here (see memory-budget.mjs's fallback for
// the same problem), and a soft substring preference is enough for "prefer",
// which is all this needs — it is not gating anything.
function projectLeaf(cwd) {
  if (!cwd) return '';
  return basename(String(cwd).replace(/\\/g, '/'));
}

// Pure: given a spawn brief and the tunables spawn-guard.mjs read from opt(),
// returns { block, hits }. `block` is '' when nothing clears minScore — the
// caller appends it to the prompt only when non-empty.
export function buildMemoryBrief({
  prompt, cwd, maxHits = 3, minScore = 25, root, dataDirPath,
}) {
  const text = String(prompt || '');
  if (!text.trim() || !dataDirPath) return { block: '', hits: [] };

  let index;
  try {
    ({ index } = loadOrBuildIndex({
      root: root || memoryRoot(),
      dataDirPath,
      forceRebuild: false,
      // Never rebuild on the spawn's own time budget — a stale cache beats a
      // hung spawn. A cache that does not exist yet still gets built once
      // (loadOrBuildIndex always builds when there is nothing to serve).
      rebuildIfStale: false,
    }));
  } catch {
    return { block: '', hits: [] }; // fail open
  }
  if (!index?.chunks?.length) return { block: '', hits: [] };

  // Cast a slightly wider net than maxHits so the local-project boost below
  // has candidates to promote past a marginally higher-scoring cross-project
  // hit, then trim to maxHits after boosting.
  const hits = search(index.chunks, text, { limit: Math.max(20, maxHits * 5) });
  if (!hits.length || hits[0].score < minScore) return { block: '', hits: [] };

  const leaf = projectLeaf(cwd).toLowerCase();
  const boosted = hits
    .map((h) => ({ ...h, local: !!leaf && h.chunk.project.toLowerCase().includes(leaf) }))
    .sort((a, z) => (z.score * (z.local ? LOCAL_PROJECT_BOOST : 1)) - (a.score * (a.local ? LOCAL_PROJECT_BOOST : 1)));

  const top = boosted.slice(0, Math.max(1, maxHits));
  const lines = top.map((h) => {
    const tag = h.local ? '' : ' [cross-project]';
    const heading = h.chunk.heading ? ` · ${h.chunk.heading}` : '';
    return `- ${h.chunk.project}${tag} · ${h.chunk.file}${heading} — "${snippet(h.chunk.text)}"`;
  });

  let block = [
    '',
    '---',
    'agent-companion memory pointers (unverified — worth reading, not established fact):',
    ...lines,
    '---',
  ].join('\n');
  if (block.length > MAX_BLOCK_CHARS) block = `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`;

  return { block, hits: top };
}
