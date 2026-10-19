-- EXEC-004 / DATA-002: deleting a repair must never reauthorize its old source
-- item. Claims live with the source and disappear only when that source is erased.
ALTER TABLE crank_wf_runs ADD COLUMN repaired_paths_json TEXT NOT NULL DEFAULT '[]';
UPDATE crank_wf_runs SET repaired_paths_json=(
 SELECT json_group_array(path) FROM (
  SELECT DISTINCT chosen.value AS path FROM crank_wf_runs repair,json_each(repair.repair_paths_json) chosen
  WHERE repair.repair_of=crank_wf_runs.id
 )
) WHERE EXISTS(SELECT 1 FROM crank_wf_runs repair WHERE repair.repair_of=crank_wf_runs.id);
