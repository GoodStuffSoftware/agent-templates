---
id: preview-mcp-orchestrator-only
title: Browser-preview and screenshot MCP tools are only available in the main orchestrator session
scope: [agent-process, vendor:anthropic]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
MCP tools that provide browser preview, screenshot, click, and DOM inspection capabilities (e.g. preview MCP, computer-use MCP) are typically scoped to the main orchestrator session only — teammate agents cannot reach them. Briefs that ask a teammate to "preview the page" or "take a screenshot" will silently no-op because the tool isn't in the teammate's toolset.

**Why:** The capability exists in the main session's tool inventory but is not automatically forwarded to spawned teammates. A teammate briefed to "visually verify the rendered page" will produce no output for this step, silently skip it, or report an error — none of which is the intended behavior. This is a silent failure mode that leads to unverified UI changes landing.

**How to apply:**
- Route all visual verification (screenshots, DOM inspection, click-testing) through the orchestrator. The reviewer or builder asks the orchestrator to "screenshot path X and check Y"; the orchestrator runs the tool and reports back.
- Automated UI assertions (Playwright, Cypress) ARE available to teammates and are the correct tool for reproducible UI verification.
- Visual spot-checks (non-reproducible, human-judgment calls) go to the orchestrator as explicit requests.
