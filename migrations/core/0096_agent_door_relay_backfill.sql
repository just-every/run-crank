-- Base 0.2.104: preserve existing paired MCP audit membership.
-- 0040 only, once: pre-existing Business-token rows, attributed to the current envelope's Business (platform P11 drops pre-join history).
INSERT INTO agent_door_relay(decision_id,business)
  SELECT id,(SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1) FROM agent_door_audit
  WHERE json_extract(row,'$.door')='mcp' AND json_extract(row,'$.consent') IS NOT NULL
    AND (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1) IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM agent_door_relay r WHERE r.decision_id=agent_door_audit.id)
  ORDER BY sequence;
