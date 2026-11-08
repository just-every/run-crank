-- Value-free installation-local ownership; never restored as execution authority.
CREATE TABLE crank_custom_search_keys (
  name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
  holder TEXT NOT NULL
);
CREATE INDEX crank_custom_search_keys_run ON crank_custom_search_keys(run_id);
