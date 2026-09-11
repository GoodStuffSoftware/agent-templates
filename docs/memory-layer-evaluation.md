# Memory layer evaluation

**Date:** 2026-09-11
**Question:** which memory layer should back this operator's own Claude Code tooling across
long-running, multi-project work — and in what shape should it be adopted?

> **Reading convention.** Claims are marked **[VERIFIED]** (read directly from the cited
> source — a LICENSE file, a documentation page, a file measured on this machine) or
> **[INFERRED]** (reasoned from evidence, not directly read). Unmarked statements are the
> author's judgement. Licence claims carry the URL of the file they were read from.
>
> **Naming.** Real project names are replaced with `{{PLACEHOLDERS}}` per this repository's
> publication hygiene rule, which `scripts/leak-check.mjs` enforces in CI. `{{COORD_BUS}}`
> is the operator's cross-agent coordination bus; `{{PRODUCT}}` is their commercial consumer
> product; `{{APP_A}}` is their largest application repo; `{{WORKBOARD}}` is the work-tracking
> subsystem inside `{{COORD_BUS}}`.

---

## 1. Recommendation

**Q1 — which memory layer: keep the one you have, and add retrieval on top of it.** The
incumbent is not a hand-rolled system — it *is* Claude Code's native Auto memory feature, so
"replacing" it means switching off a platform capability that auto-injects your index into
every session and survives compaction, and getting nothing equivalent back
[VERIFIED: https://code.claude.com/docs/en/memory.md]. Every hosted candidate — mem0, Honcho,
Letta, Zep, Cognee — fails the decisive test for your use case: they compress facts into
conversational summaries, and mem0's own extraction prompt proves it by instructing the model
to capture preferences and names, never file paths or command lines
[VERIFIED: https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/configs/prompts.py]. A
memory that says "fixed a path issue" is worthless to you; one that says which flag broke the
pre-push hook is the entire value.

**Q2 — what shape: an opt-in, read-only script plus a spawn-time nudge hook inside the existing
`agent-companion` plugin. Not a service, not MCP, not a new plugin.** That plugin already has
exactly the machinery this needs — a `PreToolUse` hook already intercepting every `Agent` spawn,
a `SessionStart` hook that injects text via `hookSpecificOutput.additionalContext`, a scripts
directory, a 16-key `userConfig` toggle block, and a zero-dependency Node-builtins-only
discipline — so the marginal cost is one ~200-line script and one hook, with no new process, no
database and nothing to keep running [VERIFIED: plugin source, §7].

**Two constraints set by the operator, 2026-09-11, and they shape the build:** the feature ships
**default-off** behind a `userConfig` key, because `agent-companion` is distributed publicly and
other users may not want their memory touched; and it is **strictly read-only** — it builds a
derived, disposable index and never writes to or reorganises a memory file.

**The primary consumer is the spawn path, not a human.** §4.6 and §7.1 establish that the churn
worth fixing is subagents starting cold, not the operator failing to find things. Build for that
first.

---

## 2. What this has to do

### 2.1 The two jobs

**UC1 — project-scoped technical recall.** Inside one repo, recall specific technical detail:
what was decided, what broke, which flag, which path, why the obvious fix fails. Precision
matters more than recall; answers from another project are noise.

**UC2 — cross-project technical solution search.** From any repo, find a solution already
worked out somewhere else across six repositories. This is a recall problem over a corpus that
is mostly *not* curated — the answer often sits in a session transcript, not a memory file.

These pull in opposite directions: UC1 wants tight scoping, UC2 wants a join across every
silo. Any candidate must serve both, and this evaluation states how each one scopes.

### 2.2 Three capabilities the operator named

- **Import** — ingest the memories that already exist, across every project directory,
  including divergent duplicates of the same project.
- **Extract** — crawl session transcripts and pull out facts nobody wrote down.
- **Reconcile** — detect and resolve memories that contradict each other, rather than
  accumulating both and letting the model pick.

### 2.3 The seven weighted criteria

1. **Long-running projects** (highest weight) — does a session six weeks later learn what was
   decided and why?
2. **Licence** — verified from the repository, for the server component specifically.
   **Constraint relaxed by the operator, 2026-09-11:** because this tooling is free and not
   commercially distributed, copyleft — AGPL-3.0 included — is **not disqualifying here**, and
   a tool that is plainly better for personal use beats one that is merely safer to licence.
   Licences are still verified and stated, because the same verdict does **not** transfer to
   `{{PRODUCT}}` (§8), and a licence that changed once can change again.
3. **Operational burden** — one person; a service plus a database plus migrations is a tax.
4. **Failure mode** — down, corrupted, vendor gone: can memories still be read?
5. **Multi-project isolation with a cross-project view** — UC1 and UC2 above.
6. **Cost** at realistic personal scale.
7. **Does it survive compaction, and does it actually get READ?** By what mechanism does
   content reach the model — automatic injection, tool call, MCP resource?

---

## 3. The finding that reframes the question

**The incumbent is a native Claude Code feature, not a convention.** The pattern in use —
`~/.claude/projects/<encoded-cwd>/memory/`, one markdown file per fact with `type` frontmatter
(`user` / `feedback` / `project` / `reference`), plus a `MEMORY.md` index loaded at session
start — is documented as Claude Code's built-in Auto memory
[VERIFIED: https://code.claude.com/docs/en/memory.md]. Specifically:

- The **first 200 lines or first 25 KB of `MEMORY.md`, whichever comes first**, are loaded at
  the start of every conversation. Topic files are **not** auto-loaded; they are read on
  demand [VERIFIED].
- Content past that limit is **silently dropped on the next load** [VERIFIED].
- Extraction is automatic — the model decides what is worth remembering [VERIFIED].
- `MEMORY.md` is **re-injected from disk after compaction**
  [VERIFIED: https://code.claude.com/docs/en/context-window.md].
- Settings keys: `autoMemoryEnabled` (default true), `autoMemoryDirectory`, env
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, and `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+), which lets
  you **name the project directory yourself** [VERIFIED].
- A `/memory` command exists; there is no `/remember` command [VERIFIED].
- The main session's auto memory is **not** inherited by spawned subagents [VERIFIED].

Three consequences follow, and they drive the whole recommendation:

1. **Criterion 7 is already won, and only by the incumbent.** Automatic injection plus
   automatic re-injection after compaction is a property no external candidate has. Every other
   option below requires the model to *choose* to call a tool. A memory nobody retrieves is
   worthless, and "the harness put it in the prompt" beats "the model might ask" every time.
2. **The operator's `CLAUDE.md` partly re-describes a mechanism that already runs.** The
   "Memory writes — when to persist" section instructs behaviour the harness does
   automatically. That is not harmful — the KIND-routing ladder is more specific than the
   native feature and earns its place — but it should be understood as reinforcement, not as
   the thing that makes memory work.
3. **Two named weaknesses have native fixes, not tool fixes.** Path fragmentation is solved by
   `CLAUDE_CODE_PROJECT_DIR_NAME` / `autoMemoryDirectory`; index size is a documented hard
   ceiling to manage, not a scaling mystery.

---

## 4. The incumbent, measured

All figures measured on this machine, 2026-09-11 **[VERIFIED]**.

### 4.1 Scale

| Measure | Value |
|---|---|
| Memory directories under `~/.claude/projects/` | 14 |
| Of those, holding at least one memory file | 12 |
| Total memory files (`*.md`, all depths) | **435** |
| Total corpus size | **1,500,774 B (~1.5 MB, ~375k tokens)** |
| `MEMORY.md` index files | 12 |
| Combined index size | 57,166 B (~14.3k tokens if all were loaded at once) |
| Largest index | `{{APP_A}}` — 19,825 B, 120 lines, 190 linked entries |
| Second | `{{COORD_BUS}}` — 18,245 B, 67 lines, 56 entries |

**Distribution is extremely skewed.** `{{APP_A}}` alone holds 258 files / 1,006,683 B — **67%
of the entire corpus**. `{{COORD_BUS}}` holds another 58 files / 224,627 B. The remaining ten
directories together hold under 200 KB.

**You are at 79% of a hard ceiling.** `{{APP_A}}`'s index is 19,825 B against the documented
25 KB cap; `{{COORD_BUS}}`'s is 18,245 B (73%). Both are under the 200-line limit (120 and 67),
so bytes will bind first. At the ceiling, **overflow is silently dropped on the next load** —
no error, no warning, just memories that stop being loaded. This is the single most urgent
operational fact in this document.

### 4.2 Index hygiene is good — better than expected

An orphan/dangling audit across the three largest stores found **zero dangling index entries**
in all three; orphaned files (on disk, unreachable from the index) were 40/230 in `{{APP_A}}`,
1/57 in `{{COORD_BUS}}`, and 0/22 in the `dev` store **[VERIFIED]**. The curation discipline
the operator's `CLAUDE.md` describes is genuinely being followed. Any proposal premised on the
store being a mess is arguing against the evidence.

### 4.3 Convention drift is real but localised

Documented convention is one fact per file, `name` / `description` / `metadata.type`
frontmatter, kebab-case. Practice **[VERIFIED]**:

- `{{COORD_BUS}}`: 57/57 kebab-case, zero dump-style files — fully compliant.
- `dev`: 18 kebab / 4 snake, zero dump-style files — compliant.
- `{{APP_A}}`: 211 snake / 17 kebab, and ~65 files are `findings_*`, `handoff-*` or `plan_*` —
  multi-entry session dumps, not single facts. The largest single memory file in the whole
  corpus is 28,023 B — a root-cause investigation write-up, **larger than most projects' entire
  index**.

The documented and practiced systems agree everywhere except the oldest and largest store. This
matters for retrieval: a 28 KB dump is a poor retrieval unit whatever indexes it.

### 4.4 Wikilinks are decorative

540 `[[wikilink]]` occurrences, 260 distinct targets. 89 do not resolve by exact match; 54 still
fail after normalising `-` / `_`, meaning **~35 "broken" links are really just the snake/kebab
split** biting. **Nothing parses them** — a search across hooks and scripts for wikilink
handling returns zero matches **[VERIFIED]**. They are inert text that looks like structure.
Any retrieval layer should either make them real or stop writing them.

### 4.5 The corpus is NOT under version control

`~/.claude` is not a git repository, and no parent directory is either **[VERIFIED]**. The only
durable-copy mechanism visible on the machine is ad-hoc `.bak-<date>` sibling files.

**Correction, and the mechanism, now verified (2026-09-11).** An off-machine copy does exist: a
`session-sync` plugin replicates `~/.claude` to cloud storage via rclone, and **the memory
directories are included** — they are not on its exclude list [VERIFIED: plugin source]. So the
catastrophic-loss framing this section originally carried was wrong, and is withdrawn.

What remains is narrower and still real: **a copy is not a history.** Last-write-wins
replication restores *a* state; it cannot tell you what a memory said before someone rewrote it,
and a copy taken *after* a silent truncation past the 25 KB ceiling (§4.1) faithfully preserves
the truncation. The incumbent's headline strength — "git-friendly" — is unrealised, but the fix
is a hygiene item, not an emergency.

Worth noting for scale: that sync moves **~8.15 GB**, of which **96.7% is session transcripts**
and **1.47 MB is the memory corpus** [VERIFIED by measurement]. Transport and history are
therefore separable problems with a ~5,500× size difference between them, and should not be
solved by the same mechanism — see §7.3.

### 4.6 Retrieval precision is the real failure

Literal search across the corpus — the only cross-project retrieval available today — returns
far too much to be an answer **[VERIFIED]**:

| Query | Files matched (of 435) |
|---|---|
| `deploy` | 164 |
| `hook` | 101 |
| `Windows` | 89 |
| `WSL` | 58 |
| `emulator` | 50 |
| `pre-push` | 47 |
| `stash` | 16 |
| `Firebase emulator` | 10 |

"Have I hit this WSL path problem before?" returns a 58-file reading list. Note the corollary:
narrow multi-word queries still work. The failure is specific to the *exploratory*
cross-project question — exactly UC2 — and its cause is **absence of ranking**, not absence of
embeddings. That distinction sets the cheapest sufficient fix (§7).

### 4.7 What is NOT a weakness

**"It isn't a real vector database."** Not a problem. At 435 documents an exhaustive scan is
milliseconds; a vector *index* (HNSW, IVFFlat) optimises corpora three to four orders of
magnitude larger. Any recommendation arriving with a database server attached should be asked
what it buys that a flat array does not.

**"It's just files."** Files are why the failure mode is survivable and hand-editing works.
Several candidates below are worse precisely because they stop being files.

---

## 5. Candidates

Licence verification was performed by fetching the LICENSE file from each repository. Full log
in Appendix A.

### 5.1 The incumbent — Claude Code native Auto memory

Licence: n/a (platform feature). **The only candidate with automatic injection and automatic
post-compaction re-injection.** Fails UC2, has no extraction from transcripts, and no
contradiction detection. Free, zero infrastructure, readable with `cat`.

### 5.2 mem0 — Apache-2.0

[VERIFIED: https://raw.githubusercontent.com/mem0ai/mem0/main/LICENSE] — 65k stars, active.
Has a real four-operation contradiction pipeline (ADD / UPDATE / DELETE / NOOP), genuinely the
best-documented reconciliation story among the SaaS-shaped options. **Disqualified on
fidelity:** its own `FACT_RETRIEVAL_PROMPT` instructs extraction of preferences, names and
movie tastes, and the shipped examples are *"Name is John"*, *"Is a Software engineer"*
[VERIFIED: https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/configs/prompts.py]. Writing
a memory costs two LLM calls. Self-hosting wants a vector store; retrieval is a tool call the
model must choose to make.

### 5.3 Honcho — AGPL-3.0

[VERIFIED: https://raw.githubusercontent.com/plastic-labs/honcho/main/LICENSE] — confirms the
operator's earlier finding. **Under the relaxed constraint this is no longer disqualifying for
personal tooling**, so Honcho was re-evaluated on merit and still loses: it needs Postgres +
pgvector + Redis (3+ containers), runs an async reasoning worker that costs inference after
every message, and is explicitly a theory-of-mind layer — *"it doesn't store conversations, it
derives conclusions from them"*. Derived conclusions are the opposite of what UC1 needs. It
does carry an explicit `contradiction` level in its conclusion schema, a point in its favour
for reconciliation.

### 5.4 Letta (formerly MemGPT) — Apache-2.0

[VERIFIED: https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE] — 24.7k stars,
active. Self-editing memory blocks mean fidelity *can* survive if instructed, but there is no
deterministic contradiction rule — resolution is agent judgement. Needs Postgres + pgvector for
real use (SQLite is dev-only). Letta is an official MCP **client**; exposing Letta itself as an
MCP server is third-party only. It is an agent framework that happens to have memory, and
adopting it means adopting the framework.

### 5.5 Zep — the self-hostable server is gone

[VERIFIED: https://raw.githubusercontent.com/getzep/zep/main/README.md] — the repository now
states *"This repository is not Zep's product or service… Zep Community Edition is no longer
supported"*, with the code moved to `legacy/`. **This is the "promising but actually abandoned"
finding the brief asked for.** What remains is Zep Cloud, closed and paid: free tier 10,000
credits/month, then $125/month [VERIFIED: https://www.getzep.com/pricing/]. Rule it out.

### 5.6 Graphiti — Apache-2.0 — the strongest reconciliation story

[VERIFIED: https://raw.githubusercontent.com/getzep/graphiti/main/LICENSE] — 30.8k stars,
thriving, arXiv-backed. Facts carry validity windows; when information changes, **old facts are
invalidated, not deleted**, via bi-temporal edges (`valid_at` / `invalid_at`), so you can query
what was true at any point [VERIFIED: repository README]. It also preserves provenance back to
the source episode, so technical detail survives better than in mem0. **Cost of entry is the
problem:** it needs Neo4j or FalkorDB, plus LLM calls per episode *and* per invalidation
decision. For one person with 435 facts, standing up a graph database to get temporal
invalidation is not proportionate. Revisit only if reconciliation becomes the dominant pain.

### 5.7 Cognee — Apache-2.0

[VERIFIED: https://raw.githubusercontent.com/topoteretes/cognee/main/LICENSE] — active, 30.6k
stars. Best fidelity of the graph tools (raw chunks retained). But contradiction detection is
opt-in and its own maintainers state in a public issue that *"deduplication is largely
identity-based and contradiction handling is minimal"*
[VERIFIED: https://github.com/topoteretes/cognee/issues/3629]. Needs Postgres + pgvector +
Neo4j. Not ready for the job it would be adopted for.

### 5.8 basic-memory — AGPL-3.0 — the closest architectural match

[VERIFIED: https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/LICENSE];
licence agrees across LICENSE file, README badge and GitHub classifier — no packaging trap.
Active (v0.23.2, 2026-08-25). **It is the only candidate that keeps markdown as the source of
truth**: SQLite is a derived index, files round-trip with hand edits, and it is itself an MCP
server needing no LLM key for local search. Best exit story of any candidate.

**Why it still loses:** it would create a *second* markdown memory tree alongside the native
Auto memory directory, which keeps running regardless. Two systems that both claim to be the
store is worse than one with a weaker index. Its cross-project search is also per-project
`search_notes` plus a lightweight activity-based discovery mode, so UC2 still needs client-side
fan-out. **If the incumbent were not native, this would be the recommendation** — that is the
honest counterfactual, and the main thing that would have to change for §10.

### 5.9 The official MCP `memory` server — MIT

[VERIFIED: https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md]
Confirmed **not** archived; `src/memory` was touched 2026-09-03 [VERIFIED]. Stores an
entity/relation graph in a local JSONL file, no LLM key, no service. But it has **no scoping at
all** — a single global graph — which fails UC1 outright, and no contradiction handling (purely
additive). Too primitive.

### 5.10 DIY: pgvector / sqlite-vec

pgvector is PostgreSQL-licensed
[VERIFIED: https://raw.githubusercontent.com/pgvector/pgvector/master/LICENSE] — note GitHub's
classifier reports `NOASSERTION`, a false negative that illustrates exactly why badges are not
evidence. sqlite-vec is dual Apache-2.0 / MIT [VERIFIED: repository `LICENSE-APACHE`] but is
pre-1.0 (v0.1.9, 2026-03-31), last pushed 2026-05-18, with a live community issue asking
whether it is still maintained [VERIFIED: https://github.com/asg017/sqlite-vec/issues/226].
**Both are substrates, not memory systems.** Adopting either means building the layer above it
— which is §7's recommendation, minus the database.

---

## 6. Comparison table

Criteria: **C1** long-running value · **C2** licence · **C3** ops burden · **C4** failure mode ·
**C5** scoping (UC1/UC2) · **C6** cost · **C7** gets read. Plus **Imp**ort / **Ext**ract /
**Rec**oncile.

| Candidate | C1 | C2 | C3 | C4 | C5 | C6 | C7 | Imp | Ext | Rec |
|---|---|---|---|---|---|---|---|---|---|---|
| **Native Auto memory (incumbent)** | Strong — curated, durable | n/a platform | **None** | `cat`; but no git today | UC1 yes / **UC2 no** | $0 | **Auto-injected + re-injected post-compaction** | n/a | **No** | **No** |
| **+ local ranked index (recommended)** | Strong | n/a | ~200 lines, 0 deps | Index disposable; files survive | **UC1 + UC2** | $0 | Injected *and* on-demand skill | Trivial — reads the files | Batch job | Flags pairs for review |
| mem0 | Weak — lossy facts | Apache-2.0 | Vector store + 2 LLM calls/write | SQL rows readable | Good filters; OSS parity unclear | Free → $19/mo | Tool call only | Conversation replay | Yes, costs inference | **ADD/UPDATE/DELETE/NOOP** |
| Honcho | Weak — derived conclusions | **AGPL-3.0** | PG + pgvector + Redis | Raw msgs yes, derived no | workspace / peer / session | ~$2/M tokens | Tool call only | Batch, backdated ts | Yes | `contradiction` level |
| Letta | Medium | Apache-2.0 | PG + pgvector; whole framework | Postgres readable | Per-agent | Free → $20/mo | Tool call only | Loop inserts | Agent judgement | Agent judgement |
| Zep (server) | — | Apache-2.0 (examples only) | **Gone** | — | — | $125/mo cloud | — | — | — | — |
| Graphiti | Good — provenance kept | Apache-2.0 | **Neo4j + LLM per episode** | Cypher-readable | `group_id` | Self-host + inference | Tool call only | Documented backfill | Yes | **Bi-temporal invalidation** |
| Cognee | Good — raw chunks | Apache-2.0 | PG + pgvector + Neo4j | Readable | dataset + RBAC | Free → $1/M tok | Tool call only | Corpus-first | Yes | **"Minimal" (maintainers)** |
| basic-memory | Strong — markdown stays truth | **AGPL-3.0** | Local SQLite only | **Best — plain markdown** | project scoped; UC2 weak | Free / $15 mo cloud | MCP tool call | Trivial — files | No | **None — editorial** |
| MCP `memory` server | Weak | MIT | None | JSONL readable | **None — global graph** | $0 | Tool call only | Array writes | No | **None — additive** |
| pgvector / sqlite-vec | n/a substrate | PostgreSQL / Apache-MIT | Postgres / embedded | Excellent | You build it | $0 | You build it | You build it | You build it | You build it |

---

## 7. What building the recommended shape would take

### 7.1 Why this shape

`agent-companion` already proves every mechanism required **[VERIFIED from plugin source]**:

- **Injection:** its `SessionStart` hooks write JSON to stdout, and the
  `hookSpecificOutput.additionalContext` field becomes model context. This session's own prompt
  carries a line produced exactly that way.
- **On-demand invocation:** six skills already dispatch to `node <plugin>/scripts/*.mjs`.
- **Zero dependencies:** every hook and script imports only Node builtins; there is no
  `package.json` anywhere in the repo. A new script must hold that line.
- **Fail-open discipline:** every hook is wrapped so a failure never breaks a session.
- **Precedent for touching memory:** `memory-doctor.mjs` (163 lines) already detects and repairs
  memory files unreachable from the index, and `memory-budget.mjs` already warns on instruction
  budget.

So "what would it take to build this into a plugin" has a measured answer: the plugin is 4,480
lines total, its scripts run 79–523 lines each, and the largest single file is a 523-line check
registry. **A memory-search script belongs at the small end of that range.**

### 7.2 The problem this is actually solving: delivery, not lookup

A better index in the lead session puts **zero tokens** into a worker's context. Auto memory is
not inherited by spawned subagents [VERIFIED: https://code.claude.com/docs/en/memory.md], and
this was observed directly: across nine subagents spawned during this evaluation, every one
started with no project memory, and the only context any of them had was text typed into its
brief by hand.

So the churn has four distinct causes, and they need different fixes:

| Cause | Fixed by a search script? |
|---|---|
| Subagents inherit no memory at all | **No** — needs a spawn-time mechanism |
| Lead must skim 190 index pointers and guess which to open | Partly — ranking beats skimming, *if invoked* |
| No cross-project view | **Yes** |
| The fact was never written down | No — that is Tier 2 |

The target state, in the operator's words, is *"targeted technical information and starting
points for each agent"* — per-task, at spawn. That reorders the work below: the script's primary
consumer is the spawn path, and a human-invoked search skill is a secondary convenience.

**The mechanism is a nudge, not a content injection.** The hook does not need to rewrite the
subagent's prompt. It needs to say *"this project has memory covering X, Y and Z — search it
before you start, like this."* That is strictly weaker, degrades gracefully, costs a few tokens
rather than a context dump, and avoids depending on an input-rewriting capability that may not
exist. It also lets the agent pull what its own task needs rather than receiving what a hook
guessed.

### 7.2a Delivery mechanism — resolved by test, 2026-09-11

Two claims in earlier drafts of this section were **wrong, and are corrected here.**

**Correction 1 — subagents are not memory-blind.** The documentation states that a subagent does
not load the main conversation's auto memory. A direct test — spawning a subagent and asking it
to report its own starting context — found otherwise on this harness: it **did** receive the
project's `MEMORY.md` index, named the project, and quoted its opening lines, alongside the user
`CLAUDE.md`, a git-status block and the skills listing **[VERIFIED by test]**. The earlier draft
asserted subagents start blind; that was inferred from documentation and never observed.
What a subagent genuinely does **not** get: memory *topic files* (index only), any cross-project
view, any ranking, and — confirmed by the same test — **any `SessionStart` hook output**; the
plugin's own scout line was plainly absent. Treat the memory-index behaviour as version-sensitive:
it contradicts the docs, so re-test it rather than relying on it.

So the churn is not "workers start with nothing." It is that a worker receives **the same
unranked pointer list the lead does** — 2 entries in a small project, 190 in the largest — with
nothing targeting it to that worker's task.

**Correction 2 — which mechanisms can actually deliver.** Tested, in order of what was found:

| Mechanism | Verdict |
|---|---|
| `SubagentStart` hook output | **Dead end.** The event exists, but its output is *discarded entirely* except one terminal field — documented, and the plugin's own hook comment already says so **[VERIFIED]** |
| `SessionStart` hook output | **Dead end.** Fires only for `startup`/`resume`/`clear`/`compact`/`fork`; a normal spawned subagent gets none, confirmed by the missing scout line **[VERIFIED by test]** |
| `memory:` subagent frontmatter | Real but unsuitable — creates a *separate* per-agent directory keyed by agent name; cannot point at the project's auto memory **[VERIFIED]** |
| **`PreToolUse` on `^Agent$` returning `updatedInput`** | **Works.** This is the mechanism |

The last one needed a real test, because an earlier draft claimed it was "already proven in
production" on the strength of the plugin's existing model-autofill path. That claim was
**false**: of 401 logged spawns, **zero** had `model_autofilled: true` — every spawn names a
model explicitly, so the branch had never executed. The code existed; the mechanism was unproven.

A controlled probe settled it: a subagent was spawned with **no `model` argument** and a declared
weight, from a session running Opus. The guard's autofill set `model: haiku` via `updatedInput`,
and the subagent's own transcript records it running as `claude-haiku-4-5-20251001`
**[VERIFIED by test]**. The harness therefore consumes `updatedInput` for the `Agent` tool.
Because `updatedInput` is a whole-object replacement, a mutated `prompt` travels the same path.

**Constraint this imposes on the build:** the existing guard already returns `updatedInput` to
autofill the model. There must be **exactly one `updatedInput` per spawn**, or a second hook on
the same matcher could silently clobber the model autofill — a live cost-control feature. So the
memory logic belongs *inside* the existing hook, not in a second one registered alongside it.

### 7.2b Why the pointers are a nudge, not injected content

The intuitive design — rank the brief against the corpus and inject the best passages — requires
deciding *whether anything is relevant at all*, and BM25 scores cannot make that call. Measured
on this corpus **[VERIFIED by test]**:

| Spawn brief | top score | top ÷ median |
|---|---|---|
| on-topic, long | 21.63 | 1.31 |
| off-topic but plausible dev text, long | 17.65 | 1.26 |
| **nonsense, long** | 6.71 | **1.33** |
| on-topic, short | 10.70 | 1.54 |

BM25 sums over query terms, so the score tracks brief *length* as much as relevance: a long
off-topic brief outranks a short on-topic one. Normalising by matched-term count did not help,
and a *relative* gate is worse still — the nonsense query produced the highest top-to-median
ratio of the set. There is no threshold that separates these.

The resolution is to stop asking this layer to judge relevance. Append **one line** stating that
a searchable corpus exists and how to query it, and let the agent — which is good at judging
relevance — decide whether to look. That needs no threshold, is invariant to brief length, costs
~250 characters, and is never wrong. Scored pointer injection remains available as a non-default
mode, documented with the numbers above so the next person does not re-derive them.

### 7.3 The work, in priority order

**Operator actions — not plugin features.** These apply to this machine's setup and ship in
nothing.

1. **Collapse the three duplicate `{{APP_A}}` stores — and this is far smaller than §4.1
   implied.** Measured **[VERIFIED]**: the WSL store's newest file is 2026-05-01 and the Linux
   store's is 2026-04-30, with **zero files modified in either in the last 90 days**, against 119
   in the live Windows store. **No filename exists in either dead store that is absent from the
   live one** — it is a strict superset by name. On content, 19 of 32 WSL files are byte-identical
   to their live counterparts, 11 more have a *larger* live copy (i.e. it evolved), and only
   **two** files hold more content in the dead copy than the live one: `feedback_memory_sync.md`
   (1,812 B vs 932 B) and `server_minder.md` (5,567 B vs 4,902 B).
   So this is not a three-way merge. It is: review two files, then archive both directories.
   Set `CLAUDE_CODE_PROJECT_DIR_NAME` (or `autoMemoryDirectory`) afterwards so the store is keyed
   by project rather than by working-directory path, and it cannot recur.
2. **Put the curated text in git — for history, not for backup.** Replication already covers
   backup (§4.5). Scope the repo to what history is actually wanted for: `projects/*/memory/**`,
   `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `hooks/`. Two rules that matter:
   **seed `.gitignore` from the sync plugin's existing exclude list**, which already enumerates
   the credential files (`.credentials.json`, `.claude.json`, `mcp.json`, and two token files) —
   writing one from scratch risks committing a token; and **do not let a live `.git` directory be
   file-synced**, since last-write-wins replication over a git directory risks index and packfile
   corruption. Snapshot history with `git bundle create` instead — a single file, which is safe
   under last-write-wins and restores anywhere.
   **Do not convert the sync transport itself to git.** Evaluated and rejected: rclone is not
   behind an adapter, so a git backend means rewriting one module and roughly half of another
   (~250–350 lines), and git has no workable story for 8 GB of frequently-appended JSONL across
   4,548 files. The plugin's own README already reached this conclusion independently.
   *Scope note: sync scoping and a tested full-restore path are tracked separately from this
   evaluation.*

**Tier 1 — the recommendation. Opt-in, default-off, read-only.**

3. **An index-ceiling check** in the existing audit registry: warn at 20 KB, fail at 24 KB
   against the documented 25 KB cap. `{{APP_A}}` is at 19,825 B. ~15 lines added to a check
   registry that already exists, and it generalises to every user of the plugin — which makes it
   the one piece worth shipping on by default.
4. **`memory-search.mjs`, ~200 lines, zero dependencies.** Walk every
   `~/.claude/projects/*/memory/**/*.md`, split into chunks by heading, build an in-memory
   **BM25** index, and return ranked hits each labelled with its project. Cache the index as
   JSON beside the plugin's other state; rebuild when any source file's mtime is newer. Two
   modes: `--project <name>` for UC1, all-projects by default for UC2.
   **Why BM25 and not embeddings:** §4.6 showed the failure is *absence of ranking*, not absence
   of semantics — grep returns 58 unranked files where ranked search returns the best ten. BM25
   needs no API key, no model download, no embedding cost and no network. It is a strictly
   smaller change that addresses the measured defect. Embeddings remain a later upgrade behind
   the same interface if ranked lexical search proves insufficient — and that is a testable
   question, not a guess.
5. **A spawn-time nudge on the existing `PreToolUse` / `^Agent$` hook — the piece that fixes the
   churn.** `spawn-guard.mjs` already intercepts every subagent spawn [VERIFIED: plugin source].
   Extend that path to run the search against the brief text and emit a short nudge naming which
   memory topics look relevant and how to search them. Keep it to a handful of lines, never a
   context dump. Behind its own `userConfig` key, default off.
6. **A `memory-search` skill** whose body tells the model when to reach for cross-project search
   and how to invoke the script — the UC2 entry point for a human or a lead, and the thing the
   nudge in (5) points at.
7. **A fork-detection check — and it needs no index at all.** Path-encoded stores fork silently
   for *any* user who runs from two different paths (WSL and Windows, or a moved repo), so this
   generalises beyond this machine. What actually resolved the case in §7.3 item 1 was three
   cheap signals, not similarity ranking: **newest mtime per store** (is it live or dead?),
   **filename-set overlap** (is one a superset?), and **byte-compare on the collisions** (which
   copy evolved?). That is a pure-filesystem check with no embeddings and no index. Emit a
   reviewable plan; **propose, never merge** — `memory-doctor.mjs` already sets the precedent of
   moving files to `archive/` non-destructively rather than deleting. Auto-merging two versions
   of a technical fact is how the caveat that made it worth keeping gets lost.
   The similarity engine from (4) is for the *harder* job — near-duplicate facts that disagree,
   which is reconciliation (item 9), not fork detection.

> **On backfill cost — the operator's concern, and it is smaller than it looks.** BM25 requires
> **no backfill in the expensive sense**. It indexes markdown that already exists: no LLM pass
> over the corpus, no embedding API, no per-file processing cost, no network. Building the index
> over 1.5 MB is seconds, and it is disposable — delete it and rebuild. The genuinely
> substantial backfills are (a) embedding the corpus, which is why §7.3 defers embeddings behind
> the same interface, and (b) transcript mining over 8 GB, which is Tier 2 and scoped to
> compaction summaries precisely to keep it bounded. Ranking is the cheap half.

**Tier 2 — extract and reconcile, once Tier 1 proves useful.**

8. **Transcript mining is bounded and cheap *if scoped correctly*.** The corpus is 8.0 GB across
   4,519 `.jsonl` files, but **95% of those are subagent transcripts**, and only ~4.6% of bytes
   are actual prose — the rest is tool output, hook attachments and opaque signature blocks
   **[VERIFIED by sampling]**. Critically, **compaction summaries are persisted on disk**: a
   `type:"system", subtype:"compact_boundary"` record followed by a synthetic user message
   carrying a full structured narrative summary **[VERIFIED]**. Those are pre-digested,
   high-value and few. **Mine the compaction summaries in the ~225 main-session transcripts
   first**; fall back to raw prose only if that proves thin. Retention is `cleanupPeriodDays:
   180` **[VERIFIED]** — anything older is already gone, which makes this time-sensitive rather
   than optional.
9. **Reconciliation: surface, do not auto-resolve.** No candidate does this well — Cognee's
   maintainers call theirs "minimal", and Graphiti's good answer costs a graph database. The
   proportionate version is a check in the existing audit registry that reports near-duplicate
   pairs above a similarity threshold (the BM25 index already gives you this) and lets the model
   or the operator adjudicate. Silent automatic merging of technical facts is how you lose the
   caveat that made the fact worth keeping.

### 7.4 What breaks

- **The index cache goes stale** if a memory file changes without the mtime check firing.
  Rebuild whenever any source mtime exceeds the cache's, and keep rebuild cheap enough (1.5 MB)
  that a forced rebuild is never painful.
- **A `SessionStart` hook costs context in every session, forever.** The plugin already injects
  a scout line; a second competes for the same budget. Keep it to one line, or fold it into the
  existing hook rather than adding another.
- **The 28 KB dump files retrieve badly.** BM25 over a whole 28 KB document returns the
  document, not the answer. Chunk by heading, and treat `{{APP_A}}`'s `findings_*` / `handoff-*`
  files as the case that proves chunking is required rather than optional.
- **A second retrieval path can contradict the injected index.** If the index says one thing and
  a ranked hit says another, the model has two sources and no precedence rule. State one: the
  file on disk wins, the index is a pointer.
- **Zero-dependency discipline is a real constraint.** BM25 in plain JS is fine. The moment
  anyone wants embeddings they want a model runtime, and that breaks a rule the plugin has held
  across 4,480 lines. Decide that consciously if it comes up.
- **The nudge's delivery target is unverified.** It is confirmed that a `PreToolUse` hook on
  `^Agent$` fires at spawn [VERIFIED: plugin source], but **not** whether its output reaches the
  *spawned subagent* or only the *spawning session*, nor whether `SubagentStart` can emit
  `additionalContext` into the subagent the way `SessionStart` does for a main session. Both
  routes work — one nudges the worker directly, the other nudges the lead to put it in the brief
  — but they are different builds. Settle this before writing the hook; it is a ten-minute
  documentation check, listed in §11.
- **Default-off features go unused.** Shipping behind a `userConfig` key is correct for a
  publicly distributed plugin, but it means the operator must remember to enable it and no one
  else will discover it. Mitigate by turning on only the index-ceiling check by default — it is
  read-only, universally applicable, and warns about a real documented cliff — and leaving
  search and the nudge opt-in.
- **A nudge on every spawn is a recurring context cost.** At 77 spawns in 24 hours [VERIFIED:
  plugin telemetry], even a few lines per spawn adds up, and a nudge that fires when nothing
  relevant exists is pure noise. Emit nothing when the top-ranked hit falls below a score
  threshold; silence must be the default state.

### 7.5 Why not the other shapes

- **Standalone service:** nothing here needs a process. Rejected on criterion 3.
- **MCP server:** defensible, and the natural upgrade path — but it is a separate process to
  configure and keep alive for a capability a script already delivers. The plugin can ship an
  MCP server later [VERIFIED: plugins may contain `.mcp.json`] without redoing the work, because
  the index and search live in a script either way. Start with the script.
- **A new plugin:** `agent-companion` already owns hygiene, budget and memory-doctor checks. A
  second plugin splits one concern across two installables.
- **Skill alone, no script:** a skill body is instructions, not an index. It cannot rank 435
  files. The skill is the entry point; the script is the capability.

---

## 8. Should one memory layer serve both this tooling and `{{PRODUCT}}`?

**No. Sharing would be a category error, and the product's own architecture documents already
say so.**

The requirements only look similar. This tooling holds **one operator's technical notes**, where
every reader is the same person, the worst case of a leak is embarrassment, and — as of
2026-09-11 — copyleft is explicitly acceptable. `{{PRODUCT}}` holds **end users' intimate
personal data** across people whose interests can diverge, is treated as GDPR Article
9-equivalent sensitive data, and carries a per-person isolation rule stating that *"no
cross-member read path exists, at any privilege level"* [VERIFIED: product architecture docs].

Three reasons, any one sufficient:

1. **The licence verdict does not transfer.** The product already rejected Honcho because its
   AGPL-3.0 network-use clause conflicts with closed commercial SaaS [VERIFIED: product
   `DECISIONS.md`, 2026-09-06, which decided `MemoryProvider` on Postgres + pgvector with mem0 as
   the reference alternative]. The relaxation granted for this tooling is *precisely* what the
   product cannot accept. A shared implementation would be pinned to the stricter constraint,
   discarding the freedom just gained here.
2. **The retrieval problems are opposites.** This tooling needs verbatim technical fidelity —
   file paths, flags, error strings — and explicitly wants a cross-project join. The product
   needs derived, consent-gated claims and a hard firewall *against* joining across people. One
   wants the join; the other's core safety property is forbidding it.
3. **The product has no code yet.** `MemoryProvider` exists as pseudocode in an architecture
   draft, not as an implementation [VERIFIED]. There is nothing to share *from*, so "sharing"
   would mean designing this tooling's layer around a product interface that has not been built
   and may still change — speculative coupling at the worst possible moment.

**What should transfer is the method, not the implementation:** verify licences from the LICENSE
file; keep the store behind an interface so the backend can be swapped; treat retrieval as
replaceable and the source data as precious. The product already did the right thing by putting
`MemoryProvider` in front of pgvector. This tooling should do the analogous thing at its own
scale — which is exactly why §7 recommends a script behind a skill, not a dependency on a
vendor.

---

## 9. Overlap and conflict with `{{COORD_BUS}}`

**There is one real overlap, and it changes a recommendation.**

What `{{COORD_BUS}}` actually stores **[VERIFIED from its schema]**:

- **The bus is not a knowledge store.** Inbox and roster lines are capped (~2,000) and **rotate
  on write by dropping the oldest**; message bodies are explicitly documented as untrusted input
  that the module *"only stores and returns verbatim… never interprets"*. There is no search
  index over bus messages. Putting memory on the bus would mean putting durable knowledge in a
  ring buffer.
- **The {{WORKBOARD}} *is* a durable knowledge store** — `projects`, `tasks`, `notes`, `subtasks`,
  `assignments`, an append-only `events` audit table with no rotation, and **`search_fts`, an
  SQLite FTS5 virtual table** (`porter unicode61`) indexing task and note content, queried via
  a REST search endpoint. No vector or embedding search exists anywhere in the codebase
  [VERIFIED by search].
- **It already ships a transcript-search tool** — admin-scoped, searching this machine's Claude
  Code session transcripts, explicitly *"not partitioned by app"* [VERIFIED].

**The consequences:**

1. **Do not build transcript search.** `{{COORD_BUS}}` already has a cross-project transcript
   search tool. §7's Tier-2 mining job should *use or extend* it rather than writing a second
   one. This is the one place where a naive version of this project would have duplicated
   existing infrastructure outright.
2. **Do not put memory in the bus.** Rotation-on-write makes it structurally wrong for durable
   facts. The bus moves messages; it does not remember them.
3. **The {{WORKBOARD}} and the memory corpus are complements, not rivals.** The {{WORKBOARD}} answers
   *"what work happened, and what was said about it"*, keyed by task. Memory answers *"what is
   true about this project"*, keyed by fact. Both are worth searching for UC2; neither subsumes
   the other. If the memory-search script ever grows a second source, the {{WORKBOARD}} `notes`
   table is the obvious one — via its existing API, not by reaching into its SQLite.
4. **Its FTS5 choice corroborates §7.2.** A system with far more content than 1.5 MB chose
   ranked keyword search over vectors and has not needed to change. That is evidence for
   starting with BM25, drawn from the operator's own codebase.

**No conflict** otherwise: `{{COORD_BUS}}` is coordination and work-tracking; the proposed layer
is retrieval over facts. They share a machine, not a responsibility.

---

## 10. What would have to be true for you to be wrong

Falsifiable conditions, strongest first.

1. **If Auto memory were not native** — if the documentation were wrong, or the feature were
   removed or disabled — the entire argument for criterion 7 collapses, and **basic-memory
   becomes the recommendation** (§5.8): markdown stays the source of truth, it is a real MCP
   server, and its exit story is the best in the field. *Test:* run `/memory` and confirm the
   toggle exists; confirm `autoMemoryEnabled` behaves as documented.
2. **If ranked lexical search does not actually fix UC2.** The claim in §4.6 is that grep fails
   for lack of *ranking*. If BM25 over the corpus still returns junk for a real cross-project
   question, the problem is genuinely semantic and embeddings are required — which changes the
   build, though not the shape. *Test:* build the index, run ten real questions, count how often
   the answer is in the top five. Cheap, and should be done before Tier 2.
3. **If the memory habit changes from curation to volume.** Every judgement here assumes a
   curated 435-file corpus with good index hygiene (§4.2). At 5,000 auto-extracted files the
   calculus shifts toward a real vector store and toward automatic reconciliation.
4. **If reconciliation becomes the dominant pain rather than retrieval.** Graphiti's bi-temporal
   invalidation is a genuinely better answer than anything proposed here; it is rejected on
   proportionality, not on merit. If contradictory memories start causing real errors, the Neo4j
   tax becomes worth paying.
5. **If subagent memory access matters more than session injection.** Auto memory does not reach
   subagents [VERIFIED]. Since this operator delegates heavily, a retrieval tool that works
   inside subagents could matter more than injection into the main session — which would argue
   for the MCP shape sooner than §7.4 suggests.
6. **If a maintained tool appears that indexes the native memory directory in place.** That is
   the thing that does not exist today and would beat a hand-rolled script outright. Worth
   re-checking in six months; the shape is obvious enough that someone will build it.

---

## 11. What I could not determine

- **The bodies of the `consolidate-memory` and `import-memory` skills.** Both are available in
  this session and their descriptions match the import and reconcile requirements almost
  exactly — but **neither exists as a readable file anywhere on this machine**. An exhaustive
  search of every skills directory, all five installed marketplaces, the npm CLI and the desktop
  app bundles returned zero hits; they appear to be compiled into the binary [VERIFIED
  negative]. **This is a significant gap**: the two skills that may already solve two of the
  three named capabilities cannot be inspected before relying on them. *Next step:* invoke them
  in a scratch session and observe what loads — **before** building anything in Tier 2.
- ~~Which hook can deliver text into a spawned subagent's context.~~ **RESOLVED — see §7.2a.**
- **Whether mem0's self-hosted OSS build supports the compound cross-scope filters** documented
  for its managed platform. The documentation demonstrates them on Platform only. Matters only
  if mem0 is reconsidered.
- **Single-call cross-scope search for Honcho, Letta, Graphiti and Cognee.** Each has a
  namespacing primitive; none documents a single query spanning namespaces. Client-side fan-out
  is assumed but not confirmed.
- **Exact managed pricing for mem0, Letta, Honcho and Cognee.** Aggregated from secondary
  sources, not fetched from vendor pricing pages. Zep's numbers *were* fetched directly.
- **An exhaustive count of compaction summaries across the corpus.** A full-corpus search timed
  out on 8 GB; the finding rests on a sample (~1 per 30 main-session files). The mechanism is
  confirmed; the yield is estimated.
- **Whether the transcript prose ratio (~4.6%) generalises.** Measured on one 948 KB file that
  happened to contain an unusually large hook attachment. The order of magnitude is right; the
  precise figure is not load-bearing.
- **A documented procedure for adding a capability to `agent-companion`.** None exists —
  `CONTRIBUTING.md`, `ARCHITECTURE.md` and `HYDRATION.md` contain zero references to the plugin
  [VERIFIED negative]. The extension contract lives only in code comments. Anyone building §7
  works from convention, not documentation.
- **"Auto Dream"**, a memory-consolidation feature described in third-party blogs, does not
  appear in official documentation. Treated as unverified and excluded.

---

## Appendix A — licence verification log

Every entry read from the repository file at the URL given, on 2026-09-11. No badges, no
package-registry classifiers, no summaries.

| Project | Licence (as written in the file) | Verified from |
|---|---|---|
| mem0 | Apache-2.0 | `https://raw.githubusercontent.com/mem0ai/mem0/main/LICENSE` |
| Honcho | **AGPL-3.0** | `https://raw.githubusercontent.com/plastic-labs/honcho/main/LICENSE` |
| Letta | Apache-2.0 | `https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE` |
| Zep | Apache-2.0 (examples repo only; server deprecated) | `https://raw.githubusercontent.com/getzep/zep/main/LICENSE` and `/README.md` |
| Graphiti | Apache-2.0 | `https://raw.githubusercontent.com/getzep/graphiti/main/LICENSE` |
| Cognee | Apache-2.0 | `https://raw.githubusercontent.com/topoteretes/cognee/main/LICENSE` |
| basic-memory | **AGPL-3.0** (LICENSE, README badge and classifier all agree) | `https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/LICENSE` |
| pgvector | PostgreSQL License (classifier wrongly says `NOASSERTION`) | `https://raw.githubusercontent.com/pgvector/pgvector/master/LICENSE` |
| sqlite-vec | Apache-2.0 **OR** MIT (dual, two files) | `https://raw.githubusercontent.com/asg017/sqlite-vec/main/LICENSE-APACHE` |
| MCP `memory` server | MIT (repo overall mid-transition MIT → Apache-2.0) | `https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md` |

**Copyleft flags:** Honcho (AGPL-3.0) and basic-memory (AGPL-3.0) both carry the network-use
clause. Under the 2026-09-11 relaxation this is acceptable for personal tooling and is **not**
the reason either was rejected. It remains disqualifying for `{{PRODUCT}}` (§8).

**Licence-integrity note:** GitHub's classifier was wrong in the false-negative direction twice
in this set (pgvector, and the MCP servers monorepo). Honcho's earlier packaging trap was real
and is confirmed here. The rule stands: read the file.

## Appendix B — sources

- Claude Code memory: `https://code.claude.com/docs/en/memory.md`
- Context window and compaction: `https://code.claude.com/docs/en/context-window.md`
- Hooks: `https://code.claude.com/docs/en/hooks.md`, `https://code.claude.com/docs/en/hooks-guide.md`
- Skills: `https://code.claude.com/docs/en/skills.md`
- Plugins: `https://code.claude.com/docs/en/plugins.md`
- API memory tool — API/SDK only, not Claude Code:
  `https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md`
- Repository licence files as listed in Appendix A
- Local measurement of the memory corpus, transcript corpus and plugin source, 2026-09-11
