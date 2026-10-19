# Source readers

Import `readFileSource` and `readApiSource` from `index.ts`. Both either return a
complete `SourceBundle` or reject with `ReaderError` (`code`, safe `diagnostics`).
Errors deliberately omit thrown causes, response bodies, URL strings and headers.

File input is a `Uint8Array` or an async byte iterator (including Node file read
streams). UTF-8 is strict, with an optional initial BOM. JSON arrays call `parse`
once per element with its zero-based index; every other JSON root calls it once.
NDJSON calls it for each nonblank physical line, with the zero-based nonblank
index. Duplicate JSON object keys fail explicitly rather than discarding an earlier
field (including credential metadata). Locations use one-based rows; JSON arrays also have JSON pointers. A
parser may expand an object into multiple records and provide more exact pointers.
An empty parser result fails explicitly. Empty JSON arrays/NDJSON are valid empty
exports. Source kinds and IDs are nonempty strings. Duplicate IDs are retained
with diagnostics, including conflicting content; the core owns collapse/rejection.

Defaults are 64 MiB total source bytes, 100,000 records and 1 MiB per record.
Limits must be positive safe integers. Total bytes include every successful API
page. Record bytes bound serialized input objects (files) and complete parsed
records (both readers); NDJSON physical lines are bounded before parsing. JSON
and API pages are buffered up to the total-byte limit; NDJSON is parsed per line.
Streams are pulled serially and closed on early failure. The Promise-returning
frozen API retains the bounded completed record bundle in memory.

API `parsePage` receives the JSON document and a one-based page number. It must
report every source object, including unsupported objects as records for the
mapping's unmapped report. It declares the next URL (relative or absolute), or
null/undefined for completion. Empty pages are supported. As a generic reader,
the kit cannot infer whether a format adapter deliberately omitted a vendor field
or object; completeness inside an API envelope is the adapter's responsibility.
Pages have stable names `api-page-N`; request metadata is not added to the bundle.
Accepted cursor metadata present in response bytes remains in exact originals.

API readers may opt into `preserveNumberLexeme(pathSegments): boolean`. Each
numeric value is selected by its decoded path: object keys are strings, array
indices are numbers, and the root is `[]`. Only selected numeric primitives become
ordinary JSON strings containing the exact source token, including sign, trailing
zeros and exponent spelling. No arithmetic or normalization occurs. For example,
`path.length === 4 && path[0] === 'records' && typeof path[1] === 'number' &&
path[2] === 'fields' && typeof path[3] === 'string'` selects direct record cells.
Metadata, nested objects and array cells remain unchanged by that selector.

The additive third `parsePage` argument is an `ApiPageContext` with
`numericLexemes`, a frozen, null-prototype read-only object mapping JSON pointers
to selected tokens. Pointer segments escape `~` as `~0` and `/` as `~1`; the root
pointer is `''`. Context is page-local, contains no transport metadata or second
response body, and is empty when preservation is omitted. It distinguishes source
number `42` (selected string with provenance) from source string `"42"` (no entry).
Both the context and each policy path are frozen. Return a synchronous boolean;
invalid policies, non-boolean results and thrown exceptions fail closed without
exposing thrown causes. Policy failure uses `SOURCE_NUMBER_POLICY_FAILED`.

Syntax, duplicate keys and credentials in every decoded source key or string are
validated before either callback. Known authentication values reflected as boolean
or null scalars are rejected too. Numeric authentication reflections are checked
against exact received numeric text, equivalent decimal values and ordinary JSON
Number results, whether or not preservation is selected. Authentication values
themselves are never rounded for comparison. Selected overflow tokens such
as `1e309` can therefore reach product validation as strings; unselected nonfinite
numbers retain the ordinary rejection. The product owns numeric range, canonical
representation, type-conversion accounting and retention of any needed per-cell
numeric-origin provenance. Omission keeps ordinary JSON Number semantics. These
options do not change byte, record, request, cancellation or custody guarantees.

Every artifact hashes the exact successful response bytes and retains them as
`original: { status: "available", base64 }` using canonical base64. File originals
also preserve all bytes, including BOM, line endings, whitespace and parser-excluded
wrappers. Custody is copied in bounded 64 KiB blocks, so tiny or reused stream
buffers cannot lose original bytes or allocate one retained object per chunk.
Payload hashes bind canonical JSON. Whitespace changes therefore change artifact identity. HTTP error
and redirect bodies are discarded without parsing or buffering.

The transport receives a GET `Request` with manual redirects and omitted ambient
credentials, and **must honor these settings**. Fetch is a suitable transport.
The reader handles same-origin redirects itself, rejects automatically followed
redirects, cross-origin links, userinfo, fragments and credential-bearing query
parameters, and preserves all accepted pagination parameters and request headers.
The API reader never strips URL credentials. Tokens belong in the ephemeral `token`
or `headers` arguments. A conflicting Authorization header fails. Credential keys,
credential URLs and reflected credential values in source data fail, even if a
parser would omit them. Null, an empty string or a mask (`****`, `[redacted]`)
under a credential key is not a credential and passes. No token, response error
text or credential-bearing URL is returned in bundle metadata or diagnostics; a
credential refusal names only the field kind in its diagnostic `field`.

`readFileSource` takes `credentials: 'remove'` to keep records that hold a plain
credential value: the parser sees the value as read, then each record loses its
credential fields (any key whose whole name parts are a credential word or
phrase, such as `httpPassword`, `client_secret`, `X-Api-Key`, `secret_key`,
`Ocp-Apim-Subscription-Key`, `pwd` or `X-Auth`, never `keyword` or `author`; a plural such as
`apiKeys` or `tokens` when it holds text; the `value` of a `{name|key, value}`
pair naming one, and of such a `[name, value]` pair in a list of them; booleans
stay) and its URLs' (any scheme's)
user names, passwords and credential query and fragment parameters, with one
`CREDENTIAL_REMOVED` warning per removal naming the record,
the field pointer and its kind. The original bytes are then withheld
(`reason: 'credentials-removed'`). A record still repeating a removed value
fails with `CREDENTIAL_IN_SOURCE_DATA`; forms it cannot remove still fail as
above. A field holding `[removed]`, the marker rer's vendor exports leave, is
reported as removed before upload.

All requests, including redirects/retries, count toward `maxRequests` (default
1000). Rate limits (429, or 403/503 with Retry-After) allow `maxRetries` (default 3)
per requested page/redirect target. Retry-After accepts seconds or HTTP dates;
missing 429 Retry-After uses 1s, 2s, 4s. A wait exceeding `maxRetryAfterMs` (default
30s) fails instead of retrying before the server permits. Invalid Retry-After
fails. Cycles, exhausted requests/retries and later-page failure reject the entire
read. `signal` cancels requests, body reads and waits; reasons are never exposed.
The optional sleep adapter receives both delay and signal. No concurrent page
prefetch or unbounded error-response reads occur.

### Explicit noncredential pagination cursors

Trusted adapters may select `paginationCursorPolicy: 'page-token-v1'` on
`readApiSource` or `readFileSource` when their source documents `page_token` as a
pagination cursor. Omission retains the strict default. This is a closed policy,
not an arbitrary allowlist: only the exact URL query spelling `page_token` is
exempt from the token-key prohibition. Encoded or case aliases, actual credential
keys, URL userinfo, cross-origin navigation/redirects, and reflected provided
header/token secrets remain rejected. No URL or original bytes are rewritten.
The exact wire query boundaries own the cursor value: encoded delimiters inside
it remain opaque data, including repeated encoding. Nested credential-bearing
URLs in that value and encoded credential parameters outside it still reject.
JSON pagination fields such as `next_page_token` and `previous_page_token` remain
ordinary noncredential metadata; API reflection checks still inspect their values.

The reader records the selection as `SourceBundle.paginationCursorPolicy`.
Adapters combining bundles must deliberately preserve that selection. Planning,
job creation and retained-original readback validate it and bind it in the reviewed
fingerprint. Never derive the selection from untrusted exported JSON. Saved files
have no in-memory authentication context, so adapters must only select this policy
for documented noncredential cursors; they cannot identify arbitrary secrets
hidden in otherwise ordinary values. Mapped target effects retain the strict
credential policy: the exception is for source custody and navigation.
