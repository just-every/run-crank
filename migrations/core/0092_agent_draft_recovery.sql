-- Inert draft recovery is installation-local authority, excluded with native receipts.
-- Legacy receipts remain without recovery evidence; never infer an outcome from IDs.
ALTER TABLE crank_workflow_idempotency ADD COLUMN agent_receipt_json TEXT;
