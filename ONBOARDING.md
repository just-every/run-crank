# Foundation setup adapter

First-party setup runs through `rer setup` (install `rer` once with
`npx -y @runeditrun/rer cli install`, or the installer script on the RER site:
`curl -fsSL https://runeditrun.com/install.sh | sh`). The public
command's flags, effects, state handling and exits are defined in
`SEED-COMMAND-CONTRACT.md`; use `RUN-LOCALLY.md` for the owner workflow. The
onboarding package supplies the shared lifecycle used by the command adapter.
It is not a separate first-party setup command.

## Edition-owned inputs

The foundation edition owns:

- `rer-setup.json`, the single source of setup fields, groups, defaults,
  managed secrets and ordered setup steps;
- `scripts/installer/local.mjs`, the declarative adapter for actual build,
  migration, start, health, owner, sign-in, deployment and portability behavior;
- `scripts/installer/ui/seed.mjs` and its background artwork, which describe
  the product presentation for setup surfaces;
- `src/branding.json`, which stores the app's actual name and color.

The current manifest collects `APP_NAME`, `PRIMARY_COLOR`, `OWNER_EMAIL`,
`SESSION_SECRET` and `SETUP_TOKEN`. The owner email is required; the local CLI
may prompt for it or accept the documented owner-email flag. Managed secrets
are kept private. The branding hook writes application values before the real
build; the owner-claim step uses the declared owner and setup-token fields.
Keep setup defaults factual and do not infer owner identity or credentials.

The adapter exports `install` and `commandAdapter`. The command adapter points
to the same root manifest and declares the real internal targets: build,
migrations, Vite development, production preview, verification, owner-account
deployment and local portability. Keep internal targets distinct from public
RER aliases to avoid recursive calls.

## Lifecycle and safety

RER validates answers before effects. Setup preserves an existing owner, data
and exact private settings on reruns; it does not create a second owner or
rotate secrets. It performs the real build and local migrations, prepares the
first owner through operator-auth.
The temporary local Worker stops before setup exits. Local tooling proves
installation ownership using the session secret, without sending mail.
Development and demo mail is silently suppressed.

The shared adapter lifecycle captures declared child commands, redacts
credential values from output and private logs, stops owned descendants on
failure or cancellation, and restores private settings after build. Adapter
hooks must use the shared command store for child work, report the actual
health endpoint, and preserve process cleanup. Never pass secrets as command
arguments, print generated values, or add sample providers or mock runtime
fallbacks.

Canonical local durable data is `.wrangler/state`; private settings and
installer records remain outside source control. State selection rejects
symlinks, unsafe overlap and ambiguous prior state. Preserve unclear bytes and
require explicit recovery. Local export/import uses the declared portability
policy, verifies archives and restores atomically into an empty destination.
Every first-party seed verifies a complete local export/import/export round
trip across supported resources. Remote transfer requires complete resource
coverage; unsupported targets fail visibly.

Preserve applied migration history. Make schema changes with forward
migrations and verify transition and recovery for existing data. The edition
owns its real resource names, migration choices, auth behavior, data policy
and deployment inputs. Keep authorization in every private server handler and
keep server-only secrets out of client bundles.

For command flags, reset inventory, transfer exclusions, account credentials,
managed foreground server lifecycle, and verification boundaries, follow
`RUN-LOCALLY.md` and `SEED-COMMAND-CONTRACT.md`. Local checks do not prove
provider delivery or hosted acceptance.
