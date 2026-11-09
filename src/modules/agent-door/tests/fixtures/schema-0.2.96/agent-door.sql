CREATE TABLE IF NOT EXISTS agent_door_state (
  id INTEGER PRIMARY KEY CHECK(id=1), envelope TEXT, local_document TEXT,
  local_revision INTEGER NOT NULL DEFAULT 0, local_paused INTEGER NOT NULL DEFAULT 0,
  decision_lock TEXT, decision_until INTEGER
);
CREATE TABLE IF NOT EXISTS agent_door_agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, specialist TEXT, sponsor TEXT NOT NULL,
  sponsor_name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  window INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, tombstone TEXT
);
CREATE TABLE IF NOT EXISTS agent_door_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
  agent TEXT NOT NULL, classes TEXT NOT NULL, row TEXT NOT NULL, evidence TEXT
);
CREATE INDEX IF NOT EXISTS agent_door_audit_agent ON agent_door_audit(agent,sequence);
CREATE TABLE IF NOT EXISTS agent_door_calls (
  agent TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, decision_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, state TEXT NOT NULL, outcome TEXT, expires_at INTEGER, PRIMARY KEY(agent,key)
);
CREATE TABLE IF NOT EXISTS agent_door_approvals (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, saved TEXT NOT NULL, approvals TEXT NOT NULL DEFAULT '[]',
  result TEXT, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_door_reviews (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, saved TEXT NOT NULL, marked_by TEXT, marked_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_door_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, uri TEXT NOT NULL, event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_door_events_uri ON agent_door_events(uri,sequence);
CREATE TABLE IF NOT EXISTS agent_door_usage (
  decision_id TEXT PRIMARY KEY, at INTEGER NOT NULL, seed TEXT NOT NULL, specialist TEXT, agent TEXT NOT NULL,
  classes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_door_usage_day ON agent_door_usage(at);

CREATE INDEX IF NOT EXISTS agent_door_calls_expiry ON agent_door_calls(expires_at);
CREATE TABLE IF NOT EXISTS agent_door_relay (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL, business TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_door_relay_business ON agent_door_relay(business,sequence);
CREATE INDEX IF NOT EXISTS agent_door_relay_decision ON agent_door_relay(decision_id,sequence);
-- Plain INSERT then DELETE, never INSERT OR REPLACE: an outer UPSERT's conflict policy overrides a trigger's.
CREATE TRIGGER IF NOT EXISTS agent_door_relay_audit_insert AFTER INSERT ON agent_door_audit
WHEN json_extract(NEW.row,'$.door')='mcp' AND json_extract(NEW.row,'$.consent') IS NOT NULL
 AND (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1) IS NOT NULL
BEGIN
  INSERT INTO agent_door_relay(decision_id,business) VALUES(NEW.id,
    COALESCE((SELECT business FROM agent_door_relay WHERE decision_id=NEW.id ORDER BY sequence DESC LIMIT 1),
             (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1)));
  DELETE FROM agent_door_relay WHERE decision_id=NEW.id AND sequence<(SELECT MAX(sequence) FROM agent_door_relay WHERE decision_id=NEW.id);
END;
-- Membership survives erasure, which drops door and consent from the row.
CREATE TRIGGER IF NOT EXISTS agent_door_relay_audit_update AFTER UPDATE ON agent_door_audit
WHEN EXISTS(SELECT 1 FROM agent_door_relay WHERE decision_id=NEW.id)
  OR (json_extract(NEW.row,'$.door')='mcp' AND json_extract(NEW.row,'$.consent') IS NOT NULL
      AND (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1) IS NOT NULL)
BEGIN
  INSERT INTO agent_door_relay(decision_id,business) VALUES(NEW.id,
    COALESCE((SELECT business FROM agent_door_relay WHERE decision_id=NEW.id ORDER BY sequence DESC LIMIT 1),
             (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1)));
  DELETE FROM agent_door_relay WHERE decision_id=NEW.id AND sequence<(SELECT MAX(sequence) FROM agent_door_relay WHERE decision_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS agent_door_relay_approval AFTER UPDATE OF state ON agent_door_approvals
WHEN EXISTS(SELECT 1 FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id'))
BEGIN
  INSERT INTO agent_door_relay(decision_id,business)
    SELECT decision_id,business FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id') ORDER BY sequence DESC LIMIT 1;
  DELETE FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id')
    AND sequence<(SELECT MAX(sequence) FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id'));
END;
CREATE TRIGGER IF NOT EXISTS agent_door_relay_review AFTER UPDATE OF state ON agent_door_reviews
WHEN EXISTS(SELECT 1 FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id'))
BEGIN
  INSERT INTO agent_door_relay(decision_id,business)
    SELECT decision_id,business FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id') ORDER BY sequence DESC LIMIT 1;
  DELETE FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id')
    AND sequence<(SELECT MAX(sequence) FROM agent_door_relay WHERE decision_id=json_extract(NEW.saved,'$.decision_id'));
END;
