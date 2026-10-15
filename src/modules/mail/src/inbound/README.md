# Inbound normalization

Import `normalizeInbound` from `modules/mail/src/inbound/index.mjs` (also exposed
by the assembled mail facade). It returns the frozen `InboundMessage` contract.
These are transport parsers, not authentication or HTTP handlers. No route or
persistent storage is installed. HTML, text, filenames and sender claims remain
untrusted content; the consuming application owns rendering sanitization,
authorization, deduplication, durable quarantine and sender-authentication policy.

## Trust boundary and provider inputs

- Cloudflare: call only from the Worker `email(message, env, ctx)` event, passing
  `{provider:'cloudflare', message}`. The real `raw` byte stream is parsed; its
  actual length must equal `rawSize`. `from` and `to` are the SMTP envelope values.
  Headers and threading come from the original MIME stream, avoiding synthetic
  JSON conversion and duplicate-header loss through `Headers`.
- SendGrid: bound and retain the original HTTP multipart bytes, authenticate
  those exact bytes with the configured Inbound Parse signature key, then pass
  `{provider:'sendgrid', rawBody:Uint8Array, contentType}`. Never call parsing or
  store/hydrate a message before successful verification. The normalizer accepts
  both parsed fields/binary attachment parts and the provider's raw `email`
  field. Duplicate fields, mismatched attachment counts/metadata, malformed
  boundaries and invalid transfer encoding reject the whole message.
- Resend: verify the exact Svix webhook bytes, validate `type:'email.received'`,
  and extract the authenticated event's `data.email_id`. Only then retrieve
  `GET https://api.resend.com/emails/receiving/{email_id}?html_format=cid` using
  the fixed API origin, an authorized server credential, a bounded response
  reader, a deadline and `redirect:'manual'`. Pass the response object as `email`
  and the original authenticated ID as **`signedEmailId`**. The normalizer
  requires `email.id === signedEmailId` before any attachment callback. Do not
  fill `signedEmailId` from the hydrated response. Requesting `html_format=cid`
  preserves original inline image references across providers; the normalizer
  preserves the returned HTML and does not rewrite provider data-URI HTML.

A successful webhook signature authenticates the provider's transport, not the
person named in the mail's From header. Supplying a `signedEmailId` value does
not perform cryptographic verification; the verified caller is the trust boundary.
The events unit owns `verifyWebhook`. This unit neither fabricates verification
nor retries a failed transport.

## Resend attachment hydration

Resend's received-email response contains attachment metadata, not file bytes.
Every entry requires `id`, `filename`, `content_type`, a nonnegative integer
`size`, and optional `content_disposition` / `content_id`. Supply an asynchronous
`fetchAttachment(attachment) -> Uint8Array` on the input when attachments exist.
The callback receives a frozen object containing only
`{emailId,id,filename,content_type,content_disposition,content_id,size}`. Provider
IDs are bounded safe path segments; URLs and arbitrary response fields are not
passed through. All message metadata and declared aggregate limits are checked
before the first callback. Missing hydration, duplicate IDs, oversized bytes,
or actual length differing from `size` fail the entire result. Callbacks must
be read-only: an eventual failure cannot undo a caller's storage side effects.

A real safe implementation is included:

```js
import { normalizeInbound, createResendAttachmentFetcher } from './index.mjs';
// After verified event validation and identity-bound email retrieval:
const fetchAttachment = createResendAttachmentFetcher({
  apiKey, maxAttachmentBytes: limits.maxAttachmentBytes,
});
const message = await normalizeInbound({
  provider: 'resend', signedEmailId, email, fetchAttachment,
}, limits);
```

`createResendAttachmentFetcher({apiKey,maxAttachmentBytes}, {fetch?,clock?})`
uses the fixed Resend attachment API and verifies returned ID, filename, MIME
metadata and size against the received-email entry. It permits only the documented
`https://inbound-cdn.resend.com/{emailId}/attachments/{id}` download location,
requires an unexpired URL, refuses redirects on both requests, and sends the
API credential only to `api.resend.com`. The download request has no authorization
headers. API metadata is bounded to 64 KiB; streamed content is bounded by the
expected size and configured attachment limit. One 15-second abort deadline
covers both requests and bodies. Errors are fixed and redacted. There is no
configurable arbitrary download origin. A provider CDN contract change fails
closed and requires an explicit source update.

A custom callback must enforce the same identity/metadata, origin, redirect,
timeout and streaming checks. A callback is trusted application code, not
untrusted webhook input. Neither helper retrieves email metadata before the
caller has verified the webhook.

## Limits and normalization details

All five limit values must be positive safe integers. Exact limits succeed.
`maxRawBytes` measures actual Cloudflare stream bytes or SendGrid multipart bytes,
and checks Cloudflare's claimed size too. For Resend's object input it measures
the UTF-8 JSON serialization of the hydrated response; this is not a claim to
have inspected the original SMTP message or the original HTTP whitespace.
The caller must also bound the actual HTTP response stream during hydration.
Downloaded files have separate individual and aggregate actual-byte limits.

`maxBodyBytes` is aggregate text plus HTML, checked against both decoded source
bytes and the resulting UTF-8 bytes (the larger size for each body part).
`maxAttachments`, `maxAttachmentBytes`, and `maxTotalAttachmentBytes` apply to
all decoded files, including inline and unnamed MIME parts. Both claimed Resend
sizes and actual hydrated bytes are checked. Results are returned only after
all parsing and hydration succeeds; errors never contain partial messages.
Oversized Cloudflare/download streams are cancelled.

MIME supports nested multipart alternatives/mixed/related, folded headers,
RFC 2047 encoded words, RFC 2231 extended/continued filenames, base64,
quoted-printable, 7bit/8bit/binary and Web `TextDecoder` character sets. Invalid
encodings, duplicate singleton headers, incomplete multiparts and nesting over
30 levels fail closed. Multiple body parts of the same media type are joined
with a newline, which also counts toward the output body limit. Unsupported
media types are retained as attachments instead of silently discarded.

Output addresses are mailbox addresses (display names are parsed but not
returned). Cloudflare uses its event envelope; SendGrid and Resend use their
provided sender/recipient fields. Empty subjects are preserved; absent optional
thread/body fields use null or empty arrays. Message-ID and ordered References
retain their angle-bracket values. Content-IDs are normalized without angle
brackets; an absent content ID is null. Unnamed MIME files retain filename `''`.
No caller-owned input objects or attachment buffers are mutated.

## Checks and references

From the Base worktree:

```sh
node --test modules/mail/tests/inbound/normalization.test.mjs modules/mail/tests/inbound/boundaries.test.mjs modules/mail/tests/inbound/hydration.test.mjs
node --test modules/mail/tests/inbound/workerd.test.mjs
```

The latter uses actual workerd through the module's Miniflare harness without
Node compatibility, with three provider fixtures and the safe hydration protocol.
Fixtures and provider responses live only under `./tests/inbound`. These checks do
not prove hosted mail receipt; owner-authorized domain, provider configuration,
signed routing and send/receive correlation evidence remain separate acceptance.

Provider schemas consulted: [Cloudflare email event](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
[SendGrid Inbound Parse fields](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook),
[Resend received email](https://resend.com/docs/api-reference/emails/retrieve-received-email),
and [Resend attachment metadata/download](https://resend.com/docs/api-reference/emails/retrieve-received-email-attachment).
