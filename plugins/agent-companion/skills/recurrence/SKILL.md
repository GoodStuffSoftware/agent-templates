---
name: recurrence
description: Scan session transcripts for failure signatures that recur across the most DISTINCT SESSIONS — the signal that a gotcha keeps happening rather than having been hit once. Use when asked what keeps going wrong, what error shows up over and over, which gotchas are undocumented, or to investigate a new "recurring_failures" scout signal (dispatch gotcha-capture).
---

# Recurrence — which failures keep coming back

A memory corpus captures what someone thought to write down, not what keeps
happening. This ranks failures by how many **distinct sessions** hit them,
which is a different and better question than "how often does this word
appear" — a thing struggled with five times leaves five traces in five
sessions; a one-off leaves one. See
`docs/adr/0002-stack-scoped-gotcha-retrieval.md` — this is the
capture-on-miss half of that decision.

Deterministic and streaming: no model involved in the scan itself, only in
deciding what a finding is worth once ranked. Zero dependencies.

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
node "$AC/scripts/recurrence.mjs"                              # full scan, human table, top 30
node "$AC/scripts/recurrence.mjs" --since 2026-09-01            # incremental — only transcripts touched since then
node "$AC/scripts/recurrence.mjs" --min-sessions 5 --top 10
node "$AC/scripts/recurrence.mjs" --json                        # full ranked array + scan metadata
node "$AC/scripts/recurrence.mjs" --out ./scan.json              # override the write location (see below)
```

`--min-sessions` (default 3) is the floor: a signature recurring in fewer
distinct sessions than this is dropped, not merely ranked low — a two-time
coincidence is not "recurring" yet. `--top` (default 30) caps the **human
table only**; `--json` always returns the full ranked array regardless of
`--top`; a signature that just crossed the floor rarely lands in the top 30
by raw session count, and a caller diffing "what's new" needs to see it
anyway. `--since <ISO date>` skips any transcript whose mtime predates it —
a full scan (the default, no `--since`) is the right choice for "what's
recurring, all time?"; an incremental one is what the daily scout uses so it
never re-reads the whole corpus.

## Reading a row

```
sess  proj  hits  first..last            signature
   6     4    11   2026-05-02..2026-09-18  no such file or directory, open <path>
```

`sess` (sessions) is the ranking signal — distinct sessions that hit this
signature, the recurrence count itself. `proj` is distinct projects, `hits`
is raw match count (can exceed sessions when one failure trips more than one
PATTERNS regex in the same text — not itself meaningful, don't rank on it).
`signature` is normalised: paths, hex-looking tokens, and numbers are
collapsed to `<path>` / `<hex>` / `<n>` so the same failure in two repos, or
against two different temp files, is one row, not several — the `sample`
field in `--json` output keeps one raw, unredacted occurrence for a human to
recognise the failure by by eye.

## What counts as a failure (and what deliberately does not)

Only text Claude Code itself attributes to a **tool result** — a
`tool_result` content block, or the top-level `toolUseResult` field — is
eligible to be matched. Assistant and user PROSE is never scanned, on
purpose: an early version of this scan matched every message's text and
found a 70-session "recurring failure" that was actually a line from the
operator's own standing rules ("if the reviewer failed to catch it, update
that agent's `.md` immediately") being quoted into spawn briefs — the phrase
"failed to" tripped a pattern, but nothing had actually failed. A real
failure is something a tool reported back, not something someone wrote about
failures in general.

Within tool output, ten pattern families are matched (`ENOENT`/`EACCES`/etc.,
`fatal:`, `TypeError:`/`SyntaxError:`/etc., "permission denied", "command not
found" / "No such file or directory", "cannot find module", a non-zero exit
code, and a generic `Error:`/`error TS####:` line) — see `PATTERNS` in
`recurrence.mjs` for the exact regexes. Label-only prefixes (`Error:`,
`ENOENT:`, `fatal:`, `error TS####:`, and their errno siblings) are stripped
before signing, so "Error: ENOENT: no such file…", "ENOENT: no such file…",
and a bare "No such file…" collapse into ONE row instead of three — but the
error **class** is never stripped (`TypeError:` and `SyntaxError:` stay
distinct rows even when the rest of the message matches), because which
class occurred is part of what makes two failures the same or different.

## Where the output goes

Every CLI run writes its full ranked array + scan metadata as JSON under the
plugin's disposable data directory (`recurrence-scan/scan-<timestamp>.json`
next to `transcript-harvest/` — see that script for the same convention),
**never into this repository**. A scan result contains real absolute paths,
project names, and remote URLs pulled straight out of the operator's own
transcripts; writing that into a public library's repo would fail
`node scripts/leak-check.mjs` and ship a real person's file layout to
everyone who clones it. `--out <path>` can redirect the write, and warns
(does not refuse) if the resolved path looks like it lands back inside the
plugin's own checkout.

## The daily scout's use of this

`scripts/detect.mjs`'s `recurring_failures` check (dispatch `gotcha-capture`,
gated by the `recurrence_scan` plugin option, default on) calls
`scanRecurrence()` from this file directly — no subprocess — scanning
incrementally from its own last-scan cursor. It reports a signal **only**
for a signature that crosses `--min-sessions` for the first time since the
last check; the already-reported set lives in the scout's baseline as capped
hashes, never raw text. On an ordinary day the answer is "nothing new
crossed" and the check says nothing at all — silence is this plugin's
default state, the same discipline every other scout check follows. If a
`recurring_failures` signal did fire, the next step is authoring a
`symptoms:` key on a lesson or memory file for it (see
`docs/adr/0002-stack-scoped-gotcha-retrieval.md`'s capture-on-miss section) —
this script only finds the candidate, it does not write anything.

## What this is NOT

Not a gotcha store, not a scorer, not a fix. It answers exactly one
question — "which failures have we hit in the most distinct sessions" — and
leaves deciding what to do about a finding to whoever reads the ranked list.
