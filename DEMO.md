# Demo mode: adopting `rer demo`

`rer demo` (the same as `rer dev --demo`) runs a throwaway copy, signed in
as the saved owner with realistic data. Its title and marked nav label read
`<Seed> Demo`; local dev reads `<Seed> Dev`. There is no injected bar or outbox.

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
   the document title suffix itself, including after client navigation.

Add `.rer/demo/` to `.gitignore`. Run `rer demo`, open `RER_OPEN`, and try a
real public fetch and a send: both flows complete, and only the fetch leaves.

## Hosting the demo

`rer deploy --demo` puts the demo on the web at `demo.<domain>` (the run site's
apex), so a visitor gets their own throwaway copy: the start page runs a
Turnstile check and starts it, and they land signed in as the owner, with the
seed's demo data and its Demo name. Each visitor gets their own Cloudflare
Container running this seed's image (`rer build --platform container`, workerd
engine) with `RER_DEMO=1` and public internet access, behind one front Worker
(`<project>-<environment>--demo`). The guard mocks account effects; egress
retains a small direct mail/SMS transport denylist. Only the visitor's random `rer_demo`
cookie (HttpOnly, Secure, SameSite=Lax, one hour) reaches their container. A
demo ends after 60 minutes, or 15 minutes with no requests; its container is
destroyed and its state deleted, and the visitor sees "This demo has ended".
Until then the container stays up however quiet the visitor is, and one that
stops early anyway also ends its demo and frees its place.
The demo image carries its databases already migrated. Each visitor copies that
prepared state, then gets a fresh owner, session and owner-dependent sample data.
The start page polls progress on the same copy; a slow start does not leave a
request waiting for minutes. Admission answers within 12 seconds, each progress
poll within two seconds, and a copy that cannot start within 45 seconds is ended.
A retry while it is starting resumes that copy without taking a second place.

Cloudflare prepares container capacity as demand grows. A temporary lack of
available instances can occur below `maxInstances`; it is not an account cap.
The host keeps the same visitor and reservation while requesting placement
within the existing startup budget. It repeats placement only when Cloudflare
explicitly reports that no instance is available, never after an application
boot or health failure. If placement remains unavailable, the visitor gets
"Every demo is in use right now" and the reservation is released.

At most `maxInstances` demos (10 unless set) run at once, and one IP starts at
most 3 a minute.
Mail is suppressed silently; all other effects follow the real/mocked policy above.

The seed needs, beyond the adoption above:

1. **`deploy-demo.json`** beside `deploy-site.json`:

   ```json
   { "version": 1, "domain": "run-lamp.com", "name": "Lamp" }
   ```

   Optional: `"maxInstances"`; `"instanceType"`, the Cloudflare Containers
   instance type every visitor's container runs on (`lite`, `basic`,
   `standard-1`, `standard-2`, `standard-3` or `standard-4`; `basic` unless
   set); and `"settings"`, plain demo settings for the
   container (never secrets, never `RER_*`, the origin, `OWNER_EMAIL`,
   `SESSION_SECRET` or `SETUP_TOKEN`, which the front sets). `deploy.json`
   must list `"container"` in `platforms`.

   A larger type starts a demo sooner and costs more for every minute a demo
   runs: Cloudflare bills a container's memory and disk as provisioned and
   its CPU as used. `standard-1` (1/2 vCPU, 4 GiB) costs about 4x `basic`
   (1/4 vCPU, 1 GiB) for memory, 2x for disk, and can use 2x its CPU;
   `standard-2` (1 vCPU, 6 GiB) costs about 6x for memory and can use 4x the
   CPU. `rer deploy --demo --dry-run` prints the type it plans. Rates are on
   Cloudflare's Containers pricing page.
2. **The signed owner claim.** The front signs the owner in with a
   five-minute claim to `/auth/owner-claim`, signed by a key pair made for
   that one container. The seed serves `modules/owner-claim`'s
   `createOwnerClaimHandler` there when `RER_OWNER_CLAIM_PUBLIC_KEYS` is set,
   with `RER_OWNER_CLAIM_ISSUER`, `RER_OWNER_CLAIM_INSTALLATION_ID`, its
   origin and `OWNER_EMAIL` (Base's default seed:
   `src/core/platform/auth/dependencies.server.ts`).
3. **The workflow.** Copy Base's `export/run-demo.yml` to
   `.github/workflows/run-demo.yml`. It deploys on each push to `main` only
   when the repository variable `RUN_DEMO_DEPLOY` is `true`, and whenever it
   is run by hand. Run by hand with `test_only`, it deploys a separate test
   host instead: environment `demo-test` at `demo.test.<domain>`, with
   Cloudflare's Turnstile test keys, which let every visitor start a demo
   (the 10-demo cap and the rate limit still apply). After a deploy it waits
   for the new hostname to resolve in public DNS (10 minutes at most) and for
   the start page to answer 200 (5 minutes more), then checks it sets no
   cookie; either wait ends with an error naming what did not happen.

`rer deploy --demo --dry-run` builds everything into `.rer/demo-host/` (add it
to `.gitignore`) with no provider request. The build first loads the seed's
Vite configuration, including any preparation it performs (for example,
generating `wrangler.toml` from `deploy/wrangler.template.toml`). It then checks
the configured Worker entry before compiling, and checks the emitted Worker
again before packaging. To try it locally with Docker, add
Cloudflare's always-passing Turnstile test secret to `.rer/demo-host/.dev.vars`
(`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`) and run, in that
folder, `wrangler dev --local-protocol https --var TURNSTILE_SITE_KEY:1x00000000000000000000AA`.
Wrangler serves the Worker as it is routed, so the Worker sees
`https://demo.<domain>`: point that name at `127.0.0.1` (for example in
`/etc/hosts`) and open `https://demo.<domain>:8787/`.

### Removing a hosted demo

```sh
rer deploy --demo --remove --yes                          # demo.<domain>
rer deploy --demo --remove --yes --environment demo-test  # with deploy-demo.json's domain set to test.<domain>
```

or run the workflow by hand with `remove` (and `test_only` for the test
host). It needs only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, the
deploy's token. It deletes what the demo's deploy made, each by its exact
provider id: the Custom Domain `demo.<domain>` (Cloudflare removes the DNS
record it added with it), the Container application `wrangler deploy` created
for the demo Worker's Durable Object namespace, and the front Worker, whose
Durable Objects go with it. The demo makes no D1, KV, R2 or queue. Then it
reads back that each is gone.

The deploy leaves its record on the provider, as the message of the Worker
version it uploads (`rer-demo:<hash>` of the Worker, hostname and container
names), so a fresh checkout or CI runner can remove it. Removal refuses before
any delete when the Worker of that name serves no such version, the hostname
routes to another Worker, a Container application of that name belongs to
another namespace, or another hostname is attached to the demo Worker; it
touches nothing else in the account. The Worker goes last, so a run that stops
part way leaves the record for the next run. Once the demo is gone, another
run finds nothing and changes nothing. A demo deployed by rer before 0.2.12
carries no record: deploy it once with this rer, then remove it.

### Owner steps

1. **Workers Paid** on the Cloudflare account that holds the run site
   (Containers are included; a visitor-hour on `basic` costs about one cent).
2. **A Turnstile widget** for `demo.<domain>` (managed mode). In the seed
   repository's `run-demo` GitHub environment, set the variable
   `TURNSTILE_SITE_KEY` and the secret `TURNSTILE_SECRET_KEY` from it, plus
   the variable `CLOUDFLARE_ACCOUNT_ID` and the secret `CLOUDFLARE_API_TOKEN`.
3. **The deploy token**: the run site's token (Workers Scripts: Edit; Zone:
   Read and Workers Routes: Edit on the run site zone) plus **Containers:
   Edit** on the account.
4. **`RUN_DEMO_DEPLOY=true`** as a repository variable when the demo should go
   live. Until then nothing deploys.
