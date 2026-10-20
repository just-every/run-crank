-- PLATFORM-001: installation-local preparation receipts. Neither raw keys nor
-- request/response data travel in this table or the portable archive.
CREATE TABLE crank_workflow_idempotency (
 scope_hash TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('create','draft')),
 target_id TEXT NOT NULL,
 key_hash TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 workflow_id TEXT NOT NULL,
 draft_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(scope_hash,operation,target_id,key_hash)
);
CREATE INDEX crank_workflow_idempotency_actor ON crank_workflow_idempotency(actor_id);
