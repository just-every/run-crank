# Seed command contract 1

This is the required maintained command path for every first-party seed,
including Base's default seed and composed foundation editions. Independently
authored projects may use this CLI and installer, but RER does not require
either; owners keep their own supported operations and integration choices.

## Commands and flags

Run from the project root, or use `--cwd PATH`. Every new verb accepts `--help`, `--cwd PATH`, `--non-interactive` and `--json`. Help exits before tools, configuration, adapters or effects run. Unknown flags, missing flag values and invalid values fail before effects. A single `--` separator is accepted for package-script forwarding. Flags belong only to the verbs listed below; there is no catch-all pass-through in the first-party profile.

| Required verb | Additional flags | Successful end state |
| --- | --- | --- |
| `install` | `--no-queue` | Frozen dependency installation using the pinned pnpm and lockfile; no app setup, global tool changes or deployment. |
| `setup` | `--owner-email EMAIL`, `--owner-name NAME`, `--port P`, `--host HOST`, `--answers FILE`, `--door`, `--no-queue` | Manifest answers validated; real build, all local migrations, private settings and first owner prepared; temporary app stopped before exit. `--door` sets a fresh checkout up at its front-door origin `http://NAME.localhost:PORT` once `rer door enable` has run. |
| `dev` | `--detach`, `--foreground`, `--port P`, `--host HOST`, `--idle-timeout SECONDS`, `--stop`, `--as PERSONA`, `--login`, `--door`, `--direct`, `--demo`, `--no-queue` | Managed foreground development server with assets/HMR, health-gated readiness and the project's declared Cron Triggers run locally on their schedule (`commandAdapter` option `scheduled: false` turns that off). The Cron Triggers are read from every file the deployed-Worker check reads: `devIdentity.deployConfig` when declared, else `wrangler.jsonc`, `wrangler.json`, `wrangler.toml` (unless `generatedOutputs` lists it) and deploy templates such as `deploy/wrangler.template.toml`. Two of those files that both declare `triggers.crons` must declare the same ones, or the command refuses with one line naming both files and their crons. A seed declaring `devIdentity` opens signed in as the owner `rer setup` claimed; `--as` starts as another declared persona or `signed-out`, and `--login` turns dev identity off for the outbox sign-in. Other seeds keep the ordinary outbox sign-in. A checkout whose saved origin is a front-door origin serves on `127.0.0.1` behind the machine's door; `--door` moves a direct checkout there and `--direct` moves it back, rewriting only the saved origin; `--port` and `--host` always serve directly. `--demo` (also spelled `rer demo`) serves a throwaway demo on fresh state in `.rer/demo/START/` (deleted when it stops: `--stop`, Ctrl-C, or its end, one hour by default or `--idle-timeout`), signed in as the saved owner, with the seed's demo data and nothing sent; see `DEMO.md`. |
| `preview` | `--port P`, `--host HOST`, `--idle-timeout SECONDS`, `--stop`, `--detach`, `--foreground`, `--no-queue` | Managed production output; `--detach` returns after actual health/outbox readiness, leaving the server running until `--stop` or idle timeout. `--foreground` stays serving. Changes to built assets refresh the manifest and ETags; no source rebuild runs. Same owner and canonical durable state, and the same local Cron Triggers as `dev` (the seed's `preview` target receives `scheduled: true` and must start its runtime with Miniflare's trigger handler, `unsafeTriggerHandlers`, which the shared `previewTarget` does). |
| `build` | `--site`, `--no-queue` | With `--site`, the static run site (see Installed homepage and run site) written to the declared folder, checked and named in the output; a seed without a declared run site refuses with exit 4 before any effect. Otherwise: real production Worker/assets built with private local settings excluded, then restored exactly. A `devIdentity` seed's build fails with exit 4, naming the file, when its output contains the dev layer's marker. |
| `verify` | `--no-queue` | The seed's complete verification command runs; it never calls its own public `verify` alias recursively. Then its production build is served on loopback as `rer deploy` hosts it (see Hosted assets and deploy identity); verify fails, listing each path, when a built file does not answer 200 or `/health` lacks the deploy identity. Then Chromium loads each public page of that served build and verify fails, naming the page, case, section and evidence, when page sections do not hydrate as separate units (see Hydration units). |
| `reset` | `--yes` | Explicitly confirmed local data, owner, generated settings and installer state removed; no remote effect. |
| `deploy` | `--environment NAME`, `--dry-run`, `--site`, `--no-queue` | With `--site`, the run site on its Base-generated site Worker (assets, plus the www-to-apex 301) with its custom domains (see Installed homepage and run site); with `--dry-run` it builds the site and prints the plan with zero provider requests. Otherwise: Base deploy-kit owner-account deployment plus health (the deploy identity, then one built file must answer 200); dry run validates/builds locally and makes zero provider requests. Default environment is `production`. Both refuse with exit 4, before building, a deploy binding, secret or secret source named `RER_DEV_KEY` or any key the adapter declares in `localOnlyKeys`; deploy-kit's owner plan refuses the same. A deploy that is not a dry run also refuses with exit 4, before building, tracked files with uncommitted changes, naming them. |
| `export` | `--target local\|remote`, `--output FILE`, `--origin URL`, `--session-file FILE`, `--no-queue` | Complete supported installation data written to a new owner-only archive, with integrity receipt and explicit exclusions. Default target is local; output is required. A declared `prepareData` hook runs first and the path is checked against the app's served folders after it, so a checkout that never built still completes when its Vite configuration needs a file `prepareData` generates. |
| `import` | `--target local\|remote`, `--input FILE`, `--journal FILE`, `--origin URL`, `--session-file FILE`, `--yes`, `--legacy-v1`, `--acknowledge-unverified-metadata`, `--output FILE`, `--no-queue` | Archive validated and atomically restored into an empty destination under the product's restore policy; input and confirmation are required. Normal import requires v2; `--journal` (local only) names a later archive of the same installation, whose erasure journal also fences the restore. Backup-only local Workers v1 recovery requires both legacy flags and a new v2 output; it refuses `--journal` rather than ignoring it. See modules/portability/README.md#backup-only-v1-recovery. A declared `prepareData` hook runs first, so a copy that never ran setup or build can import. |
| `outbox` | `--port P`, `--host HOST`, `--owner-email EMAIL`, `--open` | Prints the running local app's `/__dev/outbox` URL (and, for a `devIdentity` seed, its `RER_OPEN` key-exchange URL). An explicit owner email requests a fresh ordinary sign-in message. Browser opening requires `--open`. |
| `doctor` | none | Read-only tool/version, local configuration and state-placement diagnostics, naming missing inputs and their documented sources, plus `warnings` for leftover Node quarantine copies, mismatched Node/pnpm/workerd pins across running checkouts and a checkout on another volume (warnings never change the exit code). No provider request. |
| `describe` | none | Describes commands, flags, aliases, effects, pins and state without installing or executing project commands. |
| `check` | `--profile first-party` | Read-only structural contract/operations validation, including required hooks, flags, aliases and pins. No credentials needed for a fresh clone. |
| `release` | existing `--repo`, `--project`, `--repository`, `--output`, `--ref`, `--dry-run`, `--tag [vVERSION]`, `--clean-history`, `--onto`, `--env-file`, `--no-queue` | Existing Base release behavior, receipts, validation, gates, local tags and exit codes preserved. |

`release` is the compatibility exception: preserve its existing parser, required `--repo`/`--output`, JSON receipt and exit codes; do not retrofit the new common flags or infer publishing identities. Root help may list the new commands. Release never pushes or deploys. Source inspection and locking remain edition-authoring commands, not another implementation in `rer`.

`--no-queue` is available only on the heavy commands that list it and only
when the original caller has `CI=true`. The actual descriptor is authoritative
for a given checkout.

Base default-seed and exported foundation typechecks in `verify` use checkout-local, gitignored `.cache/typecheck.tsbuildinfo` in the package; deleting it forces a full check, while `build` still builds the real Worker and assets.

`P` is a decimal integer 1–65535. An explicit occupied port fails; never silently choose another. Default port is the saved local port; a first `setup` with no `--port` saves the first free port from 8787 (free on every address, never a port another process listens on) and prints it in one line. `HOST` is exactly `127.0.0.1`, `localhost` or `::1`; default is saved host, otherwise `127.0.0.1`. Public/listen-all hosts fail. First setup saves the selected origin. Dev/preview/outbox overrides apply together to runtime bindings and never rewrite private settings. Setup refuses a conflicting saved owner or a changed host with an actionable reset/recovery instruction; it does not silently ignore flags. Setup with a different `--port` moves the checkout instead: only the saved port changes, data is kept, no reset is needed, and the old and new port are printed; a refusal for a busy port names the holder and gives the exact `rer setup --port N` command for a free port. Heavy commands wait in the machine-wide job gate (`~/.rer/jobs`) for a slot, load at or below 36 and available memory above 2 GiB (macOS free+inactive+speculative+purgeable pages, Linux `MemAvailable`); the waiting message gives position, the jobs ahead with their checkout paths and available memory against the floor, and `RER_JOBS_MIN_FREE_MEMORY_BYTES` changes the floor. `dev` never queues behind other checkouts' jobs. No automatic secret rotation; existing reviewed rotation APIs remain outside these public verbs.

First setup requires an owner email explicitly, through the manifest answers file, or through an interactive prompt showing any proposed git-email default. Non-interactive mode never silently claims the git identity. Email must be a valid plain mailbox, normalized consistently with mail/auth; never put it or secrets into a shell command. Owner name defaults to `Owner` unless supplied or declared by the manifest. `--answers` is a regular private JSON answer file using manifest names, not an environment file; conflicting flag/file values fail. Conditional required fields and seed-specific workspace answers come from `rer-setup.json`, never new seed-specific CLI flags. A manifest field may declare `localDefault` (a literal for a public field, `{"generate":"hex"|"base64"}` for an entered secret, or `{"from":"origin"}` for a url or text field, which takes the checkout's chosen local origin). Only the zero-setup launch, `rer dev` on a checkout that is not set up, fills an empty active field from it; explicit `rer setup` and `deploy` never do. Generated values go only into the checkout's 0600 private settings and are never printed or logged. Secrets are read privately from declared files/environment or asked privately, never accepted as CLI values or printed. `--non-interactive` means no stdin prompt/browser launch; missing answers exit 3. JSON also suppresses automatic browser opening and prompts.

Missing-answer errors name the missing manifest fields. An answers file is a
private mode-0600 JSON object keyed by those names, for example
`{"OWNER_EMAIL":"owner@example.com"}`, passed with
`rer setup --answers PATH --non-interactive`. Keep secret
values in declared private inputs.

Local setting names come from the seed's existing declarations: `commandAdapter.hooks.secrets.originKey` selects the saved origin, and the setup manifest's `owner-claim.emailField` selects the owner mailbox. Without an owner-claim step, `commandAdapter.input.names.email` selects the mailbox. Undeclared names default to `AUTH_ORIGIN` and `OWNER_EMAIL`. Setup preflight, dev/preview/outbox prerequisites and sign-in input, and doctor all use these same keys and the adapter's declared settings file/format. Native-auth seeds retain their own setting names; do not add duplicate aliases or redeclare the manifest's owner field in the adapter.

## Output and exits

Human dev output also prints one line `RER_SCHEDULED TIME "CRON" ok MSms` (or `failed (...)` / `skipped (...)`) per local Cron Trigger run, and `--json` a `scheduled` event, under `dev` and `preview` alike. Human dev/preview output includes exactly one line `RER_READY http://HOST:P` (IPv6 bracketed, no trailing slash) only after the real application health check succeeds. Then:

- **Dev identity** (a `devIdentity` seed's `dev` without `--login`): `RER_SIGNED_IN EMAIL` names the identity the browser will hold (the owner, or the `--as` persona; omitted for `--as signed-out`), then `RER_OPEN http://HOST:P/__dev/key#rer-dev=KEY&as=PERSONA`. Opening it signs the browser in.
- **Demo** (`dev --demo`): after the dev-identity lines, `RER_DEMO_ENDS_ON_STOP FOLDER` names the demo's own data folder, deleted when it stops. The JSON `ready` event carries `demo:{state,ends}`.
- **Outbox sign-in** (`--login`, `preview`, `outbox` and seeds without `devIdentity`): `RER_SIGN_IN http://HOST:P/__dev/outbox` identifies the local outbox. A `devIdentity` seed also prints `RER_OPEN http://HOST:P/__dev/key#rer-dev=KEY&next=%2F__dev%2Foutbox` for all three commands. Open `RER_OPEN` on this computer: it exchanges the fragment's key for a cookie, then opens the outbox. A fresh browser needs that exchange before the outbox can open. Seeds without `devIdentity` print only `RER_SIGN_IN`; open that URL directly. In the outbox, choose the newest sign-in message and follow its link; no email was sent.

**Why `RER_OPEN` may carry the key.** `RER_DEV_KEY` admits only this checkout's loopback runtime and is never a deploy binding, so the line hands the person at this terminal the same authority as reading `.rer/local/`. The key travels only in the URL fragment: browsers never send a fragment to a server, proxy or log, and the page removes it from the address bar before trading it, through a same-origin POST to `/__dev/key`, for a host-only `HttpOnly; SameSite=Strict; Path=/` cookie. It never appears in a query string, captured log (rer redacts it), JSON progress event or file outside `.rer/local/`. Treat the line as a credential: do not paste it into chats, tickets or another machine.

Setup prints `RER_SETUP_READY URL` and exits with no server left running; with dev identity it then says that `rer dev` opens the app signed in as the owner, otherwise it prints the sign-in instructions and `Next: rer dev`. Outbox prints `RER_SIGN_IN URL`; print neither message contents nor a token-bearing sign-in URL. Build/install/verify/reset/deploy/export/import print their verb, outcome and relevant safe path or URL. Dry-run deployment explicitly says no deployment occurred.

With `--json`, stdout is UTF-8 NDJSON only: `{version:1,verb,event,...}`. Bounded commands end in exactly one `event:"result"` with `ok` and `exitCode`; failures emit `event:"error"` with a stable `code`, safe `message` and `exitCode`. Dev/preview emits one `event:"ready"` with `url` and `signInUrl`; a `devIdentity` seed's event also carries `openUrl` and, for dev, `signedInAs` (an email, or null when signed out or using the outbox). Then comes its eventual result. Progress belongs in JSON events or redacted stderr. Never include values, cookies, generated settings, archives or token-bearing URLs; `openUrl` is the one deliberate exception, for the reason above. A declared-command result can include numeric `childExitCode` and signal.

`describe --json` is one object (the inspection exception to event streaming): `contractVersion:1`, `cliVersion` (the rer version this copy was exported from, recorded by Base's export tools; absent for a copy too old to record one), `profile:"first-party"|"independent"`, `defaults:{serverLimit,idleSeconds}` (what a `dev` or `preview` start applies when the person sets no `RER_SERVER_LIMIT`, `RER_SERVER_IDLE_SECONDS` or `--idle-timeout`), `pins:{node,pnpm}`, `verbs:{VERB:{flags:[FLAG],effects:TEXT}}`, `aliases:{ALIAS:VERB}`, and, for first-party, `local:{state:".wrangler/state",settings:[RELATIVE_FILE],installerState:".seed/installer",outbox:"/__dev/outbox",prepared:BOOLEAN,ownerSaved:BOOLEAN}` (`prepared` is true once local setup has completed: the private settings hold the owner, the origin and every required generated or supplied secret; `ownerSaved` is true once they hold the owner email, which a later setup keeps), plus `devIdentity:true,devKey:".rer/local/dev-key.env"` for a `devIdentity` seed. It must describe what the parser/adapter actually supports. `check --json` returns a result event with `clauses:[{id,ok,message?}]`; structural failures name the missing verb/flag/alias/pin and how to fix it. Use clause IDs SC-01 through SC-12 below, with more specific subclauses allowed.

| Code | First-party/new CLI meaning |
| --- | --- |
| 0 | Success, help or completed read-only check. |
| 1 | Executed command/test/health/transfer failed, or contract check failed. |
| 2 | Invalid invocation, flag/value, malformed descriptor or answer/archive syntax. |
| 3 | Missing setup answer, prerequisite/tool version, configuration, authentication or input file. |
| 4 | Safety refusal: unconfirmed reset/import, unsafe state/path/host, occupied requested port, conflicting saved identity, active local operation, unsupported capability, a build holding the dev layer, a local-only deploy key, an archive holding dev sessions or dev-minted credentials, or dev identity beside a managed installation. |
| 130 / 143 | SIGINT / SIGTERM after owned children stop and private files recover. |

Release keeps 0 success, 1 BLOCKED receipt, 2 failed argument/source/artifact validation. Independent declared commands preserve their child's exit status and signal conventions; wrapper validation uses the new CLI codes. An error in the requested operation is never success with a warning. Dev's optional run site privacy refusal is a warning while the app continues (see below). Check is structural; doctor is environment-dependent; neither claims app acceptance or remote health.

## Local sign-in and state

All first-party local runs use Base mail's development provider and `/__dev/outbox`. No external mail credential, static session, sample owner or email-provider fallback. Setup builds/migrates, briefly starts the app through the shared runner, claims its first owner through operator-auth with the private one-use setup token, requests an ordinary sign-in message, checks it reached the outbox, then stops the app. An already-claimed owner and data survive setup; it must not create a second owner or rotate secrets. These setup and dev requests carry the CLI's `x-rer-local-cli` proof (HMAC-SHA256 of `local-cli\0sign-in` keyed by `SESSION_SECRET`, supplied by the shared adapter and honoured by operator-auth only in local mode), so restarts never spend the owner's sign-in rate limit; a person's requests and any non-local server still count. HTML forms use POST before hydration.

**No built-in routes or private files on the public listener.** For every seed, nothing the local runtime serves under `/cdn-cgi/*` (Wrangler's and the Cloudflare Vite plugin's Local Explorer, the scheduled and email trigger handlers, the R2 and platform proxies) answers on the port a person or proxy reaches, and neither do the checkout's private folders (`.rer`, `.seed`, `.wrangler`, `.dev.vars*`) or export archives (the `exports/` folder and any `*.rer` file). rer starts every runtime with `X_LOCAL_EXPLORER=false`, setup's temporary app runs without trigger handlers (preview's runtime has them only when the project declares Cron Triggers, on the internal port), rer's public listener answers 404 for those paths, and rer's scheduler calls the runtime's internal port. `rer export` refuses an `--output` the dev server would still serve: save archives at a normalized path inside the checkout's `exports/` (`exports/x.rer`, `./exports/x.rer` or an absolute path there), or at an absolute path outside the checkout. Outputs elsewhere in the checkout are refused, including public, source and build folders; so are `..` segments, unsafe symlinks and any path served by the app. Upstream connection failures, including while setup is building its app, answer the same 404 as private-path refusals. All three local runtimes (dev, preview and setup) bind a separate loopback port behind this same proxy. The listener answers only its own hosts: a request whose `Host` is not loopback (`127.0.0.1`, `localhost`, `[::1]`), a `*.localhost` name or the configured origin's host gets a plain `421` (`This local server answers only its own host.`) and never reaches the app, so an auth check that throws on a foreign Host (operator-auth's `getSession` throws `invalid_host`) can no longer answer with a crash page and stack trace. Vite's `/@fs/<absolute path>` answers only a request holding the checkout's dev key (the key gate's `x-rer-dev-key` header or `rer_dev_gate_<port>` cookie); any other `/@fs` request gets 404 whatever the path, so Vite's refusal page, which lists its serving allow list with the checkout and home directory paths, never answers it. Every seed build must use `archiveOutputGuard()` from the shared onboarding `archive-output.mjs` in its Vite plugins: after public assets and bundles are written, it refuses `*.rer` files and portability archive manifests under any filename, including custom output directories. A seed whose own export writes another format declares it: `archiveOutputGuard({ formats: ['runeditrun/pencil-local-data.v1'] })` also refuses any built file whose leading JSON object carries one of those `payload.format` strings; a seed that declares nothing is checked as before. The shared lifecycle also checks `dist/` before setup can start its temporary app. A seed's Vite config limits `server.fs.allow` to the folders the app is built from (`src`, `public`, `node_modules`) so nothing else in the checkout is served.

**The key gate** (a `devIdentity` seed). A tunnel or local reverse proxy makes remote requests look local, so the loopback origin is not a guard. For a `devIdentity` seed, `rer setup` writes a random `RER_DEV_KEY` (32 random bytes) per checkout to `.rer/local/dev-key.env` (directory 0700, file 0600); a repeat setup keeps its bytes, `rer reset --yes` removes it and the next setup makes a new one. Only local runtimes receive it: Vite's dev server, setup's temporary app and preview. Opening `RER_OPEN` trades it for the gate cookie. Dev sign-in, persona switching, `/__dev/personas`, `/__dev/outbox` and tests' `signInAs` need that cookie (or, for the CLI and test harnesses, the key in an `x-rer-dev-key` header); without it each answers 404, through any proxy. A cookie from before a reset is refused. A runtime without the key binding serves none of them.

**Dev identity** (`commandAdapter.devIdentity`). The operator-auth `dev` layer, server-only in its own directory, serves `/auth/dev/enter?as=PERSONA`, which creates or reuses a real `oa_sessions` row of kind `dev` for the owner `rer setup` claimed, or for a persona, so version fences, revocation and deactivation behave exactly as in production. A dev session, and any credential minted while using one, is admitted only on a request that passes the key gate. Until first-run is finished the owner lands on `/setup`. The `owner` persona is the owner `rer setup` claimed while that owner is active; once that owner has left, it is the earliest-created active owner, and `rer dev` names that owner in `RER_SIGNED_IN`; with no active owner left, `rer dev` says so plainly and prints no `RER_SIGNED_IN`. `rer dev` also keeps its `RER_OPEN` link in `.rer/local/open-url` (mode 0600, inside the private `.rer/local`), which `rer reset --yes` removes with the rest of `.rer/local`; stdout, the JSON ready event and `RER_READY` are unchanged. A dev-only badge switches between `owner`, `signed-out` and the seed's `devPersonas()`: real operators at `<as>@dev.localhost`, created only by local dev sign-in. Export drops dev sessions and dev-minted credentials and marks personas suspended; import refuses an archive that holds either. Dev identity refuses to start when `RER_INSTALLATION_ID` is set beside a non-loopback `RER_MANAGEMENT_ORIGIN`. There is still no static session, sample owner or mail fallback: every dev session belongs to a real operator in the app's own database.

The seed loads the layer only through a local-only entry (a Vite-serve or local `wrangler dev` entry), never from the deployed main, and declares `devIdentity: {entry, output, emailLinkTest}`: `rer build` scans `output` and refuses any file containing the layer's marker, naming it. Each seed keeps **one end-to-end email-link test** (owner claimed, ordinary link mailed to the key-gated outbox, confirmation, signed-in session), so the email path stays proven while people use dev identity. `rer dev --login` turns dev identity off and uses that outbox sign-in, the same experience as seeds without `devIdentity`.

**Seeds without `devIdentity`** get no key: they keep the outbox guarded to the configured loopback origin and unavailable to a remote Host (a tunnel that rewrites Host to loopback passes that guard; the key gate is what closes it), and `rer dev` requests a fresh link for the saved owner before readiness and prints `RER_SIGN_IN …/__dev/outbox` unchanged.

HappyToHelp and Slate retain their own accounts, sessions and roles: their owner and sign-in hooks use their real auth while preserving first-owner idempotence, prior data and the same Base outbox experience. Base operator-auth identity reaches them only through an accounts adapter over their own tables. The foundation template includes a real minimal owner/auth/mail/D1 path. Owners may remove it only by deliberate divergence.

Canonical local durable data is `.wrangler/state/`, outside dist/build output. CLI bookkeeping is `.rer/local/`; installer drafts/logs are `.seed/installer/`; private settings default to `.dev.vars` (0600). An existing seed may explicitly inventory a retained private file such as `data/local-secrets.json`; it has the same custody/reset rules. Directories containing secrets are 0700. No symlink/traversal/overlap with source, exports, dependencies or build outputs is accepted as state. Preserve and report ambiguous legacy state; never silently adopt/move/delete it. Setup reruns keep exact existing private bytes, permissions and owner/data; builds preserve interrupted-operation recovery and credential exclusion.

Reset acquires the shared local lock and refuses while dev/installer/transfer owns the state. It lists exactly the removal inventory before confirmation. `--non-interactive` requires `--yes`; neither JSON nor non-interactive implies consent. Remove local D1/R2/KV/DO state, owners/sessions/outbox, `.rer/local/` (including the dev key, so earlier gate cookies stop working), `.seed/installer/`, and declared generated private settings/backups only. Keep Git/source/lockfiles, `rer-setup.json`, edition baselines, dependencies, owner export archives and `.rer/deploy/` receipts. Do not remove a broad `.wrangler`, `.rer`, `data` or checkout directory. A second confirmed reset succeeds with an empty inventory. A fresh setup then creates a fresh owner, with no previous domain rows or messages.

## First-run setup at /setup

Every first-party seed serves its owner's first-run setup at `/setup`: while setup is unfinished the signed-in owner completes it there (and any app route sends the owner to it); once finished, `/setup` takes the owner into the app (or to settings for later changes). Signed-out visitors are sent to sign-in and back. `rer setup`, dev identity and the outbox sign-in link return the owner to `/setup` until first-run is complete, and the README/AGENTS name it (owner, 10 Oct 2026).

First-run completion is stored durably; a setup rerun does not clear it.

## Seed theme

A first-party seed may declare one theme so the shared installer, sign-in confirmation, `/setup` and development outbox pages wear its look: a CSS file at the root of its served static directory (conventionally `public/rer-theme.css`) holding only `:root` `--rer-*` tokens (page, surface, text, muted, border, focus, optional accent pair, link, font stacks, radius, logo) and `@font-face` rules for font files the app serves. The app serves it at `/rer-theme.css` (a Worker that admits only listed static paths lists it). The installer seed descriptor names it as `theme: 'public/rer-theme.css'`; the Worker passes `/rer-theme.css` to operator-auth `branding.theme`, to `firstRunResponse(..., { theme })` and to the development outbox's `createDevelopmentOutboxHandler({ ..., theme })`. The installer refuses a theme outside that grammar, naming a file the app does not serve, or whose declared colours fail contrast (4.5:1 for text pairs, 3:1 for focus and borders). Without a theme the pages are unchanged. The package exposes its installer integration through `@runeditrun/rer/operator-installer`.

## Installed homepage and run site

The run site privacy check matches the saved owner's whole name and exact email
with word/mailbox boundaries, rather than treating them as fragments of other
words or addresses. Names keep the saved spelling and case; email matching is
case-insensitive. Names and emails are checked in every emitted file, including
binary assets, with those identifier boundaries preserved. Secret values and the
dev key still use literal matching in every file.
An exact owner identifier in a README/docs example still refuses `rer build
--site` with exit 4. During `rer dev`, that privacy refusal emits a warning
(`event: "warning", code: "site_private_data"` in JSON), omits `RER_SITE`, and
keeps the healthy app available at `RER_READY`; the refused output is never
served. Fix the example before building or publishing the run site. Other site
build failures remain errors.

Every first-party seed has two homepages. The **installed instance** (what `rer dev`, `rer preview` and the deployed Worker serve) answers `/` with the Lobby: the seed's lockup, one line about this installation, and one button, **Sign in** once the owner has confirmed first-run setup and **Finish setup** (to `/setup`) before that. A seed whose installed root is a public product page (a status page, a public form, a portal, a help centre) keeps that page at `/` and links Sign in from its header instead. Edition identity chooses which: `installedHome: 'lobby' | 'page'` in the seed's identity value (`EditionIdentity` from `foundation/runtime/identity.ts`, in an edition `src/base/identity.ts`), with its product name, this installation's name, its one-line purpose (`{deployment}` stands for the installation's name), its tagline, its sign-in route, its run site origin and its served theme, mark and optional floor art (`public/brand/band.svg`).

The Worker mounts two shared responses before its documents: `setupStateResponse(request, env, claimed)` from `foundation/runtime/setup-state.ts` answers `GET /setup/state` with exactly `{"state":"claimed"}` or `{"state":"unclaimed"}` (no session, no cookie, `no-store`, 405 for other methods, another origin or Host answered with the ordinary document 404), and `lobbyResponse(request, env, identity, claimed)` from `foundation/runtime/lobby.ts` renders the Lobby at `/` on the server from that same reading, with no JavaScript. `claimed` reads the seed's own first-run record (`claimedWhen('SELECT …')`); without it both read Base's `oa_first_run`. Neither reveals anything else.

The **run site** (`run-<seed>.com`) is static: the seed's approved homepage with its primary action reading **Run <Seed>** and linking to `/run`, the Run page at `/run` (install rer, then get the seed and start it with `rer dev`; `foundation/runtime/run-site.ts`), its docs at `/docs/*` when it serves docs, and a `404` page. It never links an instance-only route (`/signin`, `/login`, `/sign-in`, `/setup`, `/app`, `/auth/*`). A seed opts in with the `commandAdapter` option `site: { entry, output, declaration, config }`: `entry` is a module whose `sitePages({ styles })` returns `{ pages: [{ path, html }], assets: [paths under public/] }`. `rer build --site` builds it for Node with the checkout's own Vite (TypeScript, TSX, JSON and CSS imports work, and a React page renders with `renderToStaticMarkup`); the optional `config` names a Vite config holding the plugins the site pages need, such as a docs virtual module or a CSS toolchain (never the app's own `vite.config.ts`, whose Worker plugins do not run in Node). The CSS the entry's modules import compiles to one stylesheet under `/site-assets/`, with the files it references; `styles` lists its site path for each page to link in its head. `output` is the ignored folder `rer build --site` writes (`dist/site` in Base's seeds), with `/` as `index.html`, `/run` as `run.html` and `/docs/a` as `docs/a.html`; `declaration` is the run site deploy declaration, `{"version": 1, "domain": "<apex hostname>"}` (`deploy-site.json`). The build reads no installation data. Before replacing the folder it refuses a site without an index or Run page, with a link that does not resolve on Cloudflare's static assets or reaches an instance-only route, with a page or style that loads from another origin, with server code, Wrangler configuration, migrations, settings or data files, with the dev layer, or with any of the checkout's owner identity, secrets or dev key. `rer dev` builds and serves it as `RER_SITE`; `rer deploy --site` publishes it (see the deploy-kit README, Run site). A Worker that reads `deploy-site.json` in `vite dev` lists it in `server.fs.allow`.

**Deploying the run site from CI.** `rer deploy --site` keeps no state it depends on: it proves the site Worker and its Custom Domains are its own from the provider (the Worker's live version carries its `rer-site:` annotation; each domain's service is that Worker), so a fresh checkout, such as a GitHub Actions runner, deploys over the site it deployed before, and a Worker or domain of the same name it did not make is still refused. The www to apex 301 lives in the Base-generated site Worker, so the token needs only Workers Scripts: Edit on the account and Zone: Read and Workers Routes: Edit on the run site zone, with no Single Redirect permission. A seed's `.github/workflows/run-site.yml` runs, after `pnpm install --frozen-lockfile`, `pnpm exec rer deploy --site` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in its environment (vendored mode: `rer deploy --site`); `.rer/deploy/site-production.json` is a receipt for the person and needs no cache.

## Hosted assets and deploy identity

`rer deploy` uploads `dist/client/` behind the Worker (`assets.run_worker_first`), so the Worker sees every request first and a built file reaches the browser only when the Worker hands it to `env.ASSETS`. Make `staticAssetResponse(request, env)` from Base's `foundation/runtime/static-assets.ts` (in an edition, `src/base/static-assets.ts`) the first thing the Worker entry's `fetch` does, and return its answer when it is not null. It answers GET and HEAD for paths with a file extension from `env.ASSETS` (a built `.html` file too: when assets' `html_handling` answers `/guide.html` with a redirect to `/guide`, it follows that redirect inside `env.ASSETS` and returns the file with 200) and returns null on a miss, so app routes and documents keep their own handling; it never looks up dot paths (`.rer`, `.seed`, `.well-known`, `.dev.vars`), `/exports/`, `/__dev/` or `*.rer`. Declare `ASSETS?: Fetcher` in the seed's bindings type; TypeScript rejects the call until the type shares it. A seed that prerenders pages builds with the same routing, so `rer preview` serves them as deployed: give the Cloudflare Vite plugin `config: { assets: { binding: 'ASSETS', run_worker_first: true } }` for the build only (the reference's `vite.config.ts`; under `vite dev` the Worker would also take Vite's module requests). A prerendered page then reaches the browser as the Worker's document, with its `Cache-Control`, under preview as under deploy. The uploaded assets never hold `dist/client/.assetsignore` or any file its gitignore-style patterns name (the Cloudflare Vite plugin writes it with `wrangler.json` and `.dev.vars`): `rer deploy` and the delivery producer's artifact (`modules/delivery-producer`, a seed's `scripts/delivery/base/`) both leave them out, so `/.assetsignore` answers 404 when hosted.

Answer `/health` with `deploymentHealth(env)` from `foundation/runtime/deployment-health.ts` (`src/base/deployment-health.ts`): `{ok: true, deployment: {sourceSha, fingerprint, versionId}}` from the `RER_DEPLOY_SOURCE`, `RER_DEPLOY_FINGERPRINT` and `RER_VERSION` bindings the deploy kit sets. Spread it into a body that carries other fields (`{status: 'ok', ...deploymentHealth(env)}`) and run any readiness check first. Declare `RER_DEPLOY_SOURCE?: string`, `RER_DEPLOY_FINGERPRINT?: string` and `RER_VERSION?: { id: string }` in the bindings type too. `rer deploy` compares these three values with what it just deployed and exits 1 when they differ.

A seed's own deploy hook (the `commandAdapter` option `deploy`) returns `{deployed: true, origin}` once its upload is live (an https origin; rer refuses an http one off loopback before sending it anything), plus `setupToken`, the setup token its Worker holds, when that is not the `SETUP_TOKEN` rer passed it in the environment. `rer deploy` then waits until the origin's `/health` names the checkout's commit and claims the owner with that token, needing no deployment record from the hook. A hook that deploys with the kit under its own state file also returns that file as `state` (the kit's `deploy` result names it); rer then reads that record for every later step, so it issues, claims with and retires the setup token, and `--set-secret`, `--unset-secret` and `rer deploy --remove --yes` act on what the hook deployed.

Run `rer verify` after updating the exact `@runeditrun/rer` pin to a version that contains the check. After the seed's own verification it serves `dist/` in Miniflare from the seed's own Wrangler, with the deploy kit's asset setting, the deploy declaration's vars and origin variable (at an https origin), stand-in secrets and a generated deploy identity, applies the D1 migrations, then requests every built file except dot paths (built `.html` documents included, each by its own path), every same-origin file linked from the built HTML and the home page, and `/health`, and fails on any answer but 200. A secret's stand-in follows the setup manifest's kind or default; when that value is one the hosted app refuses (a `MAIL_PROVIDER` whose setup default `development` a deployed app answers 503 for), the secret item in the deploy declaration names a hosted-valid one, `{"binding": "MAIL_PROVIDER", "environment": "MAIL_PROVIDER", "verifyStandIn": "resend"}`. `verifyStandIn` is used only by this check: `rer deploy` never sends it, never plans or prints it and never makes it a secret value. It needs no network and no account. The declaration is the one `ownerDeploy` reads (`deploy.json`); a seed with its own deploy command names its file with the `commandAdapter` option `deployDeclaration` (for example `deployDeclaration: 'owner-deployment.json'`). `rer verify` includes the hosted-output check.

Start document responses send `Cache-Control` with `no-transform`, keeping their other directives (the reference's `uncachedStartResponse` sends `no-store, no-transform`). It stops any proxy rewriting the HTML React hydrates; Cloudflare's email address obfuscation honours it. Cloudflare documents that obfuscation does not apply to HTML a Worker generates, which is how `rer deploy` hosts every response. A Worker that proxies an origin on the same Cloudflare zone instead passes `fetch(url, { cf: { scrapeShield: false } })` on that subrequest, or the owner adds a Configuration Rule for the hostname with `email_obfuscation: false`. The deploy kit changes nothing for this.

## Package conversion and run-site adoption

Package mode pins the shared command implementation as an exact `@runeditrun/rer` devDependency. `rer check --profile first-party` checks the installed pin; keep seed-owned application and onboarding journeys and run them against that pin.

Small browser islands declare `site.clients`, a map of names to entries:

```ts
site: {
  entry: 'src/site/pages.tsx', output: 'dist/site', declaration: 'deploy-site.json',
  config: 'vite.site.config.ts',
  clients: { hero: 'src/site/hero.client.tsx' },
  clientConfig: 'vite.site.client.config.ts',
}
```

`sitePages({ styles, clients })` receives each emitted module URL, for example
`clients.hero`; link it with `<script type="module" src="…"></script>` on the
pages that use it. Browser modules and their reachable imports/assets are
bundled under `site-assets/`. `clientConfig` is optional, separate from the SSR
page config, and names browser plugins such as React; an external import still
reachable from an island refuses the build. No seed-specific client plugin is
needed. The rendered page's appearance and copy stay seed-owned.

Known targets at browser resource operations, including fetches, imports, DOM
URL writes and emitted CSS, are checked against the run-site boundary. Inert
URL construction/parsing and URL-shaped data are not resource use. Unresolved
runtime targets do not alone refuse the build: they appear in
`site.references.unresolved` with the emitted asset and operation kind, and in
the human-readable report. This adds no published asset and does not certify
unknown runtime targets; a known disallowed target or prefix still refuses.

Owner names/mailboxes already present in committed, unchanged source (matching
HEAD, Git index and working-tree bytes) are published examples and do not refuse
the site build. Untracked files, staged or dirty changes and private settings
cannot exempt an identifier. Secrets and dev keys are always refused, even if
committed. Without Git, identifiers remain private.
The Lobby stays script-free in dev; `RER_OPEN` and `dev --login` use the separate
`/__dev/key` document for key exchange, with its exact-hash CSP.

`export/run-site.yml` is the guarded push-to-main/manual deployment template:
**add it only when the per-seed gate holds**. Copy it to
`.github/workflows/run-site.yml` only after the seed's public-switch record,
owner-reviewed main page, source/run-page proof and deployment prerequisites
hold. The owner/orchestrator enables `RUN_SITE_DEPLOY=true` on the seed's public
repository at that gate. The template pins the Actions, installs the seed's
frozen rer pin, and checks the Run page and www redirect after deployment.
Copying the template alone does not enable deployment.

## Adopting Base's import, erasure, migration and dependency fixes

Each needs a Base refresh (vendored copies) or the rer pin that contains it.
Base's own `default-seed` shows every one in use.

### Erasing a person named in many imported records

`retireD1ImportCustody` costs a few statements per job, not per affected row,
when the people adapter implements the optional `redaction(db, destination,
fields)` scope (default-seed's `person-redaction.server.ts` is the reference):
300 reactions take one request, 3,000 too. Mark alternate identifiers
`optional: true` instead of dropping fields after `readD1ImportFieldMatches`.
When a person's values span more than about 150 imports, pass `{ resumable:
true, continuation }` as the fifth argument and, while the result's `phase` is
`redacting`, queue the next call with its `continuation` (default-seed's
`erasePerson` and its `redact` queue message); start native erasure only after
`complete`.

### Erasing a person who appears only inside someone else's record

Call `retireD1ImportCustody({ values, related: { fields } }, [], context,
checkpoint)` without a `target` for a person with no native record of their own,
such as a cancelled invitee on another invitee's booking: their fields leave
every source, effect, before-image and native row, originals holding them are
withdrawn, and the shared record keeps its resume and undo. Replace a seed's
`erasure_import_shared_source` refusal with this call.

### Importing files too large for one request

Replace the review/prepare pair with `prepareD1ImportSteps(source, mapping,
context)` called once per request until `reviewable`, then
`publishD1ImportPreparation(id, { ...context, reviewedFingerprint })` and
`resumeD1ImportStream` as before. Apply import-kit's
`d1PreparationStepsSchema` as a new numbered migration (default-seed's
`0021_import_preparation_steps.sql`, plus `0022_import_stream_sources.sql` for
its later `ik_d1_stream_sources` table) before refreshing, since erasure,
cancellation and replay read its tables. See the D1 README, "Preparation across requests".

### Shipping a reviewed rewrite of a released migration

Declare it in `migrations/rewrites.json`: `{ "version": 1, "rewrites": [{
"migration": "0019_import_custody.sql", "from": "<released SHA-256>", "to":
"<current SHA-256>", "reason": "...", "reviewed": true }] }`, and add a later
migration that converges databases that applied the released bytes. Deploy and
local runs then upgrade past it; anything else that changed in applied history
is still refused. Keep the record for as long as an installation may hold the
released digest.

### Seed table inventories and Base's tables

A seed inventory that refuses unknown tables skips the ones archives never
carry with portability's `excludedTable(name, policy)` (or the
`excludedTables` list), which includes `_rer_deploy_migrations` and the other
migration ledgers. Do not delete or rename those tables.

### Shared dependency fixes

Base's lockfiles resolve sharp 0.35.5, undici 7.29.1, source-map-js 1.2.2,
esbuild 0.25.12 and later, and playwright 1.63.0, and `pnpm audit` finds no
known advisory in them. Copy Base's `pnpm.overrides` for `sharp`, `undici` and
`@esbuild-kit/core-utils>esbuild` into the seed's root `package.json` (and any
vendored `mail` package), run `pnpm install`, and run the seed's suites. Base's
own suites showed no behaviour change from undici 7.29.1; Mango's one red
move-in journey on it did not reproduce.

## Hydration units

A mismatch between the server HTML and what React hydrates (an extension linking an address, a translator, a proxy rewrite) makes React client-render the nearest Suspense boundary; under TanStack Router that is everything under the root route, and the root route's own chrome is in no boundary at all. Seeds wrap every page section and the root chrome in `HydrationUnit`, mark one-time entrance animations with `data-intro` under the root's intro guard, hydrate through a `src/client.tsx` that passes `createRecoverableErrorHandler()`, keep addresses as lone text and send `no-transform` on documents. The convention and the adoption steps are in Base's `foundation/runtime/hydration/README.md` (in an edition, `src/base/hydration/README.md`).

`rer verify` checks it right after the hosted-output check, on the same served build at its https origin. Chromium answers every request from that serve and aborts external requests, so it needs no network, account, owner or setup. Each page is loaded with every application script held in the network layer until an in-page probe releases it, so its edits always land before hydration:

- a plain load (elements React replaces even then are excluded from later loads; any console error, page error or counted recovery fails);
- for each page section (an outermost `header`, `nav`, `section`, `article`, `aside` or `footer` in `<body>`), a text node beside siblings split and its second half wrapped in a span (an address linkifier), or a lone text node changed in place when the section has none, with scripts released after every one-shot animation has finished and, when the section holds an intro, at the midpoint of its intro;
- text beside sibling elements outside every section, split the same way;
- when the page shows an email address, its HTML rewritten as Cloudflare's email address obfuscation does, with the decoder running before hydration and with the anchors still present;
- a plain load with `prefers-reduced-motion: reduce`.

Verify fails when an element outside the edited section (or any section, for loose text; or outside the sections holding addresses) is replaced; a one-shot animation restarts more than two frames late or an animated element's opacity falls by more than 0.15 after rising; a frame lacks a section present at the edit; a rebuild comes with a console or page error, or without `window.__rerHydration.count` of at least 1; the document of a page React hydrates sends `Cache-Control` without `no-transform` (a redirect or a page React does not hydrate is not held to it); a one-shot animation runs under reduced motion; or the check was not exercised (an edit landed after hydration; React had hydrated before the probe released the held scripts, as when the client bundle is inlined in an inline module script the check cannot hold; a held script reached the page before that release; or no edit on a page with sections made React rebuild anything). A page's plain load fails on any console or page error or counted recovery. A plain-HTML page (React never hydrates it, it loads no application script and its plain load raises no error) is listed and skipped; a page that loads application scripts or raises an error and never hydrates fails, naming the scripts and the error. Application scripts are script requests to the page's own origin, module scripts and `modulepreload` links in the served document from any origin (client scripts on a CDN host are aborted like every external request, so such a page fails), and cross-origin module fetches the page starts; a third-party classic `<script src>` is not one. The result's `hydration` lists each page, its sections, its load count, its cases and advisories: text beside sibling elements that holds an email address, which never fails verify.

Pages are the page `/` answers, following same-origin redirects (at most five, so a signed-out `/` that redirects to `/sign-in` checks `/sign-in`), plus same-origin links on that page that answer 200 HTML without a session (following only a trailing-slash redirect), at most six. Name them instead with the `commandAdapter` option `publicPages` (for example `publicPages: ['/', '/docs/start']`). A check that loads no page (`/` answers an error or redirects to another origin, and no `publicPages` are declared) fails naming what it did not check, never passes. Verify prints each page with its loads or why it was skipped, each redirect followed and each link not checked; the result's `hydration` carries them as `pages`, `redirects` and `notChecked`. The check runs Chromium through the seed's own Playwright (`playwright-core`, `@playwright/test` or `playwright` resolved from its `package.json`); without one, or without its Chromium (`pnpm exec playwright install chromium`), verify fails naming what to install and never skips. `rer verify` includes the hydration check.

## Pins, aliases and responsibility

Package mode pins `@runeditrun/rer` exactly in `package.json` and `pnpm-lock.yaml`. After updating the pin, run `pnpm install --frozen-lockfile` and `rer check --profile first-party`.

Run package-mode checkout commands as `rer VERB`. Delivery operations and CI use `pnpm exec rer VERB` after the frozen install; heavy package scripts can use `rer queue NAME -- COMMAND`.

Required first-party pins: `.node-version` is `22.20.0`; `package.json.engines.node` is `22.20.0`; `packageManager` is `pnpm@10.12.4`. Keep any `.nvmrc`, CI/bootstrap and documentation declarations consistent. These are today's tested Base cloud-bootstrap/foundation pins, not a requirement for independent projects. Commands that execute project work select the exact Node pin, using an exact matching installed runtime or a checksum-verified user-cache copy at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on supported platforms, the runner retrieves the official release and verifies its SHA-256 against `SHASUMS256.txt`. The runner never changes global Node installations. `RER_NODE_AUTO=0` opts out; a failure reports the repair invocation `npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`. Help, check, describe, doctor and stop do not select or acquire Node. pnpm works the same way: when the person's PATH has no pnpm of the pinned version, commands that run project work use rer's own copy of the pinned pnpm, fetched once from the npm registry, its tarball checked against the registry's sha512 integrity before anything is extracted or run, and kept at `~/.rer/pnpm/pnpm-VERSION/`; only that rer command's PATH carries it, nothing global changes, and a PATH that already has the pin is used as it is. Doctor counts an already cached copy and never fetches one. Refresh lockfiles legitimately for pnpm 10 and retain the reviewed native-build allowlist (esbuild/workerd where needed).

Package-mode documents name the production command, `rer VERB`. The seed pins `@runeditrun/rer` as an exact devDependency locked in `pnpm-lock.yaml` (SC-13); OPERATIONS argv and package aliases use `rer VERB`, and delivery operations and CI call `pnpm exec rer VERB` after installation. Adapters import declared exports including `@runeditrun/rer/adapter`, `@runeditrun/rer/local-installer`, `@runeditrun/rer/operator-installer` and `@runeditrun/rer/deploy`. Heavy package scripts use `rer queue NAME -- COMMAND`.



Package scripts for `setup dev preview build verify reset deploy export import release outbox doctor describe check` use the package dispatcher: each value is the OPERATIONS argv (`["rer",VERB]`) joined by single spaces. Invoke them as `pnpm run VERB -- FLAGS`; use `pnpm run deploy`, not pnpm's built-in deploy. Never define a package `install` lifecycle script to launch `rer install`; `pnpm install --frozen-lockfile` is the dependency action. Provide `deps` (the same dispatcher with `install`) and `rer` (the dispatcher alone). Internal adapter targets use distinct names/files to prevent alias recursion.

Use OPERATIONS v2, preserving environmentSources and loops. Its `commands` declares every required verb with real argv, inputs and effects; inspector/CLI verbs still perform only their documented inspection. Opt in to the first-party profile with `seedContract:{version:1,profile:"first-party",adapter:"scripts/installer/local.mjs"}`. This is a small operations extension, not another configuration file or a second setup schema. An explicit `rer check --profile first-party` must enforce the profile even if its marker has been deleted; this flag is additional to check's common flags. References and generation tests must also require the marker. No package/edition presence alone makes an independent project first-party.

Each seed adapter exports `commandAdapter` alongside its installer integration:
declarative hooks and targets for dependencies, build, migrations, start,
health, owner, sign-in, verification, deploy and portability; state/settings
removal inventory; and the selected manifest. Reuse `localInstaller`,
`onboarding/commands.mjs` and `onboarding/local/` guarantees. The CLI owns
argument validation, profile resolution, locks/recovery, sequencing, pins,
captured/redacted child execution, health readiness, confirmation, JSON/exit
mapping and cleanup. The seed owns product answers, real resource
names/migrations, approved auth overrides, data policy and actual
build/dev/verify targets.

A seed whose build rewrites tracked-looking files that are not source (generated migrations, widget or download assets, route trees, delivery output) lists them in `commandAdapter.generatedOutputs`: project-relative files or directories, for example `generatedOutputs: ['.generated', 'public/widget.js']`. Preview's fixed-build receipt and its during-build check ignore exactly those paths and nothing else. A real source edited during the build is still refused with its file named, and an undeclared file the build rewrites is refused with a message naming it and this declaration. Without the declaration nothing changes.

A seed that must keep data `rer reset` would otherwise delete (legacy state still to be recovered, for example) declares `commandAdapter.resetPreflight`: an async function given `{ root }` that throws to refuse. Reset awaits it before showing its inventory or asking for confirmation, `--yes` does not skip it, and a refusal exits 4 with the thrown message and removes nothing.

Every first-party adapter selects one root `rer-setup.json` manifest. The CLI,
installer and deploy producer share its field selection and digest rules; do not
create a second setup schema. Every first-party seed proves local
export/import/export equivalence across all supported resources. Local
export/import must cover every supported resource. Remote transfer is optional
and requires complete resource coverage; an unsupported remote target fails
with exit 4 and names the missing capability.

A seed that imports people through Base import-kit erases a person from import custody with `retireD1ImportCustody({ target, values }, nativeStatements, context, checkpoint)`, not `eraseD1ImportTarget` alone: `target` is the native entity their records were imported into, `values` are their exact identifiers (an email, never a name, never matched as a substring), `nativeStatements` are the erasure module's `nativeStatements(entity, subject)`, and `checkpoint` is portability's `redactionStatements()` mapped through `toD1Sql`, so native rows, the portability fence, the restore checkpoint and import custody commit in one batch before `deleteBlobs`. Records become tombstones and other people's imports keep undo and resume; an import whose header equals a value is retired whole and answers `IMPORT_JOB_RETIRED` with its journal `receiptId`. Apply `d1RetirementSchema` as the next numbered migration after the other import-kit schemas (a seed that already applied it adds `d1RetirementAppendOnly` as its next migration), keep `ik_d1_erasure_journal` and `ik_d1_retirements` in archives, and read the journal with `readD1ErasureJournal`. An archive made before the erasure is refused whole under `--journal LATER_ARCHIVE` on a fresh store, even one that held the person only in import custody. The default seed's people imports (`src/core/features/people/`) are the reference adoption.

For shared imported records, pass `related: { fields: [{ path: ['reactions', '*', 'users', '*'], value: sourceUserId }] }` in that same `retireD1ImportCustody` call. Exact matching array items or object fields are removed; peer entries and explicit aggregate counts remain. Paths are relative to source payloads and effect/native values and apply to undo before-images too (the default seed uses `details.reactions.*.users.*`). The kit atomically sanitizes the adapter's imported native set, rebinds custody/provenance/decision hashes and fingerprints, withdraws affected original artifacts, and cancels destination private preparations; resume and undo use the sanitized retained data. Keep the same restore checkpoint and journal export policy. The adapter must enumerate and exactly fence its complete imported native set; the seed handles references elsewhere and filters erased identities on new source intake. Field selection requires an unbounded context, like other related erasure. Existing D1 erasure/retirement schemas suffice; no rer release or schema evolution is implied. See modules/import-kit/README.md#erasing-fields-in-retained-shared-records.

Erasure (`modules/erasure`) takes only its subject and costs time linear in its rows. A key column named like a `json_each` column (`id`, `key`, `value`...) is now qualified with its table when remembered rows are re-read, so one subject's erasure can no longer delete another subject's rows of an `id`-keyed table (or lose its re-read check). The first step orders the whole plan and queues what it leaves in `rer_erasure_scope` (no new table); each later step reads and verifies only its own slice, and one last step re-collects the graph from the subject and every remembered parent. A seed that carries an adapted copy of `plan.mjs` for this (Spool) drops it and re-records the byte-identical copy. Index the child columns an edge matches on, as foreign keys usually are.

`retireD1ImportCustody` refuses caller-supplied `nativeStatements` when the batch carries no checkpoint (`IMPORT_RETIREMENT_NATIVE_REQUIRES_CHECKPOINT`, before any write): only the checkpoint fences rows the kit does not count, such as another import's job. A seed that passes its native statements with the checkpoint, as the reference does, changes nothing.

Portability's `unbase64` validates in linear time with no recursion, so a store holding a binary cell or an R2 object of a few megabytes (the old validator overflowed its stack from about 4 MB) exports and restores. The seed's copy of `modules/portability/hash.mjs` is re-recorded; nothing else changes. A seed whose own code validates base64 with a repeated-group regular expression (Slate) replaces it the same way and repeats its large-original round trip.

Backup-only legacy recovery (`rer import --legacy-v1`) accepts a fresh installation: FTS5 shadow tables (`<index>_data|idx|content|docsize|config` of a `CREATE VIRTUAL TABLE ... USING fts5`) and the rows the destination's own migrations seed (compared with a scratch replay of the applied migrations) no longer make it `legacy_target_not_empty`; any other row, an added or edited seeded row, or a real row in the FTS5 index still does, and the same check is repeated inside the restore batch. A seed that carries a local recovery wrapper for this (Nook's `scripts/local/legacy-recovery.mjs`) drops it. A seeded table that the policy lists in `replaceableTables` is replaced by the restore as usual.

An import job is bound to the principal that created it, and its plan and fingerprint carry that principal, so a restored job cannot be rebound to the new owner's operator row. Give the import context a principal that survives a restore: the operator's role, not the operator's row id (`principalId: 'role:' + operator.role`, with the authority predicate checking that this operator is still active in that role). A restored installation's owner then undoes, resumes and reads the originals of the restored jobs, a different role cannot, and an archive never chooses a principal. The default seed's people imports are the reference adoption; a seed that binds jobs to operator ids (Penny's UserVoice imports) adopts the same change, and jobs created before it stay bound to their operator.

Independent projects without an adapter use `OPERATIONS.json` v2 `commands.NAME.argv`, `inputs`, effects, environmentSources and loops. Execute argv directly with shell false in the checkout, forwarding explicit arguments after `--` unchanged; never translate them into Cloudflare/pnpm/Base behavior. Common wrapper flags are consumed before the separator. No declared verb means exit 4, not an inferred command/fallback. Existing v1 inspection remains supported. Do not infer runnable commands from the platform registration descriptor's shell strings. No global pins, aliases, installer, outbox, state layout or required verb set is imposed on independent projects; runtime requirements remain project-owned. Independent check still validates the actual declaration and refuses missing/outside-checkout inputs.

## Acceptance clauses

- SC-01: required verbs, real flags, thin self-contained dispatcher and truthful describe output.
- SC-02: exact pins and public aliases, no lifecycle/built-in collision or recursion.
- SC-03: real manifest-driven setup, private custody, idempotent owner and failure recovery. Validate the selected dependency graph before effects; claim the native owner then pull-link selected dependencies. Declared idp claim mode completes the atomic provider owner grant before readiness. Blank optional dependencies preserve standalone email-link setup; unchanged links need no new approval. Link approvals are private, exact-origin and callback-set, one-use files, deleted after successful use. Multiple interfaces use the private `RER_LINK_TOKEN_FILES` interface-to-file map; each approval is validated before effects.
- SC-04: managed foreground development/HMR and fixed production preview, requested origin, health/outbox-gated ready output, intact public-input/output build reuse and descendant cleanup.
- SC-05: Base outbox and ordinary one-use sign-in with pre-hydration POST; no `/cdn-cgi/*` route or private checkout folder answering on the public listener; for a `devIdentity` seed, the per-checkout key gate on every local sign-in surface, real key-gated dev sessions and personas, a local-only entry whose layer `rer build` refuses in output, refused local-only deploy keys, dev data kept out of archives, and one end-to-end email-link test. `rer check --profile first-party` enforces the entry, the build exclusion and the declared email-link test (`SC-05.dev-identity.*`); it reads the deployed main from `devIdentity.deployConfig` when declared, else from `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` (skipping any the adapter lists in `generatedOutputs`), else from a deploy template such as `deploy/wrangler.template.toml`. Copies of Base's operator-auth layers that the seed records (`base-copies.json`, `composition.lock.json` or `foundation.lock.json`) stay byte-exact to their pinned Base revision and share one application, runtime and schema pin (`SC-05.auth-copy.pin`). `rer check` names each drifted, missing or unrecorded file (`SC-05.auth-copy.*`).
- SC-06: confirmed, contained, local-only reset and clean subsequent setup.
- SC-07: real build/verify and production preview, owner-account deploy/dry-run and unchanged release producer/receipt/exits; bounded expensive execution joins the shared queue. After deployment readiness, link selected dependencies to the real deployed origin using its own approval. Dry-run has no link effect; no additional public verb is introduced.
- SC-08: complete local export/import, integrity, empty-destination/confirmation and credential exclusions.
- SC-09: structural check rejects omissions, doctor names missing inputs, stable JSON and exits.
- SC-10: optional independent execution uses only declared argv, preserves child outcomes and forces no stack.

## Managed servers and bounded work

Dev and preview are managed servers with explicit stop and
idle-timeout controls. `--detach` returns after readiness and leaves the server
running; `--foreground` keeps the invocation active while serving. A
compatible repeated invocation verifies the registered live application,
emits its ready/outbox URLs and exits 0 without another build/sign-in. They
share one canonical-checkout slot;
symlink/cwd aliases share it, distinct worktrees do not. The other mode or an
explicitly conflicting host/port/timeout, or a different `--login` choice, refuses
with exit 4 and the correct stop instruction; `--as` only changes the printed
`RER_OPEN`, so it reuses a running dev server. Mode changes require stop then start. `--stop` is idempotent when
absent, needs no tools/settings/build, refuses another live mode, and rejects
start-only flags before effects.

Idle timeout precedence: explicit `--idle-timeout`, `RER_SERVER_IDLE_SECONDS`,
then 43200 seconds (12 hours). Positive integers only. The clock starts at readiness.
Application HTTP, assets and outbox activity reset it; active requests/streams
prevent expiry. Internal management/readiness probes and HMR control
traffic alone do not count. Real application WebSocket data messages do count.

Private registry: OS home `~/.rer/servers`, with `RER_SERVERS_DIR` override.
Combined cap: 10 servers per computer by default. Set `RER_SERVER_LIMIT=N`
(positive integer) to change it. Load is no guard by default; a fleet sets
`RER_SERVERS_LOAD_THRESHOLD=N` (the 1-minute load) in its own environment. Atomic reservations
precede ports/heavy work and count toward capacity. A start that sets
`RER_SERVER_LIMIT` is capped by that value, higher or lower, whatever running
servers recorded; a start that sets nothing is capped by the lowest limit a
running server's person set explicitly; a recorded default never lowers the cap. At capacity refuse 4 with a plain message giving
the count and the limit, each running server's checkout, mode, port and exact
stop command, and how to raise the limit; a load refusal states the load, the
threshold and how to override it. A
server is stopped only by its own checkout (explicit stop, idle timeout, signal),
never to make room for another, in any mode. A run that declares itself a test
or CI journey with `RER_SERVER_JOURNEY=1`, on its own free port, is neither
counted nor refused by the cap. Verify lifetime/process identities and health; preserve
foreign/unverifiable processes. Cleanup all owned descendants and private/state
custody before freeing records/ports; old generations cannot remove replacements.
Explicit stop/idle exit 0; child failure remains nonzero; INT/TERM retain
130/143. Starting duplicates wait boundedly and never announce a failing startup.

Preview serves real built Worker/assets/routes/private streams/404 with exactly
one workerd, no Vite/HMR, source/config watcher or automatic rebuild. Queue one
cache-miss build; reuse only when actual dirty/untracked/shared/copied runtime,
config/lock/tool inputs and intact output bytes match a nonsecret `.rer/local`
receipt. Never hash private settings. Missing/corrupt/interrupted output or an
input change during build invalidates certification. Require ordinary prior
setup/migrations; missing prerequisites name `rer setup` and exit 3. Preserve
private bytes/modes, owner, origin overrides and canonical `.wrangler/state`
D1/R2/KV/DO. Request fresh ordinary sign-in and verify health/outbox before ready.

Heavy install/build/verify targets, directly documented browser suites and
indirect/generated scripts use the exported dependency-free Base job queue module.
Setup uses the shared RER installer lifecycle for build, migrations and a
bounded temporary runtime. Dev/preview queue finite preparation; managed serving uses the server
cap and never outlives a released job as its descendant. Deploy queues local
build/validation including zero-provider dry run; release queues expensive steps
without changing its producer/parser/receipt/exits except adding `--no-queue`.
Export/import queues local resource runtime work. Help/describe/check/doctor,
outbox URL, stop and reset inventory/removal stay light.

Labels identify the declared project, initiating verb/phase and safe checkout
identity without credential remotes or secrets. Status/waits are human progress,
valid JSON events or redacted stderr. Human queue waits report immediately with
a reason and numeric one-based position, then refresh about every 15 seconds.
Package mode has no queue status command; a waiting command reports its live position.
Nested commands share only validated live
owned membership, never a boolean bypass; slots=1 works. Queue cancellation
removes pending work; admitted cancellation stops owned children and restores
private files before releasing the lease. Queue/state locks cannot deadlock.
Original-caller `CI=true` skips queue admission. Heavy-capable verbs alone accept
`--no-queue`, only with original `CI=true`; other use fails 2 before effects.
`CI=false`/unset queue. Synthesized install child CI cannot change the original
policy. Independent commands preserve their declared argv/stack and outcomes.

- SC-11: canonical managed foreground server lifecycle, real request activity,
  exact idle/stop/cap defaults, identity-safe crash recovery and deterministic
  cross-process admission, with complete cleanup before reuse.
- SC-12: real queue coverage of every bounded expensive path, portable
  dependency-free sources, safe labels/output, validated nested membership,
  original CI policy, cancellation/custody and light inspection boundaries.

## First-party agent instructions and current entry points

Every first-party `AGENTS.md` opens, directly under its title, with a short
`Launch for review` section, in place of the earlier `Run it locally` recipe;
`CLAUDE.md` is exactly `@AGENTS.md`. The section tells an agent asked to
launch, run or review the app to run `rer dev` from the checkout root and
nothing else: it installs and sets up a fresh checkout by itself and prints
progress, so the shell tool gets at least 10 minutes, and a timed-out call is
resumed by running the same `rer dev` again. The agent never runs install,
setup, reset or deploy for a review and never asks for an email, port, password
or answers file. It gives the owner the `RER_READY` address and the `RER_OPEN`
link (a credential, shared only with the owner in that chat) and asks nothing.
It stops the app with `rer dev --stop` and, on a refusal, runs the next command
the message names. One line tells a reader without `rer` to run
`npx -y @runeditrun/rer cli install` or the installer script on the RER site.
Base's `export/AGENTS.md` holds the current wording; keep the section under
about 25 lines.

Below it, show the commands for a real owner installation from a runnable
edition root:

```sh
rer install
rer setup --owner-email you@example.com
rer dev
```

Explain how to enter the real owner mailbox through the setup prompt or an
approved flag, then open the app: a `devIdentity` seed's `dev` prints
`RER_OPEN`, which opens it signed in as the owner (`--as` and `--login`
change that); other seeds sign in through the local outbox URL printed by
`dev`, using the newest ordinary sign-in message. State whether external mail is sent
and preserve the actual local auth and data requirements. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification. Then show the current
verification, reset, transfer, deployment and description commands:

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

Document the actual flags, effects and cautions for each operation.

Base's root guide directs maintainers into its runnable first-party seed.
Composed foundation input becomes runnable after composition, and its agent
guide runs from that edition checkout. Describe managed foreground server
behavior and compatible repeat invocations according to the current command
contract.

Maintain first-party documents and entry points as current guidance. Remove
superseded setup, dev, install, reset, deploy and verify wrappers and
instructions, including descriptions of earlier flows. Keep the commands and
behavior the RER CLI actually uses, and retain real product, architecture,
authentication, data, security and deployment requirements. RER adoption stays
optional for independently authored projects.
