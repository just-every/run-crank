-- Value-free retry suspension/release/actual-resume timing; the existing run
-- and step records retain the immutable input and current execution authority.
-- Existing immutable versions keep their reviewed defaults. New versions
-- explicitly snapshot today's policy when published or tested.
ALTER TABLE crank_workflow_versions ADD COLUMN retry_policy_json TEXT NOT NULL DEFAULT '{"read_attempts":3,"base_delay_ms":500,"write_base_delay_ms":500}';
CREATE TRIGGER crank_retry_policy_immutable BEFORE UPDATE OF retry_policy_json ON crank_workflow_versions
BEGIN SELECT RAISE(ABORT,'crank_version_immutable'); END;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_parked_at TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_released_at TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_resumed_at TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN slice_started_at TEXT;
CREATE INDEX crank_attempts_parked ON crank_wf_attempts(retry_at) WHERE retry_parked_at IS NOT NULL AND retry_resumed_at IS NULL;

-- Only completed responses needed to reconstruct an unfinished step. Credential
-- headers never enter these rows, and terminal steps discard them.
CREATE TABLE crank_request_checkpoints (
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 path TEXT NOT NULL, operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
 request_key TEXT NOT NULL, response_json TEXT NOT NULL, attempts INTEGER NOT NULL,
 exhausted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,path,operation_key,ordinal)
);
CREATE TABLE crank_request_checkpoint_chunks (
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 path TEXT NOT NULL, operation_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
 chunk_index INTEGER NOT NULL, content_base64 TEXT NOT NULL,
 PRIMARY KEY(run_id,path,operation_key,ordinal,chunk_index),
 FOREIGN KEY(run_id,path,operation_key,ordinal)
   REFERENCES crank_request_checkpoints(run_id,path,operation_key,ordinal) ON DELETE CASCADE
);

CREATE TRIGGER crank_request_checkpoint_step_insert AFTER INSERT ON crank_wf_steps
 WHEN NEW.status IN ('succeeded','failed','uncertain','skipped','stopped') BEGIN
 DELETE FROM crank_request_checkpoints WHERE run_id=NEW.run_id AND path=NEW.path;
END;
CREATE TRIGGER crank_request_checkpoint_step_update AFTER UPDATE OF status ON crank_wf_steps
 WHEN NEW.status IN ('succeeded','failed','uncertain','skipped','stopped') BEGIN
 DELETE FROM crank_request_checkpoints WHERE run_id=NEW.run_id AND path=NEW.path;
END;
CREATE TRIGGER crank_request_checkpoint_run_settled AFTER UPDATE OF status ON crank_wf_runs
 WHEN NEW.status IN ('succeeded','failed','cancelled','rejected','stopped_by_filter','stopped_by_search') BEGIN
 DELETE FROM crank_request_checkpoints WHERE run_id=NEW.id;
END;
