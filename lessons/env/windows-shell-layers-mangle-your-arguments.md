---
id: windows-shell-layers-mangle-your-arguments
title: Every shell layer between you and the tool rewrites your arguments — leading slashes, carets and drive paths
scope: [env:windows]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
On Windows an argument can pass through a POSIX-emulation layer, cmd.exe, and a language runtime before the tool ever sees it, and each layer rewrites a different character class — silently, with no error, producing a request that fails confusingly downstream.

Three concrete faces, all reconstructed generically:

**(a) MSYS / Git Bash rewrites a leading-slash argument into a native path.** An argument meant as a URL path segment or a tool-internal flag path (`/api/...`, `/target`) arrives at the tool as `C:\...`, corrupting the request in a way that looks like a wrong endpoint rather than a mangled argument. Prefix the invocation with the path-conversion opt-out environment variable, or phrase the value so it has no leading slash.

**(b) A shelled-out command on Windows routes through cmd.exe, whose escape character is the caret.** Any argument containing a caret — notably version-control reference syntax such as a tree-ish suffix — is silently corrupted by cmd.exe's own parsing before the target program ever sees it. Use the array-argument form that bypasses the shell for ALL such invocations, not just the ones where a caret was actually noticed; the next argument with one will hit the same silent corruption.

**(c) A POSIX-style drive path is not a path the runtime resolves.** A language runtime invoked from Git Bash does not resolve `/c/...` in its own file and module-loading functions — that syntax is a Git Bash convention, not something the runtime's filesystem layer understands. Convert to a forward-slash drive form (`C:/...`) before handing a path to the runtime.

**Why:** each layer has its own, independent notion of what counts as a special character, and none of them error on a rewrite — they treat the mangled argument as valid input and hand it onward. The failure surfaces two or three layers downstream, in a tool that has no way to know its argument was ever touched, so the error text describes the symptom (wrong path, bad ref, module not found) rather than the cause.

**How to apply:**
- When a Windows invocation fails in a way the tool's own error text cannot explain, print the argument vector exactly as the tool receives it before theorizing about the tool's logic.
- Prefer array-argument spawning over string commands for every shelled-out invocation on Windows, not only the ones observed to contain a special character — the next argument might.
- Add a test that passes a caret-bearing and a leading-slash-bearing value through the real call path, not a mock, so a future shell hop that reintroduces string concatenation gets caught.
- Treat any path variable crossing from a POSIX-emulation shell into a native runtime as needing conversion by default, rather than special-casing it only after a failure.

Related: [[validate-cli-args-against-injection]], [[recursive-delete-follows-a-reparse-point]], [[shell-read-encoding-double-encodes]], [[a-parameter-named-like-an-automatic-variable-does-not-bind]].
