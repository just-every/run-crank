# Demo mode

Import `withDemo` first in the Worker entry and wrap the worker with
`withDemo(worker, { seed })`. It changes behavior only with `RER_DEMO=1`.
Production build/deploy refuses that setting; ordinary builds keep real effects.

- Public internet reads and checks run for real: pages, feeds, previews and
  monitor probes against any URL. GET, HEAD and OPTIONS use the real network.
  A check using POST uses `fetchDemoRead(url, init)` to declare read intent.
  Redirects pass through the same policy at every hop.
- Third-party writes are mocked: external POST, PUT, PATCH and DELETE, message
  APIs and webhook URLs return success without contacting their destination.
  Common mail, SMS and chat providers receive their normal success envelope;
  generic JSON writes receive their submitted resource with a generated ID.
  For an SDK, binding or another non-HTTP transport use
  `demoEffect(() => realSend(), () => providerSuccess)` around the effect.
  Without `RER_DEMO` this always executes `realSend`. A seed with a richer
  provider response should supply its own exact success shape this way.
- Mail in local dev and demo is silently suppressed. There is no outbox or
  blocked-send UI. Logs contain only the mocked request's method and host.
- The configured owner's authenticated session supplies step-up proof inside
  its own demo, including owner invitations and role changes. The demo guard
  must be active; ordinary hosted instances still require real proof. Each
  visitor's separate session secret and store reject other visitors' cookies.
- `seed(env, { ownerEmail, now })` runs once after the owner exists and must
  be idempotent. Its only table is the demo's throwaway `rer_demo` marker.
- Base adds ` Demo` to the document title, including client-side navigation.
  Put `data-rer-name` on the product's text label, for example
  `<span data-rer-name>Uptime</span>`, to show **Uptime Demo** in its nav.
  The same attribute shows **Uptime Dev** under the local dev wrapper. No bar,
  layout offset or timer is injected. In demo mode a **Run <Seed>** link sits
  beside each marked navigation label and opens `https://<domain>/run`. The
  existing `demoSockets()` Vite plugin supplies the public `name` and canonical
  run-site `domain` from `deploy-demo.json` and the command adapter's
  `site.declaration` (normally `deploy-site.json`); an explicit HTTPS `/run`
  `runUrl` in the demo declaration takes precedence and is validated for both
  local and hosted demos. No per-seed link is required. CSS adds the label suffix without
  changing the application's hydrated text; CSP allows exact hashes only.

Public sockets, WebSockets and event streams remain usable for checks. The
local sockets guard and hosted egress retain a small direct mail/SMS denylist;
use the effect helper for such sends. Hosted demos keep their isolated
container, Turnstile, per-IP start limit, TTL/idle end and maximum instances.
See [adoption and hosting](https://github.com/runeditrun/base/blob/main/export/DEMO.md).
