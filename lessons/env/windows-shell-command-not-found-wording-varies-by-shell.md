---
id: windows-shell-command-not-found-wording-varies-by-shell
title: "Windows' \"command not found\" wording depends on which shell ran it — PowerShell and cmd.exe never say the same thing"
scope: [env:windows]
requires: { os: windows }
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms:
  - is not recognized as the name of a cmdlet, function, script file, or operable program
  - is not recognized as an internal or external command
sessions: 38
---
A missing or misspelled command on Windows produces one of two entirely different sentences depending on which shell actually ran it. PowerShell (5.1 and 7+) reports `'<name>' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.` `cmd.exe` reports the shorter, older `'<name>' is not recognized as an internal or external command, operable program or batch file.` Neither one mentions the word "PATH," and neither one tells you which shell produced it — that has to be inferred from the wording itself. Measured on this operator's own corpus: the PowerShell wording alone recurred in 38+ sessions across 34 projects (with several truncated-length variants of the same underlying message, depending on where the capturing tool cut it off); the `cmd.exe` wording recurred separately in 11 sessions across 16 projects.

**Why:** both messages mean the same underlying thing (the shell could not resolve the given name to an executable via `PATH`, an alias, a function, or a cmdlet) but their wording is specific enough to each shell that pattern-matching on one variant silently misses the other — a script or hook written and tested against PowerShell's wording will not recognize a `cmd.exe` failure as the same class of problem, and vice versa. This is the same shape of gap named directly in this repository's own `docs/adr/0002-stack-scoped-gotcha-retrieval.md` for hook *matchers* (a `Bash`-only matcher silently misses PowerShell) — here it is the error *text* itself that forks by shell instead of the tool name.

**How to apply:**
- Before concluding a tool is missing, confirm which shell actually ran the failing command — a script that shells out sometimes uses `cmd.exe` even on a machine whose interactive default is PowerShell (or the reverse), and the wording alone tells you which one it was.
- Check `PATH` for the resolving shell specifically, not just the interactive terminal's own — a subprocess can inherit a different (often narrower) `PATH` than the terminal it was launched from.
- A tool installed via one package manager (npm global, a language's own installer, a GUI installer) may only be on the `PATH` of the shell profile that manager updated — confirm the binary resolves in the SAME shell type that is about to run it, not just in whichever terminal you happen to be looking at.
