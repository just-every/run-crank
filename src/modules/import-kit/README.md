# Import kit

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

The import kit plans and applies reviewed, inert data imports. It preserves the
source records, available custody bytes, and the provenance needed to inspect,
resume, reconcile, or reverse an import. Without an intake declaration, custody
keeps the exact available source bytes. A door source that declares an intake
allowlist drops other fields before any persistent write and keeps the sanitized
NDJSON as its original custody; it never stores the raw export. It does not send
messages, enqueue work, activate access, or run application lifecycle hooks.

## Adopt the shared door

For a seed, start with [the complete door adoption guide](src/door/ADOPTING.md).
The signed-in screen, RER and Business share upload, plan, reviewed fingerprint,
apply, reconcile and undo. Keep product readers, mappings and native adapters;
remove separate importer routes and their job creation/apply callers. Owner
history and Undo include jobs from either authority.

Use the door's optional static `intake: {formats, allow}` declaration when a
seed's source contract prohibits retaining fields outside an allowlist, including
in uploads and originals. CSV lists exact case-sensitive decoded headers; JSON
and NDJSON list exact RFC 6901 pointers to scalar leaves. The door streams the
raw request through that drop-only declaration into NDJSON before storage;
parsers and mappings still run during planning with `credentials: 'remove'`.
No sanitizer callback or client-supplied sanitizer/hash is accepted. See the
[intake protocol](src/door/README.md#optional-intake-before-custody) and the
[Auth adoption example](src/door/ADOPTING.md#example-auth-source-contract).

The declaration belongs to the source returned to both door mounts:

```ts
const source: ImportDoorSource = {
  parse, mapping,
  intake: {
    formats: ['csv', 'ndjson'],
    allow: {
      csv: ['user_id', 'email', 'name', 'blocked'],
      ndjson: ['/user_id', '/email', '/name', '/blocked'],
    },
  },
};
```

## Engine primitives

The APIs below implement the shared pipeline. They are not an alternative
owner-facing importer to mount alongside the door.

The source entry point is [`src/index.ts`](./src/index.ts). Its main exports are:

- `readFileSource` and `readApiSource` to parse bounded exports while retaining
  exact artifact bytes;
- `planImport` to map records into effects and report omissions or rejections;
- `createImportJob`, `applyImportBatches`, and `resumeImport` for reviewed,
  durable application;
- `undoImport` and `rollbackImport` to reverse completed or partially applied
  work;
- `readImportJob`, `readPersistedImport`, `readImportOriginals`, and
  `reconcileImport` for status, custody, and independent comparison;
- `validateImporters` for registry shape plus evidence-policy validation.

The product supplies the parser, mapping, native target adapter, and a fresh
`ImportContext` for the authenticated actor and destination. A typical flow is:

```ts
import {
  applyImportBatches,
  createImportJob,
  openSqliteImportStorage,
  planImport,
  readFileSource,
  resumeImport,
  undoImport,
} from './src/index.ts';
import type { ImportContext } from './src/index.ts';

// These values and helpers come from the product's parser, mapping, native schema,
// authenticated request, and current permission store.
const storage = openSqliteImportStorage(databasePath, { targets: productTargets });
const context: ImportContext = {
  destination,
  namespace,
  mappingVersion: mapping.version,
  storage,
  authorization: {
    principalId: actor.id,
    assertAuthorized(action, destination, db) {
      requireCurrentImportGrant({ db, principalId: actor.id, action, destination });
    },
  },
};

const source = await readFileSource(fileInput);
const plan = planImport(source, mapping, context);
showPlanForReview(plan); // product-owned review surface
context.reviewedFingerprint = plan.fingerprint; // set only after approval

const job = await createImportJob(plan, context);
const partial = await applyImportBatches(job.id, { ...context, maxBatches: 2 });
if (partial.state === 'completed') {
  await undoImport(partial.id, context);
} else if (partial.state === 'applying') {
  // A later process reopens the same database and rebuilds context for its current actor.
  const currentActor = requireAuthenticatedActor();
  const recoveryContext: ImportContext = {
    destination,
    namespace,
    mappingVersion: mapping.version,
    storage: openSqliteImportStorage(databasePath, { targets: productTargets }),
    authorization: {
      principalId: currentActor.id,
      assertAuthorized(action, destination, db) {
        requireCurrentImportGrant({ db, principalId: currentActor.id, action, destination });
      },
    },
  };
  const completed = await resumeImport(job.id, recoveryContext);
  await undoImport(completed.id, recoveryContext);
}
```

`requireCurrentImportGrant`, `requireAuthenticatedActor`, `showPlanForReview`, and
the sample values above are product-owned. `requireCurrentImportGrant` must
synchronously check the supplied database and throw on denial. The reviewed
fingerprint must be the fingerprint shown to the reviewer. Rebuild the context
after reopening the database with the current actor; do not persist authorization
callbacks, credentials, parser functions, or mapping functions in the import job.
Resume uses the immutable retained plan and needs only the job ID and current
authorized context. Handle failed states through the product's review and
rollback flow instead of retrying them blindly.

`rollbackImport(jobId, context)` reverses applied batches after a partial failure;
`undoImport(jobId, context)` reverses a completed import. Both preserve retained
source and before-image audit data. Reversal is restartable and checks the exact
applied revision and value before changing a target. A native edit is reported as
`NATIVE_EDIT_CONFLICT` and preserved.

## Credential names

A name is a credential when its **whole parts** are a credential word or phrase,
never because a part only contains the letters of one. The kit splits an object
key, a header name, the name in a `[name, value]` pair and a URL query or
fragment key into lower-case parts at camelCase and PascalCase boundaries
(`apiKey`, `XAPIKey`), at `_`, `-`, `.`, spaces and any other non-letter, and at
digits (`token2` is `token`). One rule serves refuse mode (`assertNoCredentials`,
the readers), the import door's `credentials: 'remove'` (which drops the value
and notes it per record) and rer's vendor exports, at two reaches:

- **Refuse mode** takes the whole name as the phrase, after an optional header
  `x-`: the word alone or after one qualifier (`token`, `access_token`,
  `refresh_token`, `X-Auth-Token`, `password`, `httpPassword`, `client_secret`,
  `api_key`, `x-api-key`, `private_key`, `cookie`, `Authorization`, `bearer`), a
  `secret`, `subscription` or `functions` key under any name
  (`Ocp-Apim-Subscription-Key`, `x-functions-key`, `secret_key`), and `pwd`. A
  longer name such as the pagination cursor `next_page_token` is not refused.
- **Remove mode and URL keys** take any name that ends in the phrase
  (`pushToken`, `integration_key`, `db_pwd`, `webhook_url`), since removing a
  value keeps the record.
- **URL query and fragment keys** also count a bare `key` (the `?key=`
  convention), a last part `sig` or `signature` (an Azure SAS `sig`,
  `X-Amz-Signature`), `key`/`keys` after `application`, `user`, `account`,
  `deploy` or `shared` (Datadog's `application_key`, 3scale's `user_key`,
  `account_key`, `deploy_key`, `shared_key`), `auth` after `token`, `basic`,
  `http`, `proxy` or `api` (Matomo's `token_auth`, `basic_auth`, `http_auth`), and
  a one-part key ending in `apikey`, `accesstoken` or `authtoken` (HubSpot's
  `hapikey`). As record fields these stay, since a field such as `user_key` or
  `account_key` names a record far more often than a secret.
- **Header-only names:** `sig`, `signature` and `sessionId` (`session_id`,
  `Session-Id`) are credentials only as URL query or fragment keys and as HTTP
  header names: the name in a `[name, value]` tuple, a key of an object under
  `headers`, `header` or `customHttpHeaders`, or the name of a
  `{name|key, value}` pair in such a header list (`customHttpHeaders`, HAR's
  `headers`, Postman's `header`). As a record's field they are data, so a
  support export's agent `signature` (Zendesk and Freshdesk users and agents)
  and a chat's `session_id` import as they are in refuse and remove mode.
- **A `{name|key, value}` pair outside a header container labels a field.**
  Its name has the field place, so Help Scout's
  `customFields: [{name: 'Session ID', value}]` and Zendesk's
  `custom_field_options` named `Signature` or `Session ID` import intact, while
  a pair named `Authorization`, `password` or `api_key` loses its value
  anywhere.
- **`auth` and `credentials` hold a credential only when they hold one.** A
  field or container named `auth`, `X-Auth`, `credential` or `credentials` is
  refused (or removed) when its value is text that is no placeholder and names
  no scheme or mode, or a list with such a member; an object under it is searched
  field by field like any other, so its credential-named fields (`auth: {token}`,
  `credentials: {password}`) and credential-bearing URLs are refused, or removed
  and noted at their own path. `auth: {type: 'oauth2'}`, `credentials: []`,
  fetch's `request.credentials: 'include'` and `auth: 'Bearer'` are accepted as
  they are. The scheme and mode names are fetch's `include`, `same-origin` and
  `omit`, and the HTTP and API schemes (`none`, `basic`, `bearer`, `digest`,
  `oauth2`, `apikey`, `jwt`, `ntlm`, `aws`, `sigv4`, `hmac` and the like) and the
  boolean words `true`, `false`, `yes`, `no`, `on`, `off`, `enabled` and
  `disabled`, so Keycloak's `smtpServer.auth: "true"` imports intact.
- **Generic member names count inside `auth` and `credential(s)`.** Directly
  under such a container (an object, or the objects in a list), a member named
  `value`, `pass` or `pw`, or one whose first part is `secret` (`secretData`),
  holds the credential: a Keycloak realm user's
  `credentials: [{type: 'password', value}]` and `[{secretData}]`, nodemailer's
  `auth: {user, pass}` and `credential: {type: 'apiKey', value}` are refused, or
  removed and noted at their own path (`/credentials/0/value`), and rer's
  vendor exports mark them `[removed]`. Elsewhere `value`, `pass` and `pw` are
  data. Their siblings (`type`, `user`, `username`, `temporary`) stay, so
  `auth: {type: 'bearer'}` and `credentials: {username: 'ops'}` import intact; a
  bare `key` under them (`credentials: {key}`) usually labels and stays.

The words are `token`, `secret`, `password`, `passwd`, `pwd`, `cookie`,
`authorization`, `bearer` and `credential(s)`; `key` counts after a qualifier
(`api`, `access`, `private`, `secret`, `auth`, `client`, `integration`,
`routing`, `service`, `signing`, `session`, `refresh`, `subscription`,
`functions`, `consumer`, `app`, `license`, `master`, `encryption` or `admin`);
`auth` and `X-Auth` and the one-part spellings (`apikey`, `accesstoken`,
`clientsecret`) count; `passphrase`, `jwt` and the Java and PHP session cookies
`JSESSIONID` and `PHPSESSID`, however split (`passPhrase`, `jsessionId`), count
everywhere, as fields, header names and URL keys, since they name nothing else
(`jwt_issuer` and `jwtAudience` end in another word and stay); and `sig`,
`signature` and `sessionId` count as a whole header name and as URL keys. Plurals (`tokens`, `apiKeys`, `secrets`,
`passwords`) hold credentials only as text, so `tokens: 1500` is a count and
stays.

- **Borderline names are not credentials:** `primaryKey`, `foreignKey`, `sortKey`,
  `monitorKey` and `keyType` name a database or sort key or an identifier, not a
  secret, and treating them as credentials would fail real exports. A bare `key`
  is a credential only as a URL query or fragment key, never as a field. Public
  identifiers (`publicKey`, `keyId`, `AWSAccessKeyId`) are not credentials.
- **Look-alikes are not credentials:** `keyword`, `keywords`, `monkey`, `donkey`,
  `turkey`, `hockey`, `author`, `authority`, `authors`, `signal`, `design`,
  `signup`, `tokenizer`, `passwordless`, `keyboard` and the like. An UptimeRobot
  keyword monitor's `?keyword=up` plans with its URL intact, while an `?api_key=`
  beside it is still removed (or refused).
- **Trade-off:** a `Signature` or `Session-Id` header and a `?sig=` key are
  credentials, but a record field of the same name is not, so a signature or
  session token an exporter wrote as a plain record field is kept; the value
  checks below still apply to it. A field named just `auth` holding text other
  than a scheme, mode or boolean word is a credential.

Value-shaped detection is unchanged: user names and passwords in URLs, known
token prefixes, base64 and every encoding layer are checked as before. Null, an
empty string, a mask (`****`, `[redacted]`, `[removed]`) and a boolean under a
credential name are not credentials.

## Plan-size cap

New plans and plans submitted for creation are bounded by the inclusive
`PLAN_BYTES_LIMIT` (300,000,000 bytes). This is the UTF-8 length of the canonical
JSON content **without the `fingerprint` property**. The complete stored plan
adds exactly 81 bytes for the comma, property name, colon and quoted 64-character
SHA-256 fingerprint: at the cap it is 300,000,081 bytes. That fixed overhead is
reserved below the encoding limits; the content count is not the stored size.
Keys, separators, escaped controls/quotes/backslashes, Unicode, lone surrogates,
metadata, originals' base64 and every repeated occurrence of source, effect or
diagnostic data count. Shared object references do not save serialized bytes.

`planContentBytes(plan)` measures content without building its encoding. The
planner admits its initial source/metadata envelope before copying it, then
reserves the second source occurrence before hashing or cloning mapper input,
then counts each mapping, diagnostic, artifact change and count lexeme in a
running total. It checks mapper expansions and the cumulative retained plan
before cloning or encoding effects, validating attachments or encoding target
identities. Unsupported durable JSON, cycles, nesting beyond 256 containers and
sizes beyond safe-integer arithmetic, including cumulative reservations and
signed replacement/count deltas, are rejected as `INVALID_JSON` before the
recursive serializer runs. Existing valid stored jobs keep their resume contract;
the cap does not replace their fingerprint, custody or inventory integrity checks.

`planImport`, `planD1Import`, `createImportJob`, `preflightD1ImportJob` and
`createD1ImportJob` refuse oversized input with `PlanTooLargeError`, code and
message prefix `IMPORT_PLAN_TOO_LARGE`, numeric `bytes` and `limit`, and `subject`.
A `source` size is the source alone, a lower bound on the eventual plan. A `plan`
size is the measured content constructed so far, including the pending source
entry or mapping that crossed the bound; later mappings are not invoked. Creation checks the complete
submitted plan. Show the measured count and limit in the product's preview,
before writes. D1 creation rechecks after awaited lookup on both fresh and replay
paths, and after stored-plan, custody and inventory reads before replay's atomic
boundary. Pure preflight confers no authority; transactions still check current
authority and the original reviewed fingerprint.

The cap follows the second 8 October 2026 ruling. The following historical local
observations are unverified here; no corresponding benchmark receipts are
retained in this repository. Historical boundary probes on
Node 26.8.1 showed that fresh input reaches V8's 536,870,888-character string
bound or the module runner's 4 GiB heap limit before exhausting the 1,000-request
D1 budget. At the earlier encoding boundary, one `JSON.stringify` output buffer
can abort at 256 MiB; `canonicalJson` therefore escapes strings longer than 1 MiB
in slices without splitting surrogate pairs. The byte cap is about 56% of V8's
string bound, with room for the fingerprint overhead.

The recorded 9 October 2026 checks of this guard implementation, on Node 26.8.1 with
`--max-old-space-size=4096`, measured:

- A 55,570,000-byte original: 56 actual create executions, equal to preflight,
  exact original bytes/hash/size, chunked plan, and every public request <=1,000.
- Quote-heavy mapped content: 299,899,168 content bytes, 342 preflight executions,
  2,660,488,040 bytes heap used at observation, 3,791,683,584 bytes peak RSS.
- Three-byte UTF-8 mapped content: 299,881,168 content bytes, 179 preflight
  executions, 1,487,613,656 bytes heap used at observation, 3,000,123,392 bytes
  peak RSS.
- The real-D1 inclusive 300,000,000-byte admission and 300,000,001-byte refusal
  pass. Refusal leaves every `ik_*` table empty. The combined original-based
  boundary/55.57 MB test peaks at 5,776,048,128 bytes RSS: a 4 GiB **heap** limit
  is not a 4 GiB total-memory promise, especially with buffers, input copies and
  the native runtime. Allocate process capacity accordingly.

The historical twenty distinct 10 MiB original-custody lifecycle report recorded
exact bytes through undo. It does **not** prove every twenty-file maximum-content
CSV import fits. A representative valid twenty-table CSV shape (105 rows/table, two fields,
10 MiB/file, cells <=100,000 characters) requires 910,382,498 canonical plan
content bytes: originals alone contribute 279,620,320 base64 bytes, and parsed
source is retained both in the source and entries before effects are counted.
The kit cap is an additional storage bound. A product must name it honestly
without reducing its separate 20-table, 80-field, 10 MiB/file, 10,000-row/file or
100,000-character/cell limits, or dropping original/parsed data to fit.

These are local Node/Miniflare checks. Hosted Worker memory, CPU, upload and
provider storage capacity are not established; the adopting product must check
those independently. `tests/plan-size*.test.ts`, `tests/plan-mapping-size.test.ts`
and the SQLite/D1 cap tests cover exact measurement, pre-encoding mapper growth,
awaited changes, and inclusive/refusal boundaries. The untouched
`creation-remaining-budget.test.ts` still refuses a 1,001-execution invocation.

## Durable storage and native effects

The supported durable adapter is Node's built-in `node:sqlite`, opened with
`openSqliteImportStorage(filename, { targets })`. The targeted acceptance suite
runs on Node v26.8.1. Use a durable database file and pass the same synchronous
`TargetAdapter` for every operation, including recovery.
The adapter's native rows and the import journal, source identity claims,
provenance, originals, and attachment staging share that SQLite database and
transaction. External object-store custody is not claimed. The separately documented D1 port
uses an asynchronous native SQL adapter.

The supplied `sqliteTargets` adapter stores generic JSON target rows. A product
with a native schema should implement its own `TargetAdapter` on the provided
`SqlDatabase`, so each native write and its provenance commit or roll back
together. Adapter methods must be synchronous and must not make HTTP, queue, or
lifecycle-hook calls. This module records data effects; the product owns any
separate external-effect workflow.

Authorization is checked synchronously inside mutation transactions and again at
commit boundaries. The consumer callback must consult current authority using the
database passed to it and throw on denial. A cached permission check performed
before the transaction leaves a time-of-check/time-of-use gap. Jobs are bound to
the creating actor even when the actor is an administrator.

Each apply or reversal batch is one SQLite transaction. A lease claim increments
the fencing token; expired holders cannot publish or clean up a recovered holder's
work. After a process is killed, committed batches remain durable and an
uncommitted transaction is rolled back by SQLite. A new process reopens the same
file and calls `resumeImport(jobId, context)` after the existing lease expires.
It resumes the stored plan without refetching the source or rerunning the parser
and mapping. Repeated resume does not duplicate already committed target rows or
provenance. The same recovery path applies to an interrupted undo or rollback.

`modules/import-kit/tests/core/crash.test.ts` exercises real child-process
`SIGKILL` during apply and reversal, reopen, resume, unique durable attribution,
and completed undo. Its process termination evidence is local SQLite acceptance;
it does not establish a vendor export or provider integration.

## Registry shape and evidence

Consumers supply their own registry to `validateImporters`. The committed
Draft 2020-12 [`schema/importers.schema.json`](./schema/importers.schema.json)
defines its shape. Validation uses this local schema without a network request.

Schema validity does not establish that an importer has been verified.
`validateImporters` also needs a consumer-supplied evidence port and trust policy
to resolve and verify the referenced evidence. A `documented format` row records
`validation: "synthetic-only"` and `realExport: "not-supplied"`; only the required
real-export evidence can establish `verified` status.

### Signing receipts and supplying a trust policy

The public API exports `canonicalReceiptJson`, `signImporterVerificationReceipt`,
`verifyImporterVerificationReceipt` and `createReceiptEvidencePort`. The receipt
and status entry points (`src/receipt/index.ts` and `src/status/index.ts`) use only
WebCrypto and Web APIs and can run in a Worker or Node. The root entry also
exports these APIs alongside the existing Node SQLite engine. Package consumers
use `@runeditrun/rer/modules/import-kit/receipt` for signing, portable verification
and trust policy, and `@runeditrun/rer/modules/import-kit/status` for
`validateImporters`; both entries avoid the Node SQLite engine. Bundle these
TypeScript package entries for your Node or Worker target.

The signer takes a caller-supplied Ed25519 private `CryptoKey` with `sign` usage
and a payload satisfying
[`importer-verification-receipt` v1](./schema/importer-verification-receipt.schema.json).
It validates the schema, snapshots the payload and signs its canonical UTF-8
bytes. Canonical JSON sorts every object's keys recursively by JavaScript's
UTF-16 code-unit ordering, preserves array order, and uses `JSON.stringify`
scalar escaping and number representation, without whitespace. Non-JSON values,
non-finite numbers, sparse arrays and cycles are refused. The signature is padded
base64. Only `payload` is signed, as required by v1; envelope key IDs select a
public key and do not independently attest an issuer name. Reordering an object's
keys before verification is harmless; signing insertion-order JSON instead of
canonical JSON produces an invalid signature.

The verifier returns `{ valid, issues }`. It checks the complete schema
(including `source.sha256`, every dry-run/apply count and `byKind`), the signature,
and the existing mapping, count, reconciliation, unmapped-manifest and safe-text
rules. Unmapped items must be sorted by `sourceIdentitySha256` in the same UTF-16
code-unit order as canonical keys, never by locale, so every host reaches the
same verdict.
For the same reason the export origin, `source.origin`, is read by the module's
own ASCII grammar, never by the runtime's URL parser, whose IDNA tables differ
between Node and Workers releases. It must be `https://` (scheme letters in
either case), then a host, an optional port from 1 to 65535 without leading
zeros, and an optional RFC 3986 path (`/` and unreserved, sub-delimiter, `:`,
`@` and well-formed `%XX` characters), with no credentials, `?` or `#`. The
host is either a dotted-quad IPv4 address without leading zeros or labels of
ASCII letters (either case), digits and inner hyphens, optionally ending in one
dot, whose last label is not numeric (all digits, or `0x` hex). Write an
internationalized host as its `xn--` labels; they are not decoded, so every
runtime treats them as ASCII. Non-ASCII text anywhere, IPv6 literals and
WHATWG's lenient forms (backslashes, missing slashes, short or hexadecimal IPv4
numbers, empty labels) are refused.
`synthetic: true` always fails. A policy maps each `keyId` to a public
Ed25519 `CryptoKey` with `verify` usage or an SPKI PEM public key. Its `environment`
is a non-empty string chosen by the consumer; a key's optional `environments` array
restricts its use to the environments it names. An empty array refuses it
everywhere; omitting `environments` permits every environment, and any other
value (such as a string, `null` or `false`) refuses the key. Unknown IDs and keys
outside these rules fail closed.
The policy is trusted consumer configuration and must never come from the receipt
or registry being checked.

For example, given a real verification payload and its reviewed registry, this
Node example signs with a temporary development key, then checks pinned artifacts:

```ts
import { readFile } from 'node:fs/promises';
import {
  signImporterVerificationReceipt, verifyImporterVerificationReceipt,
  createReceiptEvidencePort, validateImporters,
} from './src/index.ts';

const payload = JSON.parse(await readFile('verification-payload.json', 'utf8'));
const registry = JSON.parse(await readFile('importers.json', 'utf8'));
const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const policy = {
  environment: 'stage',
  keys: { 'stage-development': { publicKey: keys.publicKey, environments: ['stage'] } },
};
const receipt = await signImporterVerificationReceipt(payload, 'stage-development', keys.privateKey);
const verified = await verifyImporterVerificationReceipt(receipt, policy);
if (!verified.valid) throw new Error(JSON.stringify(verified.issues));
// Publish JSON.stringify(receipt) and the finished research artifact. Pin the
// SHA-256 and byte size of those exact published bytes in registry evidence.
const evidence = createReceiptEvidencePort({
  trustedHosts: ['evidence.example.test'], // Use your controlled publisher host.
  async resolve(link) {
    const response = await fetch(link, { redirect: 'error' });
    if (!response.ok) return undefined;
    return { url: response.url, bytes: new Uint8Array(await response.arrayBuffer()) };
  },
}, policy);
const result = await validateImporters(registry, evidence);
if (!result.valid) throw new Error(JSON.stringify(result.issues));
```

`validateImporters` accepts that port directly. It additionally binds the receipt
to the row's incumbent/product and the resolved research bytes, and retains URL,
publisher-host, size and artifact hash checks. An evidence link's scheme,
credentials, host and port are read by the same grammar: an `https` link needs
`//` and a host of that form, which must equal an entry of `trustedHosts`
ignoring ASCII case (pin an internationalized host by its `xn--` form); a host
in the consumer's `evidence:` scheme may be any RFC 3986 registered name. The
path, query and fragment reach the resolver as written. A link may contain no
spaces or control characters, no credentials and no query key naming a token,
password, secret, API key or authorization. A valid result's
`evidence.verifiedReceipts` counts only verified rows whose receipts pass every
check. It does not promote or mutate registry rows; `documented format` keeps its
synthetic-only meaning. Existing `receiptPublicKeys` PEM pins remain an unrestricted
public-key policy when `receiptTrustPolicy` is absent; an explicit trust policy
takes precedence and never falls back to those pins on refusal.

Signing attests the caller's claims; it does not capture exports, recalculate the
source digest, run an importer or perform the review. The caller must calculate
those values from the actual export, preview, apply and reconciliation results.
The signer never generates, stores or retrieves production keys. The consumer
lists public keys only. Production private-key custody, issuer authorization and
rotation are owner decisions outside this module; this contract chooses none of
them. A stage-only key must be explicitly restricted to `['stage']` and cannot
authorize a production receipt.

Base keeps its edition registry and source-specific guides in its private
authoring tree. They retain exact source identities and evidence pins and are
not part of this reusable module. Review any consumer registry and its source
references before publishing it with an edition.

## Verification and further guidance

From the Base repository root, run `pnpm verify:modules` for the retained module
suites. The targeted crash and evidence-validation checks can be run with:

```sh
TMPDIR="$PWD/../scratch" node --test \
  modules/import-kit/tests/core/crash.test.ts \
  modules/import-kit/tests/status.test.ts \
  modules/import-kit/tests/receipt.test.ts
```

Set `TMPDIR` to an existing writable directory inside the work area before
running tests. [`CONTRACT.md`](./CONTRACT.md) defines durable and authorization
invariants, [`FIXTURES.md`](./FIXTURES.md) documents consumer fixture conventions,
and [`src/readers/README.md`](./src/readers/README.md) covers file and API reader
limits and byte custody.

## Cloudflare D1 Workers

The additive asynchronous [D1 port](./src/d1/README.md) is available through
`@runeditrun/rer/modules/import-kit/d1` in a supplying rer release after 0.2.77
(or `src/d1/index.ts` when working in Base source). It supports native SQL effects, reviewed jobs, durable bounded
resume, original custody and conflict-safe undo in the same D1 batch as its
journal. Products supply native snapshot predicates and current-session SQL
permission predicates. Use its D1-specific API and numbered schema migration;
existing synchronous APIs continue to require Node SQLite.

D1 consumers can opt new jobs into durable conflict-preserving undo while legacy
and omitted-policy jobs remain strict. The adapter supplies exact native
ownership/dependency snapshots; retained edits keep their original attribution.
See [D1 evolution 0001 and adoption instructions](./src/d1/README.md#adopting-preserved-conflict-undo-evolution-0001)
before updating a deployed D1 schema or adapter.

Existing strict D1 jobs switch policy only through the public reviewed
`previewD1PreservedUndo` / `convertD1ReversalPolicy` flow. Eligible jobs are
`completed` or `undoing`; conversion checks current undo authority, the job's
binding and the exact reviewed snapshot, then atomically appends its conversion
record and journal evidence with the new policy binding. It leaves provenance,
originals, claims and history unchanged. See the
[conversion decision table and migration requirements](./src/d1/README.md#reviewed-conversion-of-existing-strict-jobs).
Use `readD1ImportUndoReport().outcome` (`pending`, `undone` or `compensated`) for
the product result: the engine's terminal `job.state` remains `undone`, including
compensated work.

Historically, rer 0.2.77 lacked these APIs. Adoption through the package requires
a pinned supplying release, `@runeditrun/rer/modules/import-kit/d1`, the additive
conversion migration, a complete native adapter and proof through the seed's own
public door. Updating Base alone does not adopt or release the capability in a
seed.

### Erasing fields in retained shared records

Use `retireD1ImportCustody` from `src/d1/index.ts` to erase a person and journal
the change atomically with native erasure and portability's redaction checkpoint.
Its `person.related.fields` accepts `D1FieldRedaction[]`:

```ts
await retireD1ImportCustody({
  target: { kind: 'person', id: personId },
  values: [email],
  related: {
    fields: [{ path: ['reactions', '*', 'users', '*'], value: sourceUserId }],
  },
}, nativeStatements, context, checkpoint);
```

Paths start at a source payload or effect/native value, and also apply to
retained reversal before-images. String segments name object properties, numeric
segments select array indexes, and `*` visits array items. Only an exact string
leaf equal to `value` is removed: an array item is omitted or an object property
is deleted. For example `{ count: 2, users: ['A', 'B'] }` becomes
`{ count: 2, users: ['B'] }`; the aggregate count and peer record remain. Supply
both paths when the source and mapped values use different nesting. The default
seed demonstrates `['details', 'reactions', '*', 'users', '*']`, resolving
references from the native person ID and their optional `details.sourceUserId`.

Each distinct path with a required selector must match at least one exact leaf;
a path whose selectors are all `optional: true` may match nothing. An unmatched
required path refuses with `IMPORT_REDACTION_PATH_UNMATCHED` before native, custody, journal or checkpoint
writes. Multiple values for the same path share its count, so an absent alternate
identifier is allowed when another value matches. A different matching path cannot
hide a typo. Successful results include `fieldMatches: [{ path, matches }]`, never
selected values. Counts cover each logical retained source payload, effect value,
native value and stored reversal before-image; repeated custody copies count
separately. `readD1ImportFieldMatches(fields, context)` provides read-only discovery
for optional references as `{ fieldMatches, snapshot }`. Carry `snapshot` in
`related.snapshot` and preserve the selector set when using a scoped redaction
adapter, whose snapshot depends on those selectors. Mark references that may be
absent as `optional: true`. The snapshot fences discovery against custody/native
changes before publication and cancels incomplete private preparations even when
fields are empty. Erasure rechecks every supplied selector; a snapshot never
permits a required path to match nothing.

The kit rebinds payload/effect hashes, source claims, entry decisions, active and
historical provenance, before-images and plan/reversal fingerprints. Peer source
identities, applied revisions, counts and sequential checkpoints stay intact.
Resume uses sanitized pending effects; undo restores sanitized before-images.
Other native edits still produce the existing undo conflict. The adapter's
`list` must enumerate its complete imported native set and supply exact full-set
guards (`matchesMany` or `matchesCount` with individual snapshot predicates).
The kit writes sanitized native values through that adapter in the same batch.
An adapter with `redaction(db, destination, fields)` instead reads, fences and
rewrites only the rows holding a selected value, proving with holding-set
predicates that no other row holds one before or after, so the cost follows the
affected rows rather than the destination (default-seed's
`person-redaction.server.ts` packs them into a few statements: 3,000 affected
people take 191 statements in one request).
Caller statements must not separately change those retained peer targets; such
changes fail their snapshot guards. The product handles personal data outside
the adapter's set and outside the selected fields.

Affected originals are withdrawn whole under `originalErasurePolicy` (the
journal API defaults to `withdraw-affected-artifacts`), never rewritten as an
apparently original archive. Use `related.original` for additional byte artifacts
the product recognizes. Field erasure cancels private preparations in that
destination because incomplete staged data cannot be safely field-rewritten.
Public peer jobs remain usable; cancelled preparations must be reviewed again
from sanitized input. Preserve the journal and portability checkpoint in exports:
a pre-erasure archive is refused when the current or supplied later journal
fences it. This does not authorize importing new unsanitized source exports;
the product must filter erased identities when accepting new input.

A selector with `optional: true` is an alternate identifier the person may not
have: a path whose selectors are all optional may match nothing. Pass optional
references this way rather than omitting fields after discovery; with a
`redaction` adapter the discovery snapshot depends on the selectors.

**Fields without a target.** A person who never became a native record (a
cancelled invitee on another person's booking) is erased from custody with
`retireD1ImportCustody({ values, related: { fields } }, [], context, checkpoint)`:
their values leave every source payload, effect, before-image and native row,
originals holding them are withdrawn, and the shared record keeps its effects,
resume and undo. `related.source` and `related.original` still need a `target`.

**Across requests.** Each job holding a value costs a few statements to rewrite,
so one request covers about 150 such jobs (a 100,000-row stream has 1,000). Pass
`{ resumable: true }` as the fifth argument: when more than 25 jobs remain
unchecked, or the rest does not fit one request, the call commits one bounded
step (some jobs' custody and the native rows they own, with the checkpoint and
a journal row) and returns `{ phase: 'redacting', continuation, jobsRedacted,
jobsPending }`. Call again in a new request with `{ resumable: true,
continuation }` until `phase` is `'complete'`; the native statements run only in
that final batch, which fences every job checked earlier by its custody revision
and proves no other row holds a value. A job that changed since it was checked
is checked again.

Steps follow the request's own statement budget. A step takes as many jobs as
fit (at least one, at most 25); a job that does not fit alone is redacted in
pages of its entries, each a consistent job (its plan, provenance, history and
native rows rewritten for those entries), and a job changed between its pages
starts again. A step that would not fit writes nothing and is sized from what
it would have cost: it is tried again in the same request while there is room,
otherwise the call returns `redacting` with no rows written (`jobsRedacted: 0`)
and the next request takes the smaller step. Only a single entry larger than a
request, or a final batch larger than one (an adapter without `redaction` reads
and fences every native row there), still refuses with `D1RequestLimitError`.
The continuation holds job ids, revisions, match counts, step sizes and a salted
digest of the selectors, never a selected value; keep it server-side
(default-seed queues it with the operator id). `related.snapshot` cannot span
steps (`IMPORT_REDACTION_SNAPSHOT_UNBOUNDED_ONLY`).

This additive API uses the existing D1 erasure/retirement schemas; no new
migration is needed for an installation already using them. Like related-record
erasure, field selection scans destination custody and is available only without
`maxBatchBytes`; admission/budget failures leave the atomic batch unpublished.
`eraseD1ImportTarget` also accepts `related.fields`, but seeds need the journal
API and restore checkpoint for their complete person-erasure flow. Existing
`related.source` still tombstones whole records; do not select a peer record with
it when that peer must remain resumable and reversible.
