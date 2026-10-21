# Customer-controlled outbound gateway

Run this runtime on a customer-controlled host with Node **22.20.0**. It opens
no listener and makes outbound HTTPS requests only to the configured Crank
origin. Plain HTTP is allowed for `localhost`, `127.0.0.1` and `::1` development
origins. Redirects fail; bearer credentials are never forwarded to a redirect.
SQLite and local file operations have no package dependencies. Remote database
operations require `npm ci --prefix gateways/node --ignore-scripts`; drivers and
the SQL parser load only for those explicitly configured operations.

The owner creates a private JSON manifest and keeps the databases and files on
that host. Both the manifest and enrolled state must be regular, mode-0600 files;
symlinks are rejected. Keep their directory private too. Private destination
credentials and configuration stay in these local files and are never included in
enrollment, polling or result requests. The gateway's own enrollment credential
is sent only in its Authorization header. Only the explicitly selected
operation's output is returned to Crank. Choose its columns and file content
accordingly.

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
change before it can execute. `operation_key` must be present and nonempty; the
server owns task identity and leases. These local operations are read-only.

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

Issue a one-use enrollment code in Crank, then run on the customer host:

```sh
node gateways/node/cli.mjs enroll \
  --origin https://synthetic-crank-7.example \
  --code synthetic-crank-8 --environment synthetic-crank-9 \
  --state /private/synthetic-crank-10.json --manifest /private/synthetic-crank-6.json
node gateways/node/cli.mjs work \
  --state /private/synthetic-crank-10.json --manifest /private/synthetic-crank-6.json --once
```

The enrollment code is a short-lived secret; protect command history/process
visibility on the customer host. The long-lived gateway credential is written
only to a newly created mode-0600 state file, never printed. Enrollment refuses
to replace existing state. Run `work` without `--once` under a customer-managed
service supervisor for continuous polling. A manifest is loaded at startup;
restart after local configuration changes. `--once` processes at most one task
and exits successfully when idle or after reporting its result. A reported
operation failure is a completed protocol exchange; transport/configuration
failure exits nonzero. No failed HTTP request or operation is retried locally.
Continuous polling waits two seconds between completed polls, and each HTTP
request has a ten-second deadline. Stop the owned process normally to stop work.

## Worker protocol

All requests are JSON `POST`. Enrollment sends
`/api/crank/gateways/enroll` with `{ "code": "...", "environment": "..." }`
and receives `{ "gateway": { "id": "...", "environment": "..." },
"credential": "..." }`. The local state records these fields plus `version: 1`
and the configured `origin`.

Subsequent requests carry `Authorization: Bearer <credential>`.
`/api/crank/gateways/:id/poll` sends `{ "environment": "..." }` and receives
`{ "task": null }` or `{ "task": { "id": "...", "connector_id": "...",
"connector_version": 1, "operation": "...", "destination": "...",
"input": {}, "operation_key": "..." } }`.

`/api/crank/gateways/:id/tasks/:taskId/result` sends
`{ "environment": "...", "output": {} }` or
`{ "environment": "...", "error": { "category": "...", "message": "..." } }`.
Categories are `operation_refused`, `invalid_input`, `output_limit`,
`execution_failed`, `file_changed` and `timeout`. Messages are fixed sanitized descriptions, never raw
SQLite exceptions, local paths, queries or credentials. HTTP error bodies are
never printed. Worker responses are capped at 96 KiB. Result acknowledgement
may be an empty successful response or JSON.

This runtime supports the bounded SQLite query and file-line doors above.
It does not execute PostgreSQL, shell commands, arbitrary SQL or network URLs.

## Remote SQL adapters (live database proof pending)

The optional `postgres-query`, `mysql-query` and `sqlserver-query` doors use
parameterized official drivers and a single-SELECT SQL syntax gate. Configure
`connection` locally with host (SQL Server: server), port, database, user,
password and verified driver TLS settings (mandatory outside loopback). Unencrypted
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
  "connection": {
    "host": "synthetic-crank-11.internal", "port": 5432,
    "database": "synthetic-crank-12", "user": "synthetic-crank-13",
    "password": "synthetic-crank-14", "ssl": true
  },
  "query": "SELECT id, name FROM customers WHERE id=$1",
  "parameter_order": ["id"]
}
```

Each driver streams rows into the same 64 KiB/maxRows output limit. Driver and
query deadlines are five seconds, under the existing owned subprocess deadline.
Missing packages, unsupported read-only controls, failed TLS/authentication and
remote errors are explicit failures; there is no alternate writable adapter.
Live PostgreSQL/MySQL/SQL Server acceptance has not been established by the
SQLite/file journey. SFTP and S3 adapters are not shipped in this runtime.
