---
id: rebuild-an-unrepresentable-tree-with-plumbing
title: A commit holding a path your platform cannot represent is still fixable — with object-graph plumbing that never touches a working tree
scope: [universal, stack:git]
requires: { stack: git }
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
An agent running on one operating system committed a cache file whose *name* was legal there and structurally impossible on another — it embedded a drive letter and that platform's separators. Every developer on the second platform was then unable to create a new working copy from that branch at all: the checkout aborted before producing any files.

That blocks all local work on the branch, not just the one file, and the obvious fixes are circular. Staging a deletion needs an index; populating an index needs a checkout; the checkout is what refuses.

**Why:** checkout, index-read, and partial-checkout mechanisms all validate paths, so they all refuse the same tree. Worse, one of them may fail *silently into an empty state*, which lets you construct and commit an empty tree believing you removed one file. The escape is that the object graph itself has no filesystem to satisfy.

**How to apply:**
- **Operate on the object graph directly.** List the tree entries, filter out the unrepresentable one, write a new tree object from that listing, create a commit whose parent is the original tip, point a branch at it — and only then create a working copy. No step touches the filesystem until the bad path is gone.
- **Match the plumbing's expected line endings and encoding when you feed the filtered listing back.** Stray carriage returns get absorbed into filenames, silently renaming everything you preserved.
- **Diff the new tree against the old one and confirm it differs by exactly the intended removal, BEFORE committing.** Verify, do not assume, that your rebuild is a one-line change — this is the step that catches the silent-empty-tree failure.
- **Prevention is upstream.** When agents run on heterogeneous platforms against one repository, a path one of them resolves relative to its own filesystem becomes a literal filename for everyone else. Machine-local caches belong outside the repository, and ignore rules should cover the shapes a foreign platform would produce.
- **Add the cross-platform filename check where the commit happens**, not to a review checklist — a hook or CI check that rejects reserved characters, drive-letter prefixes, and foreign separators. The authoring platform is the one place the defect is invisible ([[clean-clone-cross-os-build-truth]]).
