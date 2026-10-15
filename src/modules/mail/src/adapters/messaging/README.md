# Messaging v1 wire and Base client

Normative phase-1 wire choices for independent implementations and the concurrent
Messaging core. Linking, production credentials and deployment are separate.

`createMailSender({provider:'messaging', mode, serviceOrigin, installId, kid,
signingKey}, {fetch?, serviceBinding?, clock?, timeoutMilliseconds?})` exposes
`send(message)`, `reconcile(deliveryId)`, and `erase(address)`. `signingKey` is a
private ES256 P-256 JWK; no API key or direct provider settings are allowed.
Configuration and each message are snapshotted before asynchronous work.
`serviceOrigin` is an exact HTTPS origin (HTTP loopback only in test/development).
A `serviceBinding` is a Worker Fetcher with `fetch`; it replaces the HTTP edge,
never signature authentication. Do not configure both fetch and serviceBinding.

Every request has `RER-Signature: <compact JWS>`. Protected header is
`{alg:'ES256',kid,typ:'JWT'}`. Claims are `{iss:installId,aud:serviceOrigin,
iat:<integer epoch seconds>,method,path,bodySha256:<lowercase SHA-256 hex>}`.
The signature is the JOSE 64-byte P1363 ECDSA signature. Hash the exact UTF-8
request bytes; GET hashes zero bytes. Path is the URL's encoded pathname,
including `encodeURIComponent(deliveryId)` for reconciliation. Request verification
permits iat within +/-60 seconds. Never follow redirects or retry automatically.

`POST /v1/mail`: JSON fields `deliveryId`, required `kind` (`auth`,
`transactional`, `bulk`), `from`, `to` (ONE address string, not array), `subject`,
optional `replyTo`, `text`, `html`, `headers`, `attachments`, `expiresAt`.
Base's public message still uses a one-element `to` array. `cc`/`bcc` are refused.
Messaging delivery IDs retain Base's 512-character limit and must have no
surrounding whitespace, so sends can be reconciled and correlated with events.
Internal spaces, Unicode, slashes, query and fragment characters are preserved;
`.` and `..` and strings that cannot be URL-encoded are refused before dispatch.
Address strings preserve display names and local-part case. `expiresAt` is an
RFC3339 timestamp; Base carries it only for Messaging (other transports cannot
promise expiry). Attachments are `{filename,contentType,content:<canonical padded
base64>,disposition?,contentId?}`; no byte conversion through text. Text plus HTML
is at most 1 MiB UTF-8; decoded attachments total at most 5 MiB; entire JSON body
at most 8 MiB. Headers are Base's allowed subset of `List-*`, `Auto-Submitted`,
`In-Reply-To`, `References`, `Message-ID`, `X-*`; `replyTo` supplies Reply-To.
Base applies its unsubscribe assembly before signing.

The send response is the JSON result itself, without an envelope:
`{provider:'messaging',status,providerMessageId,code?,suppression?,retryAfter?}`.
Accepted has a nonempty Messaging message id and no code. Development has null
providerMessageId and no code. All other states have null providerMessageId.
Rejected codes: suppressed, kind_not_granted, sender_not_granted, app_paused,
invalid, unsubscribe_missing, expired, provider_rejected_recipient, key_reused.
Only suppressed requires `suppression: hard_bounce|complaint|provider`.
Rate-limited codes: app_cap, recipient_limit, provider_rate_limited,
providers_unavailable; these require `retryAfter`, an integer epoch timestamp in
seconds (schedule at this time, not a duration). Uncertain codes: ambiguous,
in_progress, orphaned; in_progress requires retryAfter, other uncertain codes
may carry it. No other fields or status/code combinations are accepted.
Application responses are HTTP 200. HTTP errors, malformed/overlong response
bodies, timeouts and network failures map to uncertain/ambiguous without echoing
response fields or issuing a second request. The default client deadline is 15s,
including body reading; Messaging's own send budget is 10s.

`GET /v1/messages/{deliveryId}` sends no body. HTTP 200 returns
`{deliveryId,messageId,state,result,attempts,lastEvent}`; state is sending or a
send-result status, result is null while sending and otherwise the above result.
Attempts are `{provider,outcome,httpStatus,code,durationMs}`: provider is resend,
sendgrid, cloudflare or development; outcome is started, accepted, rejected,
rate_limited or uncertain; HTTP status and code may be null; durationMs is a
nonnegative integer or null. `lastEvent` is null or the event object below.
An authenticated 404 returns null. Other failures throw a fixed redacted
MailValidationError; they do not imply a send outcome.

`POST /v1/erase` sends exactly `{address:<bare mailbox preserving case>}`;
HTTP 200 returns `{erased:true}`. Erasure is idempotent and scoped by signed iss.
Failures throw a fixed redacted error; a timeout does not prove erasure failed.

## Event wire

The raw POST body is the compact JWS itself (UTF-8), not JSON wrapping it.
Protected header is `{alg:'ES256',kid,typ:'JWT'}`. Payload is
`{iss:serviceOrigin,aud:installId,iat:<integer epoch seconds>,events:[...]}`.
Each event is `{id,messageId,deliveryId,recipient,occurredAt,type,detail}`.
Recipient is a bare mailbox with local-part case preserved; occurredAt is RFC3339.
Types: accepted, delivered, deferred, bounced, complained, failed, suppressed.
`detail` is a closed object, with optional `bounce: 'hard'|'soft'`,
`suppression: 'hard_bounce'|'complaint'|'provider'`, and `code` (a bounded machine
code matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`). Bounce classification is allowed
only on bounced; suppression only on suppressed. No free-form provider text.

Intake uses `messagingSource:{serviceOrigin,installId,jwks:{keys:[publicJwk,...]}}`
pinned at link time. No remote key lookup, jku, x5u, embedded jwk, algorithm
negotiation or unsigned JSON ingestion. Key rotation replaces the configured
pinned set. Signature, issuer, audience and +/-60s iat are checked before events
have any effect. Each normalized record carries `eventId:id`,
`providerMessageId:messageId`, `deliveryId`, `recipients:[recipient]`, `detail`,
and `status:type` except suppressed maps to rejected. Stable receipts fingerprint
the validated event fields in fixed order, independent of batch order, envelope
clock, signing key rotation or JSON property order. A changed field conflicts.
