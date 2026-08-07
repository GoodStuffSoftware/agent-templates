---
id: never-test-in-a-live-deployment-tree
title: A deployment directory that is also a checkout is production, not a workspace
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Never run a test suite, seed script, or migration inside a live deployment tree. When a project is deployed by pulling into a directory that is also a source checkout, that directory looks exactly like a dev workspace and every habitual dev command is loaded. Test suites write to paths relative to the working directory (`./data`, `./tmp`, `./logs`), so "run the tests to get a baseline" silently means "run them against production".

The incident: an agent ran the suite inside the running service's working directory to get a pre-merge baseline. The suite opened the production database, took an exclusive lock, and the service crash-looped for minutes on `database is locked` until the run was killed — and it left test fixtures in live application state that had to be cleaned by hand. Nothing in the suite was wrong. The working directory was.

This applies to any pull-to-deploy setup — self-hosted runners, `git pull && restart`, bare-metal or container-host deployments — and it does not require a database: any suite that writes relative to the working directory, seeds fixtures, or binds a port has the same blast radius.

**Why:** The failure mode is not a clean error. Prose warnings do not prevent it either — three prior "be careful on the box" notes existed before this happened — because the directory presents every affordance of a workspace and the destructive step is the most ordinary command in the repo.

**How to apply:**
- Work in a throwaway clone instead, with dependencies symlinked (they are read-only; data is not):

  ```bash
  D={{SCRATCH_DIR}}
  rm -rf "$D" && git clone --shared {{DEPLOY_DIR}} "$D"
  ln -s {{DEPLOY_DIR}}/node_modules "$D/node_modules"
  cd "$D" && {{TEST_CMD}}
  ```

- Back it with a pre-test guard rather than a comment. Derive "which tree is live" from the **service manager**, not a hardcoded path, so the guard follows a moved deployment and is a silent no-op on a laptop or in CI: query the running unit's working directory, compare it to the process's current directory after resolving symlinks, and exit non-zero with the isolated-clone recipe in the message. Provide a per-invocation override ({{ALLOW_LIVE_ENV_VAR}}=1) so the rare deliberate case is possible but never accidental. A pre-test guard fires only on the test command — it does not affect installs or the deploy path.
- **Interpreting results from an isolated clone:** a shared clone has no secrets file and symlinked dependencies, so anything needing real credentials fails there for environmental reasons. Do not report those as codebase defects; compare against a known-good environment before raising an alarm.
- A shared clone also sets its remote to the local path it came from — see [[verify-at-destination-prove-the-target]] before trusting any ref comparison made inside one.
- Echo this rule in any agent definition permitted to run commands on a deployment host.
