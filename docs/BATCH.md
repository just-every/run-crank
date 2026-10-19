# Batches, loops and keyed joins (WORK-003)

Workflows can fetch a complete paginated dataset, iterate it with bounded
concurrency, route records through branches and join the resulting streams.
Completed item effects retain their checkpoints and operation keys across waits
and executor restarts. These operations use the ordinary workflow publish, run,
approval, callback and run-detail APIs.

## Read a paginated dataset

An HTTP GET step can declare cursor, page-number or Link-header pagination:

```json
{
  "id": "source",
  "type": "http",
  "input": { "url": "https://api.example.com/orders" },
  "pagination": {
    "kind": "cursor",
    "items_path": "orders",
    "cursor_path": "next_cursor",
    "max_pages": 10,
    "max_items": 1000,
    "max_bytes": 8388608
  }
}
```

The output adds `items`, `pages` and `complete: true`. Defaults are 10 pages,
1,000 items and 8 MiB of response bytes. The configurable maxima are 50 pages,
10,000 items and 32 MiB. Each page also follows the HTTP step's response bounds.
A page-number source must return its final empty page within `max_pages`.

The source must be exhausted before downstream work starts. More pages pending
at the page bound produce `pagination truncated`; item/byte bounds produce
`pagination limit`; repeated URLs produce `pagination cycle`. Invalid item
arrays fail rather than becoming an empty dataset. Managed authentication and
egress checks apply to every page, and Link pagination must keep the API origin.

## Iterate and aggregate

```json
{
  "id": "orders",
  "type": "loop",
  "input": { "items": "{{steps.source.items}}" },
  "max_items": 100,
  "concurrency": 2,
  "order": "input",
  "empty": "allow",
  "item_errors": "stop",
  "steps": [
    {
      "id": "invoice",
      "type": "http",
      "idempotency_header": "Idempotency-Key",
      "input": {
        "method": "POST",
        "url": "https://api.example.com/invoices",
        "body": { "order_id": "{{item.id}}", "amount": "{{item.total}}" }
      }
    }
  ],
  "result": {
    "order_id": "{{item.id}}",
    "invoice_id": "{{steps.invoice.body.id}}"
  }
}
```

Every loop policy is required at publish. `max_items` is 1–1,000 and
`concurrency` is 1–8. Nested loops and paths share the existing depth bound;
the declared bounds may expand to at most 10,000 step invocations. A loop's
retained input and aggregate output are each bounded to 1 MiB; one mapped item
result is bounded to 512 KiB. Exceeding a bound is a named validation failure.

Each item sees its own `item`, zero-based `item_index` and earlier step outputs.
Sibling iterations have isolated mapping scopes. `result` maps the output of
one successful iteration. The loop outputs:

```json
{
  "items": [
    { "index": 0, "status": "succeeded", "output": { "order_id": "o-1", "invoice_id": "inv-1" } },
    { "index": 1, "status": "failed", "error": { "category": "provider", "message": "..." } }
  ],
  "results": [{ "order_id": "o-1", "invoice_id": "inv-1" }],
  "total": 2
}
```

`items` and successful `results` retain input order even when requests complete
in another order. A filter/search stop is recorded as an item `stopped` outcome
and contributes no successful result. Child inputs, outputs, failures and
operation keys remain inspectable by concrete path in run detail.

With `item_errors: "continue"`, failed items remain inspectable while remaining
items run. With `"stop"`, a failure stops new iterations and fails the batch;
already-running workers finish and checkpoint before settlement. Use
`item_errors` rather than the generic step `on_error` on a loop. This operation
does not add failed-item replay or clear failed records.

With `empty: "allow"`, an empty array succeeds with empty `items` and `results`
and `total: 0`. With `"error"`, it fails as `empty loop input`. A non-array
fails as `invalid loop input`; exceeding the input bound is `loop input limit`;
an oversized mapped result or aggregate is `loop result limit`.

## Branches, waits and safe resumption

A paths group may be followed by further steps. For example, a `parallel` paths
group can have an `invoices` loop in its billing branch and a `packing` loop in
its fulfilment branch. A following join maps `steps.invoices.results` and
`steps.packing.results`. Branch step IDs remain unique across the whole graph.
Path branches are walked in their declared order; each loop independently uses
its declared worker concurrency.

Resolved loop inputs are retained before children start. Child paths include
stable ordinals, such as `orders/items/0/invoice`. Approval, delay, queue and
callback waits can nest inside loops and paths. Inside an iteration,
`run.resume_urls.<callback_step_id>` targets that iteration's concrete callback
path. A wait stops new iterations while existing workers settle. A callback
received during concurrent execution queues a continuation; consumed waits
cannot cause repeated continuations.

Resumption walks the retained inputs and successful child checkpoints. A
confirmed invoice is not sent again. An interrupted remote write or lost
response stays uncertain and is never blindly repeated. Static HTTP GET/HEAD
reads can restart safely. The existing HTTP idempotency/readback policy applies
to writes. Repairing failed or uncertain items through broader replay belongs
to EXEC-004.

## Merge by explicit keys

A `join` step merges two mapped arrays by explicit keys:

```json
{
  "id": "reconcile",
  "type": "join",
  "policy": "full",
  "left_key": "order.id",
  "right_key": "order_id",
  "duplicate_keys": "error",
  "order": "left_then_right",
  "empty": "allow",
  "input": {
    "left": "{{steps.orders.items}}",
    "right": "{{steps.invoices.items}}"
  }
}
```

Publish requires every policy shown above. Key paths use the usual dotted fields
and array indexes. Keys must be nonempty strings or finite numbers. Comparisons
are exact and retain types: numeric `1` and string `"1"` are different keys;
strings are case sensitive and are not trimmed before comparison.

The output contains `rows`, `unmatched_left` and `unmatched_right`. Each row is
`{ "key": ..., "left": ..., "right": ... }`, retaining the complete original
records. An absent side is `null`.

- `inner` emits only matching pairs.
- `left` also emits unmatched left records.
- `full` also emits unmatched right records.

Rows follow left input order, followed by unmatched right records in right input
order for `full`. Both unmatched arrays always retain their source order,
regardless of join policy, and are available in run detail and later mappings.

With `empty: "allow"`, an empty side behaves according to the chosen join policy;
two empty arrays produce three empty output arrays. With `empty: "error"`, either
empty side fails with the named outcome `empty join input`.

Duplicate keys on either side fail with `duplicate join key`. Missing, null,
blank or nonscalar keys fail with `invalid join key`. A non-array input fails with
`invalid join input`. The combined inputs are bounded to 10,000 records; exceeding
that bound fails with `join input limit`. Validation inspects both complete inputs
before producing output. A failure stops downstream work unless the builder
explicitly selects the existing `on_error: "continue"` behavior.

The HTTP integration journeys in `tests/batch.test.mjs` publish workflows, run
them and inspect retained run detail. They exercise paginated orders, two
branches, ordered concurrent loops, keyed joins, per-item failures, nested
approvals and callbacks, process restarts and one invoice effect per completed
order. Third-party APIs are faked only at the test network boundary.
