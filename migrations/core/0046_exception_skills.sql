-- Skills retain references and built-in operations, never copied customer samples.
CREATE TABLE crank_skills (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id),
  step_id TEXT NOT NULL,
  field TEXT NOT NULL,
  pipeline_json TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  staged_at TEXT
);
CREATE TABLE crank_skill_cases (
  skill_id TEXT NOT NULL REFERENCES crank_skills(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
  PRIMARY KEY(skill_id,run_id)
);
