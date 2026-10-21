-- Retain bounded control attempts across service and Worker restarts.
ALTER TABLE crank_executor_tasks ADD COLUMN cancel_attempts INTEGER NOT NULL DEFAULT 0;
