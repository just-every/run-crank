-- PLATFORM-001: publish and rollback receipts share local hash/ID-only custody.
-- Preserve every existing draft receipt while adding immutable version identities.
ALTER TABLE crank_workflow_idempotency RENAME TO crank_workflow_idempotency_old;
CREATE TABLE crank_workflow_idempotency (
 scope_hash TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('create','draft','publish','rollback')),
 target_id TEXT NOT NULL,
 key_hash TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 workflow_id TEXT NOT NULL,
 draft_id TEXT,
 version_id TEXT,
 attempt_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK((operation IN ('create','draft') AND draft_id IS NOT NULL AND version_id IS NULL)
    OR (operation IN ('publish','rollback') AND draft_id IS NULL AND version_id IS NOT NULL)),
 PRIMARY KEY(scope_hash,operation,target_id,key_hash)
);
INSERT INTO crank_workflow_idempotency
 (scope_hash,operation,target_id,key_hash,request_digest,workflow_id,draft_id,attempt_id,actor_id,created_at)
 SELECT scope_hash,operation,target_id,key_hash,request_digest,workflow_id,draft_id,attempt_id,actor_id,created_at
 FROM crank_workflow_idempotency_old;
DROP TABLE crank_workflow_idempotency_old;
CREATE INDEX crank_workflow_idempotency_actor ON crank_workflow_idempotency(actor_id);
