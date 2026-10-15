# Mail doctor API

`mailDoctor(options, dependencies = {})` is portable ESM. Import from the public
mail facade, or directly from
`modules/mail/src/doctor/index.mjs`. No Node APIs enter this runtime graph.

```js
const result = await mailDoctor({
  domain: 'mail.example.com', provider: 'resend', live: false,
  dnsRecords: { mx: [], spf: [], dkim: [], dmarc: [] },
});
```

Each supplied DNS group contains `{type, name, value, priority?}` records. Types
are uppercase `MX`, `TXT`, `CNAME`; names are fully qualified (a final dot is
optional). MX requires numeric priority. Supply unquoted TXT values, including
the complete SPF/DMARC policy. SPF supports a provider return-path CNAME; DKIM
supports TXT or CNAME at the provider-assigned `selector._domainkey` name. Do
not guess a selector, public key, MX host, SPF include or return-path value.
Copy exact values from the selected provider's domain setup. Receiving MX may
belong to a different receiving provider and domain from the sender. All four
groups can therefore contain names other than `domain`.

The six ordered items are `mx`, `spf`, `dkim`, `dmarc`, `send`, `receive`. Each
has `status`, `nextSteps`, optional `records`, and redacted `evidence`. A plan
has only `pending`/`not_checked` items. Supplied records remain a plan until
queried. Missing setup values have actionable instructions and empty records;
they are never invented or treated as published records.

For explicit live operation add:

```js
{
  live: true,
  send: {config: senderConfig, from: verifiedSender, to: ownerTestInbox},
  receive: readbackConfig,
  timeoutMs: 60000, pollIntervalMs: 2000
}
```

`senderConfig` is an ordinary mail sender configuration, for example
`{provider: 'resend', mode: 'production', apiKey}` with the sending credential
as `apiKey`. `readbackConfig` is `{provider: 'resend', apiKey}` with a separate
readback credential as `apiKey`. Both credentials come from the environment.

Sender provider must agree with `options.provider`; sending domain must match
`domain`. SendGrid and Cloudflare senders use the same facade (Cloudflare also
requires `config.accountId`). The built-in readback is an actual Resend receiving
mailbox, independent of the sending provider. An existing arbitrary mailbox
cannot be proven by this readback: provision an approved Resend receiving address
or implement a separately reviewed readback before claiming proof. All live
inputs validate before any effect. Complete live config is required even when
some DNS setup values have not yet been supplied.

DNS uses a fixed Cloudflare DNS-over-HTTPS endpoint and bounded GETs. Comparison
reports `match`, `missing`, `mismatch`, `error` or `unchecked` in evidence. Empty
NOERROR/NXDOMAIN means missing; resolver transport failures, malformed responses
and other DNS response codes mean error. TXT character strings are concatenated;
MX priorities and CNAME hostnames compare canonically. Duplicate SPF/DMARC
policies fail. A matching explicit record plan does not prove full recursive SPF
evaluation, DKIM message signatures or DMARC alignment. Undeclared selectors,
parent-domain DMARC discovery and provider dashboard verification are outside
this check. A missing plan remains unchecked even in live mode.

Live sends exactly once through `createMailSender`; there is no retry. Every run
creates a random UUID in the subject and plain-text body. `send:pass` means
provider acceptance only. `receive:pass` requires an independent received-mail
list and detail read, matching received ID, exact sender/recipient, fresh receipt
time (one-second timestamp tolerance), exact subject/body and an RFC Message-ID.
Uncertain submissions may be read back but retain their uncertain send result.
No send response or sent-mail status endpoint can establish receipt.

The default receive timeout is 60 seconds, configurable from 100 to 120000 ms;
poll spacing is 100–10000 ms. Limits are 30 polls, three pages of 100 messages per
poll, eight seconds per HTTP request and 256 KiB per receive response. A busy
mailbox exceeding that scan remains pending. DNS performs at most 32 distinct
eight-second queries concurrently; send has a 16-second outer bound. DNS and
send/readback run concurrently, after validation. Redirects are refused. Only
fixed provider origins are fetched; response IDs must be UUIDs before use in
paths, and remote attachment/raw-download URLs are never followed.

Dependencies are `{fetch?, resolveDns?, sender?}`. `fetch` is the standard Web
fetch host/test seam. `resolveDns({name,type,signal})` returns
`{status:'ok'|'missing'|'error',records:[{type,name,value,priority?}]}`; errors can
omit records. The injected resolver must honor abort; the caller also bounds
the wait. `sender:{send(message)}` is an explicit unit-test seam using the frozen
sender result contract. Production omits it and loads the real sender facade.
Do not expose dependency selection to application users. There is no fixture
provider, automatic outbox selection, custom URL, or dynamic code loader.

Evidence contains the random correlation ID, actual received-mail UUID, hashes
of send-provider/RFC message IDs, recipient and body, timing and counts. It never
returns credentials, message content, arbitrary headers, raw responses or remote
error messages. API keys belong only in private process/config memory. A UI
calling this function owns user authorization and test-inbox approval.

Run unit checks: `node --test modules/mail/tests/doctor/*.test.mjs`. These tests
inject explicit sender and network fixtures only under `./tests/doctor`; they prove
protocol/conformance, not delivery. `tests/assembly/workerd.test.mjs` exercises
the doctor through the real facade and all three sending adapters in workerd. See `../../live-proof/README.md` for protected proof.

Primary contracts checked 2026-10-06:

- [Cloudflare DNS JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)
- [Resend received-mail listing](https://resend.com/docs/api-reference/emails/list-received-emails)
- [Resend received-mail retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email)
- [Resend pagination](https://resend.com/docs/api-reference/pagination)
