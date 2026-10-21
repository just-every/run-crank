ALTER TABLE crank_gateway_tasks ADD COLUMN recovery_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crank_gateway_tasks ADD COLUMN recovery_request_id TEXT;
