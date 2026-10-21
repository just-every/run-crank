# Enterprise read proposals

`src/crank/custom/enterprise-recipes.ts` constructs two inert, versioned custom
connector proposals. It uses the existing definition schema and egress validator;
it does not install a connector, obtain credentials, grant consent or make a
provider request. Real ServiceNow and SAP provider sandbox proof is pending.
These recipes belong to CONN-020, the enterprise/agent/SSO clause split from
CONN-011 by ct on 21 October 2026. They do not establish completion of CONN-020.

## Export and integration

```ts
export const ENTERPRISE_RECIPE_IDS = [
  'servicenow_incidents', 'sap_business_partners',
] as const

export interface EnterpriseRecipeRequest {
  recipe: 'servicenow_incidents' | 'sap_business_partners'
  tenant_origin: string
  id: string
  version: number
  scopes: string[]
  disclosure: {
    recipient: string
    purpose: string
    fields: string[]
    region: string
    retention: string
  }
}

export function proposeEnterpriseRecipe(value: unknown): CustomDefinition
```

The caller supplies a literal public HTTPS tenant origin, with no credentials,
path, query or fragment. A trailing slash is accepted. `disclosure.recipient`
must equal the normalized origin (`new URL(tenant_origin).origin`). Private,
loopback, metadata and internal hostname literals are refused by `checkEgress`.
The existing egress validator does not independently resolve public hostnames to
detect private DNS answers; deployment egress policy remains necessary.

`POST /api/crank/custom-connectors/propose` accepts this recipe request and returns the exact definition and `digest(canonical(definition))` through the
existing custom connector proposal/review flow. The native owner must review that
exact definition, its requested scopes and disclosure before installation. Keep
installation, connection setup and sandbox acceptance on the existing authorized
doors. This module does not bypass their native-owner or immutable-version checks.

Scope names are tenant configuration, not constants in the recipes. Supply the
exact OAuth scopes your tenant administrator configured and can verify. Every
recipe operation depends on all requested scopes, so refusing one excludes that
operation at installation. The recipes declare OAuth2 only; actual client
registration, OAuth endpoints, account roles/ACLs and secrets belong to the stored
connection. No invented read scope or API-key authentication is substituted. If a
tenant uses no named OAuth scopes, an empty list is representable, but it does not
prove the existing revoked-scope sandbox gate. Such a version remains in sandbox
until its actual acceptance requirements can be met.

The disclosure must include `sys_id` for ServiceNow or `BusinessPartner` for SAP
among the fields sent to the recipient. Purpose, provider region and retention
must be supplied and reviewed by the owner; neither recipe guesses them. The
provider returns the fields its API and account permissions expose. These
recipes do not enforce a response field projection.

## Fixed read operations

| Recipe | Operation | GET path after the tenant origin | Required path input | JSON record in workflow output |
| --- | --- | --- | --- | --- |
| `servicenow_incidents` | `get_incident` | `/api/now/table/incident/{sys_id}` | `sys_id`: string | `body.result` |
| `sap_business_partners` | `get_business_partner` | `/sap/opu/odata/SAP/API_BUSINESS_PARTNER/A_BusinessPartner(BusinessPartner='{BusinessPartner}')` | `BusinessPartner`: string | `body.d` |

Both operations use custom kind `action` and HTTP `GET`: they read one record and
preserve the provider response envelope. They do not claim the custom search
array contract. The existing HTTP adapter prefers JSON in its Accept header;
verify the actual provider content type and envelope in the tenant sandbox.
ServiceNow ACLs and SAP communication arrangements remain authoritative.

The recipes fix the table/entity and resource path. SAP string keys escape embedded apostrophes using OData doubled-quote syntax before URL encoding. The owner supplies only the
origin when proposing and the record key in a workflow step. They expose no
collection traversal, writes, `$batch`, triggers, expand/filter expressions,
arbitrary table names or gateway authority. SAP `$` query options are not exposed
because the current custom definition input identifier schema cannot represent
them. ServiceNow offset pagination and SAP OData next links are not re-labelled as
the custom cursor protocol; no pagination or complete-export claim is made.

## Workflow and acceptance evidence

After exact proposal review and installation, a draft workflow may use a
`custom.request` step with the returned connector id, pinned connector_version,
the listed operation id, a separately stored OAuth connection_id, and the
required key in its input. Its actual public workflow adapter must be exercised;
calling the proposal constructor alone is not runtime proof.

At the network edge, the integration journey should assert the owner-supplied
host, fixed GET path, encoded record key, stored connection credentials and
provider-shaped JSON response. Assert invalid origins and undeclared inputs are
refused, refused/revoked scopes prevent dispatch, and the installed version starts
in sandbox. Network-edge fixtures belong only in tests. No request shim, mock
provider or production fallback is included in these recipes.

Real provider acceptance still needs authorized tenant receipts: read back an
existing sandbox incident or business partner; demonstrate denied/revoked tenant
scope behavior; complete the connector's existing duplicate-event acceptance
through its supported authenticated gateway or signed-webhook door; inspect
production gating and retained evidence. A single-record GET recipe does not
itself implement a webhook or duplicate delivery source. Provider credentials and
customer records must stay out of source, logs and evidence fixtures. Until these
receipts exist, report provider sandbox proof pending.

## Primary references

Consulted 22 October 2026:

- [ServiceNow Table API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/c_TableAPI.html)
  documents the single-record GET route and its `sys_id` input.
- [ServiceNow REST APIs](https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/c_RESTAPI.html)
  describes table ACL enforcement and offset-based collection pagination.
- [SAP Business Partner (A2X) – OData API](https://help.sap.com/docs/SAP_S4HANA_CLOUD/3c916ef10fc240c9afc594b346ffaf77/85043858ea0f9244e10000000a4450e5.html)
  documents the named-key GET route for `API_BUSINESS_PARTNER` used here. Its
  broader CRUD and batch capabilities are outside these read proposals.
