-- Product records already present belong to production; machine authority never travels.
ALTER TABLE crank_workflows ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
ALTER TABLE crank_connections ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
CREATE TABLE crank_service_accounts (
 id TEXT PRIMARY KEY,
 label TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 environment TEXT NOT NULL,
 workflow_ids_json TEXT NOT NULL CHECK(json_valid(workflow_ids_json)),
 connection_ids_json TEXT NOT NULL CHECK(json_valid(connection_ids_json)),
 owner_id TEXT NOT NULL,
 owner_version INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
 ended_at TEXT,
 end_reason TEXT
);
CREATE TRIGGER crank_service_account_immutable BEFORE UPDATE OF id,label,token_hash,environment,workflow_ids_json,connection_ids_json,owner_id,owner_version,created_at,expires_at ON crank_service_accounts
BEGIN SELECT RAISE(ABORT,'service account scope and minter are immutable'); END;
CREATE TRIGGER crank_service_account_terminal BEFORE UPDATE OF status ON crank_service_accounts
WHEN OLD.status!='active' AND NEW.status!=OLD.status
BEGIN SELECT RAISE(ABORT,'service account cannot regain authority'); END;
CREATE TRIGGER crank_service_authority_insert AFTER INSERT ON crank_service_accounts
BEGIN UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_service_authority_update AFTER UPDATE ON crank_service_accounts
BEGIN UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_service_suspension_audit AFTER UPDATE OF status ON crank_service_accounts
WHEN OLD.status='active' AND NEW.status='suspended'
BEGIN INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json)
 VALUES(lower(hex(randomblob(16))),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'system:service-authority','service_account.suspend','service_account',NEW.id,NULL,json_object('reason',NEW.end_reason)); END;
CREATE TRIGGER crank_service_owner_ended AFTER UPDATE OF status,role,version ON oa_operators
WHEN NEW.status!='active' OR NEW.role!='owner' OR NEW.version!=OLD.version
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='minter authority ended' WHERE owner_id=NEW.id AND status='active'; END;
CREATE TRIGGER crank_service_owner_deleted AFTER DELETE ON oa_operators
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='minter authority ended' WHERE owner_id=OLD.id AND status='active'; END;
CREATE TRIGGER crank_service_workflow_moved AFTER UPDATE OF environment ON crank_workflows
WHEN NEW.environment!=OLD.environment
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='workflow environment changed' WHERE status='active' AND EXISTS(SELECT 1 FROM json_each(workflow_ids_json) WHERE value=NEW.id); UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_service_workflow_deleted AFTER DELETE ON crank_workflows
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='workflow scope ended' WHERE status='active' AND EXISTS(SELECT 1 FROM json_each(workflow_ids_json) WHERE value=OLD.id); END;
CREATE TRIGGER crank_service_workflow_scope_changed AFTER UPDATE OF draft_json ON crank_workflows
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='workflow connection scope ended'
 WHERE status='active' AND EXISTS(SELECT 1 FROM json_each(workflow_ids_json) WHERE value=NEW.id)
 AND EXISTS(SELECT 1 FROM json_tree(NEW.draft_json) t WHERE
  (t.key='connection_id' AND (t.type!='text' OR t.atom NOT IN (SELECT value FROM json_each(connection_ids_json))))
  OR (t.key='environment' AND t.atom!=environment)
  OR (t.key='gateway_id' AND NOT EXISTS(SELECT 1 FROM crank_gateways g WHERE g.id=t.atom AND g.environment=crank_service_accounts.environment AND g.status='active'))); END;
CREATE TRIGGER crank_service_connection_ended AFTER UPDATE OF environment,status ON crank_connections
WHEN NEW.environment!=OLD.environment OR NEW.status!='active'
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='connection scope ended' WHERE status='active' AND EXISTS(SELECT 1 FROM json_each(connection_ids_json) WHERE value=NEW.id); UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_service_connection_deleted AFTER DELETE ON crank_connections
BEGIN UPDATE crank_service_accounts SET status='suspended',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),end_reason='connection scope ended' WHERE status='active' AND EXISTS(SELECT 1 FROM json_each(connection_ids_json) WHERE value=OLD.id); END;
