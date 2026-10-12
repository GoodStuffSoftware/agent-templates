---
id: a-history-scrub-must-cover-commit-headers
title: A history rewrite that scrubs blobs and messages still leaves author and committer emails in every commit header
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
When a repository is made public, or a value must vanish from its history, the rewrite pass usually targets file contents and commit messages. Commit headers (author and committer name and email, tagger on annotated tags) stay, and they are public from any commit's `.patch` URL. In one case that left a personal email in over a thousand headers.

**How to apply:**
- In the SAME pass, add a mailmap (`git filter-repo --mailmap`) that maps the real address to the host's noreply form `{{ID}}+{{USER}}@users.noreply.{{HOST}}` (take the id from the host's user API); attribution and the contribution graph survive.
- Audit before and after: `git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u`, plus tag taggers.
- Take a private backup first (a private repo or a bundle) and record the restore path; the rewrite needs a force-push.
- The local `user.email` must change too, or the next commit brings the old address back.

Related: [[an-inherited-env-var-beats-the-child-cwd]], [[credentials-never-reach-an-error-path]].
