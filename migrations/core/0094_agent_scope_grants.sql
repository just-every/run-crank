-- Native owner ceilings only narrow the scopes carried by an original credential.
CREATE TABLE crank_agent_scope_grants (
  agent_id TEXT PRIMARY KEY,
  sponsor TEXT NOT NULL,
  original_scopes TEXT NOT NULL,
  scopes TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Existing native preparation keys keep exactly their historical permissions.
INSERT INTO crank_agent_scope_grants(agent_id,sponsor,original_scopes,scopes,updated_at,updated_by)
SELECT 'crank-token:' || id, created_by,
  '["workflows:read","workflows:prepare","runs:read","connections:read","catalog:read"]',
  '["workflows:read","workflows:prepare","runs:read","connections:read","catalog:read"]',
  created_at, created_by
FROM crank_tokens WHERE scope='agent' AND flow_id IS NULL AND revoked_at IS NULL;
