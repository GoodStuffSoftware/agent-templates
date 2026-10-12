---
id: non-painting-browser-pane-lies
title: Don't trust geometry from an agent-driven browser pane that isn't painting
scope: [agent-process]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 2
---
An agent-driven browser pane that is **not displayed does not composite frames**. It still executes JS and still answers DOM queries, so it looks healthy — but three classes of observation become silently wrong:

1. **CSS transitions freeze mid-flight.** `getBoundingClientRect()` and `getComputedStyle(el).transform` return the frozen interpolated value, not the settled one. An element can measure a fraction of its real size for no visible reason.
2. **`scroll` events are never dispatched**, so scroll-driven handlers look dead.
3. **Screenshots fail** outright — there is no agent-side workaround; substitute DOM/geometry assertions for visual evidence.

The incident: verifying a floating-overlay UI change. A `position: fixed` element whose inline style said it was over 1200px wide measured about a third of that. There was no layout bug — the pane was not compositing, so the opening transition never advanced and every geometry read returned the interpolated value. Roughly an hour went into a defect that did not exist.

**Before measuring anything, neutralise transitions:**

```js
const s = document.createElement('style');
s.textContent = '*, *::before, *::after { transition-duration:0s !important; animation-duration:0s !important; }';
document.head.appendChild(s);
```

Geometry becomes deterministic at once, and this doubles as an honest exercise of the `prefers-reduced-motion` path. Re-inject after every navigation — a reload drops it.

For a handler that needs an event the pane won't deliver, **dispatch it yourself** (`el.dispatchEvent(new Event('scroll'))`) and state in the report which behaviour was observed naturally and which was simulated. That proves the handler's logic honestly without claiming the browser delivered the event.

**Two adjacent traps in the same family:**
- The browser **caches ES modules**. A fix that provably exists in the served file (confirm with `fetch(url, {cache:'no-store'})`) can have no effect on the page after a plain reload. Force a cache-busting navigation instead.
- The pane can **collapse to zero size** or **navigate itself elsewhere** mid-session. Re-assert both the viewport size and `location.href` before trusting a measurement — cheapest check is that a known fixture count still matches.

**The general rule:** when a browser measurement contradicts the inline style you just set, suspect the observation before the code.

**Scope this honestly.** This was measured on one tool. A second measurement on a *different* agent-driven browser found normal behaviour — page visible, frame loop live, animation clock tracking wall-clock. Record which tool you tested; see [[scope-a-broken-finding-to-the-measured-path]].

**Hidden-document variant, and two more pane artifacts.** A pane can run its page with `document.hidden === true`. Browsers throttle ResizeObserver, IntersectionObserver and requestAnimationFrame in hidden documents, so any CSS variable or measurement driven by an observer can read stale (a banner-height variable read 71.84px while the banner rendered 41px; the same page under a normal test browser read 41px). Check `document.hidden` first; take observer-driven numbers from a real test browser.
- A screenshot from a subagent can come back as a solid dark frame ("page did not finish rendering", then blank) while the tab title and URL look right. Treat a blank frame as a pane artifact and prefer page-text and accessibility reads.
- The pane's custom viewport emulation below its native width can report a dialog card at width 0 for 9+ seconds; a real browser at the same size settled in 750 ms. Verify any narrow-viewport layout finding in a real browser before escalating it.
