-- Metadata-only outbox. Triggers record transitions atomically with their source writes.
CREATE TABLE crank_ops_teams (workflow_id TEXT PRIMARY KEY, team TEXT NOT NULL);
CREATE TABLE crank_obligations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES crank_wf_runs(id), obligation_key TEXT NOT NULL,
 description TEXT NOT NULL, due_at TEXT, created_at TEXT NOT NULL,
 verified_at TEXT, verified_by TEXT, evidence TEXT,
 UNIQUE(run_id,obligation_key)
);
CREATE INDEX crank_obligations_run ON crank_obligations(run_id);
CREATE TABLE crank_ops_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL,
 workflow_id TEXT, run_id TEXT, status TEXT, step_type TEXT, actor_id TEXT,
 subject_kind TEXT, subject_id TEXT, action TEXT
);
CREATE INDEX crank_ops_events_time ON crank_ops_events(at);
CREATE TABLE crank_log_sinks (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('http','datadog','splunk','s3')),
 endpoint TEXT NOT NULL, config_json TEXT NOT NULL, secret_iv TEXT NOT NULL, secret_ciphertext TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, cursor INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_attempt_at TEXT, last_delivered_at TEXT,
 last_failure TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_id TEXT, lease_expires_at TEXT
);
CREATE TRIGGER crank_ops_run_insert AFTER INSERT ON crank_wf_runs BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status) VALUES(NEW.received_at,'run.received',NEW.workflow_id,NEW.id,NEW.status);
END;
CREATE TRIGGER crank_ops_run_update AFTER UPDATE OF status ON crank_wf_runs WHEN NEW.status != OLD.status BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'run.status',NEW.workflow_id,NEW.id,NEW.status);
END;
CREATE TRIGGER crank_ops_step_insert AFTER INSERT ON crank_wf_steps BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status,step_type)
 SELECT NEW.started_at,'step.status',workflow_id,NEW.run_id,NEW.status,NEW.type FROM crank_wf_runs WHERE id=NEW.run_id;
END;
CREATE TRIGGER crank_ops_step_update AFTER UPDATE OF status ON crank_wf_steps WHEN NEW.status != OLD.status BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status,step_type)
 SELECT COALESCE(NEW.finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'step.status',workflow_id,NEW.run_id,NEW.status,NEW.type FROM crank_wf_runs WHERE id=NEW.run_id;
END;
CREATE TRIGGER crank_ops_audit AFTER INSERT ON crank_audit BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,actor_id,subject_kind,subject_id,action)
 VALUES(NEW.at,'audit',CASE WHEN NEW.subject_kind='workflow' THEN NEW.subject_id ELSE (SELECT workflow_id FROM crank_wf_runs WHERE id=NEW.subject_id) END,
 CASE WHEN NEW.subject_kind='run' THEN NEW.subject_id END,NEW.actor_id,NEW.subject_kind,NEW.subject_id,NEW.action);
END;
CREATE TRIGGER crank_ops_connection AFTER UPDATE OF status ON crank_connections WHEN NEW.status != OLD.status BEGIN
 INSERT INTO crank_ops_events(at,event,status,subject_kind,subject_id) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'connection.status',NEW.status,'connection',NEW.id);
END;
