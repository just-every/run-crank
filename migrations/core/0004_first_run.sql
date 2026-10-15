-- First-run confirmation belongs to this installation, not portable domain data.
-- Additive: preserve all existing owners, sessions and application rows.
CREATE TABLE oa_first_run (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  completed_by TEXT NOT NULL REFERENCES oa_operators(id),
  completed_at INTEGER NOT NULL
);
