CREATE TABLE crank_team_environments(id TEXT PRIMARY KEY);
INSERT INTO crank_team_environments SELECT environment FROM crank_workflows UNION SELECT environment FROM crank_connections UNION SELECT 'production' UNION SELECT 'sandbox';
CREATE TABLE crank_team_folders (
 id TEXT PRIMARY KEY, environment TEXT NOT NULL REFERENCES crank_team_environments(id),
 name TEXT NOT NULL, parent_id TEXT REFERENCES crank_team_folders(id),
 UNIQUE(environment,name), CHECK(parent_id IS NULL OR parent_id!=id)
);
ALTER TABLE crank_workflows ADD COLUMN folder_id TEXT;
INSERT INTO crank_team_folders(id,environment,name)
 SELECT lower(hex(randomblob(16))),environment,folder FROM crank_workflows WHERE folder!='' GROUP BY environment,folder;
UPDATE crank_workflows SET folder_id=(SELECT id FROM crank_team_folders f WHERE f.environment=crank_workflows.environment AND f.name=crank_workflows.folder) WHERE folder!='';
ALTER TABLE crank_flows ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
ALTER TABLE crank_flows ADD COLUMN owner_id TEXT;
UPDATE crank_flows SET owner_id=created_by;
CREATE TABLE crank_team_resource_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
INSERT INTO crank_team_resource_revision VALUES(1,1);
CREATE TRIGGER crank_folder_revision_insert AFTER INSERT ON crank_team_folders
BEGIN UPDATE crank_team_resource_revision SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_folder_revision_update AFTER UPDATE ON crank_team_folders
BEGIN UPDATE crank_team_resource_revision SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_folder_revision_delete AFTER DELETE ON crank_team_folders
BEGIN UPDATE crank_team_resource_revision SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_workflow_folder_revision AFTER UPDATE OF folder_id,environment ON crank_workflows
WHEN NEW.folder_id IS NOT OLD.folder_id OR NEW.environment!=OLD.environment
BEGIN UPDATE crank_team_resource_revision SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER crank_folder_environment_insert BEFORE INSERT ON crank_team_folders
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crank_team_folders f WHERE f.id=NEW.parent_id AND f.environment=NEW.environment)
BEGIN SELECT RAISE(ABORT,'Folder parent must be in the same environment'); END;
CREATE TRIGGER crank_workflow_folder_environment_insert BEFORE INSERT ON crank_workflows
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crank_team_folders f WHERE f.id=NEW.folder_id AND f.environment=NEW.environment)
BEGIN SELECT RAISE(ABORT,'Workflow folder must be in the same environment'); END;
CREATE TRIGGER crank_workflow_folder_environment_update BEFORE UPDATE OF folder_id,environment ON crank_workflows
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crank_team_folders f WHERE f.id=NEW.folder_id AND f.environment=NEW.environment)
BEGIN SELECT RAISE(ABORT,'Workflow folder must be in the same environment'); END;
