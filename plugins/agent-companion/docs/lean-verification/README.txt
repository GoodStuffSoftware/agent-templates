Verification kit for feat/ac-lean-subagents (run by the operator, fresh session)
================================================================================

Why a fresh session: a frontmatter change does not hot-reload, and a project-level
agent file is read at session start.

What it proves
  1. disallowedTools: mcp__<server> removes the server's tool SCHEMAS, its DEFERRED
     tool names and its MCP INSTRUCTION block from a subagent (not only the schemas).
  2. omitClaudeMd: true keeps CLAUDE.md and the MEMORY.md index out of a subagent
     (S3 was left out of the release; this is for the record and the reverse path).
  3. The reporting contract reaches a subagent once (S5).

Steps
  1. Make an empty scratch folder, copy the three files in agents/ (next to this
     file) into <scratch>/.claude/agents/, and open a NEW Claude Code session with
     <scratch> as the project directory. Note the session's project dir under
     ~/.claude/projects/. (Run the node scripts below from this docs folder.)
  2. In that session, run three subagents, one after another (any prompt works,
     the probes only answer OK):
        Agent(subagent_type="lean-probe-control", prompt="go")
        Agent(subagent_type="lean-probe",         prompt="go")
        Agent(subagent_type="lean-probe-nomd",    prompt="go")
     For the S5 check also run one real ladder worker from a session that has the
     lean agent-companion installed (e.g. agent-companion:ac-sonnet-low, prompt "OK").
  3. Find each transcript:
        ~/.claude/projects/<encoded project dir>/<session id>/subagents/agent-<id>.jsonl
     (newest files in that folder, in spawn order).
  4. Inspect each one with:
        node inspect-subagent.mjs <transcript.jsonl> --dropped visualize,terminal,ccd_session,ccd_connectors,ccd_directory,ccd_pr,ccd_sidebar,ccd_view,ccd_window,mcp-registry,Claude_Browser,claude-in-chrome,computer-use,ccd_session_mgmt
     The script prints tools by server, deferred names by server, MCP instruction
     servers, injected instruction files, and CHECK lines:
        dropped-server-schemas   PASS when no dropped server has a tool schema
        dropped-server-deferred  PASS when no dropped server's names are listed as deferred
        dropped-server-instr     PASS when no dropped server's instruction block is present
        claudemd/memorymd        injected or not
        contract-once            the reporting contract appears once
  Expected:  lean-probe-control  -> dropped-server-* FAIL (the old state, the baseline)
             lean-probe          -> dropped-server-schemas PASS; the deferred and instr lines
                                    say whether the harness also removes names and the
                                    instruction block. If only schemas go, the saving is the
                                    schema share only: report it and keep only changes that pay.
             lean-probe-nomd     -> claudemd/memorymd not injected

Usage scan (30 days, per MCP server, per rung):
        node mcp-usage.mjs
