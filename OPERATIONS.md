# Foundation operations

Run all first-party operations from the composed, runnable edition checkout
with `rer`. To get a runnable checkout, run `npx -y @runeditrun/rer dev just-every/run-crank` (set up only: `npx -y @runeditrun/rer setup just-every/run-crank`; without Node: `curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-crank`). Inside that checkout, `rer dev` alone launches it for review. The detailed flags and effects are in
`RUN-LOCALLY.md` and `SEED-COMMAND-CONTRACT.md`.

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Use the setup prompt instead of the owner-email flag when entering the real
mailbox. Follow the newest ordinary sign-in message in the printed local
outbox; no external email is sent. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

Use `rer describe` to inspect the checkout's actual
capabilities. `rer check --profile first-party` validates the
declared command contract; it does not run application journeys or contact a
provider.

## Local data and recovery

Setup and development use explicit owner identity and real local migrations.
Dev and preview use the same owner and canonical `.wrangler/state`; the local
development outbox is available only on loopback. Any process with access to
the machine can read that outbox and sign in as the owner. Private settings are
kept in `.dev.vars` with mode 0600 and are not copied into build output.

Local export creates a private archive with an integrity receipt and explicit
exclusions. The foundation has no product-domain tables or background jobs; an
edition's archive contains the supported domain tables and resources that its
adapter declares. Owner/auth, outbox, bookkeeping, private settings and
transient runtime state are excluded. Import validates and restores atomically
into an empty destination; confirmed reset preserves export archives. Run setup
after restore to establish a fresh owner. Each first-party seed verifies local
export/import/export equivalence across its supported resources. Remote transfer
is available only when the adapter declares complete resource coverage.

Preserve ambiguous state and applied migration history. Never place a remote
credential, owner secret or local resource ID in source. A schema change needs
a forward migration and verified transition/recovery.

## Deployment

`rer deploy --dry-run` validates the real owner-account
deployment declaration and builds locally without provider requests. Real
deployment requires privately supplied `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, the declared owner/session/setup secrets, and a real
verified mail sender in `deploy.json`. Follow the owner-account deploy-kit
instructions under `node_modules/@runeditrun/rer/modules/deploy-kit`; account scope,
resource ownership, migrations, receipt and health checks are defined there.
Local validation does not prove hosted acceptance, provider delivery or remote
health.

The sender is fixed in `deploy.json`: edit `vars.MAIL_PROVIDER` and
`vars.MAIL_FROM`, then commit that declaration. A shell `MAIL_FROM` value does
not replace `vars.MAIL_FROM`. Set a real sender on the selected provider's
verified domain. Required private inputs are `CLOUDFLARE_API_TOKEN`,
`OWNER_EMAIL`, `SESSION_SECRET`, `INSTALLATION_KEY`, `SETUP_TOKEN` and
`MAIL_API_KEY`; `CLOUDFLARE_ACCOUNT_ID` selects the account. The previous
installation key is optional. Keep private values outside the repository.
The hosted artifact declares `MAIL_FROM` as a public deployment input in
`packaging.json`.

## Hosted installation packaging

The seed-owned `packaging.json` declares the existing Worker, DB binding,
unchanged migration sources, recovery policy and setup manifest. Build with
`pnpm run build`, then regenerate the committed import projection with
`pnpm delivery:spec`. `pnpm check:deployment-spec` checks that projection
against the real build and policy during hosted verification.

`node scripts/delivery/base/cli.mjs package --config packaging.json --output rer-package`
produces the descriptor, dispatch-only Managed workflow and schema-2 artifact.
`node scripts/delivery/base/cli.mjs artifact --config packaging.json` produces
the later delivery artifact. Both output directories are disposable and ignored.

Local development keeps its private outbox. Hosted sign-in requires configured
mail: Managed hosting assigns the RER relay URL, sender and private installation
credential. Assisted hosting offers RER, Resend, SendGrid and Cloudflare with
the selected provider's sender and private credentials; Cloudflare also needs
its account ID. No local check establishes live provider delivery.

## Own Linux server: container platform

Crank selects the workerd engine in `deploy.json`. Its Worker uses one D1
binding (`DB`) on the installation volume and the `* * * * *` Cron pass for
schedules and durable continuations. It declares no KV, R2, Queue or Durable
Object binding. The qualification target is a 1 GiB app memory limit; this is
not a clean-host acceptance receipt. The maintained deployment command does not
set a memory limit: after installation, apply the chosen limit to the inspected
app container with `docker update --memory 1g --memory-swap 1g CONTAINER_ID`.
Repeat that operation after replacement. Do not infer a tested limit from the
engine declaration alone.

The owner provides a Linux host, Python 3, Docker access, an SSH account with a
private owned home, verified SSH host keys and a reachable owned HTTPS name.
The account must be able to run Docker. Build from this checkout, retaining its
pinned package and runtime versions:

```sh
rer build --platform container
rer deploy --platform container --host ssh://USER@HOST --env-file /private/crank-production.env
```

Use an owned regular mode-0600 settings file outside the repository. Set
`AUTH_ORIGIN` to the public HTTPS origin, `AUTH_LOCAL=false`, `OWNER_EMAIL`,
`SESSION_SECRET`, `INSTALLATION_KEY`, `SETUP_TOKEN`, and the selected mail
provider's `MAIL_PROVIDER`, `MAIL_FROM` and `MAIL_API_KEY`. Use fresh random
installation secrets and a verified sender; set `MAIL_RELAY_URL` or
`MAIL_ACCOUNT_ID` when that provider requires it. Keep the complete file private
and backed up separately from domain archives. Runtime settings override image
variables. Never send development keys, demo settings or local model keys to
deploy. `RER_SSH_IDENTITY` and `RER_SSH_KNOWN_HOSTS` select private SSH files;
the command retains strict host-key checking. Owner hosting, DNS, account and
mail-provider setup are owner steps.

The maintained installer transfers the exact image digest, installs app and
Caddy with `restart: unless-stopped`, and retains one writer per local data
volume. Caddy terminates TLS and is the app's trusted forwarding peer. Check
`/health` over HTTPS for `platform: container`, `container.engine: workerd` and
`deployment.versionId` equal to the installed image digest. An installation
without healthy dependencies is not ready. This production service has no dev
idle timeout.

For an upgrade, preserve the full project and environment identity and the
private settings, export or snapshot the data first, then build and repeat the
same deploy command. Same-identity replacement retains the volume and hashed
migration history. Never delete the data volume to repair a failed migration;
retain the previous image, settings and disk snapshot. Do not run a second
writer against the volume.

Local container backup uses `rer export --platform container` after stopping
preview, under the same exclusive volume lock. Import requires an empty
destination; restore workflows paused and credentials and receiving authority
inactive under DATA-001, then establish fresh owner authority and reconnect
providers before explicit publication. See `RUN-LOCALLY.md` for the commands.
The pinned CLI does not implement export from an SSH-host installation. Its
local-container export reads the checkout-named local volume, not the remote
server. Until a hosted export door exists, stop the inspected remote app and
retain an owner-managed disk snapshot plus private settings; do not claim that
snapshot is a portable `.rer` archive or import it as one.

Container native inbound email has no delivery adapter. TRIG-006 address
creation and rotation are refused with a Workers and Cloudflare Email Routing
requirement; existing inactive records remain inspectable and revocable.
Outbound sign-in mail still requires the chosen configured provider. No
container qualification establishes live owner-account deployment, clean-host
reboot recovery or any Workers enforcing-egress guarantee. SEC-002, HTTP-002,
TRIG-007, PLATFORM-001 and WORK-005 holds remain unchanged.
