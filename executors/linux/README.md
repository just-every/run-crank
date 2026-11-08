# Owner-hosted Linux executor

This is a separate owner-deployed HTTP service for Crank code tasks. It runs real
Python, JavaScript and TypeScript programs locally without third-party accounts.
It does not run in a Cloudflare Worker.

## Requirements and deployment

Use a dedicated **non-root** Linux service account, a current Linux kernel with
unprivileged user/PID/network/mount/IPC/UTS namespaces and pidfds enabled,
Bubblewrap at `/usr/bin/bwrap` with `--disable-userns` support, and Python 3 at
`/usr/bin/python3` with `os.pidfd_open` and `signal.pidfd_send_signal`. This initial
deployment supports Debian-style x86-64 runtime paths (`/usr/lib/x86_64-linux-gnu`,
`/usr/lib64`, `/usr/lib/pythonX.Y`). Node runs using the installed service Node
binary. Install the repository's declared `esbuild` dependency before starting
the service; jobs never install packages.

Put the checkout and Node runtime somewhere readable by the service account,
such as `/opt/crank` and `/usr/local/bin/node`. A checkout or runtime underneath a
private `/root` directory cannot be used by a non-root service. Create an absolute
data directory owned by that account with mode `0700`, for example
`/var/lib/crank-executor`. Run exactly one service per data directory. An abstract
Unix socket lock enforces this and releases automatically after a crash.

Supply these environment variables through the owner's private service manager
configuration (keep its secret file mode `0600`):

| Variable | Meaning |
| --- | --- |
| `CRANK_EXECUTOR_TOKEN` | Required bearer token, at least 32 bytes. |
| `CRANK_EXECUTOR_DATA` | Required absolute private data directory. |
| `CRANK_EXECUTOR_CGROUP` | Absolute delegated cgroup v2 subtree for aggregate quota tasks; see below. |
| `CRANK_EXECUTOR_PORT` | Optional TCP port; defaults to 8788. |

Start as the dedicated service user:

```sh
node /opt/crank/executors/linux/server.mjs
```

The listener always binds `127.0.0.1`. To connect from a deployed Worker, the owner
must supply authenticated private connectivity or a TLS reverse proxy; this
repository does not provision a public host, tunnel or account. Keep the bearer
token out of URLs, command arguments and access logs. `SIGTERM` and `SIGINT` stop
the service and its own active child. Startup failures print only a fixed
diagnostic. The service does not log task inputs, sources, errors or bearer tokens.

## HTTP protocol

`GET /health` is public and returns `{"status":"ok"}`. It reports service liveness,
not proof that a particular job can start on a host's namespace policy.
Every other route requires `Authorization: Bearer TOKEN`.

Task IDs are exactly 64 lowercase hexadecimal characters. The caller generates
the stable ID, usually a SHA-256 digest of its execution identity. The service
separately hashes the JSON task payload with recursively sorted object keys:
retrying the same ID and payload returns its existing task; reusing an ID for a
different payload returns HTTP 409. Neither a retry nor a restart relaunches a
terminal task.

`POST /tasks/ID` accepts up to 1 MiB of JSON:

```json
{
  "language": "python",
  "source": "def main(input):\n    return {'total': input['a'] + input['b']}\n",
  "input": {"a": 2, "b": 3},
  "timeout_ms": 5000,
  "memory_mb": 128,
  "aggregate_memory_mb": 96,
  "allowed_egress": []
}
```

Languages are `python`, `javascript`, `typescript`. Python source defines
`def main(input)`; JavaScript/TypeScript source exports
`export default async function(input) { return input; }`. Return a JSON value;
stdout must contain only that value. Printing additional logs to stdout makes
the output invalid. Stderr is discarded. JSON output is bounded to 1 MiB.
TypeScript is transformed by the installed host esbuild before entering the
sandbox, without evaluating the source or resolving imports. Only runtime builtin
modules and Python's standard library are available; third-party dependencies
and package installation are unsupported. `runtime_version`, if present, must
equal the installed exact numeric runtime version, for example `22.20.0` for
Node. TypeScript uses the declared Node runtime version. No runtime is acquired
or silently substituted. Unknown fields and unsupported requests are rejected.

Accepted tasks return HTTP 202 with `{ "task_id": "ID", "status": "queued" }`.
Duplicate nonterminal requests return 202; terminal requests return 200.
`GET /tasks/ID` returns HTTP 200 with the task, or 404 if missing. Terminal tasks
have `status` `succeeded`, `failed`, `cancelled`, or `interrupted`; successful
tasks include `output`; failures include `error: {category,message}`. Messages
are fixed diagnostics and contain no user source or exception text.

`POST /tasks/ID/cancel` durably records cancellation and stops only that task's
own child using a Linux pidfd, never a stored or reused numeric PID. Cancelling
an unknown ID creates a durable cancelled tombstone, fencing later submissions.
Cancelling a task already terminal returns its existing result. Poll task status
after connection loss; never infer that a disconnected submission did not run.

## Isolation, limits and lifecycle

Each task gets fresh user, PID, mount, network, IPC and UTS namespaces, no
capabilities, no inherited host environment, and disabled nested user namespaces.
Its root filesystem, interpreter, runtime libraries, source and input are mounted
read-only. `/work`, `/tmp` and `/dev/shm` are separate fresh 16 MiB tmpfs mounts.
Other task directories, the service token, host home directories and host
configuration are absent. The task cannot reach the host network, including
loopback. Only explicit `allowed_egress: []` is accepted. Selective outbound access
is an outstanding product gap; it is never implemented by sharing host networking.

The supervisor enforces wall time (50–60000 ms), OS virtual address space
(64–2048 MiB Python; 512–2048 MiB Node), 64 processes/threads per dedicated host
UID, 64 open file descriptors per process, a 1 MiB per-file size, zero core dumps,
and a CPU time ceiling. The virtual address ceiling is an OS hard limit, not an
RSS quota. Its existing meaning is unchanged; omitting `aggregate_memory_mb`
retains exactly that previous per-process behavior.
Tmpfs byte quotas bound writable storage. The service runs one job at a time,
queues at most 32 tasks, and bounds inbound connections and request sizes.
Use a dedicated account: the process count limit includes every process/thread
for that host UID. Root is rejected because its process-limit exemption would
invalidate this protection. CPU-hard loops and fork bombs are unnecessary for
verification; use sleeping tasks to verify deadlines and cancellation.

Metadata and results are atomically written and synced as mode `0600` files in
mode `0700` directories. A task's source/input staging directory is removed on
terminal completion or recovery. Pending inputs exist in service memory until
execution; their accepted task identity/status is durable. Restart converts
previously queued/running tasks to terminal `interrupted` with uncertain outcome,
erases staging files, and never relaunches them. Terminal results and cancellation
tombstones persist until the owner removes them while the service is stopped.
Deleting an ID permits future reuse, so retain tombstones for the caller's full
retry lifetime. Filesystem deletion is not a guarantee of physical secure erase.

## Aggregate task memory

Optional `aggregate_memory_mb` is an integer from 32 to 2048 MiB. Before executing
bubblewrap, the supervisor creates `task-ID` inside `CRANK_EXECUTOR_CGROUP`, sets
`memory.max` to the declared bytes, `memory.swap.max` to zero, `memory.oom.group`
to one and `pids.max` to 64, and checks kernel readback. The entire sandbox enters
that cgroup before exec; forks and threads inherit it. The supervisor stays
outside the quota so an OOM kill cannot prevent durable outcome recording.
The memory controller accounts the sandbox's resident and other charged memory,
including tmpfs pages; the process address-space bound remains independently active.

Use an administrator-provisioned cgroup v2 subtree with memory and pids enabled
in `cgroup.subtree_control`. A service manager can delegate these controllers
(for example, a dedicated systemd unit with `Delegate=memory pids`). Keep the
service and supervisor in a leaf such as `service` below that subtree, alongside
fresh task cgroups, since an internal controller node cannot contain processes.
The dedicated user needs permission to create and remove children, configure
their controls, write `cgroup.kill`, and migrate its child from the service leaf
to a task leaf; the common delegated ancestor's `cgroup.procs` must be writable.
Set `CRANK_EXECUTOR_CGROUP` to the absolute delegated ancestor, not the service
leaf or a shared host root. The service does not acquire privilege or delegate
host controllers itself. Use a distinct delegated subtree for each service.

A missing controller, swap control or migration permission refuses a quota task
with `cgroup_setup_required`, durably readable as a failed task. Task code never
runs under a weaker replacement limit. Legacy tasks without the field remain
available. A kernel `oom_kill` produces the fixed `memory_limit` diagnostic.
Task readback includes the declared `aggregate_memory_mb`; payload identity
also includes it, so changing the quota under an existing ID conflicts.

Success, failure, cancellation and service crash cleanup kill all remaining
cgroup descendants and wait for an empty group before removal. A private synced
supervisor result records the outcome before the cgroup evidence is removed.
Restart serializes with the old supervisor, reaps any surviving group, recovers
its OOM event or recorded result and never relaunches source. A crash of both
service and supervisor is reconciled on the next startup. Keep the delegated
subtree available across restarts so orphan cleanup can finish; startup refuses
when it cannot safely complete cleanup. Source staging is erased, while task
results, cancellation tombstones and quota outcome receipts follow the same
owner-managed task-record lifetime described above.

## Embedding and focused verification

`await createExecutor({token, dataDir, port: 0, cgroupRoot})` returns an executor with
`await executor.listen()`, `executor.address.port`, `executor.runtime` (exact
installed versions), and `await executor.close()`. `startExecutor(options)` creates
and listens in one call. The same non-root requirement applies to embedding.

For root-owned Linux test environments, stage the executor directory, Node binary
and installed esbuild packages outside `/root`, chown a fresh private data
directory to an unused non-root test UID, and start the service with that UID/GID
and cleared supplementary groups. Exercise actual authenticated HTTP calls with
Python/JS/TS inputs, filesystem/environment/network probes, a sleeping deadline,
duplicate/conflicting IDs, cancellation-before-submit, and restart recovery.
Never replace Bubblewrap with an in-process evaluator when isolation is blocked.
