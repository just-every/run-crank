# Named digests

A digest belongs to the native owner and workflow environment. Publish `digest.append`, `digest.find` and `digest.release` steps through the ordinary workflow API. Every step uses a fixed `digest_name` and the same `retention_days` (1 to 365). A published owner workflow creates the named digest on first use. Draft tests, preparation agents and workflows classified as sensitive cannot use this initial implementation.

Map a text template or structured JSON value to `input.entry` on append. Find returns `entries`, `count` and `text` without releasing. Each entry includes its source run reference. Text joins string entries with newlines and serializes structured entries as JSON; structured `entries` remain available to later mapping steps.

A separate release workflow starts with `digest.release`, followed by the destination step. Choose the native schedule trigger for a daily time, `days` for a weekly schedule or `day_of_month` for a monthly schedule. The timezone is an IANA zone. The existing scheduler preserves local wall time across daylight saving changes, clamps a monthly day to month end, catches up after restart and deduplicates each occurrence. The release run and step operation identity are retained with the release snapshot.

For example, the workflow API accepts this JavaScript graph after serialization:

```js
const graph = {
  trigger: { type: 'schedule', at: '17:00', timezone: ['America', 'Chicago'].join('/'), missed: 'catch_up' },
  steps: [
    { id: 'release', type: 'digest.release', digest_name: 'Today’s leads', retention_days: 30, empty: 'skip' },
    { id: 'post', type: 'slack.send_channel_message', connection_id: slackConnectionId,
      input: { channel: selectedChannelId, text: '{{steps.release.text}}' } }
  ]
}
```

For manual release, use a manual-trigger workflow with the same release step. Set `keep_entries: true` to retain the entries after taking the snapshot. Empty policy is `skip` by default (the run stops before downstream effects), or `send_empty` to continue with an empty snapshot. For count release, set `release_count` on append. Its result contains `released: true` and the snapshot only when the threshold is reached. Route downstream delivery on that flag; ordinary append returns the appended entry and current count.

The revision compare-and-swap commits entry changes and the operation receipt together. Concurrent clear releases partition entries: an append belongs to the snapshot that wins its transaction or remains for the next release. A restarted operation returns its retained receipt. Keep releases intentionally permit the same entries in later releases. Provider acknowledgement loss still follows the destination connector’s uncertain-write rules; a Slack write is never blindly retried.

Limits are 1,000 current entries, 16 KiB per entry and 256 KiB for the complete current snapshot. Values and release receipts expire after the chosen retention period, including inactive receiving receipts. Expiry advances the archive redaction checkpoint atomically, so the later journal refuses older archives containing those values. Expiry and source-run erasure also advance the digest revision, forcing any pending release to re-read its entries before it can commit. Expired operation identities remain without values, preventing replay. Any active legal hold conservatively suspends digest expiry and erasure. Source-run erasure removes linked digest entries and receipts containing that source. Digest erasure removes the local definition, entries and receipts; it leaves only an opaque erased-name fence, so old workflows cannot recreate the same digest. Source workflow history and already delivered provider messages have their own retention and erasure boundaries.

The owner-only `GET /api/crank/digests` and `GET /api/crank/digests/:id` doors show local entries and release histories. `POST /api/crank/digests/:id/erase` requires `{ "confirm": "ERASE" }`. The ordinary run history shows the released snapshot, source references and downstream outcome. The Data screen discloses local custody and configured retention without values.

Archives include complete digest definitions, entries, release receipts and erased-name fences. Export and restore normalize definitions and operation receipts to inactive state. Restored digests cannot receive entries, release work or authorize replay. Adoption of an imported digest is not implemented; use a new owner-reviewed name for new work.

WORK-010 remains partial. Registered network-edge tests prove the native behavior; actual Slack readback requires the held Slack credential in a local fleet run. Authorized weekly Digest Zap migration, coverage and captured parity remain held on the Zapier account and MIG-002. Sensitive-class sealing and receiving adoption remain unclaimed.
