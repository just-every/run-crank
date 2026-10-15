# Verified delivery-event intake

Public exports from `src/events/index.mjs` (re-export these from the mail facade):

* `verifyWebhook(input): Promise<boolean>` — the frozen IF-056-MAIL-v1 signature.
* `MAX_WEBHOOK_BYTES` — 32 MiB, including signed Inbound Parse multipart bytes.
* `createDeliveryEventIntake(options)` — authenticated normalization plus atomic
  durable receipt and recipient-state storage. No public unverified normalizer.

## Signature verification

`verifyWebhook({provider, rawBody, headers, key, now, toleranceSeconds = 300})`
takes a `Uint8Array`, `Headers`, and epoch milliseconds. Only SendGrid and Resend
are supported. It returns false for malformed inputs, keys, signature encodings,
or timestamps. Tolerance is an integer from zero through 3600 seconds, inclusive;
both clock boundaries are inclusive. The raw body is copied before asynchronous
verification. SendGrid verifies SHA-256 ECDSA with a canonical base64 P-256 SPKI
key and strict ASN.1 DER signature. Resend verifies Svix v1 HMAC-SHA256 over the
original `id.timestamp.` prefix and raw bytes, including all valid rotation
signatures. Base64 may omit padding but must retain canonical zero padding bits;
whitespace and URL-safe substitutions are rejected. Svix signing keys must have
the `whsec_` prefix and decode to 16–64 bytes.

This stateless primitive does **not** prevent replay within the clock window,
validate a provider schema, authenticate a mail sender, or authorize a tenant.
Delivery routes should use the complete intake below. Signed Inbound Parse can
use the primitive on the original multipart bytes before invoking inbound
normalization; the application separately owns inbound authorization and durable
replay protection. Bound streamed HTTP reads before materializing `rawBody`.

## Complete HTTP intake

```js
const intake = createDeliveryEventIntake({
  provider: 'resend', // or 'sendgrid'
  tenantId,          // trusted server-side routing, never request JSON
  eventNamespace,    // stable webhook/account identity across key rotations
  key,              // configured for this endpoint and tenant
  storage: ctx.storage, // real DurableObjectStorage, described below
  authorize: async event => {
    return await applicationOwnsMessageAndAllRecipients(event);
  },
  clock: Date.now,   // optional, returns epoch milliseconds
  toleranceSeconds: 300, // optional
});
const results = await intake.ingestWebhook({ rawBody, headers });
```

The mandatory `authorize(event)` must return exactly true for every event in the
batch. It runs only after successful signature and schema verification, and must
check the server-selected tenant, provider message (or SendGrid signed delivery
correlation), and **every** recipient against application records. It must be a
read-only authorization decision, never a delivery side effect. A provider
signature authenticates the configured provider endpoint; it does not authorize
an arbitrary signed `rer_delivery_id`, product marker, mailbox, or tenant.

Each frozen authorization event has:

```js
{
  provider, tenantId, eventNamespace,
  eventId, providerMessageId, type,
  status, // accepted|deferred|delivered|bounced|failed|rejected|complained|null
  occurredAt, // epoch milliseconds, from provider event time
  recipients: ['mailbox@example.com'],
  deliveryId, product, // signed SendGrid custom args, otherwise null
  fingerprint, // SHA-256 hex of full provider event payload
}
```

SendGrid arrays remain distinct events, keyed by `sg_event_id`; each recipient
keeps its own state. Resend uses the signed `svix-id` as event identity and keeps
the provider's `data.to` recipient list. Email local-part case is preserved. All
required IDs are nonempty, bounded and control-free; missing message identities,
recipient addresses or times fail. Only known delivery/tracking event types are
accepted; inbound events belong to the inbound pipeline. Open/click/unsubscribe
events retain receipts with `status: null` and cannot change delivery state.

HTTP intake permits at most 1 MiB of raw bytes and 1000 events or recipients.
Exact limits succeed; malformed UTF-8/JSON or any invalid/unauthorized event
rejects the whole batch before storage. Stored event timestamps may be old
(provider retries are legitimate), but cannot exceed the clock by five minutes.
Fresh request signatures remain required on every retry.

The result is an array in input event order:

```js
{ eventId, outcome: 'stored', recipients: [
  { recipient, applied: true, state: { status, occurredAt, eventId } },
] }
// Replay, no state mutation:
{ eventId, outcome: 'duplicate', recipients: [] }
```

Duplicate retries can be acknowledged without repeating application effects.
Same ID with a different fingerprint throws `event_identity_conflict`, rolling
back the entire batch. SendGrid fingerprints use the exact original JSON bytes
of each event, independently of its array position, surrounding whitespace or
other batch members. Internal event whitespace changes conflict conservatively.
Resend fingerprints cover the complete raw body. Every provider field therefore
participates, including fields not selected for the normalized record.

## Durable storage seam and state policy

`storage.transaction(async tx => ...)`, `tx.get(key)` and `tx.put(key, value)`
match real Cloudflare Durable Object storage. The supplied implementation must
provide serializable, rollback-on-throw, durably committed transactions across
all concurrent calls and restarts. Route a given namespace consistently to the
same Durable Object. A Node host can supply the same methods backed by its real
transactional database; this module has no Node imports or process-local store.
Plain KV, a Map, check-then-put, and an in-process mutex are insufficient.
There is no automatic storage selection and no in-memory fallback.

Receipt keys hash the tuple `[provider, tenantId, eventNamespace, eventId]` and
state keys hash `[provider, tenantId, eventNamespace, providerMessageId, recipient]`
with SHA-256 over JSON, prefixed `mail-events:v1:receipt:` or
`mail-events:v1:state:`. Receipts store the entire normalized authorization event,
including fingerprint. States store `{status, occurredAt, eventId}`. Both writes
commit together. No expiry or pruning runs implicitly: retain receipts through
the provider's possible replay period, and retain final state for the full
application delivery lifetime. Deleting records weakens these guarantees.

A terminal state cannot become accepted or deferred. A terminal event can
finalize a pending state even when received out of order. A newer terminal fact
may supersede an older terminal fact (for example a complaint after delivery).
Older/equal-time events never replace an existing terminal state; equal-time
conflicting terminal facts retain the first committed state, while both receipts
remain available. Application policy can inspect the retained facts separately.
Delivery means recipient mail-server acceptance, not evidence of human receipt.

No application callback runs inside the transaction, and this API does not
promise exactly-once external side effects. Consume persisted receipts using an
application-owned durable workflow/outbox; do not equate a successful return with
atomic completion of a separate external action. Storage/authorization exceptions
are redacted; validation errors carry fixed `.code` values.

## Cloudflare trusted queue boundary

Configure `provider: 'cloudflare'`, omit `key`, and supply:

```js
cloudflareSource: { queue, accountId, zoneId, domain, eventSubscriptionId }
```

The returned object has **only** `consumeQueue(batch)`, not `ingestWebhook`.
Invoke it only from the actual Worker `queue(batch, env, ctx)` consumer for an
Event Subscription queue with controlled producer permissions. Match the
configured queue, sending domain, zone, account, subscription, schema version 1
and `email.sending` source. It supports documented delivered/deferred/bounced/
failed/rejected/complained events and validates their terminal flags. The same
mandatory application authorization and durable transaction apply. The entire
batch is bounded to 1 MiB after queue-body JSON serialization and 1000 messages;
the serialized full event supplies the fingerprint.

Queue name and event fields are validation, not authentication. Anyone can forge
a JavaScript object with those properties: never turn HTTP JSON into a queue
batch or expose `consumeQueue` through an unauthenticated HTTP/RPC method. The
trusted Cloudflare queue invocation and producer controls are the boundary.
For Durable Object storage, the queue handler may forward
`{queue: batch.queue, messages: batch.messages.map(({body}) => ({body}))}` through
its **private Durable Object binding** to an application-owned method which
constructs this intake with `this.ctx.storage`. This transports the authenticated
queue data without trying to serialize runtime ACK functions. Keep that method
inaccessible from public HTTP and validate the configured source there too.
Call `batch.ackAll()` only after `consumeQueue` resolves; on a throw, retain/retry
or quarantine according to application policy. The module never ACKs first and
never invents a Cloudflare HTTP signature. Routing inbound email is a separate
Worker `email` event and does not enter this delivery pipeline.

## Verification and references

From the Base root, with the module's existing development dependency available:

```sh
node --test modules/mail/tests/events/verify.test.mjs
node --test modules/mail/tests/events/boundaries.test.mjs
node --test modules/mail/tests/events/workerd.test.mjs
```

If using an existing cached dependency in another checkout, set
`MAIL_MINIFLARE_MODULE` to its absolute `miniflare/dist/src/index.js` path; no
installation is required. Tests create/dispose actual workerd and SQLite-backed
Durable Objects, test races, atomic rollback and full runtime restart, and remove
their temporary storage. Provider fixtures and test routes exist only in tests.
The tests cover crypto in Node and workerd, but hosted proof remains
**PENDING**. No live provider API, mail, or deployment is exercised.

Primary contracts checked 6 October 2026:

* [SendGrid security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
* [SendGrid signed multipart](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks)
* [SendGrid event fields](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
* [Resend verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
* [Svix framing and published test vector](https://docs.svix.com/receiving/verifying-payloads/how-manual)
* [Resend recipient event scope](https://www.resend.com/changelog/webhook-event-visibility)
* [Cloudflare event schemas](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
* [Durable Object storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Messaging events and real D1 storage

```js
import { createDeliveryEventIntake, createD1EventStore } from './modules/mail/index.mjs';
const intake = createDeliveryEventIntake({
  provider: 'messaging', tenantId: trustedTenant, eventNamespace: 'messaging-link',
  messagingSource: {
    serviceOrigin: 'https://messaging.example.com',
    installId: localInstallId,
    jwks: pinnedEventJwks, // public ES256 keys obtained when linking
  },
  store: createD1EventStore({ db: env.DB }),
  authorize: event => ownsDelivery(event.deliveryId, event.providerMessageId,
    event.recipients, event.tenantId),
});
// Bound the read to 1 MiB before allocating; this is the actual compact JWS body.
const results = await intake.ingestWebhook({ rawBody, headers: request.headers });
```

For the exact independent wire format, signature envelope and closed detail
fields, see [Messaging v1](../adapters/messaging/README.md). `key` is forbidden for
this source. The event JWKS is copied when constructing intake; mutating the
caller configuration cannot change an existing trust root. No network lookup
runs during verification. Messaging's envelope clock tolerance is fixed at 60s;
the existing `toleranceSeconds` option still configures Resend/SendGrid only.
HTTPS service origins are required; explicit `mode:'test'|'development'` permits
HTTP loopback for local integration. The signature establishes the service and
installation; application authorization must still check every correlated
message and recipient. All schema validation and whole-batch authorization
finish before any SQL effect. Normalized `detail` is frozen before authorization.

Apply `src/events/d1-schema.sql` as a new application migration before using the
store. This additive schema owns only `rer_mail_event_receipts` and
`rer_mail_event_states`; it leaves existing application and DO storage intact.
Pass the constructed store as `store`, and omit `storage`. Existing DO users keep
`storage:ctx.storage` unchanged. The D1 store also accepts authenticated Resend,
SendGrid and Cloudflare intake; choosing the database does not change a source's
authentication boundary. Only the real D1 constructor's stores are accepted,
with no process-local fallback or arbitrary unverified normalizer.

Every `commit` issues exactly one D1 `batch()` containing all receipt inserts,
conditional recipient-state upserts and state reads. The D1 transaction is the
concurrency and rollback boundary; no process mutex or preliminary read is used.
Receipts have a primary key on `(provider,tenant_id,event_namespace,event_id)`.
A conflicting fingerprint intentionally violates the named
`rer_mail_event_identity_conflict` SQL CHECK; D1 rolls back the **whole batch**,
including receipts and states inserted earlier in it. Other SQL errors also roll
back the transaction and return a redacted `event_storage_failed` error.

Each insert carries a random commit token and its batch ordinal. Conditional
state writes require that exact receipt token/ordinal, so concurrent duplicates,
repeated events within one batch and post-restart retries cannot reapply state.
Receipt `event_json` stores the full normalized event, including correlation and
detail; state keys include provider, tenant, namespace, provider message ID and
case-preserved mailbox. Terminal-state ordering is the same as the DO store.
Stored result reads occur within the same batch, so each event's returned state
reflects its place in that batch. Duplicate results have no recipient effects.

D1 bind/statement limits still apply to the host's database. Oversized batches
fail atomically rather than being split into partial commits. Applications should
size service pushes accordingly. Receipts and state are retained until the app
explicitly prunes or erases them; this module has no implicit cleanup. The app
owns an atomic business workflow for any external effects after intake, just as
with the DO store.

`tests/events/d1-workerd.test.mjs` drives public intake against real workerd D1.
It covers signature/issuer/audience/key/time refusal, whole-batch schema and
ownership checks, duplicate/conflicting races, rollback after an earlier insert,
forced SQL failure rollback, restart duplicates, tenant/namespace isolation,
local-part case and terminal ordering. The existing DO/Queue smoke remains.
