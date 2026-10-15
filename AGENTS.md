# Agent instructions

## Launch for review

When asked to launch, run or review this app, run this from the checkout root
and nothing else:

```sh
rer dev
```

- It installs and sets up a fresh checkout by itself and prints progress; a
  first launch can take several minutes. Give the shell tool at least 10
  minutes. If the tool times out, run the same `rer dev` again: it resumes.
- Never run install, setup, reset or deploy for this, and never ask for an
  email, port, password or answers file.
- Give the owner the `RER_READY` address and the `RER_OPEN` link, and ask
  nothing. `RER_OPEN` is a credential: share it only with the owner, in this
  chat. A seed without dev identity prints `RER_SIGN_IN` (its local outbox)
  instead.
- Stop the app with `rer dev --stop`. If a start is refused, the message names
  the cause and the next command: run that command.

Without `rer` on PATH, install it once with `npx -y @runeditrun/rer cli install`
or the installer script: `curl -fsSL https://runeditrun.com/install.sh | sh`.
For the current shell, run `export PATH="$HOME/.local/bin:$PATH"` after installing.

## Run it locally

This guide ships with the runnable Crank seed. To install for a
real owner instead of a review launch, run the verbs yourself from that
edition's checkout root. `rer` runs each verb with this checkout's own pinned
package (`@runeditrun/rer`).

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner retrieves the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. It does not change global Node installations.
Set `RER_NODE_AUTO=0` to disable automatic selection. If selection is disabled
or acquisition fails, the command reports a repair invocation in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.
Help, check, describe, doctor and stop do not select or acquire Node.

After `RER_READY`, `dev` prints `RER_SIGNED_IN EMAIL` and `RER_OPEN URL`.
Open that URL on this computer: the app opens signed in as the owner and
finishes first-run setup at `/setup`. Treat the line as a credential.
`dev --as PERSONA` starts as a persona or signed out; `dev --login` prints
the outbox instead: follow its newest ordinary sign-in link. Until first-run
completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. The local outbox sends no external email.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes.

Missing non-interactive setup answers exit 3 and name the manifest fields.
Read `rer-setup.json` and pass a private, mode-0600 JSON object keyed by those
names using `rer setup --answers PATH --non-interactive`,
for example `{"OWNER_EMAIL":"owner@example.com"}`. Secret values stay in
private inputs and never go in command arguments. A setup rerun with the saved
owner and origin preserves existing owner/data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation; export domain data
first if it should be restored, and import only into an empty destination.

Queue waits report their reason and live position while the command waits. Package mode has no queue status command.

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner. With `dev --login`, open the outbox it prints, choose
the newest ordinary sign-in message and follow its link. No external email is
sent. Stop `dev` with
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

Reset removes declared local data and settings. Import requires an empty
destination and explicit confirmation. Read `RUN-LOCALLY.md` for supported
flags, private state, deployment inputs and remote limitations.

`pnpm typecheck` and `rer verify` use checkout-local, gitignored
`.cache/typecheck.tsbuildinfo`; deleting it forces a full check, while
`rer build` builds the real Worker and assets.

## Work on this foundation

Choose and verify the edition UX before adding product functionality. This
source includes minimal real owner/operator auth, D1 and local development
outbox mail. It has no product domain or background jobs.

When adding private HTTP routes or Start functions, reuse native sessions and
enforce authorization in every server function handler, including direct
transport calls; route guards alone are insufficient. Use server-only modules
and dynamic imports inside `createServerFn` handlers so secrets never enter the
client. Consult the pinned Base migration recipe and default-seed reference and
run equivalent direct unauthenticated transport checks.

Keep actual Queue/Cron handlers and named Worker exports in `src/server.ts`
when adding those capabilities. The dispatcher only selects HTTP ownership; it
does not authenticate or catch failures.

`setup` builds, applies auth/outbox migrations, prepares the explicit first
owner, checks an ordinary sign-in message and stops its temporary Worker. `dev`
serves actual Vite HMR with the same auth and data. Managed foreground servers
remain active in their first invocation; compatible repeated invocations reuse
the server and exit. Stop before build or verification.

`deploy --dry-run` validates and builds locally without provider requests. Real
owner-account deploy applies declared D1 migrations and checks health. Local
validation does not establish provider acceptance or remote health.

Read `ONBOARDING.md` before changing the edition-owned answer manifest, branding
or installer adapter. Keep `rer-setup.json` as the single setup manifest and
preserve the shared RER command path. The owner may change any source, core
schema, UI, framework or infrastructure. Preserve owner requirements and
applied migration history; choose any integration method and verify the result.
Roll useful implementations and tests into shared source where that supports
their maintenance.

Pinned reference: https://github.com/runeditrun/base/blob/fc0e1041efa55771142bbb57c4ab4743147e264d/TANSTACK-START-MIGRATION.md
Native-session/runtime evidence: https://github.com/runeditrun/base/tree/fc0e1041efa55771142bbb57c4ab4743147e264d/default-seed
