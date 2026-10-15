# SendGrid outgoing adapter

`index.mjs` exports the portable ESM functions
`sendSendGrid(config, message, dependencies = {})` and
`serializeSendGridMessage(message)`. Both accept the frozen IF-056-MAIL-v1
message shape. The serializer validates and returns deterministic JSON request
bytes without effects; the sender validates config and message independently
and makes one POST to `https://api.sendgrid.com/v3/mail/send` with Bearer API-key
authentication. Config must name `provider: 'sendgrid'`, an explicit mode, and
`apiKey`. Remote sending remains remote in test/development modes. There is no
endpoint override, provider fallback, outbox selection or automatic retry.

The facade must call the actual `applyUnsubscribeHeaders` implementation before
this adapter. That assembler consumes `unsubscribe` and returns a new message
with the real headers. Direct callers must call the assembler themselves, or
supply their already-validated headers without an `unsubscribe` request. The
adapter rejects every unconsumed `unsubscribe` request, including one accompanied
by matching-looking headers, with `unsubscribe_requires_facade`. It validates
header syntax/reserved names and preserves headers; it does not certify the
semantics or delivered/DKIM coverage of caller-supplied unsubscribe headers.

The wire preserves To/Cc/Bcc display names, plain/HTML alternatives, reply address,
thread and custom headers, binary attachments, disposition and content IDs.
Attachments use base64 generated from `Uint8Array`; callers never supply base64.
`rer_delivery_id` always carries the caller's delivery ID. Custom arguments retain
the original reserved-name and 10,000-byte UTF-8 JSON limit. Positive safe-integer
ASM group IDs and optional boolean subscription tracking are supported. Omitted
subscription tracking remains omitted. Open, click and Google Analytics tracking
are explicitly disabled. Subscription tracking may append provider content;
its selection is not proof of delivered unsubscribe headers.

Shared core validation rejects unknown fields, header/address injection and
unsupported shapes. SendGrid additionally rejects empty subjects, explicitly
empty content parts/attachments, duplicate recipients, non-ASCII sender mailbox
addresses, and more than 1,000 total To/Cc/Bcc recipients. Omit unused content
parts. Local resource ceilings are 1,000 attachments, 1,000 header entries (custom arguments retain their 10,000-byte limit), 1,000,000 header key/value code units, and request JSON strictly below
30,000,000 UTF-8 bytes. Body and base64-size checks run before encoding attachments;
final serialized bytes are checked too. The wire ceiling does not establish that
the provider-generated MIME is below its separate 30 MB message limit. Oversize
or unsupported requests fail before fetch with fixed `MailValidationError` codes;
no values appear in diagnostics.

The shared transport enforces a 15-second deadline, abort signal and manual
redirect handling. Only HTTP 202 reports `accepted`; its real, bounded
`X-Message-Id` is retained or explicitly null. That is submission acceptance,
not mailbox receipt. HTTP 429 is `rate_limited`; other 4xx except 408 are
`rejected`. Network loss, deadline expiry, redirects, 408, 5xx and unexpected
non-202 responses are `uncertain`. Results never expose provider bodies/errors.
Correlation is not duplicate suppression: reconcile an uncertain submission
before deciding whether to submit again.

## Verification

From Base root:

```sh
node --test modules/mail/tests/sendgrid/*.test.mjs modules/mail/tests/core/*.test.mjs
```

Tests include complete wire conformance, all response classes, no retry/forwarding,
redaction, nullable receipts, direct-call validation, binary round trips, exact
custom-argument limit, a real 15-second deadline, and isolated ESM execution with
Web APIs only (no Buffer/process/require). They use injected test-only responses;
no live provider API is called. `tests/sendgrid/conformance.mjs` exports
`runSendGridConformance()` for reuse inside workerd, and
`tests/sendgrid/worker.mjs` is its Worker entry. The isolated harness can run it with
`createWorker('tests/sendgrid/worker.mjs', ['tests/sendgrid/conformance.mjs',
'src/adapters/sendgrid/index.mjs'])`, then dispatch a fetch and dispose the worker.
`tests/assembly/workerd.test.mjs` exercises the complete facade inside actual
workerd, including unsubscribe assembly and the doctor sender chain. Hosted send/receive proof remains pending.

Provider references checked 6 October 2026:
[Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send),
[limits](https://www.twilio.com/docs/sendgrid/api-reference/mail-send), and
[X-Message-ID](https://www.twilio.com/docs/sendgrid/glossary/x-message-id).
