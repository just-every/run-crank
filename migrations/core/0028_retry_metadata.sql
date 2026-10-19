-- Durable, value-free retry timing beside the existing request attempt ledger.
ALTER TABLE crank_wf_attempts ADD COLUMN request_key TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_number INTEGER;
ALTER TABLE crank_wf_attempts ADD COLUMN budget_started_at TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_at TEXT;
ALTER TABLE crank_wf_attempts ADD COLUMN retry_reason TEXT;
CREATE INDEX crank_attempts_request ON crank_wf_attempts(run_id,path,request_key,number);
