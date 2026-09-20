// Deliverable 2 — targeted memory pointers appended to a spawn brief — plus
// deliverable "nudge mode", a second, threshold-free behaviour below.
//
// These are PURE FUNCTIONS, not a second PreToolUse hook on ^Agent$.
// spawn-guard.mjs already returns hookSpecificOutput.updatedInput on that
// matcher, to autofill `model` from the routing table (its fit_autofill
// path). A second hook on the same matcher returning its own updatedInput
// could silently clobber that — one PreToolUse response wins, the other's
// updatedInput is simply dropped, and a live cost-control feature (the model
// autofill) goes quiet with no error anywhere. So this lives here instead:
// spawn-guard.mjs calls buildMemoryBrief() or buildMemoryNudge() and merges
// the result into the SAME updatedInput object that carries the model
// change. Exactly one updatedInput per spawn, carrying both.
//
// Silence is the default state. ~77 spawns/24h on this machine is a lot of
// chances to be noise, so nothing is appended unless the top hit clears
// minScore, and the function fails open (returns no block) on anything it
// cannot do quickly — including a stale index, which it will happily serve
// rather than block the spawn to rebuild.
//
// --- Why pointer mode (BM25 + minScore) is gated off by default -----------
//
// Measured on this operator's real corpus, top BM25 score (k1=1.2, b=0.75):
//   on-topic, long                 21.63
//   off-topic but plausible dev text, long   17.65
//   nonsense, long                  6.71
//   on-topic, short                10.70
// BM25 is a SUM over matched query terms, so it scales with brief length
// almost as much as with relevance — the on-topic SHORT brief (10.70) scores
// below the off-topic LONG one (17.65). No fixed threshold separates "about
// a documented topic" from "long enough to accumulate a few incidentally
// rare shared words": the shipped default of 25 sits above the genuinely
// on-topic long case too, so pointer mode is silent even when it should not
// be. Relative gating (top-hit / median-hit ratio) was tried as a fix and is
// WORSE, not better — on this same data the nonsense query produced the
// HIGHEST ratio observed (1.33), i.e. relative gating is most confident
// exactly when it is most wrong. The fix is not a better threshold; there
// isn't one. It is to stop asking a score to decide relevance at this layer
// at all — see buildMemoryNudge() below, which asks nothing of the kind and
// is the default (`memory_brief_mode: "nudge"`). Do not re-derive this by
// re-tuning minScore; the next tuning pass will hit the same wall.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadOrBuildIndex, search, memoryRoot,
  findRepoRoot, loadOrBuildRepoIndex,
  breadcrumb, displayText, getMergeStatus, mergeStatusLabel,
  resolveMemoryScopeDir,
} from './memory-index.mjs';

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

// Load the repo-scope chunk pool for a brief-building call (pointers or
// nudge). Shared so both modes fail open identically: no repo found, repo
// scope turned off, or any error along the way all just contribute nothing,
// same as an absent/empty user corpus does.
function repoChunksFor({
  cwd, dataDirPath, repoEnabled, repoGlobs, repoMaxFileBytes, repoMaxTotalBytes,
}) {
  if (repoEnabled === false) return { chunks: [], found: null, mergeStatus: null };
  try {
    const found = findRepoRoot(cwd);
    if (!found) return { chunks: [], found: null, mergeStatus: null };
    const { index } = loadOrBuildRepoIndex({
      root: found.root,
      dataDirPath,
      globs: repoGlobs,
      maxFileBytes: repoMaxFileBytes,
      maxTotalBytes: repoMaxTotalBytes,
      forceRebuild: false,
      rebuildIfStale: false, // same rule as the user scope: never block a spawn on a reindex
    });
    // Never fetches (see the banner in memory-index.mjs) — as-of-last-fetch,
    // same as everything else this hook can see about the remote.
    let mergeStatus = null;
    try { mergeStatus = getMergeStatus(found.root, dataDirPath); } catch { mergeStatus = null; }
    return { chunks: index?.chunks || [], found, mergeStatus };
  } catch {
    return { chunks: [], found: null, mergeStatus: null }; // fail open
  }
}

// Pure: given a spawn brief and the tunables spawn-guard.mjs read from opt(),
// returns { block, hits }. `block` is '' when nothing clears minScore — the
// caller appends it to the prompt only when non-empty. Searches BOTH scopes
// (user + repo) as one combined pool, same as the CLI's --scope all.
export function buildMemoryBrief({
  prompt, cwd, maxHits = 3, minScore = 25, root, dataDirPath,
  repoEnabled = true, repoGlobs, repoMaxFileBytes, repoMaxTotalBytes,
}) {
  const text = String(prompt || '');
  const emptyFacts = { attached: false };
  if (!text.trim() || !dataDirPath) return { block: '', hits: [], facts: emptyFacts };

  let userChunks = [];
  try {
    const { index } = loadOrBuildIndex({
      root: root || memoryRoot(),
      dataDirPath,
      forceRebuild: false,
      // Never rebuild on the spawn's own time budget — a stale cache beats a
      // hung spawn. A cache that does not exist yet still gets built once
      // (loadOrBuildIndex always builds when there is nothing to serve).
      rebuildIfStale: false,
    });
    userChunks = index?.chunks || [];
  } catch { /* fail open: user scope contributes nothing */ }

  const { chunks: repoChunks, mergeStatus } = repoChunksFor({
    cwd, dataDirPath, repoEnabled, repoGlobs, repoMaxFileBytes, repoMaxTotalBytes,
  });

  const pool = [...userChunks, ...repoChunks];
  if (!pool.length) return { block: '', hits: [], facts: emptyFacts };

  // Cast a slightly wider net than maxHits so the local-project boost below
  // has candidates to promote past a marginally higher-scoring cross-project
  // hit, then trim to maxHits after boosting.
  const hits = search(pool, text, { limit: Math.max(20, maxHits * 5) });
  if (!hits.length || hits[0].score < minScore) return { block: '', hits: [], facts: emptyFacts };

  // The resolved "here" directory (see memory-index.mjs's module banner for
  // the precedence and why an exact match replaced a substring guess) — the
  // same helper buildMemoryNudge() and memory-search.mjs's --here use, so a
  // worktree session boosts the MAIN repo's memory, not a same-named but
  // empty worktree-encoded store.
  const scope = resolveMemoryScopeDir({ cwd, root: root || memoryRoot() });
  const boosted = hits
    .map((h) => ({ ...h, local: h.chunk.scope === 'user' && !!scope.dir && h.chunk.project === scope.dir }))
    .sort((a, z) => (z.score * (z.local ? LOCAL_PROJECT_BOOST : 1)) - (a.score * (a.local ? LOCAL_PROJECT_BOOST : 1)));

  const top = boosted.slice(0, Math.max(1, maxHits));
  const lines = top.map((h) => {
    const bc = ` · ${breadcrumb(h.chunk)}`;
    const text2 = snippet(displayText(h.chunk));
    if (h.chunk.scope === 'repo') {
      // The repo root's own content is real and worth finding, but it may
      // not yet be on the main line — the label says so ONLY when HEAD is
      // actually ahead of a resolved default ref (see getMergeStatus), never
      // just because this happens to be a worktree.
      const label = mergeStatusLabel(mergeStatus);
      const tag = label ? ` [${label}]` : '';
      return `- repo${tag} · ${h.chunk.file}${bc} — "${text2}"`;
    }
    const tag = h.local ? '' : ' [cross-project]';
    return `- ${h.chunk.project}${tag} · ${h.chunk.file}${bc} — "${text2}"`;
  });

  let block = [
    '',
    '---',
    'agent-companion memory pointers (unverified — worth reading, not established fact):',
    ...lines,
    '---',
  ].join('\n');
  if (block.length > MAX_BLOCK_CHARS) block = `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`;

  return {
    block,
    hits: top,
    facts: {
      attached: true,
      hitCount: top.length,
      topScore: hits[0].score,
      hereProject: scope.dir || null,
      hereSource: scope.source,
    },
  };
}

// --- Nudge mode (threshold-free, the default) ------------------------------
//
// See the module banner above for why: relevance is not this layer's job to
// judge from a score. This asks nothing of the index but cheap metadata —
// how many files exist, for which projects — and never ranks or filters by
// content. It is either silent (no corpus anywhere relevant) or says the
// same thing regardless of what the brief is about, which is the point: it
// cannot be wrong the way a score-gated block can be.

// ${CLAUDE_PLUGIN_ROOT} is set by the harness for the hook process itself
// (see hooks.json / self-update.mjs), which is exactly the context this runs
// in — spawn-guard.mjs is invoked as a hook. The import.meta.url fallback
// mirrors context.mjs's modelTiers() for the same "no env var" case (e.g. a
// direct script invocation for tests), walking up from hooks/lib/ to the
// plugin root the same two levels.
function pluginRoot() {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) return envRoot;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Pure aside from the cached-index reads: given cwd and the plugin's data
// dir, returns { text, facts }. `text` is a single nudge line, or '' when
// there is nothing to nudge about in EITHER scope (no user-corpus files for
// this project or any other, AND no repo resolved / repo has nothing
// matching its globs). No scoring, no threshold, no relevance judgement —
// just file counts, for both scopes, which is why this survives a cloud
// session where the user corpus is simply absent: the user half degrades to
// all-zero and the repo half still has something to say. `facts` is always
// populated (even when `text` is '') so a caller — hooks/spawn-guard.mjs —
// can log what this function found regardless of whether it decided to say
// anything, which is the observability half of this fix: before it, nothing
// in spawns.jsonl named the memory feature at all, so confirming delivery
// required a live echo probe.
export function buildMemoryNudge({
  cwd, root, dataDirPath, repoEnabled = true, repoGlobs, repoMaxFileBytes, repoMaxTotalBytes,
}) {
  const emptyFacts = { attached: false };
  if (!dataDirPath) return { text: '', facts: emptyFacts };

  let index = null;
  try {
    ({ index } = loadOrBuildIndex({
      root: root || memoryRoot(),
      dataDirPath,
      forceRebuild: false,
      rebuildIfStale: false, // same rule as pointers mode: never block a spawn on a reindex
    }));
  } catch {
    index = null; // fail open: user half contributes nothing, repo half still can
  }

  // index.files is keyed by relKey = `${project}/${fileRel}` (memory-index.mjs)
  // — split on the first '/' to recover per-project file counts without a
  // second filesystem walk.
  const counts = new Map();
  for (const relKey of Object.keys(index?.files || {})) {
    const slash = relKey.indexOf('/');
    if (slash < 0) continue;
    const project = relKey.slice(0, slash);
    counts.set(project, (counts.get(project) || 0) + 1);
  }

  // The resolved "here" directory — see memory-index.mjs's module banner.
  // An EXACT match against counts' keys, not a substring guess: the whole
  // point of resolveMemoryScopeDir() is that it already names the real
  // on-disk directory, so a fuzzy match would just reintroduce the same
  // class of bug (matching a same-named-but-wrong store) one layer down.
  const scope = resolveMemoryScopeDir({ cwd, root: root || memoryRoot() });
  const hereProject = scope.dir && counts.has(scope.dir) ? scope.dir : null;
  const hereCount = hereProject ? counts.get(hereProject) : 0;
  const otherCount = counts.size - (hereProject ? 1 : 0);

  const { chunks: repoChunks, mergeStatus } = repoChunksFor({
    cwd, dataDirPath, repoEnabled, repoGlobs, repoMaxFileBytes, repoMaxTotalBytes,
  });
  const repoFileCount = new Set(repoChunks.map((c) => c.file)).size;

  const facts = {
    attached: false,
    hereCount,
    otherCount,
    repoFileCount,
    hereProject: hereProject || null,
    hereSource: scope.source,
  };

  if (hereCount === 0 && otherCount === 0 && repoFileCount === 0) return { text: '', facts };

  const here = hereCount > 0 ? `${hereCount} here` : '0 here';
  const others = `${otherCount} elsewhere`;
  // Only says "unmerged" when HEAD is actually ahead of a resolved default
  // ref (getMergeStatus) — never asserted from worktree-ness alone, and
  // never fetched: as-of-last-fetch, same as the rest of this line.
  const mergeLabel = mergeStatusLabel(mergeStatus);
  const repoPart = mergeLabel ? `${repoFileCount} repo (${mergeLabel})` : `${repoFileCount} repo`;
  const script = join(pluginRoot(), 'scripts', 'memory-search.mjs');

  facts.attached = true;

  // Worded as an available capability, not an instruction or established
  // fact — the agent decides whether its task is unfamiliar enough to use
  // it. Relevance-blind by design: this line is the same whether the brief
  // is on-topic, off-topic, or nonsense (see calibration table above). Kept
  // short deliberately — the resolved script path below is the variable
  // part of this line's length and cannot be shortened further, so the
  // fixed wording stays terse to leave it room.
  const text = `\n\n[agent-companion: memory — user ${here}, ${others}; ${repoPart} — ` +
    `unfamiliar? try: node ${script} "<query>" --scope all]`;
  return { text, facts };
}
