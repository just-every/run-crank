# Crank JavaScript SDK v1

Dependency-free ES modules for Node 22+ and browsers with Fetch. Import
`./sdk/index.js` from this checkout, or use this directory as a local package.
`index.d.ts` supplies TypeScript declarations. No build or SDK install is needed.
The client calls the real `/api/crank/v1` JSON API on one installation origin.
`API_VERSION` is `'1'`; this path and the methods below form the v1 contract.

```js
import { createCrankClient, CrankApiError } from './sdk/index.js';

// Server-side only. Load the owner's preparation credential from private config.
const crank = createCrankClient({
  baseUrl: 'https://crank.example',
  token: process.env.CRANK_PREPARATION_TOKEN,
  fetch: globalThis.fetch,
});
const input = {
  name: 'Normalize a record',
  graph: {
    trigger: { type: 'manual' },
    steps: [{ id: 'record', type: 'map', input: { name: '{{trigger.name}}' } }],
  },
};
// Persist this key with this exact input before sending. Reuse both only to
// recover this operation after a lost response; a changed input needs a new key.
const idempotencyKey = crypto.randomUUID();
const draft = await crank.createDraft(input, { idempotencyKey });
await crank.validateDraft(draft.id);
const current = await crank.readWorkflow(draft.id); // current .draft graph
const saved = await crank.readDraft(draft.id, current.draft_versions[0].id);
```

`createDraft` creates a workflow in draft state; `updateDraft(id, partialInput,
options)` saves another immutable draft snapshot. Both accept
`{idempotencyKey, signal}` and send `Idempotency-Key` unchanged. The server owns
deduplication and refuses reuse with changed content. Validation and creation
send nothing to workflow destinations.

## Authentication

The SDK reuses the installation's existing authentication. It creates no keys,
sessions or authority. Choose one credential mode per client:

| Client configuration | Existing authority |
| --- | --- |
| Browser, no `token` or `cookie` | Current same-origin native session, sent with `credentials: 'same-origin'` |
| Node, `cookie` | Your authenticated session's complete `Cookie` header; SDK supplies the installation Origin on POST |
| `token: 'crk_…'` | Owner-issued **agent** preparation bearer: reads, create/update/validate drafts; cannot publish or start granted tasks |
| `token: 'crg_…'` | Separate owner-issued execution grant: start and read only that grant's agent tasks |

`token` is the credential without the `Bearer ` prefix. Trigger-scoped `crk_`
credentials cannot use these SDK methods. Local dev credentials additionally
require the native local development gate; production credentials do not bypass
it. Native member sessions have read restrictions, and administrative sessions
can prepare drafts. Publishing requires a native/dev **owner** session; an
agent bearer, grant bearer or IdP-only owner session cannot publish.

Cookie POSTs require the exact configured `AUTH_ORIGIN`, including port, and
the request URL must have that origin. Browsers provide their own Origin. A
bearer POST may omit Origin; if supplied it must match `AUTH_ORIGIN`. Keep
`baseUrl` equal to the installation origin, without a path, query, credentials
or fragment. Cross-origin browser cookie access is not supported by this SDK.
Keep bearer credentials and Node cookies on the server; never bundle them into
browser assets or log them. `cookie` is for Node only; browsers manage cookies.

For example, in the installation's signed-in owner browser app:

```js
import { createCrankClient } from '/sdk/index.js'; // serve the SDK ES modules here
const owner = createCrankClient({ baseUrl: window.location.origin });
const publication = await owner.publishDraft(workflowId);
```

Publishing freezes the current saved draft and authorizes its declared effects.
All existing checks still apply, including an owner-reviewed USD estimate,
connection bindings, sensitive-data attestations and restored-workflow adoption.
Prepare these through the native owner interface before publishing. The optional
second argument to `publishDraft(id, input)` forwards the native publication
JSON object, including any required adoption review. No implicit publication,
cost estimate, approval, retry or permission escalation happens in the SDK.

## Granted task progress

```js
const executor = createCrankClient({
  baseUrl: 'https://crank.example',
  token: process.env.CRANK_EXECUTION_CREDENTIAL,
});
const task = await executor.startTask({
  task_id: 'source-ticket-1042',
  actions: [{ step_id: 'record', input: { name: 'Harbour Workshop' } }],
});
const progress = await executor.readTask(task.id);
console.log(progress.status, progress.steps, progress.waits);
```

The owner first publishes the tool workflow and issues a bounded standing grant
through native Access. `actions` chooses and orders existing leaf tools once
each. Inputs are literal JSON; no changed transport, URL, connection or workflow
expressions. Out-of-policy effects wait for exact native approval. `readTask`
returns that grant's task only. Call it again deliberately to observe progress;
there is no background polling. A task's workflow status and HTTP success do not
establish independently verified business completion. Use `business_outcome`
and the native retained evidence. A network error leaves the outcome unknown;
inspect the task history before dispatching additional effects.

## Reads and pagination

```js
const page = await crank.listRuns({ workflow: draft.id, limit: 25 });
if (page.next !== null) {
  const nextPage = await crank.listRuns({ workflow: draft.id, limit: 25, before: page.next });
}
const controller = new AbortController();
for await (const run of crank.iterateRuns({ workflow: draft.id, limit: 25 }, { signal: controller.signal })) {
  console.log(run.id, run.status);
  // break stops before another page is requested.
}
```

`listRuns` returns the native `{runs,next,text_search?}` envelope; `next` is an
opaque cursor passed unchanged as `before`. `iterateRuns` preserves filters,
loads pages lazily until `next:null`, and refuses repeated cursors. Filters:
`workflow,status,business_key,q,from,to,error,before,limit`. The server clamps
`limit` to 100. Concurrent incoming runs appear ahead of the current cursor;
this traversal is not a frozen snapshot. Encrypted payload text search remains
restricted by the native server. `readRun(id)` returns exact run detail.
`listWorkflows({q,folder})` returns the native array, bounded to 500 workflows;
that door has no pagination cursor and the SDK does not claim exhaustive listing.

All methods accept `{signal}` as their final options argument. Methods with a
body take options after that body, for example
`validateDraft(id, {}, {signal})`. A custom `fetch(url, init)` can provide your
server's transport. Redirects are refused, credentials stay on the configured
origin, and the SDK performs no retries.

## Public errors

```js
try {
  await crank.validateDraft(draft.id);
} catch (error) {
  if (!(error instanceof CrankApiError)) throw error;
  console.log(error.code, error.status, error.message, error.details);
}
```

Every HTTP failure throws `CrankApiError`: `code` is the API's stable code,
`status` the HTTP status, and `details` the parsed public JSON error envelope
(or null for non-JSON responses). Invalid validation is HTTP 422 and throws too.
Codes include `invalid_request`, `unauthenticated`, `forbidden`, `not_found`,
`conflict`, `invalid_operation`, `unavailable`, and `operation_failed`.
Client errors use `invalid_request`, `invalid_response`, `network_error` or
`aborted`; status is zero when no HTTP response was confirmed. Invalid success
JSON preserves the received HTTP status. Raw non-JSON bodies and transport
exception text are not exposed. `toJSON()` returns the public error fields.
Invalid constructor configuration throws `TypeError`.

No webhook subscription or delivery SDK is implemented. Webhook delivery remains
partial under the Base egress requirement; these clients only call authenticated
native HTTP doors.
