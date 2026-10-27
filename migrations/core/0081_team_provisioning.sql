-- Provisioning is installation authority and is never restored from an archive.
CREATE TABLE crank_scim_credentials (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX crank_scim_issuer_live ON crank_scim_credentials(issuer) WHERE revoked_at IS NULL;
CREATE TABLE crank_scim_users (
 id TEXT PRIMARY KEY REFERENCES oa_operators(id), issuer TEXT NOT NULL,
 external_id TEXT NOT NULL, user_name TEXT NOT NULL, resource_json TEXT NOT NULL CHECK(json_valid(resource_json)),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(issuer,external_id), UNIQUE(issuer,user_name)
);
CREATE TABLE crank_scim_groups (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, external_id TEXT NOT NULL,
 display_name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(issuer,external_id)
);
CREATE TABLE crank_scim_members (
 group_id TEXT NOT NULL REFERENCES crank_scim_groups(id) ON DELETE CASCADE,
 operator_id TEXT NOT NULL REFERENCES crank_scim_users(id), PRIMARY KEY(group_id,operator_id)
);
CREATE TABLE crank_scim_group_grants (
 group_id TEXT PRIMARY KEY REFERENCES crank_scim_groups(id) ON DELETE CASCADE,
 grants_json TEXT NOT NULL CHECK(json_valid(grants_json)), owner_id TEXT NOT NULL REFERENCES oa_operators(id),
 owner_version INTEGER NOT NULL, revision TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE TABLE crank_scim_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
INSERT INTO crank_scim_revision VALUES(1,1);
CREATE TRIGGER crank_scim_owner_revision AFTER UPDATE OF status,role,version ON oa_operators
WHEN (OLD.status!=NEW.status OR OLD.role!=NEW.role OR OLD.version!=NEW.version)
 AND (EXISTS(SELECT 1 FROM crank_scim_users WHERE id=NEW.id)
 OR EXISTS(SELECT 1 FROM crank_scim_credentials WHERE owner_id=NEW.id)
 OR EXISTS(SELECT 1 FROM crank_scim_group_grants WHERE owner_id=NEW.id))
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_user_issuer BEFORE UPDATE OF id,issuer,external_id ON crank_scim_users
BEGIN SELECT RAISE(ABORT,'SCIM identity is immutable'); END;
CREATE TRIGGER crank_scim_group_issuer BEFORE UPDATE OF id,issuer,external_id ON crank_scim_groups
BEGIN SELECT RAISE(ABORT,'SCIM identity is immutable'); END;
CREATE TRIGGER crank_scim_credential_issuer BEFORE UPDATE OF id,issuer,token_hash,owner_id,owner_version ON crank_scim_credentials
BEGIN SELECT RAISE(ABORT,'SCIM issuer authority is immutable'); END;
CREATE TRIGGER crank_scim_no_owner BEFORE INSERT ON crank_scim_users
WHEN EXISTS(SELECT 1 FROM oa_operators WHERE id=NEW.id AND role='owner')
BEGIN SELECT RAISE(ABORT,'SCIM cannot manage an owner'); END;
CREATE TRIGGER crank_scim_same_issuer BEFORE INSERT ON crank_scim_members
WHEN NOT EXISTS(SELECT 1 FROM crank_scim_groups g JOIN crank_scim_users u ON u.issuer=g.issuer WHERE g.id=NEW.group_id AND u.id=NEW.operator_id)
BEGIN SELECT RAISE(ABORT,'SCIM membership must share an issuer'); END;
CREATE TRIGGER crank_scim_credentials_insert AFTER INSERT ON crank_scim_credentials
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_credentials_update AFTER UPDATE ON crank_scim_credentials
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_credentials_delete AFTER DELETE ON crank_scim_credentials
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_users_insert AFTER INSERT ON crank_scim_users
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_users_update AFTER UPDATE ON crank_scim_users
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_users_delete AFTER DELETE ON crank_scim_users
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_groups_insert AFTER INSERT ON crank_scim_groups
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_groups_update AFTER UPDATE ON crank_scim_groups
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_groups_delete AFTER DELETE ON crank_scim_groups
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_members_insert AFTER INSERT ON crank_scim_members
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_members_update AFTER UPDATE ON crank_scim_members
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_members_delete AFTER DELETE ON crank_scim_members
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_group_grants_insert AFTER INSERT ON crank_scim_group_grants
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_group_grants_update AFTER UPDATE ON crank_scim_group_grants
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_scim_group_grants_delete AFTER DELETE ON crank_scim_group_grants
BEGIN UPDATE crank_scim_revision SET revision=revision+1 WHERE singleton=1; UPDATE crank_team_authority SET revision=revision+1 WHERE singleton=1; END;
