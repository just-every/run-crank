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

## Native multi-step graphs

Exports with more than two nodes use the bounded native graph compiler. The original
strict two-node format above continues to create the same approval flow. Native
graph imports create inactive workflow drafts with no published version, inbound
hook, connection or execution authority. Explicit native publication authorizes
future execution under the ordinary workflow policy; importing does not.

The compiler supports one POST Webhook (versions 1, 2, 2.1) or Manual Trigger
(version 1), replacement Set assignments (versions 3 through 3.4), strict IF and Filter
conditions (versions 2 through 2.2), interval Wait (version 1.1), and JSON POST
HTTP Request (versions 4 through 4.3). Set fields are explicit simple names with
matching literal types or declarative data paths. Native Set values are checked
against their declared type at execution; mismatches stop before downstream work
without implicit source coercion. IF supports the listed native
text comparisons, numeric comparisons and true or false tests, an AND or OR
combinator and one destination on each output. Imported strict conditions carry an
explicit scalar type guard: a numeric string cannot silently become a number or
select a branch. Such a mismatch fails before any downstream request. General shared joins, cycles, fan-out,
loose type coercion and every unrecognized setting require manual conversion.
A Wait preserves the preceding data and uses Crank's ordinary durable delay.

Only an exact whole-value expression shaped like `={{ $json.body.amount }}` is
translated to a native data reference. It may only select simple property names
from the current item; `={{ $json }}` selects the whole item. It never runs code.
Literal JSON values are wrapped as native literals so source text cannot become
an executable native mapping. HTTP bodies accept such a data reference or a
literal JSON document. Parsing and planning make no outbound requests. Native
HTTP execution retains HTTP-002's ordinary egress restrictions, including its
refusal of loopback targets even in local mode.

The preview lists each recognized field and each manual conversion. An unsupported
node or setting rejects the whole workflow's mapping, with no partial graph
effects. The screen withholds approval until those conversions are resolved;
Cancel plan discards its pending review so a corrected export can be uploaded.
Secret-bearing objects are refused before retention. In native graph exports, a
node credential reference may contain only bounded `id` and `name` fields. Each
reference blocks the graph with a fresh-account-binding disposition; no
connection, credential or execution authority is created. Embedded workflow JSON
receives the same credential inspection. The strict legacy two-node importer
continues to refuse all credential objects. Original coordinates,
source node identities and edges remain in the native draft's graph settings.

The native adapter keeps import revisions separately from workflow authority.
Duplicate apply, restart and journal readback preserve the same draft and
provenance. Undo fences the complete imported graph, metadata and timestamps,
and refuses native edits, hooks, publication or recorded use. Native edits are
never overwritten by catch-up or undo. Archives include the provenance sidecar;
restoration remains subject to the existing inactive-restore and owner-adoption
fences.

`tests/crank.test.mjs` proves both IF outcomes against an actual owned local HTTP
receiver, reached through a test-only address bridge at the network edge. No
receiver response or native execution is faked. `tests/n8n-graph-fixture.mjs`
constructs the documented source shape; it is engineering proof, not a live
customer export, n8n execution capture or provider receipt.

### Serial loops and embedded subflows

Split Out version 1 supports one simple array field, `include: "noOtherFields"`,
and an explicit `options.destinationFieldName` equal to that field. Naming the
destination preserves object items under the field instead of flattening them.
It must connect directly to Split In Batches version 3 with `batchSize: 1`, empty
options, an unused done output (output 0), and one loop-body destination on
output 1. The linear body may contain Set, JSON HTTP and embedded subflow calls,
and must return to the batch node. Native execution processes at most 1000 items
in input order, allows an empty array and stops on the first failed item.
Malformed or oversized arrays fail before any body request. Reset, larger
batches, done-output work and other topologies require manual conversion.

Execute Workflow versions 1 through 1.3 support `source: "parameter"`, a literal
`workflowJson`, `mode: "once"` and synchronous completion. Its snapshot needs
one Execute Workflow Trigger version 1 with empty parameters and a linear body
of Set, JSON HTTP or nested embedded calls. The caller supplies one current
item. Child steps are inlined with distinct native identities; snapshot digests
and layout are retained in `n8n_subflow_pins`. Nesting is limited to four levels.
The reviewed import fingerprint binds the whole snapshot. Database IDs, dynamic
sources, asynchronous calls, declared child-input schemas and arbitrary child
graphs require manual conversion. This does not create a reusable native registry
release or fetch a source workflow.

Code, Function and Function Item nodes always receive a blocking conversion:
source code never runs during planning or native execution. Convert them to
reviewed native transforms or explicitly provision an isolated executor. A manual
disposition records remaining work; it does not satisfy eventual code conversion.
Strict Filter nodes preserve the preceding item when conditions pass and end as
`stopped by filter` otherwise. Text comparisons preserve whitespace. Loose
coercion and unmapped operators block conversion.

Switch versions 3 through 3.5 accept strict `mode: "rules"`, the same condition
groups, and one destination per output. `allMatchingOutputs` preserves first-match
or all-match routing. `fallbackOutput: "extra"` maps the extra fallback branch;
omitted or `"none"` stops an unmatched item. Output labels remain branch names.
Expression mode, loose coercion, a fallback reusing a rule output and shared
joins remain explicit manual conversions. Strict binary conditions currently need
a literal right operand of the declared scalar type.

Date & Time version 2 maps `operation: "formatDate"` with replacement output,
`options.timezone: true`, and an explicit IANA `settings.timezone`. Supported
calendar formats are `yyyy-MM-dd`, `MM/dd/yyyy`, `yyyy/MM/dd`, `MMMM dd yyyy`
and `MM-dd-yyyy`, including those exact patterns under `format: "custom"`.
The source date can be a literal or a declarative data path. Null stays null;
an invalid date fails before a downstream request. Input-format overrides,
input-zone inference, retaining other input fields, Unix formats and other date
operations require manual conversion. These rules preserve the declared zone
instead of guessing the source installation's default.

MIG-001 stays partial. General loops, registry subflow bindings, isolated code and
fresh credential conversion, complete search, transform and condition mappings, live resource and
watched-field mappings, real samples, fresh authorized bindings, source comparison
and cutover, plus multimodal OpenAI and Anthropic operations and agent tools
remain required. A manual disposition is not a replacement for their eventual
supported mapping. No source or provider authorization is assumed.

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
