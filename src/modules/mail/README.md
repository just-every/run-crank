# Portable mail

`index.mjs` is the IF-056-MAIL-v1 ESM entry, usable from Node and Workers without a build. Applications own authorization, verified sender setup, durable delivery policy, replay storage, attachment storage and inbox reconciliation. An accepted API submission is not proof of mailbox receipt.

```js
import { createMailSender } from './modules/mail/index.mjs';

// The provider credential is a deployment secret, read from the environment.
const { RESEND_API_KEY: apiKey } = env;
const sender = createMailSender({ provider: 'resend', mode: 'production', apiKey });
const result = await sender.send({
  deliveryId: durableCommand.id,
  from: 'Support <support@example.com>',
  to: ['recipient@example.net'],
  subject: 'Your requested sign-in link',
  text: 'Open the link you requested.',
});
```

## Adopting

A seed copies this module's runtime files byte for byte, to the same paths under its root, and records them in its source lock. Every seed copies the same one module: the remote transports and an explicit development suppression path. The same facade also supports optional signed Messaging links.

### Mail

Every seed copies these files. `index.mjs` loads all of them, including the development path below, so none can be left out.

```text
modules/mail/LICENSE
modules/mail/index.mjs
modules/mail/src/sender.mjs
modules/mail/src/core/errors.mjs
modules/mail/src/core/transport.mjs
modules/mail/src/core/validation.mjs
modules/mail/src/adapters/cloudflare/headers.mjs
modules/mail/src/adapters/cloudflare/index.mjs
modules/mail/src/adapters/cloudflare/response.mjs
modules/mail/src/adapters/resend/index.mjs
modules/mail/src/adapters/resend/response.mjs
modules/mail/src/adapters/resend/serialize.mjs
modules/mail/src/adapters/resend/size.mjs
modules/mail/src/adapters/sendgrid/index.mjs
modules/mail/src/adapters/sendgrid/serialize.mjs
modules/mail/src/adapters/rer/contract.mjs
modules/mail/src/adapters/rer/index.mjs
modules/mail/src/adapters/rer/list-headers.mjs
modules/mail/src/adapters/messaging/contract.mjs
modules/mail/src/adapters/messaging/event-schema.mjs
modules/mail/src/adapters/messaging/index.mjs
modules/mail/src/adapters/messaging/jws.mjs
modules/mail/src/adapters/messaging/request.mjs
modules/mail/src/adapters/messaging/serialize.mjs
modules/mail/src/unsubscribe/index.mjs
modules/mail/src/events/index.mjs
modules/mail/src/events/intake.mjs
modules/mail/src/events/storage.mjs
modules/mail/src/events/d1-storage.mjs
modules/mail/src/events/verify.mjs
modules/mail/src/inbound/bytes.mjs
modules/mail/src/inbound/headers.mjs
modules/mail/src/inbound/index.mjs
modules/mail/src/inbound/mime.mjs
modules/mail/src/inbound/multipart.mjs
modules/mail/src/inbound/resend-attachment.mjs
modules/mail/src/inbound/resend.mjs
modules/mail/src/inbound/sendgrid.mjs
modules/mail/src/doctor/common.mjs
modules/mail/src/doctor/dns.mjs
modules/mail/src/doctor/index.mjs
modules/mail/src/doctor/probe.mjs
modules/mail/src/doctor/receive.mjs
modules/mail/src/doctor/records.mjs
```

### Development delivery

Copy the development entry with the facade. Its sender validates messages and silently suppresses them. Preserve the schema and storage reader when an installation has historical development mail.

```text
modules/mail/src/development/
```

### D1 event intake

For durable delivery-event intake on D1, copy this additive schema into a new
application migration and apply it before using `createD1EventStore`. It is
separate from the JavaScript runtime files and the local outbox migration.

```text
modules/mail/src/events/d1-schema.sql
```

### Sign-in mail

Sign-in mail is the seed's own wiring around the two things above, not a copy of module files. The reference is the Base default seed; adapt these files for the seed's own auth and keep its own database binding and migration directory:

```text
default-seed/src/core/platform/auth/mail.server.mjs
default-seed/migrations/core/0004_development_outbox.sql
```

`mail.server.mjs` builds the production sender from `MAIL_PROVIDER` (`resend`, `sendgrid` or `cloudflare`). Explicit development and demo configuration suppress mail before selecting any configured remote sender. The migration preserves historical local messages.

### Former sendgrid-email API

A seed that already calls the former sendgrid-email module copies these two files as well, and changes its import from `modules/sendgrid-email/sender` to `modules/mail/src/sendgrid-email/index.mjs`. The exports (`sendSendGrid`, `serializeSendGridMessage`, `SendGridSendError`, `SendGridMessage`) are unchanged. A seed with no such calls does not copy them; new code uses `createMailSender` with `provider: 'sendgrid'`. See [the former sendgrid-email API](#the-former-sendgrid-email-api).

```text
modules/mail/src/sendgrid-email/index.mjs
modules/mail/src/sendgrid-email/index.d.mts
```

### Not copied

These are for developing the module itself or documentation. A seed may keep any of them for reference:

- `modules/mail/tests/`, `modules/mail/live-proof/`, `modules/mail/doctor.mjs`
- `modules/mail/package.json`, `modules/mail/pnpm-lock.yaml`, `modules/mail/.gitignore`
- `modules/mail/README.md` and every `README.md` under `modules/mail/src/`

The provider is explicit: `sendgrid`, `resend`, `cloudflare`, `rer`, `messaging`, or `development`.
`mode` is required (`production`, `development`, or `test`). SendGrid, Resend, Cloudflare and RER require `apiKey`; Cloudflare additionally requires a 32-hex `accountId`. Messaging instead requires its signed-link configuration (`serviceOrigin`, `installId`, `kid` and `signingKey`) and rejects `apiKey` and `accountId`. A remote provider in test/development mode still makes a real provider request unless the caller explicitly supplies a test fetch. Missing credentials, validation errors, or provider failure never select another provider. Config and messages reject unknown fields so requested features cannot silently disappear.

`createMailSender(config, dependencies?)` returns `{send(message)}`. Dependencies are optional standard `fetch`, `clock: () => epochMilliseconds`, and `timeoutMilliseconds` (a positive safe integer bounding each remote attempt; the default is 15,000). Production normally uses global fetch. Direct provider endpoints are fixed; `rer` uses its assigned relay URL. No retry or automatic replay exists. The sender snapshots configuration at construction and the message at submission.

### Managed mail through RER

Seeds opt into Managed mail with `mail: {providers: ["rer"]}` in their candidate
deployment spec. The [delivery producer](https://github.com/runeditrun/base/blob/main/modules/delivery-producer/README.md#managed-mail)
can generate the matching setup fields. RER assigns public `MAIL_PROVIDER`,
`MAIL_FROM`, `MAIL_RELAY_URL` and private `MAIL_API_KEY`; Managed owners do not
enter them. Wire those settings into the shared sender:

```js
const sender = createMailSender({
  provider: env.MAIL_PROVIDER, // rer
  mode: 'production',
  apiKey: env.MAIL_API_KEY,
  relayUrl: env.MAIL_RELAY_URL,
});
await sender.send({
  deliveryId: durableCommand.id,
  from: env.MAIL_FROM,
  to: ['recipient@example.net'],
  subject: 'Your requested sign-in link',
  text: 'Open the link you requested.',
});
```

Pass `relayUrl` only for `rer`. It must be the assigned HTTPS URL, without URL
credentials, query or fragment. The adapter sends one POST with Bearer
authentication and `redirect: 'manual'` (Cloudflare Workers reject
`redirect: 'error'`); a 3xx is never followed. Its JSON contains one mailbox `to`,
`subject`, `text` and optional nonempty `html`. RER owns the sender and
installation identity; `from` and `deliveryId` are not transmitted. Subjects
must be nonempty, without newlines and at most 200 characters. Plain text is
required; each body is limited to 65,536 characters and the JSON to 128 KiB.

The relay sets `Auto-Submitted: auto-generated` on every message, so the
adapter accepts that header and does not transmit it; other `Auto-Submitted`
values are refused. `List-Unsubscribe` (one or two `<https:…>`/`<mailto:…>`
entries, at most 2,000 characters) travels as `listUnsubscribe`, and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` as `listUnsubscribePost:
true`, which requires an HTTPS entry. The structured `unsubscribe` request
assembles the same headers.

`List-Id`, `List-Archive`, `List-Help`, `In-Reply-To` and `References` travel as
`listId`, `listArchive`, `listHelp`, `inReplyTo` and `references`, respectively.
They match platform's relay validation at `098ba40` (`src/managed-mail/headers.ts`):
each is a string of at most 2,000 characters, without newlines or controls.
`List-Id` accepts an optional ASCII phrase or quoted display name followed by an
angle-bracketed ASCII dot-atom identifier containing a dot (at most 255
characters). `List-Archive` and `List-Help` accept one or two angle-bracketed
HTTPS or mailto URLs, using the relay's URL and mailbox checks. These three
headers allow separator tabs. `In-Reply-To` accepts exactly one `<local@domain>`
message ID with ASCII dot-atoms or a bracketed domain literal. `References`
accepts 1–20 such IDs separated by ASCII spaces, without leading/trailing
spaces, tabs or commas. Invalid values fail locally with `invalid_list_id`,
`invalid_list_archive`, `invalid_list_help`, `invalid_in_reply_to` or
`invalid_references`. Values are preserved; raw headers are never forwarded.
Other recipients, attachments, reply-to and every other header, including
`Message-ID`, are unsupported and fail before dispatch.

An optional `messageKey` asks the relay to assign the Message-ID: 1–200 ASCII
characters from `A-Z a-z 0-9 . _ : -`, matching platform's relay validation at
`c1e3ade` (`src/managed-mail/headers.ts:22`); anything else fails locally with
`invalid_message_key`. The relay derives the same ID for the same installation
and key, so use one key per message (for example `incident:7:opened`, then
`incident:7:update-1`). Keys assign identity, not duplicate suppression. To
thread updates, keep the first notice's returned `providerMessageId` and send
each later update with its own key and `In-Reply-To`/`References` set to it.
Only `rer` (and `development`, which accepts what `rer` accepts) takes
`messageKey`; other providers refuse it with `unsupported_provider_setting`.

HTTP 202 returns `accepted` with the relay's assigned Message-ID (for example
`<ABCD…@mail.example.com>`) as `providerMessageId`, or null when the relay's
body carries no valid one. HTTP 400, 401, 402,
403 and 413 return `rejected`, and so does any 3xx (`provider_redirected`);
429 returns `rate_limited`; 502 and 503 return `uncertain`. Network failures
are also `uncertain`.
The usual application delivery policy decides whether to retry or stop; the
adapter makes no retries and never reads or logs provider error bodies.

## Message and results

Required fields: `deliveryId` (nonempty, at most 512 characters), `from`, nonempty `to: string[]`, `subject: string` (SendGrid requires nonempty; RER requires nonblank and at most 200 characters; other providers allow empty), and at least one nonempty `text` or `html`. Addresses accept a mailbox or `Display Name <mailbox>`; the conservative mailbox grammar rejects controls, multiple addresses inside one string and malformed domains. Use arrays for recipients.

Optional `cc`, `bcc`, `replyTo`, and string-valued `headers` preserve envelope and threading. `In-Reply-To` and ordered `References` can be supplied as headers. SendGrid and Resend also accept `Message-ID`; Cloudflare generates it and rejects a caller-supplied value; `rer` rejects it and assigns one from an optional `messageKey`. CR/LF/control characters, duplicate header names ignoring case, reserved envelope/MIME/security headers and invalid header names fail before a request. Provider-specific header restrictions are also enforced.

Attachments use `{filename, contentType, content: Uint8Array, disposition?: 'attachment'|'inline', contentId?}`. Content is raw bytes, never a base64 string at the public boundary. Inline attachments require a content ID. Unsupported attachment features fail explicitly. Provider size and count limits still apply.

Resend checks a conservative 40,000,000-byte total email budget before Base64 or
JSON encoding, including UTF-8 bodies, all recipients/headers, aggregate Base64
attachments and MIME overhead. Its final JSON request is capped at 39,000,000
UTF-8 bytes. Oversize input throws `MailValidationError` with fixed code
`resend_message_too_large` before dispatch. See the precise
[Resend size budget](src/adapters/resend/README.md#outbound-size-budget); it is a
local guard and may reject input below the provider's maximum.

SendGrid additionally supports `customArgs: Record<string,string>`, positive safe-integer `asmGroupId`, and boolean `subscriptionTracking`. The custom argument JSON including `rer_delivery_id` is limited to 10,000 UTF-8 bytes. Caller arguments cannot replace `rer_delivery_id`, `email`, `event`, `timestamp`, `sg_event_id`, or `sg_message_id`. Resend and Cloudflare reject these SendGrid-only settings, including empty `customArgs` and `subscriptionTracking: false`.

`send` returns `{provider,status,providerMessageId,code?,recipientResults?}`. Status is `accepted`, `rejected`, `rate_limited`, `uncertain`, or `development`. `providerMessageId` is a real provider receipt or null; local correlation never fabricates one. A validation/configuration error throws a redacted error with a fixed code. Errors/results never expose raw provider response bodies or credentials.

- SendGrid requires HTTP 202 for acceptance. Its `X-Message-Id` is nullable. `rer_delivery_id` is correlation, not duplicate suppression. Click, open, and Google Analytics tracking are disabled; subscription tracking is enabled only when requested. `serializeSendGridMessage(message)` exposes validated wire bytes for callers that own durable fingerprints.
- Resend uses `deliveryId` as `Idempotency-Key` and preserves the returned ID. Resend retains idempotency keys for 24 hours; a reused key with a different payload conflicts. This module does not retry or assume indefinite duplicate suppression. See [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
- Cloudflare uses the [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/), separate from Email Routing's restricted send binding. Both `success` and recipient result data are checked. Partial recipient outcomes remain visible in `recipientResults`; API send results do not assert actual inbox receipt.

Network loss, redirects, HTTP 408 and 5xx are conservatively `uncertain`; 429 is `rate_limited`, and other definite 4xx rejection is `rejected`. Provider success statuses require their documented semantics. Reconcile uncertain attempts before deciding whether a new submission is safe. No adapter retries or follows redirects.

## Development and unsubscribe

Development requires `provider:'development'` and `mode:'development'`.
It validates the prepared message and silently suppresses delivery, returning
`development` without contacting a provider or storing the message. Production
must never select development mode after missing credentials or a send failure.

`createD1DevelopmentOutbox({db,maxMessages?,maxAgeMs?,clock?})` remains available
for reading and erasing mail retained by older local installations. There is no
outbox viewer or development sign-in mail flow. Keep applied migrations.

`put(preparedMessage)` resolves without a receipt; `list()` returns captures
newest first, and `get(id)` returns a capture or `null`. A capture is
`{id,createdAt,message}`, with epoch milliseconds and a unique capture ID.
Repeated delivery IDs remain separate captures. Attachment content returns as
`Uint8Array`; storage encodes those bytes losslessly as base64 inside JSON.
The default retention is 100 messages and seven days. Both limits must be
positive safe integers. Every read and write prunes age and count in the same
D1 batch as the operation; a message expires exactly at `createdAt + maxAgeMs`.
Equal timestamps retain the most recently inserted captures first. A failing
batch fails the operation without a process-memory fallback.

First-party seeds route local setup through `rer setup` and declare their actual
mail, auth, database and migration behavior in the RER adapter. Follow the
runnable checkout's root `RUN-LOCALLY.md` for its command and state requirements.

`unsubscribe: {url, mailto?, oneClick?}` supplies an HTTPS unsubscribe URL and optional mailbox. One-click generates `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Insecure URLs, injection and contradictory custom unsubscribe headers fail before dispatch. `applyUnsubscribeHeaders(message)` returns a new prepared message with the `unsubscribe` request removed. Passing an already prepared message to the facade is safe. Direct adapters reject unconsumed requests before any effect; the facade performs assembly once before dispatch. Applications own unsubscribe authorization and processing. Confirm delivered headers and DKIM coverage with a real delivered message; local serialization is not one-click acceptance.

## Optional Messaging link

```js
const sender = createMailSender({
  provider: 'messaging', mode: 'production',
  serviceOrigin: 'https://messaging.example.com', installId, kid, signingKey,
});
const result = await sender.send({ ...message, kind: 'transactional',
  expiresAt: '2027-01-01T12:00:00Z' });
const receipt = await sender.reconcile(message.deliveryId); // null on scoped 404
await sender.erase('Reader@example.net');
```

The ES256 private JWK belongs to this application. The application holds no
Messaging API key or underlying provider key. A Worker may supply
`{serviceBinding:env.MESSAGING}` as the second argument; requests still carry the
same signature. The linked path makes one request, including on timeout; it never
falls back to a provider or development outbox. Preserve durable delivery IDs and
use reconciliation after an uncertain result. For same-account public Worker
fetches, configure `global_fetch_strictly_public`; the optional binding avoids
that public fetch requirement. Neither path changes the signature contract.

Messaging requires exactly one `to` recipient and a granted `kind` (`auth`,
`transactional`, `bulk`). It carries optional RFC3339 `expiresAt`; direct providers
reject these service-only fields because they cannot promise expiry. Base
preserves attachment bytes and prepares unsubscribe headers before signing.
Applications own consent, unsubscribes, business ledgers and retry scheduling.
A rate-limited `retryAfter` is an absolute epoch timestamp in seconds. A synchronous
suppression includes its reason and must be applied to the application's ledger.

[The Messaging contract](src/adapters/messaging/README.md) defines every signed
byte, result, error, reconcile and erasure shape, plus pinned event JWS intake.
For a D1 application, copy `src/events/d1-schema.sql` into a **new** migration and
use [the D1 event constructor](src/events/README.md). No migration, linking,
provider switch or credential removal happens automatically. Self-hosted installs
stay unlinked until the owner configures them; local development still uses the
explicit development suppression without a Messaging service.

## The former sendgrid-email API

The former sendgrid-email module was a second SendGrid transport. It is now deprecated and re-exports this module, so the repository holds one transport. [`src/sendgrid-email/index.mjs`](src/sendgrid-email/index.mjs) keeps the former API for existing adopters, typed by `index.d.mts`, and builds every request with this module's one SendGrid adapter. Both import paths therefore send identical requests; `modules/sendgrid-email/tests/equivalence.test.ts` proves it against a fake SendGrid API.

Switch the import and nothing else:

```ts
// before
import { sendSendGrid, serializeSendGridMessage, SendGridSendError } from './modules/sendgrid-email/sender'
// after
import { sendSendGrid, serializeSendGridMessage, SendGridSendError } from './modules/mail/src/sendgrid-email/index.mjs'
```

New code should use `createMailSender({ provider: 'sendgrid', mode: 'production', apiKey })`, which returns a structured result instead of throwing.

The former shape is unchanged. `sendSendGrid({ apiKey, message, fetch?, timeoutMilliseconds? })` makes one attempt and resolves `{ provider: 'sendgrid', providerMessageId, state: 'accepted' }` on HTTP 202; `providerMessageId` is null when the receipt is missing or malformed. Anything else throws `SendGridSendError` with an `outcome` and the HTTP `status` when there was one: `rejected` (definite 4xx or invalid input, never sent), `rate_limited` (429) or `ambiguous` (network loss, timeout, 408, 5xx, redirect or any other non-202 status; reconcile before resending). Messages carry `deliveryId`, `from`, `to`, `subject`, `text` and optionally `html`, `replyTo`, `headers`, `customArgs`, `asmGroupId`, `subscriptionTracking` and base64 `attachments` (`{content, filename, type?}`). `serializeSendGridMessage` returns the validated wire bytes for claim fingerprints. `timeoutMilliseconds` is the dependency of the same name described above.

Because the one adapter now builds the request, the former module takes this module's validation. Input the provider would refuse is refused earlier and with a fixed code, never echoing values: an empty subject, empty text or attachment content, duplicate recipients, a sender with non-ASCII characters in the mailbox, header names outside the token grammar, `Mime-Version`, `Return-Path` and `Sender` headers, and an API key containing whitespace. Attachment content is decoded from base64 and written back in canonical padded form, and an attachment without `type` is sent with the generic binary content type, octet-stream. Attachment members are written in this module's order (`content`, `type`, `filename`, `disposition`), so a durable fingerprint of a message with attachments taken before the switch will not match one taken after. A message without attachments serializes to the same bytes as before. Consumers that stored receipts as strings must allow null after acceptance, keep durable correlation in `rer_delivery_id`, and never replace a missing remote receipt with that local identity.

## Verified events and inbound mail

`verifyWebhook({provider,rawBody,headers,key,now,toleranceSeconds?})` returns a boolean. Providers are `sendgrid` and `resend`; `rawBody` is the exact `Uint8Array`, `headers` a `Headers`, and `now` epoch milliseconds. Default clock tolerance is 300 seconds. SendGrid uses base64 SPKI P-256 public keys and DER ECDSA signatures over timestamp plus exact bytes; Resend uses a `whsec_` base64 HMAC secret and Svix framing. Never decode and reserialize JSON or multipart before verification. Signature validity alone establishes neither schema validity nor sender identity. `MAX_WEBHOOK_BYTES` exports the 32 MiB verifier bound; delivery-event intake has its own 1 MiB bound. `createDeliveryEventIntake({provider,tenantId,eventNamespace,key?,storage,authorize,clock?,cloudflareSource?})` verifies, authorizes, then commits receipts and recipient states in one durable transaction. It exposes `ingestWebhook({rawBody,headers})` for SendGrid/Resend or `consumeQueue(batch)` for the trusted Cloudflare queue boundary. Supply actual serializable durable storage (Durable Object SQLite, or `store:createD1EventStore({db:env.DB})` with its additive migration); there is no process-local fallback. See the [event integration contract](src/events/README.md) for atomic deduplication and recipient reconciliation.

`normalizeInbound(input, limits)` returns `{provider,messageId,from,to,subject,text,html,inReplyTo,references,attachments}`. Nullable fields remain null, empty subject remains valid, references retain order, and attachment content remains decoded bytes. Required positive-integer limits are `maxRawBytes`, `maxBodyBytes`, `maxAttachments`, `maxAttachmentBytes`, and `maxTotalAttachmentBytes`; limits apply to actual bytes, including streams and decoded attachments. Over-limit/malformed messages fail atomically.

Inputs are Cloudflare `{provider:'cloudflare',message:{from,to,headers,raw,rawSize}}` from a Worker email handler, SendGrid `{provider:'sendgrid',rawBody,contentType}` after original multipart signature verification, or Resend `{provider:'resend',email,signedEmailId,fetchAttachment?}` after a verified `email.received` event and checked hydration identity. No unsigned HTTP JSON receiver is provided. Cloudflare delivery events use a trusted Event Subscriptions Queue boundary, never an invented HTTP signature. See [inbound dependencies and trust boundaries](src/inbound/README.md), `signedEmailId` must come from the authenticated event, not the hydrated response. The facade exports `createResendAttachmentFetcher({apiKey,maxAttachmentBytes}, {fetch?,clock?})` for the explicit `fetchAttachment` dependency; it validates metadata, fixed provider/CDN origins, size and redirects. No attachment may be silently omitted.

## Doctor and live proof

`mailDoctor({domain,provider,dnsRecords?,live:false}, dependencies?)` returns six items (`mx`, `spf`, `dkim`, `dmarc`, `send`, `receive`) with status, next steps, optional records and safe evidence. Plans are not observations: without probes records remain pending/not checked. DNS values must come from provider setup or supplied records; DKIM keys/selectors are never invented. Missing credentials are actionable, never a pass.

```sh
node modules/mail/doctor.mjs --domain mail.example.com --provider resend --plan --json
node modules/mail/doctor.mjs --domain mail.example.com --provider resend --plan
```

Both plan commands are offline and require no credentials. See [doctor dependencies and explicit live invocation](src/doctor/README.md) for DNS checking and bounded send/receive correlation. A send response cannot make receive pass. The protected [live-proof contract](live-proof/README.md) names the exact runner command and receipt path; its evidence writer uses `EVIDENCE_WRITE_TOKEN`. Hosted workflow wiring and all owner-controlled credentials/resources remain separate integration work.

## Verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir modules/mail install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm --dir modules/mail test
pnpm verify:modules
pnpm --dir modules/mail test:workerd
```

The root install is also required for the bundle regression, which uses the reference app's actual Vite dependency. The facade formerly re-exported the doctor while the doctor dynamically imported the facade, causing Vite's `INEFFECTIVE_DYNAMIC_IMPORT` warning. Both now import a private sender module; the existing facade exports and send behavior remain unchanged. `tests/development/bundle.test.mjs` builds the facade and doctor with Vite and fails on that warning.

The module-local lock pins the Miniflare/workerd test runtime; production source has no npm dependencies. Unit suites cover core validation, adapters, events, inbound parsing, development, unsubscribe and doctor behaviour. The Messaging HTTP/service-binding smoke and real D1 intake race/rollback/restart suite join the existing area smokes. They check core portability, remote adapters, inbound hydration, durable event intake, historical development storage and doctor/facade assembly. The storage smokes retain real transaction rollback, namespace isolation, restart and suppression coverage. `tests/all.test.ts` runs the nested suites serially through `pnpm verify:modules`; each worker is disposed after its run. Former SendGrid API tests remain while seed source still imports the deprecated module.

Local conformance does not establish provider configuration, DNS propagation, deployed webhook reachability, DKIM coverage or mailbox delivery. Live acceptance remains **PENDING** until an exact-SHA hosted run sends and receives on the owner's approved test domain with independently correlated mailbox evidence. Resend is the default test sender; SendGrid is selected where Inbound Parse is required. No live request is authorized by running local tests.
