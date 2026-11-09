-- Apply after Penny's 0105 migration; preserve every previously applied file.
ALTER TABLE agent_door_agents ADD COLUMN tombstone TEXT;
-- Fixed Base replay window; no installation or seed override.
ALTER TABLE agent_door_calls ADD COLUMN expires_at INTEGER;
-- Older completed claims have no completion timestamp: use their recorded start,
-- never migration/erasure time, so upgrading cannot extend their retention.
UPDATE agent_door_calls SET expires_at=created_at + 30*24*60*60*1000
WHERE state NOT IN ('running','pending');
CREATE INDEX agent_door_calls_expiry ON agent_door_calls(expires_at);

-- Installation-private replay custody, never included in an archive or export.
-- The call's fixed replay horizon bounds the alias; deletion is atomic below.
CREATE TABLE IF NOT EXISTS agent_door_replay_aliases (
  agent TEXT NOT NULL, alias TEXT NOT NULL, call_id TEXT NOT NULL, tombstone TEXT NOT NULL,
  PRIMARY KEY(agent,alias)
);

CREATE TRIGGER IF NOT EXISTS agent_door_delete_replay_aliases AFTER DELETE ON agent_door_calls
BEGIN
  DELETE FROM agent_door_replay_aliases WHERE agent=OLD.agent AND call_id=OLD.decision_id;
END;
CREATE INDEX IF NOT EXISTS agent_door_replay_aliases_call ON agent_door_replay_aliases(agent,call_id);

-- Native customer erasure now owns mapped agent payloads in its transaction.
-- Operator erasure, restore custody and independent legal holds still refuse.
DROP TRIGGER penny_agent_erasure_fence;
DROP TRIGGER penny_agent_identity_erasure_fence;
