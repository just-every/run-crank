# Run it locally

Install the `rer` command once using the [RER installer](https://runeditrun.com).
After the script or `npx` install, activate it in the current shell with
`export PATH="$HOME/.local/bin:$PATH"`. First-party commands fetch and verify
the exact pnpm version declared in `package.json` when it is missing, using
`$HOME/.rer/pnpm`; no global pnpm installation or sudo is needed.
Package-mode seeds pin an exact `@runeditrun/rer` devDependency. The checkout's `OPERATIONS.json` argv and `package.json` aliases select the version that `rer VERB` runs.

## Launch with one command

From a runnable edition's root, `rer dev` is the whole launch. It installs
locked dependencies when they are missing or older than the lockfile. On a
checkout that is not set up it sets up a local owner
(`owner@<checkout-name>.test`) and fills the setup answers the seed declares a
`localDefault` for in `rer-setup.json`. Then it starts the app and prints the
`RER_READY` lines. It never prompts and never re-runs setup on a checkout that
is set up. A required setup answer with no value and no `localDefault` stops it
with exit 3 and a message naming the field.

- **Port.** The first port from 8787 that is free on both `127.0.0.1` and `::1`
  and held by no registered server. Override with `rer dev --port N`; start the
  search elsewhere with `RER_DEV_PORT_FROM=N`.
- **Detaching.** Without a terminal (an agent's shell tool) `rer dev` returns once
  the app is ready and leaves it running in the background, printing its
  private log path; in a terminal it stays in the foreground and Ctrl-C stops
  it. `--detach` and `--foreground` override that.
- **Progress and resuming.** A first launch can take several minutes. It prints
  a progress line at least every 30 seconds (`progress` events with `--json`).
  If the calling command is killed the launch carries on; run `rer dev` again to
  reattach or to finish an install or setup that stopped. A second `rer dev`
  reprints the ready lines.
- **Server limit.** Up to 10 dev or preview servers run on one computer. Set
  `RER_SERVER_LIMIT=N` to change it.
- **Idle timeout.** A server stops after 12 hours (43200 seconds) without
  activity. Set `--idle-timeout SECONDS` or `RER_SERVER_IDLE_SECONDS=N` to change
  it.
- **Stopping.** `rer dev --stop` stops the server, and any launch still preparing.
- **The run site.** A seed that declares a run site also prints `RER_SITE URL`
  after the ready lines: its static marketing homepage, `/run` and docs, built
  from edition identity and served on the first free port above the app's. The
  app itself (`RER_READY`) is the installed instance: its `/` is the Lobby, with
  Sign in, or Finish setup until the owner confirms first-run setup.
  `rer build --site` writes the same site to its declared folder and names it;
  `rer deploy --site --dry-run` prints the site Worker, custom domains and www
  redirect it would create, with no provider request.

## Install for a real owner

To install with a real owner mailbox, run the verbs yourself from the runnable
edition's root: install locked dependencies, prepare its local owner, then start
development:

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
or acquisition fails, the command reports the required runtime and repair
action. Resolve that runtime requirement, then repeat the same `rer` verb.
Help, check, describe, doctor and stop do not select or acquire Node.
A runtime that has just verified also drops its stale `.quarantine-` copies and
Node's unused `include/` headers, which saves about 250 MB per Node release;
`rer doctor` lists what it could not remove. `rer doctor` also warns, without failing,
about Node releases, workerd versions and pnpm pins that checkouts running on
this computer set differently (each distinct pin keeps its own copy), and about
a checkout on another volume than your home folder, where pnpm cannot clone
packages from its store.

After `RER_READY`, a seed with dev identity normally prints `RER_SIGNED_IN EMAIL`
and `RER_OPEN URL`: open that URL on this computer and the app opens signed in
as the owner, at `/setup` until first-run is finished. With `rer dev --login`,
open the printed `RER_OPEN` URL at `/__dev/key`: it exchanges the fragment's dev
key for a cookie, then opens `/__dev/outbox`. Treat `RER_OPEN` as a credential;
do not share it. A fresh browser needs that exchange before the outbox can open.
For seeds without dev identity, open the printed `RER_SIGN_IN` URL directly.
In the outbox, follow the newest ordinary sign-in link and finish first-run setup
at `/setup`. Until first-run completion is stored durably, app routes send the
signed-in owner to `/setup`; signed-out visitors sign in and return there.
Once complete, `/setup` opens the app or settings. The local outbox sends no
external email.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes. Sign-in and dev-key
cookies are named for the port, so checkouts open side by side on different
ports in one browser each keep their own sign-in.

A first `rer setup` without `--port` saves the first free port from 8787 and prints
it in one line; it never saves a port another process listens on, on any
address. To move a checkout whose saved port is held by another checkout (or
by nothing), run `rer setup --port N` in it: only the saved
port changes, its data is kept, no reset is needed, and setup prints the old
and new port. A refusal for a busy port names the process or checkout that
holds it and gives that exact command with a free port.

Heavy work (install, setup, build, verify) waits in a machine-wide gate in
`~/.rer/jobs` when 3 jobs are running or available memory is at or below
2 GiB. Available memory is what the OS can
reclaim (macOS: free, inactive, speculative and purgeable pages from
`vm_stat`; Linux: `MemAvailable`), not the small "free" counter. A waiting
message gives the queue position, the jobs ahead with their checkout paths and
the available memory against the floor. Change the floor with
`RER_JOBS_MIN_FREE_MEMORY_BYTES` (bytes; 0 turns it off). `rer dev` and `rer preview`
never wait behind other checkouts' jobs; they start unless available memory is
below their own floor, described next.

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

For the real owner mailbox, `rer setup` can prompt instead of receiving
`--owner-email` on the command line. Setup builds the app, applies local
migrations, prepares the first owner, requests an ordinary sign-in message and
stops its temporary app before it exits. Existing owner data and private
settings are preserved on a repeated setup.

Dev starts the real local app with assets and HMR and prints `RER_READY URL`
after the application health check. With dev identity it then prints
`RER_SIGNED_IN EMAIL` and `RER_OPEN URL`. The `RER_OPEN` URL carries this
checkout's dev key in its fragment: opening it signs the browser in through a
real dev session, and the key is removed from the address bar and kept only as a
host-only cookie. Treat that line as a credential and open it only on this
computer. A dev-only badge switches between the owner, signed out and the
seed's personas (`admin@dev.localhost` and so on). `rer dev --as PERSONA` starts as
another persona or `signed-out`; `rer dev --login` turns dev identity off and uses
the outbox: it prints `RER_SIGN_IN URL` and a `RER_OPEN` URL that opens that
outbox. Choose the newest ordinary sign-in message and follow its link. No
external email is sent. A successful sign-in consumes the link once. Seeds
without dev identity print only `RER_SIGN_IN URL` for the local outbox.

Dev and preview are managed servers. In a terminal the first invocation stays
active while serving; without one, `rer dev` returns once the app is ready and
leaves it running (see the launch section above). Use `rer dev --stop` or
`rer preview --stop` to stop them; `--idle-timeout SECONDS`
sets inactivity cleanup. Compatible repeated starts reuse the registered
server, print readiness and exit. Preview serves fixed production output; dev
serves live source edits.
Both retain the same owner and `.wrangler/state`.

Both also run the project's Cron Triggers on their schedule, read from the same
files `rer check` reads for the deployed Worker (`wrangler.jsonc`, `wrangler.toml`,
a deploy template such as `deploy/wrangler.template.toml`). Each run prints one
`RER_SCHEDULED TIME "CRON" ok MSms` line. If two of those files declare different
schedules the server refuses to start and names both files; make them the same.

A server stops after 12 hours (43200 seconds) without activity, so one left
running overnight is still there in the morning. Start it with
`--idle-timeout SECONDS` (or set `RER_SERVER_IDLE_SECONDS`) to change that.

Up to 10 dev or preview servers run on one computer, so several seeds can run
side by side. At the limit a start is refused and the message lists the running
servers with the command that stops each; start with `RER_SERVER_LIMIT=N` to
allow more. Machine load alone never refuses a start or holds heavy work; a
fleet that wants a load guard sets `RER_SERVERS_LOAD_THRESHOLD=N` and
`RER_JOBS_LOAD_THRESHOLD=N` (the 1-minute load) in its own environment.

A new server is refused only when available memory is below 1.5 GiB. An idle
dev server holds about 0.5-1.3 GiB and a preview about 0.4-0.8 GiB. The message
gives the available memory, the floor and the running servers with their stop
commands; start with `RER_SERVERS_MIN_MEMORY_BYTES=N` (bytes; 0 turns it off) to
start anyway. Reusing a checkout's running server is never refused for memory.

Use the following operations as needed. Reset is destructive local cleanup;
export any data you need to keep before resetting. Export saves under
`exports/`: normalized relative paths such as `exports/x.rer` and
`./exports/x.rer`, and absolute paths inside this checkout's `exports/`, are
accepted. An absolute path outside the checkout is also accepted. Export
refuses other paths in the checkout, `..` segments, unsafe symlinks and any
path served by the app. Import requires an empty destination and `--yes`
confirms the restore.

For a local save, reset and restore, run these in order from the same checkout:

```sh
rer dev --stop
rer export --output exports/x.rer
rer reset --yes
rer import --input exports/x.rer --yes
rer setup --owner-email you@example.com
rer dev
```

Stop the running app so no operation can write during the backup. Export saves
its domain data before reset removes the local installation. Reset makes the
destination empty, as import requires. Import restores the saved domain data;
setup then establishes the owner and private local configuration excluded from
the archive. Start development to use the restored installation.

Other supported operations are `rer verify`, `rer deploy` and `rer describe`.

Use `rer dev --stop` or `rer preview --stop` (or Ctrl-C) before `rer build`,
`rer verify`, `rer reset` and data transfer. Reset removes only the
declared local inventory: local database/storage state, owner and sessions,
outbox, CLI and installer bookkeeping, and generated private settings. It
keeps source, dependencies, exports and deployment receipts. It refuses active
operations and ambiguous or linked state.

Local export creates a private archive with an integrity receipt and explicit
exclusions. Import validates the archive and restores into an empty destination.
After import, run setup to establish the owner and local configuration. Auth,
outbox, private settings and transient runtime state are excluded. Remote
transfer is unsupported by the maintained references and fails visibly.

Real deployment uses the owner-account procedure and its private credentials.
`rer deploy --dry-run` validates and builds locally without a
provider request. The default environment is `production`; select another with
`--environment NAME`. Local validation does not establish provider acceptance,
hosted health or mail delivery.

`rer describe` reads the current checkout's actual verbs,
flags, aliases, pins, effects and local state without installing or running
project commands. New verbs accept `--help`, `--cwd PATH`, `--non-interactive`
and `--json`. Setup also accepts `--owner-name`, `--port`, `--host`, a
private JSON `--answers FILE` and `--door`. Dev and preview accept `--port`,
`--host`, `--idle-timeout`, and `--stop`; dev also `--door` and `--direct`. Deploy accepts `--environment` and `--dry-run`;
export/import accept their target, file and restore options. `rer check` accepts
`--profile first-party`. Heavy commands accept `--no-queue` only when the
original caller has `CI=true`. Release retains its own compatibility flags.

Local durable state is `.wrangler/state`; CLI bookkeeping is `.rer/local`,
installer state is `.seed/installer`, and the default private settings file is
`.dev.vars` with mode 0600. Setup writes this checkout's dev key to
`.rer/local/dev-key.env` (mode 0600); a repeat setup keeps it and reset removes
it, which also ends every browser's earlier dev cookie. Dev sign-in, personas
and the development outbox answer only a request holding that key's cookie, so
a tunnel or local proxy to the app cannot reach them; anything else returns 404.
Any local user or process that can read the checkout can read the key and sign
in as the owner. `rer deploy` refuses the key, and `rer build` refuses output
that contains the dev layer.

The first-party command profile is optional for independently authored
projects. They may keep their own runtime, tools, installer, commands and
provider choices. RER executes only their declared operations and does not
impose Base pins, aliases, outbox or state layout.

## The front door (opt-in)

With the installed `rer` command, one process on one port can serve every
checkout on this computer at its own name, starting each on its first visit
and stopping it when idle:

```sh
rer door enable            # port 8700, 10 servers, 12 hours idle
rer door add ~/review/*    # register checkouts; prints each URL
```

`rer door enable --port N --server-limit N --idle-timeout S` changes the
policy. The door stores it with the `RER_*` variables in effect when you
enable it, and every checkout it starts runs with exactly those, whoever
starts the door later.

Each checkout is then at `http://NAME.localhost:8700`, where NAME is its
folder name (a second `cradle` becomes `cradle-2`); `http://localhost:8700`
lists them with their state. Opening a stopped checkout's URL in a browser
starts it (a page reloads once it is ready); images, scripts, API calls and
WebSockets never start one. A checkout the door started stops after the idle
time, and at the server limit the door stops its own least recently used one,
never a server you started with `rer dev`; when it cannot make room, the page
names what holds the limit. Each name is its own site, so sign-in cookies stay
apart. A name stays with its checkout: `rer door remove NAME` stops serving
it there but keeps the name reserved, and that checkout's next `rer dev` (or
`rer door add`) registers it again. A checkout you move or rename keeps its
name, address and sign-in: run `rer dev` (or `rer door add`) in its new folder.
A copy of a checkout gets a name of its own.

`rer door status` shows the door and every checkout; `--json` gives the same
as data and `--links` adds sign-in links that start a checkout and sign that
browser in. While the door is enabled, `rer dev` sets a fresh checkout up at
its door URL. An existing checkout moves with `rer dev --door`, which keeps its
data and changes only its saved address; `rer dev --direct` moves it back, and
`rer dev --port N` always serves directly at `http://127.0.0.1:N`. A checkout
whose pinned Base predates the door stays direct: the door lists it and a visit
to its door URL starts it and sends the browser to its own address.

Stay direct for a checkout that signs in through an external identity
provider (Google, Microsoft and others reject `*.localhost` callback
addresses). `rer door restart` drains and restarts the door: checkouts that
were starting finish starting, and open tabs reconnect. After a reboot or logout the door needs `rer door start` (or any
`rer dev` in a checkout that uses it); `rer door stop` and `rer door disable`
stop it and opt this computer out.
