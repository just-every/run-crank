-- Scheduler and transfer outcomes stay cheap to inspect as the permanent audit grows.
CREATE INDEX crank_audit_action_time ON crank_audit(action,at,id);
