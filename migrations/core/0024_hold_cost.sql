-- Explicit owner estimates cover the current held snapshot, never an inferred zero.
CREATE TABLE crank_hold_cost_estimates (
 hold_id TEXT PRIMARY KEY REFERENCES crank_holds(id) ON DELETE CASCADE,
 workflow_id TEXT NOT NULL, version_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, cost_json TEXT NOT NULL,
 quoted_by TEXT NOT NULL, quoted_at TEXT NOT NULL
);
