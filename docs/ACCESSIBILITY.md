# Operator accessibility audit

UX-001 remains PARTIAL. This audit covers the Crank-owned web operator doors;
it is not a product-wide WCAG conformance declaration or native-device proof.
Base-owned sign-in, setup and agent doors, complete small-screen workflow editing,
actual iOS and Android assistive technology, notification-to-resolution devices
and APNs and FCM delivery remain required.

## Reproducible proof

The existing registered `tests/decision-browser.mjs` journey,
“UX-001: accessible owner operation and real decisions across connection loss”,
runs in push Verify's owner-decisions group. Its registration count is unchanged.
Run it with `CRANK_EVIDENCE` pointing to an output directory. The journey uses an
installed native owner session, another real member to start approval work,
actual HTTP routes and storage, a local destination that refuses then acknowledges
the same delivery key, and real local Cron to deliver an addressed inbox notice.
Only the browser's network boundary interrupts decision transport.

Every captured state at 1440 CSS pixels with keyboard activation and 390 with
touch activation runs the exact pinned axe-core development dependency against
`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a` and `wcag22aa`.
Every violation, including minor or unclassified impact, fails the journey.
`accessibility.json` records each state's passing rules, unresolved automatic
checks and measured results. `decision-requests.json` retains the decision request
ledger. Neither file contains sign-in links, sessions or credentials.

The states include approvals waiting, offline before send, failed reconciliation,
checking the latest state with controls frozen, workflow approval detail,
committed but lost response, a server-refused stale decision followed by an
authoritative read, reconciled approval and
rejection, bounded submission timeout, legacy pending and rejected detail,
required-field error and correction, created workflow, live and paused controls,
legacy failed delivery and acknowledged replay, structured decision error and
correction, workflow execution error, cancellation, populated and empty search,
filtered results, empty and addressed inbox and its resolved decision.

The measured checks visit every enabled visible control in natural DOM order by
Tab, including activation of the skip link. Painted operator text must be at
least 13 CSS pixels; every visible invalid field must retain its name and a
visible alert linked through its accessible description. Native segmented date and time fields may take several bounded Tab stops within one control. Each needs a computed accessible name, visible
focus of at least 3:1 contrast, an exposed hit point and its complete bounds in
the viewport. Positive tabindex is refused. Focused icon controls expose their
named tooltips. On hover-capable pointing devices, help stays visible when the pointer moves onto it and Escape dismisses it. Keyboard help is checked at both widths. Each target is at least 24 by 24 CSS pixels, has equivalent
spacing, is an inline text link, or has an equivalent larger link to the same
run. Reflow is measured at 320 CSS pixels, including nested scroll containers;
text fields retain their ordinary single-line input behavior.

For axe's unresolved image and gradient backgrounds, the journey measures the
actual background pixels behind painted text (excluding portions clipped or covered by an open popover), temporarily making foreground text
transparent and restoring all styles afterward. The worst sampled pixel must
meet 4.5:1, or 3:1 for large text. Fields also need a 3:1 boundary against their
fill. Disabled controls are exempt from the contrast requirement. Textual state
labels and atomic polite decision announcements are inspected programmatically.
Legacy delivery errors and workflow execution errors have alert semantics. Required-field and malformed JSON errors are identified in text, announced as
alerts and associated with their control through `aria-describedby` and
`aria-invalid`; correction clears the error. Invalid JSON sends no decision. A held authoritative read proves the checking
announcement while actions stay frozen; a decision already completed by another
current session is refused by the real server and announced after reconciliation
without a second decision or a replayed request.

## Criteria within the audited doors

“Pass” means the specified automated, measured or inspected evidence within this
scope. “Not applicable” identifies content or interaction absent from these doors.
It does not waive obligations on excluded pages or devices. Screenshot review
supplements automation; browser touch emulation is not a handset receipt.

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1.1.1 Non-text content | Pass | Axe; decorative marks and SVGs are hidden or have empty alternatives; controls have names. |
| 1.2.1 Audio-only and video-only | Not applicable | No recorded media in the audited states. |
| 1.2.2 Captions | Not applicable | No synchronized media. |
| 1.2.3 Audio description or media alternative | Not applicable | No synchronized media. |
| 1.2.4 Live captions | Not applicable | No live media. |
| 1.2.5 Audio description | Not applicable | No video. |
| 1.3.1 Information and relationships | Pass | Axe; headings, native forms, labels, lists, table headers and linked errors. |
| 1.3.2 Meaningful sequence | Pass | DOM Tab-order comparison and screenshot review; detail content precedes its supporting history. |
| 1.3.3 Sensory characteristics | Pass | Inspected state and action instructions use words, not position or color alone. |
| 1.3.4 Orientation | Pass | Landscape desktop and portrait phone layouts; no orientation lock. |
| 1.3.5 Input purpose | Not applicable | Audited inputs describe work and search; no personal-profile entry. |
| 1.4.1 Use of color | Pass | Nonempty textual state checks and explicit failure, stale, unconfirmed and resolved text. |
| 1.4.2 Audio control | Not applicable | No automatic audio. |
| 1.4.3 Minimum text contrast | Pass | Zero axe violations plus worst-pixel measurements for unresolved backgrounds. |
| 1.4.4 Resize text | Pass | Reflow proof at 320 CSS pixels and inspected resizable text and native controls; no fixed text-height containers. |
| 1.4.5 Images of text | Pass | Inspected live HTML text; the brand mark is decorative beside the textual name. |
| 1.4.10 Reflow | Pass | Each state is measured at 320 CSS pixels with no page or nested two-dimensional scrolling. |
| 1.4.11 Non-text contrast | Pass | Measured field boundaries and focus rings; state dots are redundant to words. |
| 1.4.12 Text spacing | Pass | Each state reflows with 1.5 line height, .12em letter spacing, .16em word spacing and 2em paragraph spacing; expanding panels and controls are inspected. |
| 1.4.13 Hover or focus content | Pass | Focus tooltip checks; hover help persists while hovered or focused and Escape dismisses it. |
| 2.1.1 Keyboard | Pass | Actual Tab traversal and Enter activation, including approvals, pause, replay, cancellation and search. |
| 2.1.2 No keyboard trap | Pass | Every control is reached in order; disclosures use native summary controls and no modal focus trap. |
| 2.1.4 Character key shortcuts | Not applicable | No single-character shortcut. |
| 2.2.1 Timing adjustable | Not applicable | No user-entry time limit; the request timeout retains the note and offers a read-only check. |
| 2.2.2 Pause, stop, hide | Not applicable | No moving, blinking or automatically scrolling content. |
| 2.3.1 Three flashes | Not applicable | No flashing content. |
| 2.4.1 Bypass blocks | Pass | Skip-to-main link and a focusable main landmark. |
| 2.4.2 Page titled | Pass | Axe and distinct server-rendered page titles. |
| 2.4.3 Focus order | Pass | Actual Tab sequence matches visible native controls in DOM order; no positive tabindex. |
| 2.4.4 Link purpose | Pass | Axe and inspected run, workflow, search and inbox link names. |
| 2.4.5 Multiple ways | Pass | Workspace navigation, run search, back links and inbox links reach operator records. |
| 2.4.6 Headings and labels | Pass | Axe; named fields, action words and section headings reviewed in screenshots. |
| 2.4.7 Focus visible | Pass | Every focused control has a measured outline and at least 3:1 contrast. |
| 2.4.11 Focus not obscured | Pass | Every Tab stop is inside the viewport and exposed to hit testing, including the sticky rail and opened menus. |
| 2.5.1 Pointer gestures | Pass | All audited actions use a single tap; no multipoint gesture. |
| 2.5.2 Pointer cancellation | Pass | Native link and button click activation occurs on release; no pointer-down business action. |
| 2.5.3 Label in name | Pass | Axe; visible native labels supply the control name. |
| 2.5.4 Motion actuation | Not applicable | No motion input. |
| 2.5.7 Dragging movements | Not applicable | Audited operation does not require dragging. Complete workflow editing remains outside this audit. |
| 2.5.8 Target size | Pass | Measured 24-pixel bounds or spacing, with explicit inline-link and equivalent-control exceptions. |
| 3.1.1 Language of page | Pass | Axe; documents declare English. |
| 3.1.2 Language of parts | Not applicable | No authored passage in another language. User payloads remain literal data. |
| 3.2.1 On focus | Pass | Tab traversal does not activate a decision or navigate. |
| 3.2.2 On input | Pass | Editing fields alone sends no decision; search and state changes require explicit activation. |
| 3.2.3 Consistent navigation | Pass | Shared workspace navigation and breadcrumbs retain order across states. |
| 3.2.4 Consistent identification | Pass | Shared action labels, status words and named shell controls. |
| 3.2.6 Consistent help | Not applicable | No separate help mechanism within these operator doors; field help and errors stay with the field. |
| 3.3.1 Error identification | Pass | Required-name and structured-JSON errors identify the affected control with text and `aria-invalid`. |
| 3.3.2 Labels or instructions | Pass | Axe and actual form use; required names, optional notes and JSON types are labelled. |
| 3.3.3 Error suggestion | Pass | Native validity guidance and a valid JSON example are programmatically described by the field. |
| 3.3.4 Error prevention | Pass | Exact proposal inspection before approval; pending decisions freeze; replay preserves the approved body and key. These fixtures execute no financial transaction. |
| 3.3.7 Redundant entry | Pass | Original offline-note assertions remain; invalid structured input is retained until corrected. |
| 3.3.8 Accessible authentication | Not applicable | Authentication is a Base-owned excluded door; the audit begins with a native session. |
| 4.1.2 Name, role, value | Pass | Axe and computed accessible-name checks for every visible control, including disabled controls. |
| 4.1.3 Status messages | Pass | Persistent atomic polite status region for stale and unconfirmed decisions; alert semantics for field and execution errors. |

## Findings corrected

Unreached timeline text no longer inherits faded opacity. The approval badge uses
dark ink on orange, and footer text uses the readable body color. Secondary editor labels, field edges and
keyboard outlines have sufficient contrast. A skip link bypasses repeated shell
navigation. Long headings wrap, the header retains its controls beside long breadcrumbs, run-ID focus remains above the phone row link, and decision notices have space for their focus
outline. Standalone links have their own 24-pixel targets. Field errors persist visibly after the native validity popup closes and
clear when edited. Tooltips can be dismissed without moving focus. Popovers close when keyboard focus leaves them, so they cannot cover the next target.

Existing one-decision, offline, lost-response, authoritative-read, input-retention
and hidden-path legacy assertions remain in the registered journey unchanged.
No Base copy, runtime pin, existing package pin, homepage or contract status cell
is changed. Full conformance and the held device obligations remain unclaimed.
