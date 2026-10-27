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

Contacts and companies are also supported. Use provider property names and values. Choose `existing` to process current matching records at first activation, or `from_now` to seed without effects. Updated triggers require watched fields or explicit `any_field: true`; the latter warns that every edit can start a run. `changed_to` and `changed_from` accept literal field maps for exact equality, or WORK-013 rule groups (AND within each group, OR between groups). Every named field must be watched, unless any field was explicitly selected. A changed-from condition needs an actual prior snapshot. Typed mismatches fail the poll visibly and retain its baseline. Rule timezone options apply; the default is UTC. The default identity includes the record, changed fields, current values and provider modification time. `first_value` admits an edit only when at least one changed field has a value never observed for that record in the workflow. Each field is tracked independently, including values in initial seeds and nonmatching edits; several changed fields still admit only one run. Digests include property presence, so missing and null differ. History survives restart and a new watched-field version. Runs expose `record_id`, `previous`, `current`, `changed_fields`, `change_time` and `change_time_source`, alongside the source record.

For typed transitions, use the same field-relative rules as native filters:

```json
{
  "changed_from": [[{"field": "dealstage", "op": "text.in", "value": ["pending", "review"]}]],
  "changed_to": [[{"field": "dealstage", "op": "text.equals", "value": "approved"}, {"field": "amount", "op": "number.gte", "value": "100"}]]
}
```

Both fields in this example must be in `watched_fields`. Literal field maps keep their existing exact, case-sensitive comparison; typed text operators use WORK-013 case and whitespace settings. Nonmatching observations still update the baseline and first-seen history. A type error consumes neither. HubSpot updated-record polling requests watched property history and replays supplied versions after the retained baseline in timestamp order. Fields at the same timestamp form one edit. Initial activation and changed-watch publication seed the current record without replaying old history. Repeated and older versions do not run again; conflicting versions fail the complete poll without consuming its baseline. Providers without history compare observations and cannot recover intermediate edits absent from their responses.

Each poll reads the complete selected resource, up to ten pages and 1,000 records, before admission. HubSpot updated-record reads request conservative pages of 50 while fetching property history, so their ten-page bound can cover 500 records. Explicit any-field HubSpot polling loads the property schema first and requests every returned property, instead of treating the provider’s default property subset as every field. Overlapping pages select the newest record timestamp. Older records cannot roll a snapshot backwards. An incomplete or conflicting response retains the prior snapshot and successful poll time; the trigger displays an error and sends an owner notice. Watched fields are stored separately per immutable workflow version; a replacement version seeds without running existing records. Snapshot values follow workflow data-class sealing and rotation; archives restore inactive. Run erasure removes the linked record snapshots and field-value history, and retains a value-free record digest to suppress later polls for that erased record. Complete subject erasure and retention for snapshots that have never admitted a run remain open.

For mailbox polling, use `provider: "microsoft_graph"`, `resource: "messages"`, and `event: "new"` with a Microsoft Graph connection. The source is the connected mailbox's message list. This is a polling source, without a hosted inbound alias or attachment ingestion. The ten-page bound applies; a larger mailbox fails visibly rather than advancing past unread messages.

An owner who has already installed a Microsoft Graph subscription can optionally add:

```json
{"subscription": {"id": "YOUR_SUBSCRIPTION_ID", "expires_at": "2026-12-01T12:00:00.000Z"}}
```

Crank attempts renewal within five minutes of expiry, requesting another day and retaining the provider's returned expiration. The trigger inspector shows expiry, renewal failure and the next action. Failed renewal never stops polling or establishes provider delivery. An expired or deleted subscription may require the owner to reconnect it at the provider and publish its replacement identifier. Crank does not create a notification endpoint or claim push notification delivery for Graph in this slice. Existing signed Slack events remain a separate trigger.

No live provider consent or hosted mail receipt is established by the automated provider-edge journeys. Other provider change-history adapters, remaining connectors and complete source parity stay in the contract Gap.

## Spreadsheet rows

Google Sheets uses an existing Google OAuth connection and this trigger definition:

```json
{
  "type": "app_poll", "provider": "google_sheets", "resource": "rows",
  "connection_id": "YOUR_CONNECTION_ID", "spreadsheet_id": "YOUR_SPREADSHEET_ID",
  "range": "Orders!A1:E1001", "key_field": "Record ID",
  "event": "updated", "backfill": "from_now", "interval_minutes": 1,
  "watched_fields": ["Status"], "changed_to": {"Status": "Approved"},
  "settle_delay": 2, "required_columns": ["Customer", "Amount"]
}
```

The first range row supplies unique nonempty column names. A nonempty unique stable key is mandatory on every nonempty row; moving a row does not create a new identity. Missing or duplicated keys and removed named columns fail visibly before any baseline or admission changes. Values use the provider’s unformatted representation. Full rows are mappable through `trigger.properties`; retained comparison snapshots contain watched columns only.

Excel uses `provider: "microsoft_excel"` with a Microsoft Graph connection, `resource: "rows"`, `workbook_id`, `worksheet_id`, and a bounded `range` such as `A1:E1001`. It uses the same header, key, comparison, settling and required-column rules. Spreadsheet ranges start at A1, including headers. The owner must explicitly bind the intended workbook or sheet; managed Microsoft authorization is not established here.

A settle delay is an integer from 1 to 60 minutes. The watched columns, required columns, and `mapped_columns` must remain unchanged for that time. If `mapped_columns` is omitted, every returned column participates, so a later note or amount edit also restarts the delay. Required cells must be nonempty; zero and false remain filled values. Initial start-from-now activation seeds existing rows without running or waiting. New rows and later changes wait; a replacement version seeds a new baseline without runs. The pending state holds only a digest and observation time, survives restart and exports, and restores inactive. No cell values are copied into that pending state. A released run carries the final row and the detecting observation time labeled `poll`.

Sheets reads use [the native values method](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get). Excel reads use [the native worksheet range method](https://learn.microsoft.com/en-us/graph/api/worksheet-range?view=graph-rest-1.0). Neither endpoint supplies a row modification timestamp, so these sources label change times as polling observations.

## Airtable records

A bearer Airtable connection supports `provider: "airtable"`, `resource: "records"`, `base_id`, `table_id`, and optional `view_id`. Record IDs are stable identities; field names may contain spaces. Each poll completes all bounded pages before comparing or admitting anything. A failed later page keeps the entire previous baseline. Omitted empty properties remain absent rather than becoming null. An optional `modified_field` names a provider-maintained last-modified column containing an ISO timestamp; older records then cannot rewind the baseline. Without that column, change time is the labeled detecting poll time, since creation time does not identify an edit. The native adapter does not invent missing property history.

Airtable documents [paged record reads](https://support.airtable.com/articles/6292134965-getting-started-with-airtable-s-web-api) and [base field schemas](https://airtable.com/developers/web/api/get-base-schema). The token needs access to the selected base and the corresponding record and schema read permissions.

## Choose watched fields

The trigger’s Watched field settings panel loads names from its current connected resource. Selected names and explicit any-field mode save through the ordinary draft door; they authorize no production work. A changed draft or renamed source field invalidates the loaded selection. Native permissions must cover both the workflow and its account. Revoked accounts cannot load or save field choices. This panel supplies field selection for these app poll adapters; broader CONN-019 resource selection and type-refresh duties remain open.

## n8n Sheets migration

The n8n import door accepts a reviewed `sheets-trigger` choice for a version-1 Google Sheets Trigger with explicit `rowUpdate` or `rowAdded`, a literal range starting at A1, one representable polling interval, and current-row output. The choice names a fresh `connection_id`, a stable `key_field`, the resolved `sheet_name` and `comparison: "stable_key_current_rows"`. Watched column names and downstream row mappings survive review and inactive apply. The explicit comparison choice discloses that native polling observes stable keys and current rows, while n8n’s source uses Drive revisions and row positions. It does not claim source revision-history parity. Old or combined output, expressions, unsupported schedules, row-position metadata and unknown settings are named manual conversions. Zapier and Make update-trigger migration and authorized parity remain required.


## Polling rates before publication

Polling keeps the existing choices: 1, 2, 5, 15, 30 and 60 minutes, or whole hours through 24 hours. There is no installation or plan gate on one minute. The saved workflow response exposes `poll_rate`; draft saving, native validation and publication return the same rate warning. The trigger inspector shows the selected interval, limiting rate and request budget even before the first publication.

These documented baselines are deliberately conservative. They describe the named resource, not discovered account entitlements or unused quota. A connection does not automatically raise a baseline. Other workflows, other applications, account-specific restrictions, concurrent requests and provider changes can require slower polling; passing this estimate is not a promise of available quota.

| Provider and resource | Rate windows used | Maximum requests counted for one poll |
| --- | --- | --- |
| HubSpot CRM contacts, companies and deals, native polls or the corresponding object-list URL | 100 requests in 10 seconds; 250,000 requests in 24 hours | Native: ten pages, plus one property-schema read for explicit any-field mode. URL: configured page bound, default ten with pagination; one without. Each page counts its initial request plus up to three redirects. |
| Microsoft Graph Outlook messages, native polls | 10,000 requests in 10 minutes per application and mailbox | Ten pages, plus one renewal request when a subscription is configured. |
| GitHub public REST repository reads under `https://api.github.com/repos/` | Anonymous baseline: 60 requests in one hour per source IP | Configured page bound, default ten with pagination; one without. Each page counts its initial request plus up to three redirects. |

Sources: [HubSpot usage limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines), [Microsoft Graph Outlook limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits), and [GitHub REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). The HubSpot entry uses the lower private-app tier and its daily allowance; managed OAuth or a paid tier may permit more. The Graph entry is a request-rate estimate and does not establish its separate concurrency allowance. GitHub authenticated entitlements and secondary throttling are not inferred from a stored connection. Feed URLs and other unlisted resources have no catalogued rate estimate; the owner must check their provider documentation.

For each window Crank divides the complete-poll request bound by the allowance, multiplies by the window duration, and takes the longest required interval. The warning calls the first supported choice at or above that floor the **slowest safe interval**. URL polls can follow up to three redirects per page, so the budget reserves four requests for every page even before the source has been read. Redirect behavior can change between polls; an earlier direct response does not reduce that bound. For example, one GitHub repository page reached through a 301 redirect uses two physical requests, so polling it every minute would already spend 120 requests per hour against 60 allowed. The conservative four-request bound needs four minutes and recommends the next supported choice, five minutes. Two pages budget eight requests and recommend fifteen minutes; ten pages budget forty requests and recommend sixty minutes. The warning includes the redirect allowance. Native app polls do not follow redirects and retain their existing request budgets. This is advisory: publishing preserves the chosen interval and does not reserve provider capacity. Actual throttling still appears as a provider-rate-limit cause in the latency report.
