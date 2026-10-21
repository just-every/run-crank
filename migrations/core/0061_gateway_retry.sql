ALTER TABLE crank_gateway_tasks ADD COLUMN retry_request_key TEXT;
ALTER TABLE crank_gateway_tasks ADD COLUMN retry_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crank_gateway_tasks ADD COLUMN budget_started_at TEXT;
ALTER TABLE crank_gateway_tasks ADD COLUMN attempt_id TEXT;
