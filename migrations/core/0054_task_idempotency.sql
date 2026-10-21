-- Installation-local, value-free receipts. Erasing history must not permit a
-- lost-response retry to launch the same effects again.
CREATE TABLE crank_task_idempotency (
 grant_id TEXT NOT NULL,
 key_hash TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 workflow_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 PRIMARY KEY(grant_id,key_hash)
);
CREATE INDEX crank_task_idempotency_actor ON crank_task_idempotency(actor_id);
