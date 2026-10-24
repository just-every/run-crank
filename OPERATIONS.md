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
