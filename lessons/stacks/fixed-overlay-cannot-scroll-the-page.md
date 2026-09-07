---
id: fixed-overlay-cannot-scroll-the-page
title: A `position: fixed` overlay cannot make the page scroll — the overflow is in the normal flow underneath
scope: [stack:css]
requires: {}
status: active
since: 2026-09-07
provenance: [contrib-2]
corroborated: 1
---
An element taken out of normal flow — `position: fixed`, or promoted into the browser's top layer by a modal dialog — contributes **nothing** to the document's scrollable overflow. So when `document.scrollHeight > window.innerHeight` while such an overlay is showing, the overlay is not the cause. It cannot be. The defect is in the layout underneath it, and it was there before the overlay appeared.

The incident: a ~17px body-level scroll at the smallest supported phone viewport was noticed while a fullscreen panel was up, and got attributed — in a test comment and an operations note — to that panel's plain `92vh` height cap. Measured on the base branch, `document.scrollHeight` equalled the viewport at every step of the panel. The overflow only reproduced with a normal-flow banner present at the top of the page, whose height was published to a CSS variable from a `ResizeObserver` callback reading `entry.contentRect.height`. `contentRect` is the **content box**; the page subtracted that number from a **border-box** height. `{{VIEWPORT_H}} - {{CONTENT_BOX_H}} + {{BORDER_BOX_H}}` matched the measured overflow to the pixel — padding plus border was the entire gap.

**Why:** the overlay is the most visually salient thing on screen when the symptom is noticed, and it usually does have a suspicious-looking height rule of its own. That coincidence is enough to end the investigation before it reaches the box that is actually too tall — and the wrong conclusion then gets written into a comment, where the next reader inherits it.

**How to apply:**
- Walk the **normal-flow chain** — `html` → `body` → app root → layout wrapper → page — and find the box taller than the viewport. Then compare the number that box was **given** with the number it **renders**.
- Suspect any height CSS variable fed by a `ResizeObserver`. `entry.contentRect` excludes padding and border; if the consumer subtracts it from a border-box height, read `entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height` instead. The two agree exactly until someone adds a border.
- Pin the invariant with a **polled assertion at the overlay's steps** (`scrollHeight <= innerHeight`). It cannot pass vacuously, and it stops the misattribution from being re-derived.
- Measure it somewhere the observers actually run. An agent-driven browser pane may report `document.hidden === true`, which throttles `ResizeObserver`, `IntersectionObserver` and rAF — observer-driven numbers read there can be stale by a whole layout generation. See [[non-painting-browser-pane-lies]].
- Same shape as [[read-which-error-fired-before-theorising]]: the suspect the symptom pointed at was structurally incapable of causing it, and one measurement said so for free.
