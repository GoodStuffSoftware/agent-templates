---
id: a-parameter-named-like-an-automatic-variable-does-not-bind
title: A PowerShell parameter named like an automatic variable silently does not bind — and the failed assignment can echo a secret
scope: [env:windows]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A PowerShell function parameter named the same as one of the shell's automatic variables (the arguments array, the input-object stream, the host object, and similar reserved names) silently fails to bind the caller's value. The function body reads the automatic variable's own — usually empty — value instead, with no error at the call site or inside the function.

**(a) The masking case.** Splat that empty value into a native command and the command receives no arguments; it prints its own usage text and exits non-zero. The caller reads that as an authentication failure, a missing-config failure, or a broken credential — three layers away from the actual cause, which is a parameter name that never bound.

**(b) The disclosure case.** PowerShell variable names are case-insensitive, so a parameter whose name collides with another in-scope variable differing only in case produces the same kind of failed assignment — except this time the ERROR TEXT can echo the OTHER variable's current value, because the interpreter treats the two spellings as the same identifier and reports on whichever one it resolved. When that value is a credential, the error path itself becomes a leak into logs, transcripts, and tickets ([[credentials-never-reach-an-error-path]]).

**Why:** PowerShell resolves variable names case-insensitively and does not warn when a parameter declaration shadows or collides with an automatic variable or an existing in-scope name — the language treats it as an ordinary rebind, not a naming conflict worth flagging. The failure mode looks exactly like a downstream tool rejecting bad input, which sends the diagnosis toward credentials or configuration instead of toward the function signature.

**How to apply:**
- Never name a parameter after a PowerShell automatic variable; treat any near-collision with an in-scope name (including a same-name-different-case variable) as a defect even when the script appears to run correctly in casual testing.
- Assert inside the function that the parameter is non-empty before using it, so a silent non-bind fails loudly at the point of use rather than three calls downstream.
- When a native command prints its own usage text instead of running, suspect an empty or malformed argument vector before suspecting the credential or config it was supposed to receive.
- Give any credential-holding variable a distinctive name that cannot collide with a likely parameter name, in either case.

Related: [[windows-shell-layers-mangle-your-arguments]], [[assert-the-resolved-value-not-the-declaration]].
