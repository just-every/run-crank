# Hydration units

Something in a visitor's browser can change a page before React hydrates it: an
extension that turns email addresses into links, a translator, Cloudflare's email
address obfuscation. React then throws a hydration mismatch and client-renders the
nearest Suspense boundary. TanStack Router has exactly one, around everything under
the root route, so the whole page is rebuilt and every entrance animation plays
again (a "blink"). Content the root route renders itself (`<html>`, header, footer)
is in no boundary at all, so a mismatch there re-renders the whole document.

These helpers keep a mismatch to the section it happened in, stop a rebuild from
replaying an intro, and make mismatches visible in dev and countable in production.
`rer verify` proves it on every public page (SEED-COMMAND-CONTRACT.md, "Hydration
units").

| File | Export | Use |
| --- | --- | --- |
| `unit.tsx` | `HydrationUnit` | `<Suspense fallback={null}>` with no wrapper element |
| `intro-guard.ts` | `introGuardScript`, `introCss` | inline `<head>` script and CSS that stop intros replaying |
| `report.ts` | `createRecoverableErrorHandler(report?)` | `onRecoverableError` for the client entry |

## The convention

**Page sections.** A page section is an outermost `header`, `nav`, `section`,
`article`, `aside` or `footer` element in `<body>`: one that is not inside another
of those.

- Each page section on a public page is exactly one `HydrationUnit`: one unit per
  section, never one unit around a group of sections (a rebuild of the group
  replaces its siblings). In a pair layout, wrap each section, not the pair.
- Root chrome rendered by the root route component (header, nav, footer, banners)
  is wrapped too. Outside every boundary, a mismatch there re-renders the document.
- Text-bearing route content outside any section (a page title above the sections,
  a skip link with mixed text) goes in a unit of its own, or becomes lone text (below).
- Signed-in app pages may adopt the same convention; the check covers public pages.

**What a unit may contain.** A unit must not suspend during server rendering (no
unresolved `lazy`, `use` or awaited loader data inside it), or its empty fallback is
streamed first. It must not render `<link rel="stylesheet" precedence>`. Units cost
a little: they hydrate in a pass after the route boundary (about 17 ms later on the
lab page).

**Root route restrictions.** The root route never sets `shellComponent`,
`wrapInSuspense` or `pendingComponent`; those wrap `<html>` in a boundary that cannot
hydrate (TanStack/router#8053).

**Intros.** A one-time entrance animation is a CSS animation on an element carrying
`data-intro`, present in the server HTML, that plays from first paint without
waiting for JavaScript.

- Declare its rule inside `@media (prefers-reduced-motion: no-preference)`, with
  keyframes that end at the element's natural style, so turning the animation off
  changes nothing visible. `animation-fill-mode: both` is fine.
- Looping animations, hover and interaction effects, and elements that mount later
  on the client never carry `data-intro`.
- A seed may keep its own selectors (`.hero-window { animation: … }`); the attribute
  is what the guard keys on.
- Intros play once per document load. After they finish, a client-side navigation
  back to the page shows it in its final state.

The root route renders the guard as early as it can in `<head>`:

```tsx
<script dangerouslySetInnerHTML={{ __html: introGuardScript }} />
<style>{introCss}</style>
```

While intros run, it pins a rebuilt intro element's animation to the original
clock, so the element continues where its predecessor was; once every intro has
finished it turns intro animations off, so a later rebuild appears in its final
state. A seed with a Content Security Policy passes the router's SSR nonce to this
inline script.

**Lone text.** React checks an element whose only child is a string by its text
content alone, so a linkifier's split-and-wrap there changes nothing React checks. A
text node beside sibling elements is checked node by node, and splitting it always
mismatches. Email addresses, phone numbers, URLs, shell commands and street
addresses in public copy are the only child of their element:

```tsx
<p>Write to <a href="mailto:records@example.com">records@example.com</a></p>
<p><b>$</b> <span>{command}</span></p>
```

`suppressHydrationWarning` only accepts in-place text and attribute changes one
level deep and does nothing for split or wrapped text; it is a per-element tool, not
part of this convention.

**Client entry.** `src/client.tsx` replaces Start's default entry:

```tsx
startTransition(() => {
  hydrateRoot(document, <StrictMode><StartClient /></StrictMode>,
    { onRecoverableError: createRecoverableErrorHandler() })
})
```

In dev each recovered boundary prints one `console.warn` naming the hydration
mismatch, with React's error and the component stack. In production it is silent and
counts recoveries in `window.__rerHydration` (`{ path, count, kinds, stacks }`;
`count` is the contract). Pass a reporter, `createRecoverableErrorHandler(summary =>
…)`, to send that summary to an error tracker: it is called once on `pagehide`, only
when a mismatch happened. Other recoverable errors keep React's default.

**Documents.** Document responses send `Cache-Control` with `no-transform` (keeping
the seed's other directives), which turns off Cloudflare's email address obfuscation
and any other proxy rewrite of the HTML React hydrates. A prerendered page is such a
document too: `rer deploy` runs the Worker before built files, so the Worker answers
it. A seed that prerenders pages builds with the same routing (the Cloudflare Vite
plugin's build `config` gives `assets: { binding: 'ASSETS', run_worker_first: true }`,
as the reference's `vite.config.ts` does), so `rer preview` serves them the same way
and not as bare assets without `no-transform`.

## Adopting

One change per seed, after the Base commit that carries these files. An
owner-reviewed homepage must look and behave exactly as approved: adoption adds
units, attributes, spans and a header, and nothing visible changes.

1. Copy `unit.tsx`, `intro-guard.ts` and `report.ts` byte for byte from that Base
   commit into the seed's Base runtime folder (`src/base/hydration/` in the
   exported layout) and record the copy the seed's way (`record-base`,
   `base-copies.json` or `sources.lock.json`).
2. Add `src/client.tsx` from Base's `default-seed` (seed-owned; pass a reporter only
   if the seed has an error tracker).
3. Update the exact `@runeditrun/rer` pin to a version that contains the shared check.
4. Root route: the guard script and `introCss` early in `<head>`; wrap root chrome
   in units. Do not add `shellComponent`, `wrapInSuspense` or `pendingComponent`.
5. Wrap each section of every public page in `HydrationUnit` (one per section).
   Wrap loose text-bearing route content.
6. Put `data-intro` on every one-time entrance animation element; its rule sits
   under `prefers-reduced-motion: no-preference` and its keyframes end at the
   natural style.
7. Make addresses, phone numbers, URLs and commands lone text (the check's advisory
   lists the email cases).
8. Add `no-transform` to the `Cache-Control` of document responses, keeping the
   seed's other directives. A seed that prerenders pages builds with the deploy's
   asset routing (see Documents above).
9. Declare `publicPages` in `commandAdapter` if discovery from `/` (and the
   same-origin redirects it follows from `/`) does not reach the seed's public
   pages, or reaches pages it should not. A check that loads no page fails.
10. Prove it: `rer verify` passes with the check; `rer dev` shows one hydration warning per induced mismatch; and screenshots of each owner-reviewed public page at 1440 and 390 wide, animations settled, are pixel-identical before and after.

A seed with its own intro resume logic may keep it if the check passes; it still
adds the attribute and the guard so the done flag covers late rebuilds. A plain-HTML page
(React never hydrates it, it loads no application script and raises no error) is
listed and skipped by the check; a page whose scripts load but never hydrate fails.
Application scripts are same-origin script requests, module scripts and
`modulepreload` links in the served document from any origin, and cross-origin
module fetches; a third-party classic `<script src>` is not one.
The check holds the client scripts in the network layer until its edits land; keep
the client entry an external module script, because a page that inlines its bundle
in an inline module script hydrates before the release and fails as not exercised.
