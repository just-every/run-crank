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

Exports outside the original Webhook-to-HTTP pair use the bounded native graph
compiler, including a two-node trigger followed by Code or Execute Workflow. The
original strict pair above continues to create the same approval flow. Native
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

Split Out versions 1 and 1.1 feed a version 3 Split in Batches loop or a
reviewed linear item stream. The supported source fields, output shape and larger
batch choices are described below. A single-item batch needs no extra cardinality
choice when its body has no intermediate expansion. Serial execution preserves
input order and stops on the first failure. Oversized streams fail before a body
request. Reset and other loop topologies require manual conversion.

Done output 0 can lead to a distinct linear Set, JSON HTTP or supported embedded
pure-subflow chain. Without an explicit stream choice, its loop body ends with
one JSON HTTP node. Completion consumes the body responses
in order, expands returned JSON object arrays and preserves duplicate items.
Every completion node finishes its incoming item list before the next node starts.
An empty input or empty returned body stream produces no completion requests;
an empty back edge also stops remaining body iterations, while retaining earlier
successful checkpoints. Completion replay preserves those checkpoints and their
operation identities. Binary response conversion remains manual work. These
semantics follow the source's [batch node](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/SplitInBatches/v3/SplitInBatchesV3.node.ts)
and [HTTP node](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts).
`tests/n8n-loop-journey.mjs` (`doneLoopJourney`) exercises the reviewed import,
ordered actual receiver effects, empty streams, failures, restart and replay.

An intermediate HTTP response can expand into multiple JSON objects when the
owner supplies an `item-stream-loop` choice for the Split Out node in the retained
conversion envelope. For example, `"conversions": {"n2": {"kind":
"item-stream-loop", "reviewed": true, "max_source_items": 10,
"max_stage_items": 20}}` explicitly limits the original source array to ten
items and each body or completion stage to twenty. Both bounds must be from one
to 1000, and the resulting native graph must fit its existing aggregate invocation
budget; planning refuses an excessive budget. The choice and original source
remain fingerprint-bound and visible in provenance.

The streamed body supports linear Set and JSON HTTP steps, including maps from
an inlined pure child. Every node processes its complete incoming stream before
the next begins. HTTP object arrays expand in response order and duplicate records
remain separate operations. Execution is serial and stops at the first failure;
it does not reproduce n8n's concurrent requests within one HTTP node. Empty
intermediate output stops later stages, remaining source batches and completion.
Primitive or binary responses fail before downstream mapping. Registry calls,
unreviewed code, branches and nested batches inside this stream still require their
own conversion. `tests/n8n-loop-stream-journey.mjs` (`streamLoopJourney`) proves the
reviewed bounds, actual receiver effects, stage barriers and retained replay.

A reviewed `item-stream-loop` choice also accepts a literal batch size from 1 to
1000. Source nodes process every item in the current batch before the following
source node starts. The final short batch is retained, duplicate inputs remain
distinct, and the done chain consumes the ordered returned items. Source and stage
bounds still participate in the native invocation budget. An empty body stream
stops the remaining batches and done work; a failed item stops the next stage.
Restart and selected replay retain completed requests.

For a Split Out feeding a linear chain directly, use the same bound fields with
`kind: "item-stream"`. The source names one simple JSON field. Split Out versions 1 and 1.1 preserve
an explicit destination name or the source default object expansion, and can
include all other fields or selected literal fields. Missing values produce no
items, object values expand in property order, and scalar values produce one item.
Nested or multiple split fields and binary inputs remain manual conversions.
Filter nodes inside reviewed streams retain matching items in order, including
duplicates, and stop downstream work when no items remain. Every condition in a
stage is evaluated before the next node dispatches; a type error stops that stage.
An empty filtered back edge stops later batches and the done output.
Set and HTTP operate per item;
Limit version 1, simple Sort version 1, current-input Remove Duplicates versions
1, 1.1 and 2, and JSON Aggregate version 1 operate on the complete preceding
stream. Sorting preserves source field directions and case handling. Duplicate
removal keeps the first original record. Aggregate supports individual fields with
renaming, nested paths, one-level list merging and explicit missing-value retention,
or all-data aggregation with literal top-level included or excluded fields. Empty
field projections are omitted from the aggregate, while a nonempty input projected
to nothing still yields one empty aggregate. History-based duplicate removal, random
sorting, object comparison values, binary aggregation, branched streams and nested
batch loops remain explicit conversions. Item and byte bounds apply before the
next write, and an empty stream never creates an aggregate record.

Execute Workflow versions 1 through 1.3 support `source: "parameter"`, a literal
`workflowJson`, `mode: "once"` and synchronous completion. Its snapshot needs
one Execute Workflow Trigger version 1 with empty parameters and a linear body
of Set, JSON HTTP or nested embedded calls. The caller supplies one current
item. Child steps are inlined with distinct native identities; snapshot digests
and layout are retained in `n8n_subflow_pins`. Nesting is limited to four levels.
The reviewed import fingerprint binds the whole snapshot. Unbound database IDs, dynamic
sources, asynchronous calls, declared child-input schemas and arbitrary child
graphs require manual conversion. This does not create a reusable native registry
release or fetch a source workflow.

Unresolved Code, Function and Function Item nodes receive a blocking conversion.
Source code never runs during parsing or planning. An owner can supply an explicit
reviewed native replacement for a provisioned executor as described below. A
manual disposition records remaining work; it does not satisfy eventual conversion.
Strict Filter nodes preserve the preceding item when conditions pass and end as
`stopped by filter` otherwise. Text comparisons preserve whitespace. Unmapped operators and loose object parsing block conversion.

Switch versions 3 through 3.5 accept strict `mode: "rules"`, the same condition
groups, and one destination per output. `allMatchingOutputs` preserves first-match
or all-match routing. `fallbackOutput: "extra"` maps the extra fallback branch;
omitted or `"none"` stops an unmatched item. Output labels remain branch names.
A numeric fallback output reuses the named rule output only when no rule matches.
Shared joins remain explicit manual conversions.
Expression mode accepts 1 to 25 literal outputs and an output index expressed as a
literal or the same declarative current-item data path. Source numeric conversion
occurs before range checking; null, missing, fractional and out-of-range indexes
fail before any receiver request. Arbitrary JavaScript expressions remain manual.
Strict conditions accept literal operands and declarative current-item paths on
both sides. String negated prefix and suffix, regular expressions, boolean equality,
array membership and length, object emptiness and typed existence operators preserve
source null handling and whitespace. AND and OR groups short circuit, as do exclusive
Switch outputs. Case handling follows the source condition version, including the
version 4 regular-expression flag behavior. Loose conversion is supported for numbers, text, booleans and arrays, including
source-version boolean truthiness and version 3 empty-number handling. Loose object
syntax remains an explicit manual conversion. DateTime conditions accept ISO
timestamps with an explicit UTC or numeric offset and compare absolute instants.
Missing or null timestamps preserve source empty and comparison behavior; malformed
or local timestamps fail before dispatch. Local-date inference, non-ISO source
formats and source DateTime runtime objects need an explicit manual conversion.

Date & Time version 2 maps `operation: "formatDate"` with replacement output,
`options.timezone: true`, and an explicit IANA `settings.timezone`. Supported
calendar formats are `yyyy-MM-dd`, `MM/dd/yyyy`, `yyyy/MM/dd`, `MMMM dd yyyy`
and `MM-dd-yyyy`, including those exact patterns under `format: "custom"`.
The source date can be a literal or a declarative data path. Null stays null;
an invalid date fails before a downstream request. Input-format overrides,
input-zone inference, retaining other input fields, Unix formats and other date
operations require manual conversion. These rules preserve the declared zone
instead of guessing the source installation's default.

### Retained owner conversion choices

Upload a migration envelope when a workflow needs a native registry binding or
reviewed code replacement:

```json
{
  "workflow": { "id": "synthetic-crank-40", "name": "Original export", "nodes": [], "connections": {} },
  "conversions": {
    "source-node-id": {
      "kind": "registry-subflow",
      "reviewed": true,
      "subflow_id": "native-registry-id",
      "subflow_version": 1,
      "definition_digest": "<reviewed native definition SHA-256>",
      "input": { "address": "={{ $json.address }}" }
    }
  }
}
```

The empty workflow above illustrates the envelope fields; it is not an importable
workflow. Place the untouched complete export under `workflow` and key each choice
by its source node ID. Arrays may contain ordinary exports and envelopes. Review
these choices as part of **Upload and plan**, then approve the exact fingerprint.
There is no separate mutable choice state or choice header. Both source and
choices participate in the retained source hash, bundle hash and fingerprint;
changing a choice requires a new upload and review. The native draft preserves
choice digests and source-node dispositions in its graph settings. Rejected
plans retain their source and manual diagnostics without creating a draft.

For a JSON HTTP Request, a choice of
`{"kind":"http-connection","reviewed":true,"connection_id":"fresh-native-id"}`
binds an account already entered through Crank's native Connections screen. The
source credential reference is retained only as provenance. Review and apply send
no request and leave the workflow inactive. Publication and every dispatch enforce
the live connection, domain and owner authority; revocation stops further work.
HTTP versions 4 through 4.3 map GET, HEAD, POST, PUT, PATCH and DELETE, explicit JSON
bodies, and named header and query parameters. Parameter names are literal and
unique; values may use declarative item paths. Nested expressions inside literal
objects or arrays are named manual conversions rather than forwarded as data. Inline credentials, dynamic names,
unknown response options, scalar or null JSON bodies and unmapped body formats
require manual conversion. A dynamically resolved scalar or null JSON body stops
with a named validation error before dispatch, rather than becoming an absent body.
Source provider references do not establish native provider-operation parity.

`registry-subflow` compiles a synchronous Execute Workflow call to a native pure
registry step with an exact ID, positive version, reviewed definition digest and
explicit mapped input. Database workflow IDs stay source evidence and are never
looked up in n8n. Input values accept literals or the same declarative current-item
paths as graph mapping. Native publication checks the reviewed digest against the
registry version. Execution checks it again and enforces current registry review
and owner publication. Installing a later version does not upgrade this pin;
revoking the pinned release blocks further work. Unknown source modes, dynamic
selectors and asynchronous calls remain manual conversions.

To execute a supported original Code node rather than supply a rewritten program,
use `kind: "n8n-code"` with the same reviewed connection, executor URL, resource
bounds, empty egress list and output schema fields below, omitting `source` and
`input`. The native wrapper derives its program from the fingerprint-bound original.
Code versions 1 and 2 support JavaScript, all-items mode with `$input.all()`,
`$input.first()`, `$input.last()` and `$input.item`, and each-item mode with
`$input.item` and `$json`. Each-item execution is serial; null suppresses the item.
The sandbox input and declared output schema use
`{"items":[{"json":{"normalized":"example"}}]}`. Returned items are normalized to
the native JSON stream before any following node. Empty streams never submit a
code task. The native executor retains its task identity and output checkpoint
through restart; an invalid result prevents downstream writes.

This wrapper is a bounded runtime adapter, not complete n8n runtime compatibility.
Source workflow lookup, environment access, imports, network APIs, binary data,
lineage metadata and legacy Function nodes remain explicit conversions. Conservative
source screening also refuses unsupported API tokens in comments and string literals.
The source program is only constructed and invoked inside the isolated executor;
parsing and planning never execute it. `tests/executor-linux.mjs` executes both code
modes through the real import door and Linux sandbox.

For a Code version 1 or 2, Function version 1 or Function Item version 1, the
alternative choice is:

```json
{
  "kind": "isolated-code",
  "reviewed": true,
  "language": "javascript",
  "source": "export default function(input) { return {normalized:input.address.trim()} }",
  "connection_id": "fresh-native-executor-connection",
  "executor_url": "https://executor.example",
  "timeout_ms": 2000,
  "memory_mb": 1024,
  "allowed_egress": [],
  "output_schema": {
    "type": "object",
    "properties": { "normalized": { "type": "string" } },
    "required": ["normalized"],
    "additionalProperties": false
  },
  "input": { "address": "={{ $json.address }}" }
}
```

This explicitly reviewed source is native executor JavaScript. The original
`jsCode` or `functionCode` stays source evidence; Crank neither executes it nor
claims compatibility with `$input`, item arrays or other n8n runtime APIs. The
owner reviews how the native input and returned JSON replace the source node's
behavior. A fresh native connection, literal executor origin, timeout, memory
bound, empty allowed-egress list and supported output schema are required.
Ordinary native executor validation and publication enforce the connection;
live revocation stops subsequent dispatch. Returned JSON is checked against the
schema before downstream steps. Source credential references continue to block
the entire graph: these choices do not authorize or silently rebind them. A
choice such as `{ "kind": "manual", "reason": "owner review pending" }`
preserves a blocking disposition.

The existing MIG-001 public-door journey covers unresolved and resolved choices,
different choice fingerprints, duplicate apply, restart, exact unused undo,
publication and use fences, actual native registry execution, version pins and
revocation. Its remote executor protocol is a network-edge fake with explicit
results; it establishes import and native orchestration behavior, not execution
or host isolation. The Linux executor journey additionally imports a reviewed
code conversion and runs it on the actual sandbox service.

MIG-001 stays partial. General loops, broader registry and code conversions,
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
