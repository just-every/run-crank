# Inbound Twilio SMS

The native `twilio_sms` trigger receives text-only SMS. A native workflow owner declares one Twilio AccountSid, one destination E.164 number and an existing encrypted webhook signing-secret connection. These declarations establish neither account authorization nor verified number ownership or provisioning. Crank makes no Twilio API request to set them up.

Create a workflow draft first, then save its trigger with these fields:

```json
{
  "type": "twilio_sms",
  "account_sid": "the declared AccountSid",
  "to": "the declared E.164 number",
  "signing_connection_id": "an existing webhook signing-secret connection ID",
  "callback_url": "https://your-installation.example/hooks/twilio/your-workflow-id"
}
```

The callback must use the installation's exact origin and that workflow's ID, without query parameters, credentials or fragments. Production requires HTTPS. Local development also accepts the installation's configured HTTP loopback origin. Configure that exact callback in Twilio yourself. Signing connections must belong to the workflow's environment. Publishing records the current native owner's authority and signing-secret revision. Rotation or reconnection requires an explicit fresh publication before receiving resumes.

The HTTP door accepts POST with a form-encoded body of at most 16 KiB and 64 distinct parameters. It verifies the Twilio signature using the configured callback URL and every submitted form field. Forwarded host headers never choose the signed URL. Repeated parameters, ambiguous encoding, invalid identities, mismatched account or destination, outgoing status events and media are refused before admission. The declared AccountSid and MessageSid must have their documented SID shapes, and From and To must be E.164 numbers. MessageSid aliases must agree. NumMedia must be zero, and Body is limited to 1,600 characters. Extra signed metadata is discarded.

Native workflows receive typed `account_sid`, `message_sid`, `from`, `to`, `body` and numeric `num_media` fields. Concurrent delivery and restart preserve one admission per workflow, AccountSid and MessageSid. Changed input under the same identity is refused. A saved draft cannot change an already published binding. Paused and burst-held events use the existing reviewable hold door. Authority is checked again within the admission transaction and before every continuation.

Successful deliveries, including duplicates and held items, return empty TwiML. Receiving sends no automatic SMS and performs no provisioning or account request. Only the separately published workflow steps can perform their declared effects.

Run payload permissions, customer-data sealing, legal holds, subject erasure, payload expiry and permanent erased-event fences apply. Archives retain complete workflow, run, hold and duplicate records while omitting credentials. Restored workflows remain paused, belong to no receiving owner and require connection reconnection and explicit adoption and publication. Restoring an archive cannot itself receive or dispatch messages. An older archive is refused against a newer erasure journal.

The broader CONN-017 clause remains partial. Required live proof includes a registered A2P 10DLC or verified toll-free test account and sender, actual account authorization, number provisioning and a handset journey. API-key lifecycle, outbound SMS and MMS, Messaging Services, inbound media custody, run-linked delivery callbacks, provider-recorded STOP and HELP suppression, displayed registration requirements, recipient-timezone quiet hours, recipient caps and exact approvals, and the complete send, delivered, reply, STOP and no-charge acceptance remain unfinished. This slice releases no EXEC-007 or mobile-push prerequisite.
