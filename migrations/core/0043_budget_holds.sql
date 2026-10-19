-- Source retains the two original storage buckets; origin_kind names the actual door.
ALTER TABLE crank_holds ADD COLUMN origin_kind TEXT;
ALTER TABLE crank_holds ADD COLUMN budget_hold INTEGER NOT NULL DEFAULT 0 CHECK(budget_hold IN (0,1));
CREATE TABLE crank_step_admissions (
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id), path TEXT NOT NULL, admitted_at TEXT NOT NULL,
 PRIMARY KEY(run_id,path)
);
CREATE TABLE crank_schedule_holds (
 workflow_id TEXT NOT NULL, occurrence TEXT NOT NULL, hold_id TEXT NOT NULL REFERENCES crank_holds(id),
 PRIMARY KEY(workflow_id,occurrence)
);
CREATE TABLE crank_usage_reporting_errors (
 run_id TEXT NOT NULL, path TEXT NOT NULL, source TEXT NOT NULL, error TEXT NOT NULL, reported_at TEXT NOT NULL,
 PRIMARY KEY(run_id,path,source)
);
