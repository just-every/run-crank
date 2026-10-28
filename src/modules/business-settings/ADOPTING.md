# Adopt Business settings in a seed

Follow these steps in the seed's own repository. The integration changes its
running workspace, sign-in/setup branding and native team accounts; preserve
the approved product mark and public marketing pages. The [API reference](README.md)
defines transport, limits and method results.

## 1. Bring in source and the migration

Copy `./modules/business-settings` from the selected Base revision to the same
relative path in the seed. Its production entry is `./modules/business-settings/index.ts`.
It imports `ink` from `./foundation/runtime/theme-frame.ts`, which imports
`./foundation/runtime/icon-head.ts`: copy both files at those paths too, or
adapt those imports coherently to the seed's source layout. Keep these
server modules out of browser bundles. This recipe uses source imports and
does not require or promise an npm package subpath export.

If using operator-auth, update that module from the same Base revision,
preserving the seed's configuration, custom policy and applied migration
history. The updated source supplies `auth.businessTeam` and the Business
branding/stop integration. Native-account compositions need their own team
adapter; passing `businessSettings` alone does not provide one.

Copy `./modules/business-settings/schema/0001_business_settings.sql` and
`./modules/business-settings/schema/0002_business_people.sql` into the
seed's normal migration directory under consecutive unused migration numbers.
The maintained reference uses `./default-seed/migrations/core/0033_business_settings.sql`.
Do not replace an applied migration or assume 0033 is free in another seed.
An installation that already applied the first schema adds only the second.
Apply it through the seed's existing local/deployment migration lifecycle,
on the same D1 binding as the native accounts. The first creates settings storage and
`bs_overrides`, `bs_logo`, `bs_team`, `bs_audit`, `bs_assert`. The second adds
`bs_settings.owner_id`, `bs_team.business_id` and `bs_team.business_role`,
including a unique index for non-null Business teammate IDs.
Apply it before starting the runtime. The first document or owner stop creates
the singleton row; a fresh installation stays empty for archive restore.

## 2. Declare the slots the app actually renders

Add this optional top-level block to the root `rer-setup.json`, retaining
its existing fields and owner-claim steps:

```json
"business": {
  "settings": 1,
  "values": ["display_name", "owner_name", "brand_color", "logo", "timezone"],
  "team": {"roles": {"admin": "admin", "member": "member"}}
}
```

Only declare slots wired in step 4. `display_name` is required; the others
are optional and cannot repeat. Omit `team` unless the seed reconciles
multi-user accounts. Both role mappings are required when present; custom
names must be trimmed, nonempty, at most 64 characters, and never grant
native ownership. The OA adapter accepts only native `admin` and `member`.
The objects are closed. Keep existing mapped public inputs for first-build
values; remove any `businessField:"logo_ref"` hint. Logo never uses an env URL.

Declare `RER_BUSINESS_TRUST?: string` in the Worker bindings and carry the
platform-provided value into the runtime. Trust contains public verification
keys, exact issuer/audience/subject and optionally owner email. Leave it absent
for an unlinked installation: the document door returns 404. Do not create a
local signing key or make missing trust accept unsigned documents. For a
self-hosted trust, audience is `"self-host"`; hosted audience is the app origin.
If trust omits `email`, provide an adapter `ownerEmail()` that reads the
currently claimed owner's normalized email, even when no team is adopted.

## 3. Construct and route the runtime

Use one declaration matching the manifest. In a server-only integration
module, with the seed's existing `authConfig` and `mailSender`:

```ts
import { createBusinessSettings } from './modules/business-settings/index.ts'
import type { BusinessManifest } from './modules/business-settings/types.ts'
import { createOperatorAuth } from './modules/operator-auth/index.mjs'

const business: BusinessManifest = {
  settings: 1,
  values: ['display_name', 'owner_name', 'brand_color', 'logo', 'timezone'],
  team: { roles: { admin: 'admin', member: 'member' } },
}

const teamAuth = createOperatorAuth({ db: env.DB, config: authConfig, mailSender, clientIp })
const settings = createBusinessSettings({
  db: env.DB,
  trust: env.RER_BUSINESS_TRUST,
  business,
  team: teamAuth.businessTeam,
})
const auth = createOperatorAuth({
  db: env.DB, config: authConfig, mailSender, clientIp, businessSettings: settings,
})
```

Adjust source import paths to the integration module. Retain the seed's
existing auth options, including client-IP handling, native policy and hooks.
Construct the team-side auth without `businessSettings` to avoid recursive
factories. Use the second auth instance in the seed's existing auth/sign-in
handlers. For a custom native adapter, pass that adapter as `team` instead.
For a seed without any adapter, bind the owner through trust's `email`.

In the Worker's fetch handler, before app authentication, setup redirects or
SPA dispatch, call `const response = await settings.handle(request)` and
return it when non-null. Preserve the seed's normal rejected-upload draining
wrapper if it has one. Route all three owned paths: `/api/rer/business-settings`,
`/rer-business-logo`, `/rer-business.css`. Permit them through the seed's
sessionless-route configuration; the POST authenticates the signed document,
not a browser cookie. Preserve all other fetch, queue and scheduled handlers.
The POST body limit is 512 KiB; decoded logos are at most 256 KiB.

## 4. Render values and connect owner edits

Read on each request or server loader, rather than freezing values at build
time. Render `await settings.publicBrand()` in the workspace/organisation
slot, retaining the product mark. It supplies an optional display name and
`/rer-business-logo?v=<sha12>`. Use the name and logo on business-owned public
pages where appropriate. Escape names through the normal template/React path.

In authenticated loaders, resolve `owner_name` and `timezone` against the
seed's existing defaults. Apply timezone to actual date/time formatting;
do not merely show its name. Keep owner name and team data behind native
sessions. Never serialize `read().document` into a public loader.

Link `/rer-business.css` only in the signed-in app shell. Use
`var(--rer-business-accent, <seed accent>)` for filled controls or selected
navigation, paired with `var(--rer-business-accent-text, <seed ink>)`.
Do not use the accent for text or fine lines, marketing/homepage routes,
sign-in/setup frames, public invoices/status pages, product marks or favicons.
Logo and CSS routes support GET/HEAD and conditional ETags. Versioned logos
cache for one year, unversioned logos for five minutes, and CSS for 60 seconds.

With updated OA handlers, passing `businessSettings: settings` supplies
sign-in name/logo and owner-only Business provenance plus the fresh-proof
stop control. For Base's first-run frame, pass
`{theme:{...existingTheme,businessSettings:settings}}` to `firstRunResponse`.
Custom sign-in/setup pages can use `publicBrand()` directly.

For every outgoing mail path, resolve `display_name` at send time and use it
as the sender's display name, retaining the provider-approved sender address.
This is adopter integration work: `createBusinessSettings` does not rewrite
arbitrary mail senders. Cover native invitations and sign-in mail as well as
the seed's own notifications; avoid calling a recursive auth factory from mail.

Where native editors already save these settings, authorize the edit normally,
then call `setOverride(field,value,actorId)`. Add a reset action calling
`clearOverride(field,actorId)`. Overrides survive new documents. For logo
edits provide `{sha256,type,bytes,data}` with standard base64 bytes, or null
to hide the logo; `resolve('logo',null)` returns metadata without `data`.
Use `publicBrand()` to render its URL. See the [override API](README.md#construction-and-methods).

## 5. Integrate native team accounts

Use `auth.businessTeam` for the standard OA account store. For a seed-owned
account model, implement this server-only interface on the same D1 database:

```ts
ownerEmail?(): Promise<string | null>
prepare(input: {
  members: { id?: string; email: string; name: string; role: 'admin' | 'member'; invite: number }[]
  managed: { email: string; operatorId: string | null; invite: number;
    businessId?: string | null; businessRole?: 'admin' | 'member' | null;
    state: 'invited' | 'active' | 'inactive' | 'conflict' }[]
  ownerEmail: string
  roles: { admin: string; member: string }
  guard: { sql: string; args: unknown[] }
}): Promise<{
  statements: Statement[]
  rows: ManagedMember[]
  afterCommit(): Promise<void>
}>
```

`members` is the verified desired roster. `managed` is the module's durable
ownership ledger, including inactive records; `operatorId:null` represents
a conflict. `ownerEmail` is the verified actor. `roles` is the seed's mapping.
Return native prepared statements and the complete next managed ledger;
the module writes `bs_team` itself. Preparation may read and build statements,
but must not mutate accounts or send mail outside the module's transaction.
The module derives `business_id` and `business_role` from the verified roster
and previous bindings, independently of the adapter's returned row metadata.
Do not infer the Business role from a mapped native role. Before preparation,
an existing member `id` projects its managed row onto the current signed email;
the row's native `operatorId` stays unchanged. Always use that operator ID for
an established binding, even when its native email has changed. Retain IDs and
inactive rows in the complete ledger. Legacy documents can omit IDs; adding an
ID to an unlinked legacy row establishes its durable Business identity.

The module first places its settings compare-and-swap in the batch, then
its logo writes, adapter statements, managed-ledger/audit writes and a final assertion.
`guard` checks the newly accepted revision **and a fresh random nonce** with
`stopped=0`. It becomes true after the settings CAS succeeds in that batch,
not during `prepare`. Repeat `guard.sql` with its bound `guard.args` in every
native mutation, combined with live owner/target versions and native policy.
Do not replace it with a revision-only check, evaluate it early, or run the
statements in a separate batch. A stale writer must change no settings,
membership or sessions. Statement/row types are exported from `types.ts`.

Create invited users through native invitation preparation. Touch only
accounts whose IDs match prior managed records; report pre-existing native
accounts and owner matches as conflicts. Role changes must preserve native
authorization. Removal deactivates accepted accounts, cancels invitations
and fences sessions. Re-addition restores managed access through the native
reactivation/invitation path. A larger `invite` requests a new invitation.
Audit every change with the claimed owner as actor and "via Business" context.
Native owner privileges must never be mapped, granted or modified.

`afterCommit()` runs only after the whole D1 batch succeeds; send prepared
invitations there through the seed's mail sender. Delivery failure after
commit does not roll back the accepted revision: surface it through the
seed's existing mail/error handling, and use the supported re-invite flow.
`team:null` performs no reconciliation; `team:[]` removes managed access.

## 6. Verify the assembled seed

Use the seed's normal targeted verification and real local D1 runtime.
`testing/index.mjs` supplies `testTrust`, `testDocument`, `signSettings` and
`fixtureKeys` for test code only. Never import that Node entry or fixture
signing material into a Worker, browser bundle or production configuration.

Verify a signed higher revision changes rendered slots, while wrong trust,
expired documents and replay cannot change stored values or native accounts.
Exercise logo replacement/removal, overrides/reset, conflicting native users,
invite acceptance, role change, removal/session invalidation and re-invitation.
Verify optional Business person IDs, rejected duplicate/owner IDs, legacy
documents without IDs, and unchanged native operator bindings after native
and signed-roster email changes. Include a native role mapping that differs
from the signed Business role and check the stored `business_role` directly.
Check mail sender display names, real timezone formatting and public/private
loader boundaries. Compare the approved homepage at desktop and mobile sizes
before and after a Business colour change; its rendering must stay identical.

Finally exercise owner stop with fresh proof and signed detachment. Both
must close the document door while keeping last values, overrides, logo and
team accounts; public rendering remains available. Document adoption and
migration requirements in the seed's release notes. The default-seed server,
`src/core/platform/business.server.ts` and app loader show source integration,
but do not substitute for verification of the adopting seed's own slots.
