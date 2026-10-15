# Resend outbound adapter

`sendResend(config, message, dependencies = {})` exports the portable, single
submission adapter from `index.mjs`. Use the mail facade for ordinary sends and
unsubscribe assembly. Direct calls validate configuration and the message through
the real core helpers before any request. No SDK, Node API or build is required.

The adapter submits JSON to `https://api.resend.com/emails` using `POST` and
`Authorization: Bearer <apiKey>`. Envelope display names, `to`, `cc`, `bcc`, subject,
text/HTML, `reply_to` and validated custom/thread headers are preserved. Names with
mailbox delimiters are quoted. Omitted text allows Resend's HTML-to-text generation;
an explicit empty text string disables that generation. At most 50 `to` recipients
are accepted. [Send API](https://resend.com/docs/api-reference/emails/send-email)

Attachments carry the original filename, Base64-encoded bytes and `content_type`.
An inline attachment requires `contentId`; this becomes `content_id`. With no
explicit disposition, a supplied content ID selects inline delivery. Without an
ID the attachment is ordinary. Explicit `disposition: 'attachment'` together with
an ID is rejected as `unsupported_resend_attachment_disposition`: Resend has no
independent send disposition field. No remote attachment URLs are fetched.
[Wire schema](https://github.com/resend/resend-openapi/blob/main/resend.yaml)
and [inline images](https://resend.com/docs/dashboard/emails/embed-inline-images)

## Outbound size budget

Resend documents a **40 MB total email limit, including attachments after Base64
encoding**. This adapter treats MB as decimal (40,000,000 bytes) and enforces a
conservative local budget before making any request.
[Provider attachment limitations](https://resend.com/docs/dashboard/emails/attachments#attachment-limitations)

- The projected email starts with a 1,000,000-byte reserve for provider-added
  envelope, MIME boundaries, headers and signatures. Each text/HTML or attachment
  part adds 2,048 bytes. Metadata (sender, all `to`/`cc`/`bcc`, reply address,
  subject, header names/values, filenames, content types and content IDs) costs
  six times its UTF-8 byte length plus 128 bytes per string, covering encoding and
  folding. An HTML-only request also reserves an equivalent generated text part.
- Each attachment costs `4 * ceil(rawByteLength / 3)` Base64 bytes, plus two bytes
  per 76-character MIME line. The aggregate includes every attachment, including
  inline and empty attachments; there is no separate per-file allowance.
- Text and HTML cost the larger of folded Base64 and conservative quoted-printable
  encoding. The latter counts printable ASCII other than `=` as one byte, CR/LF
  as two each, and other UTF-8 bytes as three; all spaces/tabs are counted as
  encoded. It reserves three bytes per 73 encoded bytes for soft line breaks.
- The projected JSON request must fit 39,000,000 UTF-8 bytes. It counts JSON
  escapes (including lone surrogates), Base64 padding, 1,024 bytes of fixed
  syntax, 64 extra bytes per metadata string and 128 per attachment. After
  serialization, the actual request is independently checked against the same
  39,000,000-byte ceiling before fetch.

The checks are incremental and do not serialize metadata, allocate UTF-8 copies,
map recipient/attachment arrays or read attachment content to estimate size. All
attachments pass the aggregate check before the first Base64 encoding. The normal
facade still validates and snapshots the caller's input as documented; these
limits bound outbound serialization, not caller-owned input allocation.

Exceeding either budget throws the public redacted `MailValidationError` with
code `resend_message_too_large`, from both direct adapter and facade calls. No
fetch, outbox write, retry, truncation or alternate send occurs. This is invalid
input, not an uncertain submission. Bounds are inclusive; additional metadata or
a second alternative reduces the permitted body/attachment size. These local
estimates deliberately reject some requests below the provider maximum; the
provider remains responsible for validating its final generated MIME message.

SendGrid-specific `customArgs`, `asmGroupId` and `subscriptionTracking` are
unsupported and rejected. A remaining `unsubscribe` property is rejected with
`unsubscribe_requires_facade`; the facade must first assemble List-Unsubscribe
headers and remove the request property. The adapter also refuses custom email
headers named `Idempotency-Key` or `Resend-Idempotency-Key`, avoiding a second source
of correlation/suppression policy. The caller's `deliveryId` is never inserted as
a provider receipt.

## Idempotency and outcomes

`deliveryId` supplies the exact HTTP `Idempotency-Key`. This adapter accepts 1–256
printable ASCII characters with no leading/trailing whitespace, so Fetch cannot
silently alter the key. It does not hash or truncate unsupported keys. Applications
must namespace their keys and retain the immutable payload for a send command.
Resend retains keys for 24 hours: repeating the same request in that window yields
the original response without another send. After expiry, reuse can send again;
this is not indefinite duplicate suppression. A different payload under the same
key produces HTTP 409 `invalid_idempotent_request`; an unfinished concurrent request
produces 409 `concurrent_idempotent_requests`.
[Provider idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys)

- HTTP 200 with a nonempty, control-free, bounded JSON `id` returns `accepted` and
  that actual ID. Missing/malformed IDs, malformed/oversized JSON, response stream
  failure and unexpected success statuses return `uncertain` with a null ID.
- 429 returns `rate_limited`; 408, redirects, server errors and transport failures
  return `uncertain`. Other ordinary 4xx statuses return `rejected`.
- A recognized payload conflict returns `rejected`/`idempotency_conflict` for this
  attempt. It does not establish whether the original request was accepted.
  A concurrent conflict returns `uncertain`/`idempotency_in_progress`. Unknown or
  malformed 409 responses are conservatively `uncertain`.

There are no retries or alternate providers/outboxes. Core transport forces manual
redirects and a 15-second request timeout. Structured response reads additionally
stop at 64 KiB or 15 seconds and cancel unfinished streams. Diagnostics are fixed
codes; response/error bodies and credentials are never returned or logged. HTTP
acceptance is not delivery, inbox receipt, or proof of delivered header/DKIM
coverage. Applications own durable policy and reconciliation.

## Verification

Run from the Base root:

```sh
node --test modules/mail/tests/resend/*.test.mjs
node --check modules/mail/src/adapters/resend/index.mjs
node --check modules/mail/src/adapters/resend/serialize.mjs
node --check modules/mail/src/adapters/resend/response.mjs
node --check modules/mail/src/adapters/resend/size.mjs
```

Fixtures live only in `modules/mail/tests/resend`; they inspect real Web Request
bytes and Response streams. Size boundaries run in the adapter unit suite;
`tests/runtime/workerd.test.mjs` checks a binary attachment through the facade
and adapters, and `tests/assembly/workerd.test.mjs` checks the doctor sender chain.
These checks establish local protocol behavior, not live-provider delivery.
No provider credentials or live mail are used by these unit tests. Official
references were inspected on 6 October 2026.
