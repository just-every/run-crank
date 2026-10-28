# Demo mode: adopting `rer demo`

`rer demo` (the same as `rer dev --demo`) runs a throwaway copy, signed in
as the saved owner with realistic data. Its title and marked nav label read
`<Seed> Demo`; local dev reads `<Seed> Dev`. Beside the marked product navigation,
**Run <Seed>** opens the canonical run site’s `/run` chooser. There is no injected
bar or outbox.

The exit uses only spare space beside or directly below the label and truncates its own text.
It stays out of the host layout, preserving sibling rectangles and document
width relative to the same header with the Demo suffix but no exit. It never
repairs an already overflowing host header. With no readable room it remains
a keyboard stop; keyboard focus reveals the full link above clipping ancestors.
The full name is also its accessible name and title. The host keeps ownership
of its responsive layout.


Invite another person through the app, then choose **Sign in as <name>** in
operator access or at `/signin`. Owners and invited people use the same one-click
path to `/app`, with their assigned roles. Local demos require the checkout's
key cookie (open `RER_OPEN` in each browser profile); hosted demos use only that
visitor's isolated accounts. Mail is silently suppressed. Cancelled or expired
invitations and inactive people cannot sign in this way.

```sh
rer demo            # prints RER_READY, RER_OPEN and RER_DEMO_ENDS_ON_STOP
rer demo --stop
```

Data lives in `.rer/demo/<start time>/` and is deleted on stop, Ctrl-C or
expiry. The checkout's `.wrangler/state` is never written. Stop `rer dev`
before starting a demo in the same checkout.

## Effects

Public internet reads and checks run for real, including monitor probes,
feeds, link previews and fetching a page. External writes that reach other
people or third-party accounts are **mocked**: email, SMS, chat posts,
web/social publishing, webhooks, payments and OAuth provider writes return
success without sending. This exception for mocks applies only under
`RER_DEMO`, never to a production installation. Mail in dev/demo is silently
suppressed; one-click sign-in has no email step.

The guard covers global fetch for routes, cron, queues and Durable Objects.
GET/HEAD/OPTIONS use real networking; external write methods and message or
webhook URLs use provider success responses. Use `fetchDemoRead(url, init)`
for a read/check that uses POST. For non-HTTP effects or a provider-specific
response, use `demoEffect(() => realSend(), () => providerSuccess)`; outside
demo mode the real send runs. No payload is retained or shown. Public sockets
remain open for probes; direct mail/SMS transports have a small denylist.
Production build/deploy refuses `RER_DEMO` in declarations or settings.

## Adopting it in a seed

1. **The hook.** Add `src/demo.ts` exporting
   `seedDemo(env, { ownerEmail, now })`. Put the seed's existing sample data in
   (the records a new owner would want to see, the owner's finished first run).
   It runs once, after the owner exists, and must be idempotent: fixed IDs with
   `INSERT ... ON CONFLICT DO NOTHING`. It never fetches.
2. **The import.** Copy Base's `modules/demo/` beside the seed's other Base
   modules (it uses `operator-auth/http.mjs` and `operator-auth/csp.mjs`). Make
   `withDemo` the first import of the Worker entry (`src/server.ts`), so it runs
   before any module could keep the real `fetch`, and wrap the default export:

   ```ts
   import { withDemo } from './modules/demo/index.mjs' // first import; Base's default-seed: '../../modules/demo/index.mjs'
   import { seedDemo } from './demo'
   export default withDemo({ fetch, queue, scheduled }, { seed: seedDemo })
   ```

   Options: `binding` names the D1 binding when it is not `DB`; `owner(env)`
   returns the owner's email when the seed's accounts are not Base
   operator-auth's.
3. **Three `vite.config` changes.** The dev persistence path reads
   `RER_STATE_DIR`, the demo switches reach the dev entry's vars, and
   `demoSockets()` (first in `plugins`) hands the Worker's `cloudflare:sockets`
   imports the guarded `connect` under `rer demo`:

   ```ts
   import { demoSockets } from './src/modules/demo/vite.mjs'
   persistState: { path: process.env.RER_STATE_DIR ?? '.wrangler/state' },
   const serve = { main: './src/server.dev.ts', vars: { /* ... */ ...local('RER_DEMO'), ...local('RER_DEMO_EXPIRES') } }
   plugins: [demoSockets(), cloudflare({ /* ... */ }), /* ... */],
   ```

4. **The nav label.** Mark the product text with `data-rer-name`, for example
   `<span data-rer-name>Uptime</span>`. Base adds the Demo/Dev suffix and sets
   the document title suffix itself, including after client navigation. Demo mode
   also adds a Run link beside that label, using the existing link and theme tokens.
   `demoSockets()` supplies its public name and URL from `deploy-demo.json`
   (`name` and optional `runUrl`), plus the existing run-site declaration's domain
   (the command adapter's `site.declaration`, normally `deploy-site.json`),
   in local demos and hosted builds. Both refuse invalid `runUrl` destinations
   before rendering; only HTTPS `/run` URLs without credentials, queries or
   fragments are accepted.
   Local-only demos use the same declaration; no hosting credentials are needed.

Add `.rer/demo/` to `.gitignore`. Run `rer demo`, open `RER_OPEN`, and try a
real public fetch and a send: both flows complete, and only the fetch leaves.

## Hosting the demo

`rer deploy --demo` publishes the seed at `demo.<domain>`. Turnstile admits a
visitor into their own native Worker Loader isolate and SQLite Durable Object
storage. The ordinary production Worker bundle is built once, with static files
served directly at the edge. While the visitor waits for the human check and
sign-in, the start page prefetches the console's hashed JS and CSS at idle
priority (at most 1 MiB compressed, the `deploy.operatorPath` views first; the
chunks are read from the build's Vite manifest, else its `build.assetsDir`), so
each view's first visit is served from the browser's cache. Those built chunks
are served `immutable` from the edge wherever the build put them. The visitor lands
signed in as the demo owner with sample data and `RER_DEMO=1`; account effects
remain simulated by the demo guard.
Each copy ends after 60 minutes or 15 idle minutes, or when the visitor signs
out (`POST /auth/signout`), when its storage is erased and the visitor sees the
ended page with "Start a new demo".

1. Adopt local demo mode above and the owner-claim endpoint. The hosted app must
   export its Worker entry and declare all resources in its Wrangler config.
2. Add `deploy-demo.json`: `{"version":1,"domain":"run-example.com","name":"Example"}`.
   Optional `maxInstances` limits concurrent visitors (default 10), `ownerEmail`
   sets the demo owner (default owner@demo.invalid), `runUrl` sets the canonical
   HTTPS `/run` chooser (default the declared run-site domain, then the demo
   domain), and `settings` contains plain
   demo settings. Secrets and front-owned settings cannot be supplied there.
3. Copy `run-demo.yml` to `.github/workflows/run-demo.yml`. It installs the seed's
   locked dependencies and invokes `rer deploy --demo`; Docker is unnecessary.
   Set `RUN_DEMO_DEPLOY=true` to deploy on pushes to main. The manual `test_only`
   input targets `demo.test.<domain>` in the separate `demo-test` environment,
   using Turnstile's always-passing test keys. It moves the declaration's domain
   to `test.<domain>` and every `settings` host under `demo.<domain>` (such as
   a `container.hostVariables` host like `page.demo.<domain>`) to the same name
   under `demo.test.<domain>`; production is unchanged. The existing run-site
   declaration keeps exits on the canonical site when the demo domain is scoped.
   An edition without a run-site declaration sets `runUrl` for a scoped test host. Test starts require the private
   measurement token, passed as `rer_demo_measure` cookie or
   `x-rer-demo-measurement` header. Do not commit that token.
4. In the `run-demo` GitHub environment, set `CLOUDFLARE_ACCOUNT_ID`,
   `TURNSTILE_SITE_KEY`, `CLOUDFLARE_API_TOKEN`, `TURNSTILE_SECRET_KEY`, and
   optionally `RER_DEMO_OPERATOR_TOKEN` and `RER_DEMO_MEASUREMENT_TOKEN`.
   Workers Paid and Worker Loader/Facets access are required; no Workers for
   Platforms subscription is needed. The deploy token needs Workers Scripts:
   Edit, Zone: Read and Workers Routes: Edit for the run site zone. New native
   hosts need no Containers permission.

`rer deploy --demo --dry-run` builds `.rer/demo-host/` with no provider requests.
The bundle excludes private local settings. Deploy waits for the custom-domain
certificate; the workflow also waits for DNS and the public start page.

### Upgrading an existing hosted demo

Pin the new rer and run the same workflow. The Worker id and custom hostname
stay the same. The deploy verifies the previous version's ownership record,
removes its Container application by exact id, detaches the retired binding
with the ownership annotation preserved, then emits a Durable Object
migration deleting `DemoContainer` and creating `NativeDemo`, retaining the
existing `DemoCapacity` namespace. Old visitor copies end during this upgrade;
new starts use native isolates. Interrupted deploys can be rerun. The token used
for this one transition must retain its existing Containers: Edit permission.
Retired sizing and mode keys in old declarations are consumed with a migration
notice; remove them from the declaration when next editing it.

### Removing a hosted demo

```sh
rer deploy --demo --remove --yes
rer deploy --demo --remove --yes --environment demo-test
```

For the test command, set the declaration's domain to `test.<domain>`, as the
workflow does. Removal needs only the Cloudflare account id and deploy token.
It deletes the exact Custom Domains and Worker covered by the deployment's
ownership record; the Worker's namespaces and visitor storage go with it. It
reads back their absence and a repeat is a no-op. An existing legacy Container
application is also removed when its namespace proves ownership. Unrelated
resources and host attachments are refused before any deletion.

### Seed bindings

The seed's Wrangler configuration supplies all D1s, R2 buckets, queues and local
DO classes. D1s and seed DOs get separate SQLite facets. R2 objects, their
metadata and multipart uploads are kept per binding in the visitor's own
Durable Object storage, next to the app, so file reads and writes answer from
where the visitor is; a visitor's objects may total 256 MiB, and a write past
that fails as R2 does for an oversized upload. Alarms deliver UTC crons and
durable queue batches with ack/retry, delays and dead letters. Expiry deletes
facets, queued work and R2 objects with the visitor's storage. Unsupported
bindings are refused by name at demo build. The Worker's build modules
(JavaScript, text, WebAssembly and data) load as a normal deploy uploads them;
a failed demo build prints its reason and file.

Hosts deployed by rer 0.2.30-0.2.33 kept every visitor's R2 objects in one
demo-owned bucket. The next `rer deploy --demo`, or a removal, empties and
deletes that bucket while the deployed Worker still proves it owns it.
