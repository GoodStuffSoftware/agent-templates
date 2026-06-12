# Cross-project agent-team rules (portable kernel)

A self-contained, vendor- and project-neutral summary of the rules an agent team relies on. The template agent defs hold only the *project-specific application* of these rules and point here for the general principle. Adapt freely; nothing here names a specific project, person, path, or domain.

> This is a generic skeleton. In a real setup, the specialized version of these rules lives in your global agent-config file (for Claude Code, `~/.claude/CLAUDE.md`). Copy what you need from here into that file and specialize it.

---

## 1. Model routing — use the lowest sufficient model

Before spawning a sub-agent, silently score the task weight (1–5) and pick the lowest model tier that can do it. Never default to the most powerful model.

| Weight | Characteristics | Examples |
|--------|-----------------|----------|
| 1 — Trivial | Single lookup/read/echo, no reasoning | Read a file, list a dir |
| 2 — Simple | One-step transform or search, deterministic | Find a string, rename a var, run a command |
| 3 — Moderate | Multi-step but bounded, limited context | Edit one function, write a short script |
| 4 — Complex | Multi-file or cross-referencing | Refactor a module, debug a non-obvious error |
| 5 — Deep | Broad understanding, planning, novel reasoning | Architecture, multi-phase migration, strategy |

Two knobs control cost and quality — **model** (capability) and **effort** (how much reasoning):

| Weight | Model | Effort |
|--------|-------|--------|
| 1–2 | smallest/cheapest | lowest |
| 3 | mid | medium |
| 4 | mid (or large) | high |
| 5 | largest | high by default; reserve the maximum effort level for genuinely novel/frontier reasoning |

For Claude Code specifically, the tiers are `haiku` / `sonnet` / `opus` and effort `low` / `medium` / `high` / `xhigh` / `max`. The exact aliases differ by vendor; the *principle* is constant.

**Routing rules:** score first; round down on uncertainty; never over-provision (a heavy model on a trivial task is a rule violation); escalation is allowed (re-delegate to the next tier if a sub-agent returns incomplete output due to model limits); batch multiple light tasks into one sub-agent call.

**Effort is the highest-leverage within-tier dial.** Output usually bills several times input, and effort scales all output (thinking + answer + tool calls). Prefer raising effort on the right tier over jumping to the top tier + top effort by reflex.

**Lead/orchestrator sizing.** Size the lead to the *session*, not a blanket default: a large-model lead for multi-agent orchestration, design work, or many-open-thread sessions; a mid-model lead only for simple/short single-task sessions. The lead holds *decisions*, not token volume (that lives in the workers' file reads and code gen) — so recover the lead's cost via delegation depth + worker effort, not by downgrading the decision-maker. A weak lead on a complex session makes bad calls, and the rework costs more than the cheaper lead saved.

---

## 2. Delegation — the main session orchestrates, teammates do

The main conversation is an orchestrator. Don't fill its context with work a sub-agent can do.

**Always delegate:** any file read / search / exploration; any self-contained single-file edit; any shell command / build / install; any task with a clear input and a bounded output; verifying file contents / configs; running tests and capturing output.

**Keep in the main session:** planning multi-step / multi-file changes; interpreting results and deciding what's next; anything requiring reasoning across multiple sub-agent outputs.

**Pattern:** explore first → plan before acting on anything spanning >2 files → delegate execution → review results in main for the decision. Never chain more than ~3 steps in main without delegating.

**Teammates, not one-shot workers.** Spawn into a team so teammates can message each other and persist across turns. Use a fresh, date-stamped team name per session (e.g. `<prefix>-YYYYMMDD-<slug>`). Never reuse a bare team name across sessions — it accumulates ghost teammates and bleeds idle messages.

**Named agents for recurring task types.** Define reusable agents (with `model` + `effort` baked into the frontmatter) for patterns that repeat across sessions, so the orchestrator invokes them by name instead of re-specifying everything each time. Update an agent def the moment a session reveals a new gotcha, a better step order, or a missing rule — agent defs are living documents.

**Context reading scales with agent weight.** A weight-1–2 agent reads nothing beyond its brief; a weight-3 agent reads only its target file(s); a weight-4 agent reads the project rules file + the target's README; a weight-5 agent reads the project rules file, the state/handoff doc, and every README the change touches.

---

## 3. Reviewer pairing — no "done" without a sign-off

Every code-change teammate is paired with a reviewer. Pipeline: **writer → reviewer sign-off → user sign-off → merge.** The reviewer is read-only: it runs the checks (lint / build / typecheck), reads the diff against the plan, and returns a verdict (pass / blockers / nits). Blockers must be fixed and re-reviewed before shipping; don't accept "I'll fix it myself" deferrals without a re-review.

**Tier the review gate to the risk.** Verification is usually easier than generation, so a mid-model reviewer at high effort catches the large majority of defects cheaply — and a fresh adversarial pass that *runs the tests* and *reads the call path* beats raw horsepower for most bugs. BUT a lower model can rubber-stamp a higher model's *novel* error it can't fully comprehend, so escalate to a top-model adversarial pass when the diff touches a security/permission boundary, production-data writes / migrations / destructive ops, or subtle-correctness/architectural changes (concurrency, sync/merge, money). Frame the escalated pass adversarially and keep it concrete.

---

## 4. Stall prevention — keep teammates observable

A teammate can stall silently if its first action is a tool that prompts for permission (Edit, Write, side-effecting Bash). Once the prompt is pending, the agent can't message out to report it. These rules apply to writer-style teammates; read-only teammates are largely immune.

- **First-action read-only.** The first tool call of every writer-style teammate must be a read-only diagnostic (`pwd`, `git status`, `Read`, `Grep`, `Glob`), immediately followed by a message to the lead containing the diagnostic output and a one-line plan. No write tool may be the first call.
- **Heartbeat at turn start.** At the start of each subsequent turn, before any potentially-blocking tool call, the teammate sends a one-line message previewing the intended next action. Skip only when the entire turn is a single read-only diagnostic + a report.
- **Briefing requirement (orchestrator side).** Every brief for a writer-style teammate closes with the first-action-read-only + heartbeat clause verbatim. If a brief omits it and the teammate stalls, the orchestrator owns the recovery cost.

---

## 5. Worktree, write-target & dev-server discipline

Operational rules learned from real failures; they apply to any project using worktrees, branch previews, or local dev servers.

1. **Branch what deploys, not your tooling.** Feature/experiment code that needs preview isolation gets its own branch + worktree. Dev-config that's read from the working tree and never shipped (`.claude/`, agent defs, docs, scripts) commits straight to the current working branch. Branching non-deployed config only creates merge-back busywork.

2. **Bake the write-target into the writer's INITIAL brief; never redirect mid-flight.** Decide the worktree + branch a writer will use before spawning it, and state it in the opening brief. Never redirect a writer to a new worktree/branch after it has begun editing — the redirect and the in-flight write cross, and the change lands in the wrong place. If a redirect is truly unavoidable: stop the writer, confirm exactly what it already wrote and where, then re-brief from a clean state. A half-applied multi-file change split across two branches is the worst outcome.

3. **Dev servers belong to a persistent owner, not transient writers.** A long-lived dev server is owned by the main session or a dedicated server-minder. Writer agents *request* a preview/URL from the owner instead of spawning their own — sub-agent servers die with the agent and leave stray listeners that accumulate across a session. Reap stray listeners when you find them.

4. **Report the ACTUAL bound URL, then verify it before relaying or diagnosing.** Dev tooling silently falls back to the next free port when the requested one is taken (`:3000` → `:3001` → `:3002`). So: (a) the teammate running the server reports the EXACT "Local:" URL the tool printed, never the port it requested; (b) before relaying that URL or diagnosing a failure on it, the orchestrator probes the exact URL (expect HTTP 200); (c) never diagnose a port/process you only *assumed* serves the build — confirm which process is actually listening first.

5. **After you invalidate a teammate's world, sync it or shut it down — before it reports stale state.** When an orchestrator action invalidates a teammate's cached view (you merged + removed its worktree, restarted/moved a server, moved a branch), immediately tell that teammate what changed or shut it down. Otherwise it sends a now-false report after the fact.

**Destructive-git safety.** Before any `push --force`, `reset --hard` on a pushed branch, or branch delete: create and push a `backup/<branch>-pre-<reason>-YYYY-MM-DD` ref first. No exceptions.

**Don't absorb blocked execution into orchestrator scope.** When a teammate hits a permission- / sandbox- / classifier-blocked operation (deploys, migrations, force-pushes, prod writes), the fix is a fresh teammate with a tighter brief, an escalation to the user, or restarting the blocked agent — never "I'll just run it from the orchestrator." The orchestrator's job is routing decisions and relaying user authorization, not executing ops.

---

## 6. Commit conventions

**Format:** `type(scope): subject` — e.g. `feat(home): add hero section`.

**Allowed types:** `feat`, `fix`, `docs`, `content`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. (A content-heavy site earns the `content` type for copy changes; drop it if your project doesn't need it.)

**Discipline:** group all changes for a logical task into ONE meaningful commit — don't commit after every edit. Push after each logical commit group. Run lint before committing. Never bypass hooks (`--no-verify`) unless explicitly approved for a known loop scenario.

---

## 7. Documentation hygiene — single source of truth

- **Each fact lives in exactly ONE file**; other files reference it. Don't duplicate stack decisions, content plans, brand/design rules, or deploy procedures across files.
- **Save progress to files, not conversation.** Rules, decisions, and results go in project files, never only in chat context. Update the handoff/state doc at the end of every session.
- **New rules go in the right place:** applies to all projects → the global agent-config file; one project → that project's rules file; one agent → that agent's def.
- **Ask "will a future session need this?"** If yes, it must be in a file. If no, it's conversation-only.

---

## 8. Session-orchestration hygiene (optional but recommended)

- **Task list at session start (3+ tasks).** Write a queryable task list early in any session with 3+ pending tasks and keep it current as tasks move pending → in-progress → done. It survives context compaction; in-flight work that lives only in chat does not.
- **Reports to files, not chat.** Teammates write full reports to a task file and send the lead a one-line pointer. The lead reads the file only to act. This keeps the lead's context runway long.
- **A durable handoff/state doc is the source of truth.** It survives compaction, so the lead can lose chat scrollback and still continue.

---

_This kernel is generic by construction — it names no project, person, path, or domain. When you specialize it into a project, the specifics go in that project's filled-in `CLAUDE.md` (and your global agent-config file), never back into this file._
