-- EXEC-004: completed runs retain their history; selected failed loop items
-- execute in a linked run carrying the original checkpoints and operation keys.
ALTER TABLE crank_wf_runs ADD COLUMN repair_of TEXT;
ALTER TABLE crank_wf_runs ADD COLUMN repair_paths_json TEXT;
CREATE INDEX crank_wf_runs_repair_source ON crank_wf_runs(repair_of);
