---
id: validate-cli-args-against-injection
title: Validate any user- or agent-supplied value before it becomes a CLI argument — a leading dash is read as a flag, not data
scope: [universal]
status: active
since: 2026-07-13
provenance: [contrib-2]
corroborated: 1
---
When a value from outside the code (a request query param, an agent-supplied field, a tool argument) is passed as a positional argument to a CLI, a value that starts with `-` is parsed as a FLAG, not as data. Passing an untrusted branch/ref/path straight to `git` (or any getopt-style CLI) lets an attacker or a buggy caller inject options — e.g. a ref of `--output=...`, `--upload-pack=...`, or `--absolute-git-dir` changes what the command does rather than which object it names. This is argument injection, and it needs no shell metacharacters to fire.

Guard it with an allowlist applied BEFORE the value can reach the CLI, at BOTH boundaries: the entry point (reject with a 4xx / clean error at the route or tool boundary) AND the internal choke point right before the spawn (so a value that arrives through a second caller is still caught). The load-bearing check is the leading-dash rejection; also forbid shell metacharacters, `..`, and over-long input, and cap to a sane character class. Spawn with an args-array API (`execFile`/`spawn` with an array), never a shell string — that removes quoting/metachar corruption but does NOT stop flag injection, so the allowlist is still required.

Lock it with tests: assert that each rejected value never reaches the (mocked) command runner — proving the guard sits in front of the spawn, not merely that a bad value produces an error somewhere.

**Why:** Bypassing the shell (args array) is necessary but not sufficient — people assume it closes the injection surface, but flag injection happens inside the target program's own option parser, downstream of the shell. Validating at only one boundary breaks the first time a second caller reaches the choke point directly. And an allowlist beats a denylist here because the safe character set for refs/paths is small and known, while the set of dangerous flags grows with every CLI version.

**How to apply:**
- Define one small validator (e.g. `^[A-Za-z0-9._/-]{1,N}$`, no `..`, no leading `-`) and run every externally-influenced value through it before it becomes an argument.
- Apply it at the route/tool boundary AND at the internal function that builds the argv — don't trust callers to have validated.
- Spawn with an args array, not a shell string; treat that as orthogonal to (not a replacement for) the allowlist.
- Add tests asserting rejected inputs never reach the command runner (mock the runner, assert zero calls).
- The leading-dash rule generalizes to any CLI, not just git — apply it wherever untrusted data becomes a positional argument.
