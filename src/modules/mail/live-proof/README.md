# Protected mail proof preparation

Live acceptance is **PENDING**. No live DNS/send/receive operation has been run
by the local assembly checks. The CLI plan and test fixtures are not delivery evidence.

Offline sample (no credentials, DNS, send or receive):

```sh
node modules/mail/doctor.mjs --domain mail.example.com --provider resend --plan --json
node modules/mail/doctor.mjs --domain mail.example.com --provider resend --plan
```

The human output names MX, SPF, DKIM, DMARC and next actions. To print actual
record values, pass `--config` with the four DNS arrays copied from provider
setup. No provider-specific record values can be inferred from a sample domain.

The owner must supply a test sending domain, verified sender, Resend sending
key, configured receiving mailbox and readback credential; throwaway Cloudflare
resources/credentials where required, and the evidence-store token. SendGrid
verified sender/Inbound Parse details remain prerequisites for that separate
path. An existing Base `live-proof` Environment and `SENDGRID_API_KEY` alone are
not send-and-receive proof. Resend is the default sender for this proof.

Use a private throwaway Resend receiving mailbox on the owner-approved test
domain. Enable its actual receiving MX and retain access to the received-email
API. The receive key must read that mailbox's received email list and detail;
a sending-only key is insufficient. This uses actual SMTP delivery into a
provider receiving mailbox. It does not certify an application's signed inbound
webhook integration, attachments, unsubscribe delivery or every sending adapter.
No application/Worker deployment is involved in this runner; the protected
Actions run is its execution identity.

Store nonsecret config in an approved file with this shape (replace the example
addresses and fill every DNS group with records from actual setup before proof):

```json
{
  "domain": "mail.example.com",
  "provider": "resend",
  "dnsRecords": {"mx": [], "spf": [], "dkim": [], "dmarc": []},
  "send": {"from": "doctor@mail.example.com", "to": "doctor@receive.example.com"},
  "receive": {"provider": "resend"},
  "timeoutMs": 60000,
  "pollIntervalMs": 2000
}
```

The example is a config shape, not a working fixture or evidence. Each DNS entry
is `{ "type": "TXT", "name": "full.record.name", "value": "exact setup value" }`;
MX adds integer `priority`. The API guide in `../src/doctor/README.md` describes
record types and the resolver's precise coverage.

After explicit approval, the direct live CLI invocation is:

```sh
node modules/mail/doctor.mjs --live --config /path/to/approved-mail-config.json --json
```

It reads `MAIL_DOCTOR_SEND_API_KEY` and `MAIL_DOCTOR_RECEIVE_API_KEY` from the
process environment only; never put values on the command line or in JSON.
The supplied config never chooses a receiving URL or executable. CLI exits 0
for a valid offline plan, 0 for all six live items passing, 1 for incomplete live
checks, and 2 for configuration/runtime failure. An uncertain submission must be
reconciled before another run because each invocation sends a new probe.

The Base workflow integrator owns wiring into protected `live-proof.yml`.
This module installs no shared workflow; integrate the reviewed runner into the
qualified workflow line before any live run.
Required invocation contract:

1. The owner supplies and approves the test inputs. Configure secrets only in
   `live-proof` with its integration-line/release-tag branch policy. Do not make
   secrets available to task branches or untrusted PR code.
2. The workflow checks out the intended exact 40-hex SHA, confirms its reachability
   from the permitted integration line or release tag, and reviews this code for
   secret exfiltration before merge. It exposes sending/readback secrets as the
   two `MAIL_DOCTOR_*_API_KEY` variables only to the proof step. Cloudflare send
   mode also needs nonsecret `send.accountId` in the config. No provider login
   on the Mac and no DNS writes are needed or authorized by this runner.
3. Make the approved nonsecret config available as `$RUNNER_TEMP/mail-config.json`.
   In a clean checkout at `$GITHUB_SHA`, execute exactly:

   ```sh
   node modules/mail/live-proof/run.mjs "$RUNNER_TEMP/mail-config.json" "$RUNNER_TEMP/mail-receipt.json"
   ```

4. The entry verifies Actions metadata and clean tracked source against
   `GITHUB_SHA`. It reserves a new mode-0600 receipt before remote effects and
   refuses an existing path before sending. An interrupted run leaves a pending
   starting receipt, never successful proof. The calling workflow enforces actual Environment protection and source
   reachability; environment variables alone do not establish either. Upload
   only the receipt using the protected evidence-store mechanism and scoped
   `EVIDENCE_WRITE_TOKEN`; never upload config, env, raw mail or logs with secrets.
   Destination: `mail/live/<sha>/<run-id>-<attempt>/mail-receipt.json`.
   The runner performs no GitHub/evidence-store API operations itself.
5. Retain workflow run ID, attempt, UTC times, exact SHA and immutable store path.
   A fresh gate reads the receipt and actual protected run. Only a receipt with
   all six checks passing, independent `source:resend_received_email_api` and a
   real mailbox UUID satisfies this probe. A fixture receipt cannot satisfy it.

`mail-live-proof-v1` receipt fields: `state:pass|pending`, `sourceSha`, `command`,
`runUrl`, `runAttempt`, `startedAt`, `phase:starting|completed`, and (after
completion) `completedAt` and structured doctor `result`.
The send and receive evidence share a random `correlationId`; receive includes
actual `inboxMessageId`, receipt timestamp and SHA-256 of body, recipient and
RFC Message-ID. Send includes a hash of its provider receipt ID (or null when
absent). Config errors produce no delivery receipt; incomplete checks produce a
pending receipt and exit 1. Send HTTP acceptance alone never sets receive pass.

Unit verification: `node --test modules/mail/tests/doctor/*.test.mjs`.
Workerd assembly and the live run remain the integrator/fresh gate's distinct
checks. No plan, secret-presence check, loopback receiver or injected provider
response substitutes for the protected live receipt.
