# Where data can leave

In **Data**, open **Where data can leave**. The same owner-only inventory is
available at `GET /api/crank/data/flows`; it uses the existing Data permissions
and returns `Cache-Control: no-store`. Inspection sends no provider requests.

The inventory describes configuration, not successful delivery or certification.
Each entry identifies its current state, recipient origins or allowed connection
domains, purpose, request field categories, required credential kind, region and
provider retention. Credential values, URL paths/query values, and literal graph
input values are omitted. A mapped URL is marked as resolved at runtime; inspect
the graph and the particular run for its resolved destination. Connection domains
also allow their subdomains. Existing egress restrictions still apply, including
the documented unresolved DNS-rebinding gap in SEC-002.

Current request classes are:

- Native sign-in, invitations and owner notices through the installation's mail
  provider. Development and demo sends are suppressed, without delivery or storage.
- Connection verification and credential refresh, including owner-supplied test
  URLs inside the connection's allowed domains. Generic OAuth token URLs are
  constrained to those domains. Credentials remain sealed on the installation.
- Owner-registered Slack, HubSpot and Google OAuth consent and token endpoints.
- Configured, pending and linked identity providers: discovery, consent, token
  exchange, public-key refresh, incoming identity assertion validation and the
  explicit deregistration request when the owner unlinks a provider. Unlinking
  stops later sign-in authority; its deregistration notification is deliberate.
- Legacy approved HTTP deliveries to the installation's permitted exact origin.
- Workflow HTTP requests, file downloads and Slack operations, including nested
  paths/loops, pagination, readback, current drafts and old versions retained by
  unfinished work. Draft tests use an immutable test version with their explicitly
  rebound accounts. Multipart HTTP bodies can contain stored file bytes, names
  and content types; file downloads send the URL request, not local file bytes.
- Feed and URL polls and owner-requested historical source previews. Historical
  release uses stored records; it does not refetch the original source.
- Enabled or disabled operational log sinks, with their selected metadata fields.
  An S3 signing region is shown as owner-configured, not verified data residency.
- Local-only live development AI when Models service bindings are present. It
  forwards the caller's AI input and optional feature label with the installation
  key. The deployed Worker has no development AI door or production agent step.

Provider region and retention are provider-controlled. Where Crank has no verified
terms, it says so and directs the owner to their agreement; it never invents a
region, retention period, certification or compliance result. Local payload,
attachment and history periods are separate, displayed in Data under DATA-003.
Financial/health agreements and data locations remain owner attestations.

Core native operation has no required author telemetry, license request or kill
switch. Local sign-in/data, approved HTTP delivery, history and export operate
without optional app connections. Software installation and updates are explicit
operator commands. Fonts and app assets are served by the installation itself.

Archives omit installation credentials, sessions, keys and receiving authority.
On another installation, reconnect providers and explicitly adopt workflows;
old sessions and tokens cannot authorize work there. A revoked connection cannot
send new requests. See [Backup and restore](BACKUP-RESTORE.md) for the exact
inactive restoration and erasure behavior.
