# Move n8n workflows into Crank

Crank supports a deliberately narrow n8n JSON export: a POST Webhook connected
directly to one HTTP Request that forwards the complete incoming JSON body.
The import creates draft flows. Review the new Crank webhook address and activate
each draft explicitly before sending events. Source workflow activation does not
activate a Crank flow. Importing never executes a workflow or sends an HTTP request.

## Review and move in

1. Sign in as an owner and open **Move in** (`/app/import`). Select
   **Download the documented-shape example** if you want to inspect the accepted
   format first. The example targets the local Operations inbox; it is not a
   customer export.
2. Paste your export into **Workflow export JSON** and select **Upload and
   plan**. Crank uploads the original bytes to Base's shared import door and
   plans them. Planning changes no data.
3. On **Review before importing**, check the counts (new, replaced, unchanged,
   gone from the source), any rejected or noted records and the new drafts.
   Select **Cancel** to return without importing, or **Approve this plan** to
   apply exactly that plan. Crank then reconciles the drafts against the plan.
4. Check **Import history** for the approving person, time and result. In
   **Flows**, review each imported draft before selecting **Activate flow**.
5. In **Access**, create a **Trigger — one flow only** credential for the new
   flow. Point your source at `/api/crank/flows/FLOW_ID/trigger` on your Crank
   origin and use the [event envelope and authentication](ACCESS.md#connect-a-source-app).
   The old n8n webhook address is not a live Crank endpoint. Each event still
   needs the owner's **Approve and deliver** decision.

Uploading the same n8n workflows again later plans a catch-up: a changed
workflow replaces its unused imported draft once you approve that plan; a draft
that was activated, run or edited blocks it.

To remove an unused import, select **Undo unused import** in its journal entry.
Undo requires the original draft values and no recorded runs. Active flows or
changed values block undo; it does not reverse a delivery. Inspect a refused
import's message before trying again.
Crank does not silently skip unsupported nodes or settings.

For a local receiving app, see [Get started](GETTING-STARTED.md). Read
[Flows and runs](FLOWS-AND-RUNS.md) before switching a source, and keep a
[backup](BACKUP-RESTORE.md) of your Crank data.

Export using n8n's workflow **Download** action. Before uploading, remove
credentials and authentication headers. n8n warns that workflow exports can carry
credential references and headers imported from cURL; Crank refuses them instead
of stripping them silently. See [n8n export/import documentation](https://docs.n8n.io/workflows/export-import/).

## Supported shape

Upload one workflow object or a JSON array containing 1–20 workflow objects,
at most 128 KiB total UTF-8. Every n8n upload shares the `n8n` import
namespace, so a later upload of the same workflow IDs is a catch-up. A repeated
workflow ID with different content in one upload is refused; an identical
repeat counts once. An omitted ID receives `workflow-1`, `workflow-2`, etc.

Each workflow must have exactly two distinct nodes with IDs, names and two-number
positions:

- `n8n-nodes-base.webhook`, version 1, 2 or 2.1, with `httpMethod: "POST"`,
  a nonempty `path`, optional `authentication: "none"`, optional
  `responseMode: "onReceived"`, and omitted or empty `options`.
- `n8n-nodes-base.httpRequest`, version 4, 4.1, 4.2 or 4.3, with
  `method: "POST"`, a permitted `url`, `sendBody: true`, optional
  `contentType: "json"`, `specifyBody: "json"`, and exactly
  `jsonBody: "={{ $json.body }}"`. Authentication must be omitted or `none`;
  headers/query switches must be omitted or false; options must be empty.

The only connection is Webhook `main[0]` to HTTP Request input 0, with edge
`{ "node": "<HTTP node name>", "type": "main", "index": 0 }`.
The HTTP node may have no connection entry or an empty object.

The exact body token is a recognized whole-body marker. Crank never evaluates
n8n expressions. Every other expression, including differently spaced variants,
transforms, interpolated URLs and field selections, is refused. Static JSON
bodies, key/value body mappings, raw bodies, credentials (including empty
credential objects), auth headers, schedules, branches, retries, disabled nodes,
code nodes and additional graph edges are unsupported. A refused upload has no
partial native effects.

Workflow metadata accepts `id`, `name`, `active`, `versionId`, `createdAt`,
`updatedAt`, empty `tags`, empty `pinData`, null/empty `staticData`, empty `meta`,
and empty `settings` or `settings: { "executionOrder": "v1" }`. Optional node
`webhookId` is retained. Other properties are refused. Accepted metadata and
layout remain in the retained original; they do not become Crank runtime
settings. Imported names come from workflow names, source app is `n8n`, and
destination app is `HTTP inbox`. The old n8n webhook path is retained as evidence;
the new Crank webhook address must be used after activation.

The [HTTP Request documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
describes JSON bodies. The [upstream node parameter definitions](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/HttpRequest/V3/Description.ts)
identify `sendBody`, `contentType`, `specifyBody` and `jsonBody`.
The [Webhook implementation](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Webhook/Webhook.node.ts)
places the request body in the output's `body` field. These primary sources were
consulted on 15 October 2026. This supports the documented-shape mapping; it
does not establish compatibility with every n8n release or node option.

## Destination and review

`CRANK_TARGET_ORIGIN` declares the single permitted destination origin. In
production it is required and must use HTTPS. In `AUTH_LOCAL=true`, omission
selects `http://127.0.0.1:9051`. Imported target URLs must have that exact parsed
origin, without username/password, query or fragment. The configured origin
cannot include a path. Import preview and apply use the same validator.

Every import goes through Base's shared import door
(`src/modules/import-kit/src/door`, mounted by `src/crank/import-door.ts` at
`/api/operator/import/{uploads,plan,apply,status,reconcile,undo}` with the
`X-Import-Source: n8n` header). The plan returns a SHA-256 fingerprint, counts,
rejections, diagnostics and differences. Apply must submit that plan id and the
reviewed fingerprint; any source, mapping or destination change makes a new
plan. Base persists the reviewed plan, its approval (owner email and time),
source identities, native provenance and batch progress in D1, and repeating
apply resumes the same job. Uploaded chunks are deleted once a plan is saved.

Each door request authenticates the owner's current native session with an exact
`Origin`; the same session predicate is rechecked inside every mutation. Admins,
members, agent and trigger credentials, signed-out callers and other origins are
refused. Run Edit Run Business grants (`/api/rer/import/*`) reach the same door
only when RER's owner-claim key ring (`RER_OWNER_CLAIM_PUBLIC_KEYS`) is
configured and the owner has turned **Business imports** on at Move in
(`/api/operator/import-settings`); otherwise they answer 404 or are refused.
Crank does not read `RER_IMPORT_DOOR`: the setting starts off and only the owner
turns it on. Revoked signing keys stay revoked. History lists door imports with their approval caption and jobs
approved by Crank's earlier importer, which keep their undo at
`/api/crank/imports/JOB_ID/undo`. Apply and undo are written to the audit.

Undo uses the retained Base journal after reopening the database; it does not
need the upload again. It removes only the exact imported native values and
revisions. Changed native values, an active flow, a changed creation time, or a
recorded flow run block undo. Foreign references also remain protected by native database
constraints. Partial apply can be rolled back through the same undo action;
Base retains restartable reversal intent. Original source and approval evidence
remain after undo. Reversal does not erase customer data or undo an external
HTTP delivery.

## Fixture and source provenance

[`public/fixtures/n8n-workflow.json`](../public/fixtures/n8n-workflow.json) is a
constructed example of the documented shape, with invented IDs and local inbox
URL. It is not a customer export and has not been exported from a live n8n
instance. Its evidence status is **documented format / synthetic-only / real
export not supplied**. Change its URL to the installation's declared origin for
production use. No broad n8n compatibility or provider acceptance is claimed.

The import kit and its door are copied without modifications from Base commit
`6d38b54a6401879989e8d1f7ab4a02ffbdb4c46c` (rer 0.2.68), source directory
`modules/import-kit`, into `src/modules/import-kit`. Worker execution requires
`nodejs_compat`. Product adaptation lives in `src/crank/import-door.ts`,
`src/crank/import-target.ts`, `src/crank/n8n.ts` and, for jobs from the earlier
importer, `src/crank/imports.ts`.

`migrations/core/0015_import_kit.sql` materializes 311 statements from Base's
exported D1 schema arrays, in `initializeD1ImportStorage` order, followed by the
Crank approval and revision-sidecar tables and approval immutability triggers.
The migration is applied once by the ordinary migration runner. It does not
initialize or modify schema during an import request. Base's later kit and door
schemas follow verbatim as `0032_import_custody_replace.sql`,
`0033_import_erasure_progress.sql` and `0034_import_door.sql`.

The copied file inventory is recorded in `base-copies.json`.
