# Crank

Human-approved workflow automation. An incoming event becomes a visible run;
a person approves its exact body and destination before Crank sends anything.
Failed delivery gets one manual replay with the same idempotency key.

## Run it

```sh
git clone https://github.com/just-every/run-crank.git
cd run-crank
npx -y @runeditrun/rer@0.2.22 cli install
export PATH="$HOME/.local/bin:$PATH"
rer dev
```

Keep this terminal open. RER installs the pinned dependencies, selects Node
22.20.0, migrates local D1, and creates a local owner. Initial setup can take
several minutes. Open the **RER_OPEN** link it prints, confirm the owner on
**Finish setup**, and open **Flows**. That link is a credential; keep it private.
Local development mail stays in the local outbox; nothing is emailed externally.
If a command times out, repeat it to resume. Stop with `rer dev --stop`.

For an installation with your own owner email, run `rer install`, then
`rer setup --owner-email you@example.com` before `rer dev`. `rer dev --login`
uses an ordinary email sign-in link from the gated development outbox instead
of dev identity. `rer dev --as admin` and `--as member` open local role personas.

## Do the first jobs

In a second terminal in this checkout, start the included receiving application
(Node 22.20.0 or later is required for its SQLite storage):

```sh
npm exec --yes --package=node@22.20.0 -- node examples/inbox/server.mjs
```

Open `http://127.0.0.1:9051`. This is a separate **Operations inbox**, with real
messages persisted in `.rer/inbox/inbox.sqlite`. It binds only to loopback.
Stop it with Ctrl-C. It is a local receiving app, not a hosted service or a
replacement for your business apps.

1. In Crank, create **Support follow-up**, source **Support desk**, destination
   **Operations inbox**, URL `http://127.0.0.1:9051/events`. Select **Activate flow**.
2. Expand **Prepare a run**. Use event ID `ticket-1042` and input
   `{"customer":"Harbour Workshop","task":"Book a callback"}`. This manual
   preparation represents an event from your source; the authenticated webhook
   and agent commands below provide the automated source connection.
3. Inspect the input and destination, then **Approve and deliver**. The run
   shows the decision and delivery attempt. Refresh the inbox to see one message.
   A second submission with the same event ID and body returns the existing run;
   changed input under that ID is refused.
4. In the inbox, select **Pause receiving**. Prepare `ticket-1043`, then approve.
   Crank shows failed delivery. Resume the inbox, then select **Replay once** in
   Crank. Refresh the inbox: the event appears once. No second replay is available.
   Prepare another event and **Reject** it to leave a decision without delivery.
5. Open **Move in**, download its example, paste the JSON, and select **Dry run
   import**. Review the draft and **Approve import**. The journal records the
   approver and result. **Undo unused import** removes its draft. Activation,
   edits or runs prevent undo. See [the n8n shape and limits](docs/IMPORTING.md).
6. Open **Data** to download an archive. Restore only into an empty installation.
   To erase a run, pause its flow, open the completed run, and select **Erase run
   and its data**. The receiving app retains its existing effect.

## Connect a source or agent

In **Access**, create a flow-scoped **Trigger** credential for your sending app,
or an **Agent** credential for preparation. Save the one-time value in a regular,
mode-0600 file outside source control. Agents cannot activate flows, approve,
reject, replay, manage credentials, import, export or erase. Admins prepare;
members read. Invite people and deactivate access on the same page.

```sh
export CRANK_ORIGIN=http://127.0.0.1:8787 # use the actual RER_READY origin
export CRANK_TOKEN_FILE=/private/path/crank.token
node scripts/crank.mjs state
node scripts/crank.mjs prepare-flow flow.json
node scripts/crank.mjs prepare-run FLOW_ID event.json
node scripts/crank.mjs trigger FLOW_ID event.json
```

Use an agent token for `state` and preparation; a trigger token can only use
`trigger` for its one flow. `event.json` is
`{"event_id":"ticket-1044","input":{"customer":"Harbour Workshop"}}`.
`flow.json` has `name`, `source_app`, `destination_app`, and `target_url`.
The person then opens **Runs** to approve. [API contract](docs/API.md).

Tokens created with local dev identity also require the local dev gate. Save
the `rer-dev` fragment value from your private RER_OPEN link in another 0600
file and set `CRANK_DEV_KEY_FILE` to that file. Alternatively stop dev, start
`rer dev --login`, sign in through the outbox and mint a native credential.
Credentials are stored as hashes, revoked immediately, and excluded from archives.

## Export and restore

With the app stopped, these commands support archives larger than the browser's
small-archive interface:

```sh
rer export --output exports/crank.rer
# In a separate, empty clone, after rer install:
rer import --input exports/crank.rer --yes
rer setup --owner-email you@example.com
rer dev
```

The archive must be a regular private file (`chmod 600 exports/crank.rer`).
It includes workflow and move-in data, but no owners, sessions, tokens or private
configuration. Set up your destination owner and credentials again. Restored
flows are drafts; review before activation. Crank never dispatches on restore.
Erasure invalidates local snapshots and fences older archives on this installation.
When restoring an older backup elsewhere, supply a newer post-erasure archive:
`rer import --input exports/old.rer --journal exports/latest.rer --yes`.
Without that later journal, a new installation cannot know subsequent deletions.

## Deploy to your Cloudflare account

`rer deploy` builds and applies D1 migrations; it never runs tests. Keep the
project `automation/crank`, Worker `automation-crank`, package and D1 IDs intact.
No domain purchase is needed: the app can use its workers.dev address.

1. In `deploy.json`, set `vars.MAIL_FROM` to your verified Resend sender and
   add `vars.CRANK_TARGET_ORIGIN` with your receiver's exact HTTPS origin.
   The receiver must implement the contract below. If it requires a bearer
   secret, add `{"binding":"CRANK_TARGET_TOKEN","environment":"CRANK_TARGET_TOKEN"}`
   to `secrets`; supply it through the same-named environment variable.
2. Supply `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `OWNER_EMAIL`,
   `SESSION_SECRET`, `SETUP_TOKEN`, and `MAIL_API_KEY` through your private
   deployment environment. Never commit or paste their values. Use a Cloudflare
   account where you may create Workers and D1; project work here is restricted
   to the RunEditRun account. Use independently generated strong session/setup secrets.
3. Commit deployment configuration changes, then run:

   ```sh
   rer deploy --dry-run
   rer deploy
   ```

   Dry run validates and builds without provider calls. Real deploy reports the
   hosted address after health checks. Open it, sign in with the configured
   owner email, and complete setup. Your verified mail provider must deliver
   that link. Deployment credentials and a verified sender are owner-supplied.

Crank sends JSON to the declared destination origin only, without following
redirects. It sends `Idempotency-Key: <run-id>`. The receiver must atomically
retain that key and body digest with its effect, refuse different bytes under
the same key, and return JSON `{"id":"destination-id","idempotencyKey":"<run-id>"}`
on first delivery and duplicates. A timeout is uncertain, not proof of no effect.
Exactly-once effects depend on this receiver contract; arbitrary webhook APIs
are not compatible. Crank does not store third-party credentials or execute
arbitrary n8n code. Destination credentials live only in deployment bindings.

## Development

`rer verify` is the complete CI wall: build, typecheck, nine workflow HTTP tests,
runtime smoke, real email-link sign-in and a static-site HTTP journey, followed by Base's built-app checks.
Stop dev first. For a domain-only change run `pnpm run test:crank`.
There are no tests during build or deploy. See [ACCEPTANCE.md](ACCEPTANCE.md),
[source attribution](docs/SOURCES.md), and [the command contract](SEED-COMMAND-CONTRACT.md).
Owner guides are published on the run site at `/docs` and kept in [docs/](docs/GETTING-STARTED.md). Build the static homepage, `/run` and guides with `rer build --site`.

This is a public seed candidate; release review and a release tag are separate work.
