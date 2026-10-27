-- Explicit inner conflict handling survives an outer budget upsert.
DROP TRIGGER crank_usage_budget_insert_notice;
DROP TRIGGER crank_usage_budget_update_notice;
CREATE TRIGGER crank_usage_budget_insert_notice AFTER INSERT ON crank_usage_budgets
BEGIN
 INSERT INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5)
 ON CONFLICT(scope,scope_id,month,threshold) DO NOTHING;
END;
CREATE TRIGGER crank_usage_budget_update_notice AFTER UPDATE ON crank_usage_budgets
BEGIN
 INSERT INTO crank_usage_notices(scope,scope_id,month,threshold,created_at)
 SELECT t.scope,t.scope_id,t.month,n.threshold,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM crank_usage_budget_totals t CROSS JOIN (SELECT 80 AS threshold UNION ALL SELECT 100) n
 WHERE (n.threshold=100 AND t.used_units>=t.limit_units)
 OR (n.threshold=80 AND t.used_units>=(t.limit_units/5)*4+((t.limit_units%5)*4+4)/5)
 ON CONFLICT(scope,scope_id,month,threshold) DO NOTHING;
END;
