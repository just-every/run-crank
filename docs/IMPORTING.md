# Move n8n workflows into Crank

Crank supports a deliberately narrow n8n JSON export: a POST Webhook connected
directly to one HTTP Request that forwards the complete incoming JSON body.
The import creates draft flows. Review the new Crank webhook address and activate
each draft explicitly before sending events. Source workflow activation does not
activate a Crank flow. Importing never executes a workflow or sends an HTTP request.

Export using n8n's workflow **Download** action. Before uploading, remove
credentials and authentication headers. n8n warns that workflow exports can carry
credential references and headers imported from cURL; Crank refuses them instead
of stripping them silently. See [n8n export/import documentation](https://docs.n8n.io/workflows/export-import/).

## Supported shape

Upload one workflow object or a JSON array containing 1–20 workflow objects,
at most 128 KiB total UTF-8. Choose an import namespace of 1–64 ASCII letters,
digits, dots, underscores or hyphens, starting with a letter or digit. Keep it
stable when retrying the same export. Workflow IDs must be unique within an
upload; an omitted ID receives `workflow-1`, `workflow-2`, etc. Changing an
existing source workflow under the same namespace/ID is refused, rather than
overwriting a native flow.

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

The dry run returns a Base SHA-256 plan fingerprint and a summary. Explicit
human apply must submit the same namespace, exact source bytes and fingerprint.
Any source, mapping, actor or destination change invalidates the reviewed
fingerprint. Base persists the immutable reviewed plan, source identities,
original bytes, native provenance and batch progress in D1. Crank stores the
approving owner, reviewed fingerprint and approval time separately before any
flow can be applied. Repeating the same apply reuses its durable job.

Authorization is checked by the HTTP layer and again by SQL predicates inside
Base's native transactions. Only an active `oa_operators` owner can plan, apply
or reverse imports. Jobs remain bound to their creating principal. The history
list shows at most the newest 100 jobs and includes approval information.

Undo uses the retained Base journal after reopening the database; it does not
need the upload again. It removes only the exact imported native values and
revisions. Any native edit, activation, changed creation time, or recorded flow
run blocks undo. Foreign references also remain protected by native database
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

The import engine is copied without modifications from Base commit
`fc0e1041efa55771142bbb57c4ab4743147e264d`, source directory
`modules/import-kit/src`, into `src/modules/import-kit`. The copied files are
the transitive source dependency closure of `d1/jobs.ts`, `d1/apply.ts`,
`d1/reverse.ts`, `d1/database.ts` and `readers/file.ts`. Tests, the synchronous
SQLite entry point, registry and API reader were not copied. Worker execution
requires `nodejs_compat`. Product adaptation lives in `src/crank/imports.ts`,
`src/crank/import-target.ts` and `src/crank/n8n.ts`.

`migrations/core/0015_import_kit.sql` materializes 311 statements from Base's
exported D1 schema arrays, in `initializeD1ImportStorage` order, followed by the
Crank approval and revision-sidecar tables and approval immutability triggers.
The migration is applied once by the ordinary migration runner. It does not
initialize or modify schema during an import request.

The copied file inventory is recorded in `base-copies.json`.
