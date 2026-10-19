-- Continuation is captured at pause/replacement, not inferred from old waits.
-- Bit 1 permits continuation while paused; bit 2 permits a retired version.
ALTER TABLE crank_wf_runs ADD COLUMN continuation_authority INTEGER NOT NULL DEFAULT 0;
