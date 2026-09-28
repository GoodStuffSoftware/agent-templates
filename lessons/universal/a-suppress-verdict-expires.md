---
id: a-suppress-verdict-expires
title: A "benign, suppress" verdict expires — key a triage conclusion to the pair of references that produced it
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 2
---
Triage notes are reusable. Triage *conclusions* are not. A finding about the difference between two references is valid only for the exact pair that produced it.

The incident: a drift alarm fired naming the same serving version as one triaged a day earlier. The prior triage had correctly ruled it benign — the whole gap was one documentation file plus its merge, zero runtime files — and that reasoning was written down for reuse. Reusing the *conclusion* would have been wrong. The deployed side had not moved, but the reference branch had advanced several more commits, and the gap now included runtime files: a bootstrap entrypoint and two files in the deploy-verification path. Same alarm shape, same serving identifier, same prior write-up, opposite correct verdict. The alarm went from suppress to escalate purely because the other side of the comparison kept moving while nothing re-ran the classification.

**Why:** "Deployed version X is fine" reads like a fact about X, but it was a fact about `X vs Y` at a moment. Stored as a property of one endpoint, a point-in-time finding silently becomes a standing rule that decays — and it decays in the direction that produces silence, because the stored verdict keeps voting *suppress*. This is the failure mode of every known-benign list keyed on a single side of a comparison.

**How to apply:**
- **Never key a known-benign record on one endpoint.** Key it on the pair, or re-derive it.
- **Re-run the cheap classification step every time.** Listing the changed files between two references costs seconds. Skipping it because "we already looked at this one" is what turns a correct suppression into a missed escalation.
- **Prefer age over count for staleness severity.** Commits-behind is a volume measure that says nothing about content, and checkers frequently mark it cosmetic in their own source. "The deployed artifact was built {{DURATION}} ago and the refresh interval is {{INTERVAL}}" is direct evidence the update mechanism stopped. Put the age in the alarm body.
- **Watch for the self-referential case.** If the undeployed range contains fixes to the verification or monitoring path itself, passing checks from the deployed code prove nothing about those paths — the safeguard that would catch the failure is the safeguard still sitting undeployed.
- **Dedupe alarms by the frozen side, not the moving side.** Keying alarm identity on the reference that advances turns one stuck deployment into a stream of separate-looking alerts, each individually easy to dismiss.

**A verdict can also expire along a different axis: not because a referenced side moved, but because it was only ever evaluated against ONE question.** A design change was examined during review, scored explicitly for size inflation, correctly found to cause none, and dismissed as cleared. It was never scored against the failure mode the whole change existed to remove — a freeze transition — which was the actual risk. Same case, same reviewer, right analysis, wrong question: "cleared" silently meant "cleared against the failure mode I was checking for," not "cleared, period," and nothing marked the distinction. This is worse than missing the case outright, because a case you have already looked at feels retired, and "I already considered that" is exactly the sentence that stops someone from re-examining it.

- **When a change addresses failure mode B, re-walk every case cleared under failure mode A** rather than trusting the prior clearance to transfer. Ask which QUESTION each case was scored against, not merely whether it was considered — "considered" and "cleared against the question that matters now" are different claims, and a case log that records only the verdict loses the one field that would catch this.
- A reviewer's corollary: when citing a case as "already handled," name the failure mode it was checked against. An unqualified "cleared" is exactly the phrasing that lets a wrong-question clearance stand unquestioned a second time.

Related: [[monitor-default-target-is-part-of-the-finding]] and [[probe-behaviour-not-version-stamps]] say the alarm's *numbers* may be wrong. This one says the numbers may be right and the *stored conclusion* wrong — whether the conclusion decayed because a referenced side moved, or because it only ever answered one question.
