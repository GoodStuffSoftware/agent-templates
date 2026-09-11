---
name: memory-search
description: Search the operator's WHOLE memory corpus — every project's memory/*.md under ~/.claude/projects/*/memory/, not just this one — with BM25 lexical ranking. Use when a task smells previously-solved, when you hit an unfamiliar error and want to know if another project already hit it, when recalling why a past decision was made, or when onboarding to a repo you have not worked in before. Triggers: "have I solved this before", "did we hit this error in another project", "what did we decide about X", "is there prior art for this", recalling a past fix across repos.
---

# Memory search — cross-project technical recall

A BM25 index over every project's `memory/*.md`, ranked by chunk (not whole
file) with a project, file, and heading-trail breadcrumb on every hit. It
exists for the gap this project's own loaded memory can't fill: what got
solved, decided, or learned somewhere else.

## When to reach for it

- The task smells previously-solved — a config quirk, a flaky test, a deploy
  step that always trips people up.
- An error message or stack trace looks generic enough that another project
  has probably hit it too.
- A decision's *rationale* matters ("why did we pick X over Y") and is not
  written down in the code itself.
- Onboarding to a repo this session has not worked in before, where a scan of
  what's been learned beats re-discovering it from scratch.

## When NOT to

- The answer is in the code in front of you. Read that first.
- It's already in **this project's own `MEMORY.md`**, loaded at session start.
  Searching for what you already have in context wastes a call and adds
  nothing — this tool is for what is *not* already in front of you.

## Locate the plugin first

`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks. In an ordinary shell it is
empty, so a command written with it collapses silently. Resolve it explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
[ -n "$AC" ] || AC="$(ls -d "$HOME"/.claude/plugins/cache/*/agent-companion/* 2>/dev/null | tail -1)"
[ -n "$AC" ] || { echo "agent-companion not found — is the plugin installed?"; }
```

PowerShell (forward slashes on purpose — they survive copy-paste):

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
```

## How to invoke

```bash
node "$AC/scripts/memory-search.mjs" "<query>"
node "$AC/scripts/memory-search.mjs" "<query>" --project best-sudoku
node "$AC/scripts/memory-search.mjs" "<query>" --limit 5 --json
node "$AC/scripts/memory-search.mjs" --stats
```

`--project` is a case-insensitive substring match against the project's
directory name — no need for the exact encoded path. `--limit` defaults to 10.
`--json` gives machine-readable hits (score, project, file, heading, snippet)
for a caller that wants to post-process rather than read prose. `--stats`
reports corpus size (projects, files, chunks) with no query, useful for
sanity-checking that the index sees anything at all.

## How to read results

Each hit is `score  project · file · heading trail`, followed by a snippet.
These are **pointers, not the content itself** — open the file at the given
heading for the real thing before acting on it. Memories carry **no expiry**:
a hit may describe a decision that was later reversed, a bug since fixed, or a
constraint that no longer holds. Check the date and surrounding context in the
file itself; do not treat a hit as current just because it ranked highly.

## The honest limitation

This is **BM25 lexical ranking, not semantic search**. It matches shared
words, not shared meaning. A specific, multi-word technical query works well —
error strings, flag names, file names ("firebase emulator boot failure",
"ETIMEDOUT wrangler dev"). A vague conceptual query works poorly ("how do we
do deploys") because it shares few literal terms with whatever text actually
answers it. Query with the distinctive terms you'd expect the answer to
contain, not a prose description of what you want to know.

## Recovering a lead from session history

If the corpus above comes up empty, it may be because the answer was never
written down as a memory file — but a past session may still have solved it,
and left a trace at compaction time. `scripts/transcript-harvest.mjs` mines
that trace: not a transcript search tool (a separate tool elsewhere in the
operator's toolchain already does full-text transcript search), but a
harvester for the structured recap Claude Code writes for *itself* when a
conversation runs out of context and gets compacted.

```bash
node "$AC/scripts/transcript-harvest.mjs" --project <name> --limit 10
```

It writes a reviewable Markdown digest (plus a JSON sidecar) under the
plugin's data directory and prints the path — it never touches a `memory/`
directory itself. Treat everything in that digest as a **model's own
recollection of an earlier conversation, not a primary source**: it can be
incomplete, or simply wrong about its own history. Read it, verify anything
that looks relevant against the real files or commits, and only then propose
it as a memory through the normal memory-writing path — never copy a digest
entry straight into a memory file.
