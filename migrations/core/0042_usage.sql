-- OPS-002. All USD amounts are exact integer 10^-8 USD units.
-- No FK cascades: accounting survives history retention and includes legacy flows.
CREATE TABLE crank_usage_workflow_estimates (
 workflow_id TEXT PRIMARY KEY, graph_json TEXT NOT NULL, graph_digest TEXT NOT NULL,
 cost_json TEXT NOT NULL, quoted_by TEXT NOT NULL, quoted_at TEXT NOT NULL
);
CREATE TABLE crank_usage_version_estimates (
 version_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, cost_json TEXT NOT NULL,
 estimate_units INTEGER NOT NULL CHECK(typeof(estimate_units)='integer' AND estimate_units>=0),
 quoted_by TEXT NOT NULL, quoted_at TEXT NOT NULL
);
CREATE TRIGGER crank_usage_version_immutable BEFORE UPDATE ON crank_usage_version_estimates
WHEN NOT (NEW.version_id IS OLD.version_id AND NEW.workflow_id IS OLD.workflow_id AND NEW.cost_json IS OLD.cost_json
 AND NEW.estimate_units IS OLD.estimate_units AND NEW.quoted_at IS OLD.quoted_at AND NEW.quoted_by IS NOT OLD.quoted_by
 AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.quoted_by||':'||NEW.quoted_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_usage_version_immutable'); END;
CREATE TABLE crank_usage_flow_versions (workflow_id TEXT PRIMARY KEY, version_id TEXT NOT NULL);
CREATE TABLE crank_usage_budgets (
 scope TEXT NOT NULL CHECK(scope IN ('workspace','workflow','team')), scope_id TEXT NOT NULL,
 monthly_units INTEGER NOT NULL CHECK(typeof(monthly_units)='integer' AND monthly_units>=0),
 updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(scope,scope_id)
);
CREATE TABLE crank_usage_allowances (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('workspace','workflow','team')), scope_id TEXT NOT NULL,
 month TEXT NOT NULL, usd_units INTEGER NOT NULL CHECK(typeof(usd_units)='integer' AND usd_units>0),
 reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE INDEX crank_usage_allowance_month ON crank_usage_allowances(scope,scope_id,month);
CREATE TRIGGER crank_usage_allowance_bounded BEFORE INSERT ON crank_usage_allowances
WHEN NEW.active=1 AND COALESCE((SELECT SUM(usd_units) FROM crank_usage_allowances WHERE active=1 AND scope=NEW.scope AND scope_id=NEW.scope_id AND month=NEW.month),0)+NEW.usd_units>400000000000000000
BEGIN SELECT RAISE(ABORT,'crank_usage_allowance_limit'); END;
CREATE TABLE crank_usage_reservations (
 run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version_id TEXT NOT NULL, team TEXT,
 month TEXT NOT NULL, estimate_units INTEGER NOT NULL CHECK(typeof(estimate_units)='integer' AND estimate_units>=0),
 accounted_units INTEGER NOT NULL CHECK(typeof(accounted_units)='integer' AND accounted_units>=estimate_units),
 created_at TEXT NOT NULL
);
CREATE INDEX crank_usage_reservation_month ON crank_usage_reservations(month,workflow_id,team);
-- This value-free ledger survives per-run erasure; deleting history cannot refill a cap.
CREATE TABLE crank_usage_spend (
 scope TEXT NOT NULL CHECK(scope IN ('workspace','workflow','team')), scope_id TEXT NOT NULL, month TEXT NOT NULL,
 used_units INTEGER NOT NULL CHECK(typeof(used_units)='integer' AND used_units>=0), updated_at TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,month)
);
CREATE TABLE crank_usage_observations (
 run_id TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, observed_at TEXT NOT NULL,
 PRIMARY KEY(run_id,path)
);
CREATE TABLE crank_usage_provider_charges (
 run_id TEXT NOT NULL, path TEXT NOT NULL, source TEXT NOT NULL,
 usd_units INTEGER NOT NULL CHECK(typeof(usd_units)='integer' AND usd_units>=0),
 reported_at TEXT NOT NULL, PRIMARY KEY(run_id,path,source)
);
CREATE TABLE crank_usage_notices (
 scope TEXT NOT NULL, scope_id TEXT NOT NULL, month TEXT NOT NULL, threshold INTEGER NOT NULL CHECK(threshold IN (80,100)),
 created_at TEXT NOT NULL, delivered_at TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(scope,scope_id,month,threshold)
);

-- Guard the estimate debit inside the same transaction as the new run.
CREATE TRIGGER crank_usage_reservation_budget BEFORE INSERT ON crank_usage_reservations
WHEN EXISTS(SELECT 1 FROM crank_usage_budgets b
 WHERE b.active=1 AND (b.scope='workspace' OR (b.scope='workflow' AND b.scope_id=NEW.workflow_id) OR (b.scope='team' AND b.scope_id=NEW.team))
 AND (
  COALESCE((SELECT used_units FROM crank_usage_spend s WHERE s.month=NEW.month AND s.scope=b.scope AND s.scope_id=b.scope_id),0)
  +NEW.accounted_units >
  b.monthly_units+COALESCE((SELECT SUM(a.usd_units) FROM crank_usage_allowances a WHERE a.active=1 AND a.scope=b.scope AND a.scope_id=b.scope_id AND a.month=NEW.month),0)
  OR COALESCE((SELECT used_units FROM crank_usage_spend s WHERE s.month=NEW.month AND s.scope=b.scope AND s.scope_id=b.scope_id),0) >=
  b.monthly_units+COALESCE((SELECT SUM(a.usd_units) FROM crank_usage_allowances a WHERE a.active=1 AND a.scope=b.scope AND a.scope_id=b.scope_id AND a.month=NEW.month),0)
 ))
BEGIN SELECT RAISE(ABORT,'crank_budget_exhausted'); END;

-- Receiving workflows restore with this owner sentinel and never reserve again.
CREATE TRIGGER crank_usage_workflow_admit AFTER INSERT ON crank_wf_runs
WHEN NEW.mode='production' AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=NEW.workflow_id AND owner_id!='restore:awaiting-adoption')
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM crank_usage_version_estimates WHERE version_id=NEW.version_id AND workflow_id=NEW.workflow_id)
  THEN RAISE(ABORT,'crank_usage_estimate_required') END;
 INSERT INTO crank_usage_reservations(run_id,workflow_id,version_id,team,month,estimate_units,accounted_units,created_at)
  SELECT NEW.id,NEW.workflow_id,NEW.version_id,(SELECT team FROM crank_ops_teams WHERE workflow_id=NEW.workflow_id),
   strftime('%Y-%m','now'),estimate_units,estimate_units,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM crank_usage_version_estimates WHERE version_id=NEW.version_id AND workflow_id=NEW.workflow_id;
END;
-- Legacy archives restore draft, so imported history cannot obtain new admission authority.
CREATE TRIGGER crank_usage_flow_admit AFTER INSERT ON crank_runs
WHEN EXISTS(SELECT 1 FROM crank_flows WHERE id=NEW.flow_id AND status='active')
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM crank_usage_flow_versions f JOIN crank_usage_version_estimates v ON v.version_id=f.version_id WHERE f.workflow_id=NEW.flow_id)
  THEN RAISE(ABORT,'crank_usage_estimate_required') END;
 INSERT INTO crank_usage_reservations(run_id,workflow_id,version_id,team,month,estimate_units,accounted_units,created_at)
  SELECT NEW.id,NEW.flow_id,v.version_id,(SELECT team FROM crank_ops_teams WHERE workflow_id=NEW.flow_id),
   strftime('%Y-%m','now'),v.estimate_units,v.estimate_units,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM crank_usage_flow_versions f JOIN crank_usage_version_estimates v ON v.version_id=f.version_id WHERE f.workflow_id=NEW.flow_id;
END;
-- Provider charges are already incurred; record them even if they cross the cap.
-- max(estimate, summed reported charges) accounts once and closes subsequent admission.
CREATE TRIGGER crank_usage_charge_account AFTER INSERT ON crank_usage_provider_charges
WHEN EXISTS(SELECT 1 FROM crank_usage_reservations r WHERE r.run_id=NEW.run_id AND (
 EXISTS(SELECT 1 FROM crank_workflows w WHERE w.id=r.workflow_id AND w.owner_id!='restore:awaiting-adoption')
 OR EXISTS(SELECT 1 FROM crank_flows f WHERE f.id=r.workflow_id AND f.status='active')))
BEGIN
 UPDATE crank_usage_reservations SET accounted_units=MAX(estimate_units,
  (SELECT SUM(usd_units) FROM crank_usage_provider_charges WHERE run_id=NEW.run_id)) WHERE run_id=NEW.run_id;
END;
CREATE VIEW crank_usage_budget_totals AS
 WITH months(month) AS (
  SELECT strftime('%Y-%m','now') UNION SELECT month FROM crank_usage_spend UNION SELECT month FROM crank_usage_allowances
 )
 SELECT b.scope,b.scope_id,m.month,
  b.monthly_units+COALESCE((SELECT SUM(a.usd_units) FROM crank_usage_allowances a WHERE a.active=1 AND a.scope=b.scope AND a.scope_id=b.scope_id AND a.month=m.month),0) AS limit_units,
  COALESCE((SELECT used_units FROM crank_usage_spend s WHERE s.month=m.month AND s.scope=b.scope AND s.scope_id=b.scope_id),0) AS used_units
 FROM crank_usage_budgets b CROSS JOIN months m WHERE b.active=1;
CREATE TRIGGER crank_usage_reservation_notice AFTER INSERT ON crank_usage_reservations
WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=NEW.workflow_id AND owner_id!='restore:awaiting-adoption')
 OR EXISTS(SELECT 1 FROM crank_flows WHERE id=NEW.workflow_id AND status='active')
BEGIN
 INSERT INTO crank_usage_spend(scope,scope_id,month,used_units,updated_at)
 SELECT scope,scope_id,NEW.month,NEW.accounted_units,NEW.created_at FROM (
  SELECT 'workspace' AS scope,'workspace' AS scope_id UNION ALL SELECT 'workflow',NEW.workflow_id UNION ALL SELECT 'team',NEW.team WHERE NEW.team IS NOT NULL
 ) WHERE 1 ON CONFLICT(scope,scope_id,month) DO UPDATE SET used_units=used_units+excluded.used_units,updated_at=excluded.updated_at;
 INSERT OR IGNORE INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5);
END;
CREATE TRIGGER crank_usage_accounted_notice AFTER UPDATE OF accounted_units ON crank_usage_reservations
WHEN NEW.accounted_units>OLD.accounted_units
BEGIN
 INSERT INTO crank_usage_spend(scope,scope_id,month,used_units,updated_at)
 SELECT scope,scope_id,NEW.month,NEW.accounted_units-OLD.accounted_units,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (
  SELECT 'workspace' AS scope,'workspace' AS scope_id UNION ALL SELECT 'workflow',NEW.workflow_id UNION ALL SELECT 'team',NEW.team WHERE NEW.team IS NOT NULL
 ) WHERE 1 ON CONFLICT(scope,scope_id,month) DO UPDATE SET used_units=used_units+excluded.used_units,updated_at=excluded.updated_at;
 INSERT OR IGNORE INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5);
END;
CREATE TRIGGER crank_usage_budget_insert_notice AFTER INSERT ON crank_usage_budgets
BEGIN
 INSERT OR IGNORE INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5);
END;
CREATE TRIGGER crank_usage_budget_update_notice AFTER UPDATE ON crank_usage_budgets
BEGIN
 INSERT OR IGNORE INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5);
END;
