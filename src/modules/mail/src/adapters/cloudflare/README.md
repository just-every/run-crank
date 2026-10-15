# Cloudflare Email Sending adapter

`sendCloudflare(config, message, dependencies = {})` implements IF-056-MAIL-v1
using the structured Email Sending REST endpoint. Import it from `index.mjs` in
this directory. It uses the shared portable core validation and transport and
makes one request to
`https://api.cloudflare.com/client/v4/accounts/{accountId}/email/sending/send`.
Configuration requires provider `cloudflare`, a mode, a nonempty API token in
`apiKey`, and an exact 32-hex `accountId`. No endpoint override is accepted.

This is Cloudflare **Email Sending**, with its account/domain entitlement and
sender setup. It does not use the older Email Routing send binding that restricts
outbound mail to verified destinations. Routing inbound email events are a
separate module responsibility. Neither a send response nor the provider's
`delivered` group proves that the owner checked an inbox.

The wire body preserves named addresses (REST `{address,name}` objects), to,
cc, bcc, reply_to, text, HTML, allowed custom/thread headers, and base64 attachment
bytes. Inline attachments use REST `content_id`, not the binding's `contentId`.
A content ID on a non-inline attachment is rejected because the structured REST
attachment schema does not support it. SendGrid-only settings and unknown
message/config fields are rejected. Message-ID and other platform-controlled or
unsupported custom headers are rejected before sending. Header byte/count/value
limits follow the current provider reference. Serialized JSON over 5 MiB is
rejected locally; final MIME size and provider limits still apply at Cloudflare.

The facade must consume `unsubscribe` and supply assembled, validated List
headers. Direct calls with any remaining own `unsubscribe` property fail with
`unsubscribe_requires_facade`. Caller message objects and attachment bytes are
not modified. `deliveryId` remains caller correlation; no Cloudflare duplicate
suppression or provider receipt is invented from it. No retries or provider
fallbacks are performed. Applications own durable reconciliation and retry policy.

## Response semantics

HTTP success requires JSON `success: true`, an empty `errors` array, a result
object and complete, non-conflicting recipient groups. Both `delivered` and
`queued` map to public recipient status `accepted`. `permanent_bounces` and
`suppressed_recipients` map to `rejected`. The suppression group is optional to
support the REST guide's documented response without it. Missing, null or unsafe
message IDs never become a synthetic ID: absent/null returns null; an invalid
supplied ID makes the response uncertain.

All accepted recipients produce overall `accepted`; all rejected recipients
produce `rejected`. A mix produces `uncertain` with
`cloudflare_partial_recipient_failure` and explicit recipient results. Missing,
duplicated, conflicting, malformed or unknown returned recipients produce
`uncertain`; valid known outcomes remain visible and missing/conflicting requested
mailboxes are uncertain. Unknown returned addresses never enter the public result.
One public outcome is returned per unique requested mailbox, even when that
mailbox occurs repeatedly in the unchanged wire envelope. Matching normalizes
only domain case and retains local-part case.

The response body is bounded to 1 MiB and 15 seconds. HTTP 429 is rate limited,
408/redirects/5xx and transport/body failures are uncertain; other 4xx reject.
A logical `success:false` response yields a fixed error code, with documented
throttling/transient codes distinguished. Contradictory failure-plus-result
responses are uncertain. Provider error strings and transport exception text
never escape. There is no credentialed live test in this unit.

## Provider contracts and checks

Inspected 2026-10-06:

- [REST Sending guide](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Sending API reference](https://developers.cloudflare.com/api/resources/email_sending/methods/send/)
- [Header allowlist and limits](https://developers.cloudflare.com/email-service/reference/headers/)
- [Named REST addresses](https://developers.cloudflare.com/email-service/examples/email-sending/specify-recipients/)
- [Official generated SDK schema](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/email-sending/email-sending.ts)
  resolves the REST inline `content_id` discriminated attachment schema that the
  API reference's collapsed request body does not display.

From the Base repository root:

```sh
node --test modules/mail/tests/cloudflare/*.test.mjs modules/mail/tests/core/*.test.mjs
```

Fixtures are exclusively under `modules/mail/tests/cloudflare`. They check the
actual request protocol, documented and malformed responses, partial delivery,
cardinality, header/feature rejection, redaction, and no retry/redirect following.
`tests/assembly/workerd.test.mjs` verifies the facade and doctor sender chain
in actual workerd; local fixture conformance does not claim hosted delivery or
mailbox receipt.
