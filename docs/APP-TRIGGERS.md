# Native app polling

Create a connection in Connections, then save and publish a native workflow through the existing workflow API. HubSpot accepts a private-app bearer credential or the existing managed OAuth connection. Microsoft Graph accepts a buyer-provided bearer credential; managed Graph OAuth setup is not supplied by this slice. Tokens remain in the connection vault.

An updated HubSpot deal trigger can use:

```json
{
  "type": "app_poll",
  "provider": "hubspot",
  "resource": "deals",
  "event": "updated",
  "connection_id": "YOUR_CONNECTION_ID",
  "interval_minutes": 1,
  "backfill": "from_now",
  "watched_fields": ["dealstage"],
  "changed_to": {"dealstage": "closedwon"},
  "identity": "change"
}
```

Contacts and companies are also supported. Use provider property names and values. Choose `existing` to process current matching records at first activation, or `from_now` to seed without effects. Updated triggers require watched fields or explicit `any_field: true`; the latter warns that every edit can start a run. `changed_to` compares exact values. The default identity includes the record, changed fields, current values and provider modification time. `first_value` omits the modification time. Runs expose `record_id`, `previous`, `current`, `changed_fields`, `change_time` and `change_time_source`, alongside the source record.

Each poll reads the complete resource, up to ten pages and 1,000 records, before admission. Overlapping pages select the newest record timestamp. Older records cannot roll a snapshot backwards. An incomplete or conflicting response retains the prior snapshot and successful poll time; the trigger displays an error and sends an owner notice. Watched fields are stored separately per immutable workflow version; a replacement version seeds without running existing records. Snapshot values follow workflow data-class sealing and rotation; archives restore inactive. Run erasure removes the linked record snapshots. Complete subject erasure and retention for snapshots that have never admitted a run remain open.

For mailbox polling, use `provider: "microsoft_graph"`, `resource: "messages"`, and `event: "new"` with a Microsoft Graph connection. The source is the connected mailbox's message list. This is a polling source, without a hosted inbound alias or attachment ingestion. The ten-page bound applies; a larger mailbox fails visibly rather than advancing past unread messages.

An owner who has already installed a Microsoft Graph subscription can optionally add:

```json
{"subscription": {"id": "YOUR_SUBSCRIPTION_ID", "expires_at": "2026-12-01T12:00:00.000Z"}}
```

Crank attempts renewal within five minutes of expiry, requesting another day and retaining the provider's returned expiration. The trigger inspector shows expiry, renewal failure and the next action. Failed renewal never stops polling or establishes provider delivery. An expired or deleted subscription may require the owner to reconnect it at the provider and publish its replacement identifier. Crank does not create a notification endpoint or claim push notification delivery for Graph in this slice. Existing signed Slack events remain a separate trigger.

No live provider consent or hosted mail receipt is established by the automated provider-edge journeys. Changed-from operators, settle delays, property-history detection, resource pickers and the remaining providers stay in the contract Gap.
