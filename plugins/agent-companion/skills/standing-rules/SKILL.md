---
name: standing-rules
description: Add, inspect, test or disable "always do X if Y" rules that a hook re-injects instead of relying on a written rule surviving a long session. Use when asked to make something always happen, add a standing instruction or house rule, "remember to always do this when I say that", make prompts come back copyable, stop a rule being forgotten or ignored, or when a rule in CLAUDE.md keeps getting dropped mid-session.
---

# standing-rules — conditional instructions a hook keeps re-applying

A rule written in a document is read once, at the top of a session, and then
competes with everything that follows it. That is why "I have delegation rules
all over and they stop being followed" is a structural complaint, not a
discipline one. A standing rule is re-injected by a hook every time its
condition is met, so it arrives at the moment it is relevant rather than hours
earlier.

Resolve the plugin root first; every command below uses it:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

## A rule is a condition plus a directive

Two independent conditions, and the split is the design:

- **`when`** — a regex over the *text* of what is happening. Asks "is this turn
  about X?"
- **`gate`** — a *session state* check. Asks "is this session in a state where
  the rule is worth its tokens?"

And a **scope**, which decides what text `when` is tested against and where the
directive lands:

| scope | `when` is tested against | injected into |
|---|---|---|
| `user-prompt` | the prompt you just submitted | the main session, that turn |
| `always` | *(ignored — fires every turn)* | the main session, every turn |
| `session-start` | *(ignored — fires once)* | the main session, at start |
| `spawn` | the brief of an agent being spawned | that subagent's prompt |

## Commands

```bash
node "$AC/scripts/rules.mjs" list                    # every rule, built-in and yours
node "$AC/scripts/rules.mjs" show <id>
node "$AC/scripts/rules.mjs" test "some text"        # which rules match it, and the exact injected block
node "$AC/scripts/rules.mjs" add --id <id> --scope <scope> --when '<regex>' --then '<directive>'
node "$AC/scripts/rules.mjs" add --id <id> --scope <scope> --when '<regex>' --then-file <path>
node "$AC/scripts/rules.mjs" disable <id>
node "$AC/scripts/rules.mjs" enable <id>
node "$AC/scripts/rules.mjs" remove <id>             # your rules only; a built-in is disabled, not removed
```

`test` is the one to reach for first. A regex that does not fire is the common
failure, and `test` makes it visible without restarting a session.

## Writing a good rule

Write the directive as an instruction to the agent, in the imperative, and make
it specific enough to act on. `--then 'be careful with migrations'` changes
nothing; `--then 'Before editing a migration, print the current schema version
and state which direction the migration runs.'` does.

Scope it as narrowly as it will go. `user-prompt` with a real `when` costs
nothing on the turns it does not match. `always` is paid on every single turn of
every session — the CLI warns when you add one, and only one rule ships with
that scope (see `delegate-reminder` below, which is gated).

Match on the words you actually use, not the words you would use in
documentation. `--when 'deploy|ship it|push to prod'` beats `--when
'deployment'`.

## Built-in rules

| id | scope | fires when |
|---|---|---|
| `copyable-prompt` | `user-prompt` | you ask for a prompt — requires the answer to contain the whole prompt in one fenced block, with commentary kept outside the fence |
| `lead-brevity` | `session-start` | every session, while brevity is globally on — report at outcome level, blockers in full, detail to files |
| `delegate-first` | `session-start` | every session — the orchestrator rules, restated where they are read |
| `delegate-reminder` | `always` | **only once this session has actually drifted** — see below |
| `agent-brevity` | `spawn` | disabled; it exists so `list` shows you the spawn scope is available |
| `poll-guard-doctrine` | `session-start` | every session — one completion wait, never per-item wakes (cache-advisor guard b, `hooks/poll-guard.mjs`) |

Disable any of them by id (`disable copyable-prompt`) — they are never removed,
so a plugin update can still improve their wording while your choice stands.

### `delegate-reminder`, and why it is gated

This is the rule that answers "the delegation rules get ignored". Its gate is
`delegation-drift`: it is satisfied only once `delegation-guard` has actually
caught this session running execution work on the main thread. Until then it
injects nothing at all; after that it repeats on every turn for the rest of the
session.

A constant reminder is a tax everyone learns to skim. An adaptive one arrives
exactly when it has been earned, and keeps arriving while the behaviour lasts.
That is a shape a document cannot have.

## Where rules live

`~/.claude/agent-companion/config/standing-rules.json` — user-authored config,
deliberately separate from the plugin's derived `state/` and `telemetry/`
directories, which are safe to delete. Only your additions and overrides are
written; built-ins stay in code.

A malformed file never breaks a turn: bad JSON, an unknown scope, a missing
directive, an uncompilable regex — each entry is dropped and the rest still
work. Regexes longer than 400 characters are skipped rather than run, because
the hook that evaluates them has a five-second timeout.

## Related

- `/agent-companion:brevity` — the reporting contract on spawned agents, and the
  feature `lead-brevity` and `delegate-reminder` coordinate with.
