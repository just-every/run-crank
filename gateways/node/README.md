# Customer-controlled outbound gateway

Run this runtime on a customer-controlled host with Node **22.20.0**. It opens
no listener. It sends enrollment, polling and results only to the configured Crank
origin, and connects to private destinations explicitly configured below.
Plain HTTP is allowed for `localhost`, `127.0.0.1` and `::1` development
origins. Redirects fail. Every outward request, including enrollment, is signed
with an Ed25519 identity generated on this host; no bearer credential is used.
SQLite and local file operations have no package dependencies. Remote database
and SFTP operations require `npm ci --prefix gateways/node --ignore-scripts`;
drivers, the SQL parser and SSH load only for their selected operations. S3 uses
Node's HTTP/TLS and crypto modules with AWS Signature Version 4.

The owner creates a private JSON manifest and keeps the databases and files on
that host. Both the manifest and enrolled state must be regular, mode-0600 files;
symlinks are rejected. Keep their directory private too. Private destination
credentials stay in a named `credentials` map in the private manifest. Remote
operations reference the map by their `credential` name. Destination details
(host, port, database, path, endpoint and bucket) stay in `connection` and the
operation; user names, passwords and private keys belong only in the named
credential. Credential values and names are never included in enrollment, polls,
results, logs or audit. Only the selected operation's output is returned to
Crank. Choose its columns and file content accordingly. The enrollment state
contains the host's private identity and the pinned installation public key;
protect it as carefully as the credentials.

## Configure the local operations

This synthetic example uses a local fixture database whose `customers` table
has `id` and `name` columns, and a UTF-8 text fixture. All paths are local and
relative to the manifest's directory (absolute local paths also work).

```json
{
  "version": 1,
  "operations": {
    "find_customer": {
      "type": "sqlite-query",
      "connector_id": "synthetic-crank-1",
      "connector_version": 1,
      "destination": "synthetic-crank-2",
      "database": "synthetic-crank-3.sqlite",
      "query": "SELECT id, name FROM customers WHERE id = :id ORDER BY id",
      "parameters": { "id": { "type": "integer", "min": 1, "max": 100000 } },
      "maxRows": 100
    },
    "read_lines": {
      "type": "file-lines",
      "connector_id": "synthetic-crank-1",
      "connector_version": 1,
      "destination": "synthetic-crank-4",
      "path": "synthetic-crank-5.txt",
      "parameters": {
        "cursor": { "type": "string", "optional": true, "maxLength": 512 },
        "limit": { "type": "integer", "optional": true, "min": 1, "max": 100 }
      },
      "pageLines": 100
    }
  }
}
```

Use `chmod 600 synthetic-crank-6.json` before enrollment. No task can supply a
database path, file path, URL, SQL statement or undeclared parameter. The
`operation` is the exact key in `operations`; its connector ID, version and
destination must all match. Connector versions are positive safe integers, with
no string coercion. A new connector version needs an explicit manifest
change and a new exact-version owner grant before it can execute. A local
`connector_operation` optionally narrows the connector operation ID that can
select this binding. Otherwise the installation's signed connector-operation
mapping selects this exact local operation key. `operation_key` must be present
and nonempty; the server owns task identity and leases. SQLite, file, SQL query
and storage operations are read-only. The explicit PostgreSQL command below
is the write door. A manifest alone grants no authority: every task also needs the
installation's signed, active grant at the task's exact grant revision and
current TEAM authority revision.

Parameter types are `string`, `integer` (safe JavaScript integer), finite `number`
and `boolean`. Parameters are required unless `optional` is true. Numeric `min`
and `max` and string `maxLength` are enforced; strings default to 4096 characters
and cannot be configured above that. There are at most 32 parameters per
operation and 100 operations per manifest.

SQLite uses `node:sqlite` in read-only mode, with `query_only=ON`, trusted schema
off and extension loading disabled. Configure a named `SELECT` or `WITH` query,
bind each input using `:parameter`, and set `maxRows` from 1 through 1000. Give
every referenced query parameter a required local schema. Booleans bind as 0/1.
Output is `{ "rows": [...] }`; safe integers stay numbers, larger integers are
decimal strings, and blobs are `{ "encoding": "base64", "data": "..." }`.
More than the configured row count or 64 KiB of serialized output is a reported
`output_limit` failure, with no silently truncated query result. A subprocess caps
query execution at five seconds, and SQLite lock waits at one second. The
operation runs in a separate Node process with a 64 MiB JavaScript heap limit,
SQLite's 16 MiB hard heap limit, and memory-only temporary storage. The deadline
kills that owned process even when native SQLite execution has not returned.

File operations require regular UTF-8 files no larger than **64 MiB**, including
concurrent growth during a read. Final file symlinks are rejected. The operation
returns `{ "lines": [...], "next_cursor": "..." }`; `next_cursor` is `null` at
EOF. Newline separators are omitted, CRLF is normalized, blank lines are
preserved and a trailing newline adds no extra line. `limit` defaults to
`pageLines` (1–1000) and cannot exceed it. Pass `next_cursor` as the next task's
`input.cursor`; omit it for the first page. Cursors bind the next line's byte
offset to the file's SHA-256 digest. Each page hashes and validates UTF-8 over
the complete source incrementally with a 64 KiB read buffer, then reads only
its bounded page. The source file is never buffered in full. File identity,
size, modification time and change time are checked before and after hashing
and page reading. A changed file rejects an old cursor as `file_changed`.
Pages are at
most **64 KiB of serialized output**, so byte bounds may reduce the line count.
A single line larger than that bound fails explicitly.

## Enroll and run

In Crank, the owner first completes a fresh email-link step-up, then issues a
single-use enrollment code bound to this installation, gateway and environment.
The step-up lasts five minutes and the code expires after fifteen minutes.
Run on the customer host:

```sh
node gateways/node/cli.mjs enroll \
  --origin https://synthetic-crank-7.example \
  --code synthetic-crank-8 --environment synthetic-crank-9 \
  --state /private/synthetic-crank-10.json --manifest /private/synthetic-crank-6.json
node gateways/node/cli.mjs work \
  --state /private/synthetic-crank-10.json --manifest /private/synthetic-crank-6.json --once
```

The enrollment code is a short-lived secret; protect command history/process
visibility on the customer host. The gateway generates its own Ed25519 key
pair, redeems the code with the public key and its SHA-256 fingerprint, and
saves the identity only to a newly created mode-0600 state file, never printed.
Enrollment refuses to replace existing state. The identity serves exactly one
installation and one environment. Existing bearer state is rejected; revoke the
old gateway and enroll a new identity instead of copying old state. Run `work` without `--once` under a customer-managed
service supervisor for continuous polling. A manifest is loaded at startup;
restart after local configuration changes. `--once` processes at most one task
and exits successfully when idle or after reporting its result. A reported
operation failure is a completed protocol exchange; transport/configuration
failure exits nonzero. No failed HTTP request or operation is retried locally.
Continuous polling waits two seconds between completed polls, and each HTTP
request has a ten-second deadline. Stop the owned process normally to stop work.

## Worker protocol

All requests are JSON `POST` over HTTPS (HTTP loopback is permitted only for
local development). Enrollment sends `/api/crank/gateways/enroll` with
`{code, environment, public_key, public_key_fingerprint}` and receives
`{gateway:{id,environment,installation}, installation_public_key}`. Both public
keys are Ed25519 SPKI DER encoded as unpadded base64url; the fingerprint is the
lowercase hexadecimal SHA-256 of the public DER bytes. The local version-2
state also records `origin`, `public_key` and the local PKCS8 DER `private_key`
as base64url. The installation is the exact canonical Crank origin.

Every request carries `x-crank-gateway-id`, `x-crank-environment`,
`x-crank-timestamp` (Unix seconds), `x-crank-nonce` (32 random bytes as base64url)
and `x-crank-signature` (Ed25519 signature as base64url). Enrollment uses
`enrolling` as its header gateway ID. Sign the UTF-8 bytes below, with literal
newline separators and no final newline:

```text
crank-gateway-request-v1
POST
<pathname and query>
<lowercase hexadecimal SHA-256 of exact transmitted JSON bytes>
<timestamp>
<nonce>
```

Crank checks the timestamp within 300 seconds and consumes each nonce once.
`/api/crank/gateways/:id/poll` sends `{environment}` and receives a signed
envelope `{payload:"<JSON string>",signature:"<base64url>"}`. The installation
signs `crank-gateway-job-v1` followed by a newline and the exact payload string.
The payload contains `installation`, `environment`, `gateway_id`, `status`,
`authority_revision`, `issued_at`, `expires_at`, `nonce`, `request_nonce`,
`grants` and `task` (null when idle). Times use Unix seconds; the envelope
expires within 300 seconds. `request_nonce` must match the current poll's nonce,
so an old signed job cannot be replayed on another poll. Invalid signatures,
bindings, status, expiry or decreasing authority revisions stop the worker.

A grant is `{id,revision,status,connector_id,connector_version,operations,
destinations}`. Operations are connector operation IDs. Each destination is a
concrete descriptor with its connector destination `label`:

- Database: `{label,type:"database",host,port,database}`.
- SFTP: `{label,type:"sftp",host,port,path_prefix}`.
- S3-compatible: `{label,type:"s3",endpoint,bucket,prefix}`.
- SQLite or local file: `{label,type:"local",path}` (absolute local path).

The host derives the destination from its own local operation, checks every
concrete field and confines SFTP paths and S3 keys to the granted prefix. A
label alone never authorizes a destination. `deriveDestination(operation,
manifestPath)` in `destinations.mjs` returns the concrete descriptor without
credentials. An optional local `destination_spec` adds another destination
restriction. This runtime has no arbitrary HTTP operation or proxy door.

A non-null task contains `id`, `connector_id`, `connector_version`,
`connector_operation`, `operation` (the exact manifest key), `destination`
(the grant label), `input`, `operation_key`, `installation`, `environment`,
`gateway_id`, `grant_id`, `grant_revision`, `authority_revision`, `method` and
`recovery_only`. The host
checks active status, environment, revisions, exact version, operation and
concrete destination before invoking a driver. Crank repeats its checks when
accepting the result. Revocation prevents the next dispatch and withholds later
results; replacement requires a new enrollment.

`/api/crank/gateways/:id/tasks/:taskId/result` sends `{environment,output:{}}`
or `{environment,error:{category,message}}`. Categories are `operation_refused`,
`invalid_input`, `output_limit`, `execution_failed`, `file_changed` and `timeout`.
Messages are fixed descriptions, never raw driver exceptions, paths, queries or
credentials. HTTP error bodies are never printed. Worker responses and requests
are capped at 96 KiB. A result acknowledgement may be empty or JSON.

The host resolves every remote destination itself and pins the checked address
into its actual socket while preserving the configured TLS host and SSH host
pin. Any DNS answer containing link-local, metadata, unspecified or multicast
addresses is refused, including IPv4-mapped IPv6 forms and known metadata
hosts. Private and loopback addresses are permitted only when the concrete
destination matches the grant. HTTP, S3 and SQL Server redirects cannot select
another endpoint. No shell command, task SQL, task URL, proxy environment or
credential chain is consulted.

## Remote SQL adapters

The optional `postgres-query`, `mysql-query` and `sqlserver-query` doors use
parameterized official drivers and a single-SELECT SQL syntax gate. Configure
`connection` locally with host (SQL Server: server), port, database and verified
driver TLS settings, and `credential` with a name from `manifest.credentials` (mandatory outside loopback). Unencrypted
connections or disabled certificate verification outside loopback are refused.
Those credentials never travel to
Crank. Declare `read_only_credentials:true` and use an independently restricted
DB login. PostgreSQL and MySQL execute inside read-only transactions; SQL Server
also requires its connected database to report `READ_ONLY`, and refuses writable
databases. An owner attestation or read-intent connection option cannot replace
that server check. Mutation CTEs, multiple statements, SELECT INTO and locking
reads are refused. PostgreSQL/MySQL use `parameter_order` for `$1`/`?` bindings;
SQL Server derives typed `@parameter` bindings from `parameters`.

For example, a PostgreSQL operation can use the same binding/schema fields as
the SQLite example, plus:

```json
{
  "type": "postgres-query",
  "read_only_credentials": true,
  "credential": "synthetic-crank-13",
  "connection": {
    "host": "synthetic-crank-11.internal", "port": 5432,
    "database": "synthetic-crank-12", "ssl": true
  },
  "query": "SELECT id, name FROM customers WHERE id=$1",
  "parameter_order": ["id"]
}
```

The enclosing manifest supplies the credential by name:

```json
{
  "credentials": {
    "synthetic-crank-13": { "user": "synthetic-crank-14", "password": "synthetic-crank-27" }
  }
}
```

Each driver streams rows into the same 64 KiB/maxRows output limit. Driver and
query deadlines are five seconds, under the existing owned subprocess deadline.
Missing packages, unsupported read-only controls, failed TLS/authentication and
remote errors are explicit failures; there is no alternate writable adapter.
`tests/database-gateway-journey.mjs` runs the actual Worker and CLI against
independent PostgreSQL and MySQL containers, with restricted logins and real
permission/read-only checks, bound inputs, byte/row/deadline refusal, revocation
and credential-free restore. It starts and removes only its own isolated
containers. This does not establish SQL Server or a buyer deployment.

`tests/gateway-streaming-journey.mjs` uses a real incrementally written 64 MiB
UTF-8 source and real Worker/CLI pages, continues a saved cursor after restart
and refuses a same-size tail mutation. It makes no throughput claim. Scale
results belong to an exact-candidate heavy-slot run, separately from push Verify.

## Read-only SFTP and S3-compatible lines

Storage operations use the same connector binding fields as `read_lines` above.
The owner fixes one remote path or bucket/object in the private manifest. Tasks
may provide only the declared optional `cursor` and `limit`; they cannot choose
a host, path, bucket, object, URL, credential or authentication option.

An SFTP operation is:

```json
{
  "type": "sftp-lines",
  "connector_id": "synthetic-crank-1",
  "connector_version": 1,
  "destination": "synthetic-crank-15",
  "credential": "synthetic-crank-17",
  "connection": {
    "host": "synthetic-crank-16.internal",
    "port": 22,
    "hostKeySha256": "REPLACE_WITH_INDEPENDENTLY_VERIFIED_SHA256_FINGERPRINT"
  },
  "path": "/synthetic-crank-19.txt",
  "pageLines": 100,
  "parameters": {
    "cursor": { "type": "string", "optional": true, "maxLength": 512 },
    "limit": { "type": "integer", "optional": true, "min": 1, "max": 100 }
  }
}
```

`hostKeySha256` must be the exact OpenSSH `SHA256:` fingerprint followed by
43 unpadded base64 characters, obtained through an independently trusted channel.
The placeholder above deliberately fails validation. Every SSH handshake checks
that fingerprint before authentication; there is no accept-first-use mode or
agent forwarding. The named credential contains `username` and exactly one of `password` or
`privateKey`. For example, `credentials["synthetic-crank-17"]` holds
`{"username":"synthetic-crank-18","password":"synthetic-crank-28"}`. The
`privateKey` value contains the actual private key text in that named entry;
an encrypted key may also use `passphrase`. No key files, SSH agents,
environment credentials or alternate authentication methods are consulted. The
configured absolute remote path is opened read-only and must be a regular file.

An S3-compatible operation is:

```json
{
  "type": "s3-lines",
  "connector_id": "synthetic-crank-1",
  "connector_version": 1,
  "destination": "synthetic-crank-20",
  "credential": "synthetic-crank-23",
  "connection": {
    "endpoint": "https://synthetic-crank-21.example",
    "region": "synthetic-crank-22"
  },
  "bucket": "synthetic-crank-25",
  "key": "synthetic-crank-26.txt",
  "pageLines": 100,
  "parameters": {
    "cursor": { "type": "string", "optional": true, "maxLength": 512 },
    "limit": { "type": "integer", "optional": true, "min": 1, "max": 100 }
  }
}
```

The endpoint is an HTTPS origin without a path, query, fragment or URL credentials.
Requests use path-style bucket/object URLs and sign every request with AWS SigV4;
the owner must configure the endpoint's actual region. Temporary credentials may
add `sessionToken` to the named credential. For example,
`credentials["synthetic-crank-23"]` holds
`{"accessKeyId":"synthetic-crank-24","secretAccessKey":"synthetic-crank-29"}`. Explicit test-only cleartext loopback endpoints
also require `connection.allowInsecureLoopback: true`; allowed hosts are
`127.0.0.1`, `localhost` and `::1`. Cleartext localhost resolves only to loopback.
TLS certificate verification is mandatory. Redirects, retries, proxy environment
settings and automatic credential lookup are never used.

S3 requires exact `Content-Length`, strong quoted ETag and Last-Modified metadata.
It checks a HEAD snapshot, then uses `If-Match` with an exact byte `Range`,
requires HTTP 206 with matching `Content-Range`/metadata and complete body, and
checks a conditional HEAD afterwards. Unsupported range or consistency semantics,
changed metadata, compressed sources and authentication errors fail explicitly.

Both adapters return `{ "lines": [...], "next_cursor": "..." }` with the same
newline/CRLF/blank-line behavior as local files. Sources are bounded to **64 MiB**;
each page streams and hashes the complete UTF-8 source without retaining it in
memory. Cursors bind source location, source metadata, SHA-256 digest and next
line byte offset. A source change rejects continuation as `file_changed`, even
when SFTP size and timestamp remain unchanged. Each serialized page is at most
**64 KiB**; `pageLines` is 1–1000, and optional `limit` cannot exceed it. Byte
bounds can reduce a page's line count; an oversized individual line fails.
The storage operation has a four-second deadline inside the existing five-second,
64 MiB-heap subprocess. Slow sources fail rather than returning a partial page.

`node tests/storage-gateway-journey.mjs` uses the existing real Worker harness for
enrollment, grants, draft workflows, polling and results. The real gateway CLI
connects to temporary network-edge SFTP/S3 protocol fixtures, including pagination
across Worker restart, mutation, fingerprint and request-signature rejection,
source/page bounds and UTF-8 validation. This establishes local protocol behavior;
live customer SFTP/S3 provider acceptance remains unproven.

## Explicit PostgreSQL commands

`postgres-command` performs one configured INSERT or UPDATE and returns one
business row as `{ "rows": [...] }`. It requires `write:true`, an exact local
`connector_operation`, a named host credential, and an owner grant for that exact
POST connector operation, version and concrete database destination. The signed
task must declare `method:"POST"`. Native workflow write approval is required.
The customer controls the destination and credential permissions. No task can
provide SQL, a table, a column, a predicate or a connection setting.

For example, inside `operations`:

```json
{
  "stock_write": {
    "type": "postgres-command", "write": true,
    "connector_id": "synthetic-crank-1", "connector_version": 1,
    "connector_operation": "stock_update", "destination": "synthetic-crank-2",
    "credential": "synthetic-crank-13",
    "connection": {
      "host": "synthetic-crank-11.internal", "port": 5432,
      "database": "synthetic-crank-12", "ssl": true
    },
    "receipt_table": "public.crank_receipts",
    "parameters": {
      "name": { "type": "string", "maxLength": 100 },
      "quantity": { "type": "integer", "min": 0, "max": 100000 }
    },
    "command": {
      "action": "update", "table": "public.stock",
      "values": { "quantity": "quantity" }, "key": { "name": "name" },
      "returning": ["name", "quantity"]
    }
  }
}
```

Use `action:"insert"` with all key columns also in `values`, bound to the same
parameters. UPDATE cannot change key columns. A business key must identify
exactly one row and its columns must be returned. Missing or ambiguous readback
rolls the transaction back. Use ordinary tables with a unique business key;
partitioned/inherited UPDATE targets are not supported. Identifiers are simple
ASCII SQL names and tables are explicitly schema-qualified. Values are always
positional parameters. At most 32 columns, eight key columns and 32 returned
columns are allowed. All inputs are required; strings need an explicit
`maxLength` up to 4096 and numeric inputs need finite `min` and `max` bounds.
The business readback is limited to one row and 64 KiB. Output-bound failure
rolls the write back. Remote connections require verified TLS and use the same
checked, pinned DNS socket policy as read adapters.

Before enabling the operation, the database administrator provisions the receipt
table and a dedicated restricted login. The gateway never creates schema or
falls back when this table is missing. For the example, provision:

```sql
CREATE TABLE public.crank_receipts (
  operation_key text PRIMARY KEY,
  binding_digest text NOT NULL,
  input_digest text NOT NULL,
  output_json jsonb
);
REVOKE ALL ON public.crank_receipts FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO "synthetic-crank-14";
GRANT SELECT, INSERT, UPDATE ON public.crank_receipts TO "synthetic-crank-14";
GRANT SELECT ON public.stock TO "synthetic-crank-14";
GRANT UPDATE (quantity) ON public.stock TO "synthetic-crank-14";
```

For INSERT grant only the required INSERT columns and any required sequence
usage. Keep the login free of DDL, delete, superuser and unrelated table rights.
Restrict direct access to receipts to trusted administrators and this gateway;
their integrity is part of the customer's operation guarantee. Do not prune,
edit or restore receipts independently of business effects while an operation
key can be replayed. Keep both in the same database and recovery lifecycle.

Each transaction locks the exact operation key, checks its receipt, performs the
write, rereads the selected business fields, saves that original readback, and
commits both together. The digest binds canonical inputs and the installation,
environment, exact connector/version/operation, database destination and local
command/schema. Changed inputs or binding under the same key are refused.
An ordinary same-key dispatch returns the committed original readback without
repeating the effect, even if business data has since changed. An absent receipt
permits only an ordinary approved first dispatch to write.

If a gateway result is lost, recovery is deliberate and readback-only:

```sh
node gateways/node/cli.mjs recover --state /private/synthetic-crank-10.json \
  --manifest /private/synthetic-crank-6.json --task-id synthetic-crank-29
node gateways/node/cli.mjs work --state /private/synthetic-crank-10.json \
  --manifest /private/synthetic-crank-6.json --once
```

Recovery requires the same current authority, frozen task, inputs and operation
key. The signed task has `recovery_only:true`; the adapter can only return an
existing matching durable receipt. If the first transaction never committed,
recovery refuses instead of issuing a fresh write. There is no automatic write
retry. A timeout or interrupted COMMIT can leave the write committed; inspect
or recover its exact task rather than starting a new workflow to guess.
`tests/postgres-write-journey.mjs` exercises this door with the real Worker,
gateway CLI and isolated Linux PostgreSQL provider. It requires Docker and the
existing gateway dependencies, runs separately from push Verify, and removes
its owned containers.

`tests/storage-provider-journey.mjs` runs the actual Worker and gateway CLI
against isolated OpenSSH and RustFS S3-compatible containers. It proves exact
pages and continuation after Worker restart, source-change refusal, invalid
credentials and host-pin refusal, and credential-free export. The separate
`tests/storage-gateway-journey.mjs` checks protocol-edge UTF-8, byte and redirect
refusals. The provider journey requires Docker and gateway dependencies, removes
only its own containers before PASS, and runs outside push Verify:

```sh
CRANK_DOCKER=docker node tests/storage-provider-journey.mjs
```

These isolated-provider results do not establish ServiceNow/SAP, SQL Server or
buyer IdP interoperability.
