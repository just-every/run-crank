-- Claim identity and destination commit in one transaction, including held events.
ALTER TABLE crank_trigger_events ADD COLUMN admission_id TEXT;
ALTER TABLE crank_trigger_events ADD COLUMN hold_id TEXT;
