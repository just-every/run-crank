-- import-kit d1CustodyStateReplaceSchema, after 0018 (d1CustodyStateSchema and
-- d1RetirementSchema). SQLite's REPLACE deletes the row it conflicts with without
-- firing DELETE triggers: an insert over a custody counter (by job id or rowid) is
-- ignored, a counter's rowid never changes, a job id that exists or was retired is
-- refused, and an insert or update (UPDATE OR REPLACE) that would replace a claim,
-- provenance, history, stream page or stream row by a named key, or any custody or
-- tombstone row by its rowid, advances its owners' revisions.
CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_insert BEFORE INSERT ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_custody_states WHERE job_id=NEW.job_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_rowid BEFORE UPDATE ON ik_d1_custody_states WHEN NEW.rowid IS NOT OLD.rowid BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_job_reuse BEFORE INSERT ON ik_jobs WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=NEW.id AND kind='job') BEGIN SELECT RAISE(ABORT,'IMPORT_JOB_ID_REUSED'); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_sources_replace BEFORE INSERT ON ik_sources BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_sources WHERE identity=NEW.identity UNION ALL SELECT job_id FROM ik_sources WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_provenance_replace BEFORE INSERT ON ik_provenance BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_provenance WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_provenance WHERE rowid=NEW.rowid UNION ALL SELECT job_id FROM ik_provenance WHERE NEW.reversed=0 AND reversed=0 AND destination=NEW.destination AND target_kind=NEW.target_kind AND target_id=NEW.target_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_history_replace BEFORE INSERT ON ik_d1_history BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_history WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_d1_history WHERE rowid=NEW.rowid UNION ALL SELECT job_id FROM ik_d1_history WHERE successor_id=NEW.successor_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_stream_pages_replace BEFORE INSERT ON ik_d1_stream_pages BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.stream_id AND ordinal=NEW.ordinal UNION ALL SELECT job_id FROM ik_d1_stream_pages WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_streams_replace BEFORE INSERT ON ik_d1_streams BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.id OR stream_id IN (SELECT id FROM ik_d1_streams WHERE rowid=NEW.rowid) UNION ALL SELECT p.job_id FROM ik_d1_streams s JOIN ik_d1_stream_pages p ON p.stream_id=s.id WHERE s.destination=NEW.destination AND s.principal_id=NEW.principal_id AND s.operation_key=NEW.operation_key); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_jobs_replace BEFORE INSERT ON ik_jobs BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT id FROM ik_jobs WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_plan_chunks_replace BEFORE INSERT ON ik_d1_plan_chunks BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_plan_chunks WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_creation_plans_replace BEFORE INSERT ON ik_d1_creation_plans BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_creation_plans WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_plan_index_replace BEFORE INSERT ON ik_d1_plan_index BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_plan_index WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_originals_replace BEFORE INSERT ON ik_originals BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_originals WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_original_chunks_replace BEFORE INSERT ON ik_d1_original_chunks BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_original_chunks WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_original_sets_replace BEFORE INSERT ON ik_original_sets BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_original_sets WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_indexed_jobs_replace BEFORE INSERT ON ik_d1_indexed_jobs BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_indexed_jobs WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_reversal_reports_replace BEFORE INSERT ON ik_d1_reversal_reports BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_reversal_reports WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_entries_replace BEFORE INSERT ON ik_d1_entries BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_entries WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_batches_replace BEFORE INSERT ON ik_batches BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_batches WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_erased_sources_replace BEFORE INSERT ON ik_d1_erased_sources BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_erased_sources e JOIN ik_jobs j ON j.destination=e.destination JOIN ik_d1_plan_index i ON i.job_id=j.id AND i.source_identity=e.identity WHERE e.rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_erased_targets_replace BEFORE INSERT ON ik_d1_erased_targets BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_erased_targets e JOIN ik_jobs j ON j.destination=e.destination JOIN ik_d1_plan_index i ON i.job_id=j.id AND i.target_identity=e.identity WHERE e.rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_sources_update_replace BEFORE UPDATE ON ik_sources BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_sources WHERE identity=NEW.identity UNION ALL SELECT job_id FROM ik_sources WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_provenance_update_replace BEFORE UPDATE ON ik_provenance BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_provenance WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_provenance WHERE rowid=NEW.rowid UNION ALL SELECT job_id FROM ik_provenance WHERE NEW.reversed=0 AND reversed=0 AND destination=NEW.destination AND target_kind=NEW.target_kind AND target_id=NEW.target_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_history_update_replace BEFORE UPDATE ON ik_d1_history BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_history WHERE id=NEW.id UNION ALL SELECT job_id FROM ik_d1_history WHERE rowid=NEW.rowid UNION ALL SELECT job_id FROM ik_d1_history WHERE successor_id=NEW.successor_id); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_stream_pages_update_replace BEFORE UPDATE ON ik_d1_stream_pages BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.stream_id AND ordinal=NEW.ordinal UNION ALL SELECT job_id FROM ik_d1_stream_pages WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_streams_update_replace BEFORE UPDATE ON ik_d1_streams BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.id OR stream_id IN (SELECT id FROM ik_d1_streams WHERE rowid=NEW.rowid) UNION ALL SELECT p.job_id FROM ik_d1_streams s JOIN ik_d1_stream_pages p ON p.stream_id=s.id WHERE s.destination=NEW.destination AND s.principal_id=NEW.principal_id AND s.operation_key=NEW.operation_key); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_jobs_update_replace BEFORE UPDATE ON ik_jobs BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT id FROM ik_jobs WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_plan_chunks_update_replace BEFORE UPDATE ON ik_d1_plan_chunks BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_plan_chunks WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_creation_plans_update_replace BEFORE UPDATE ON ik_d1_creation_plans BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_creation_plans WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_plan_index_update_replace BEFORE UPDATE ON ik_d1_plan_index BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_plan_index WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_originals_update_replace BEFORE UPDATE ON ik_originals BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_originals WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_original_chunks_update_replace BEFORE UPDATE ON ik_d1_original_chunks BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_original_chunks WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_original_sets_update_replace BEFORE UPDATE ON ik_original_sets BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_original_sets WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_indexed_jobs_update_replace BEFORE UPDATE ON ik_d1_indexed_jobs BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_indexed_jobs WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_reversal_reports_update_replace BEFORE UPDATE ON ik_d1_reversal_reports BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_reversal_reports WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_entries_update_replace BEFORE UPDATE ON ik_d1_entries BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_entries WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_batches_update_replace BEFORE UPDATE ON ik_batches BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_batches WHERE rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_erased_sources_update_replace BEFORE UPDATE ON ik_d1_erased_sources BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_erased_sources e JOIN ik_jobs j ON j.destination=e.destination JOIN ik_d1_plan_index i ON i.job_id=j.id AND i.source_identity=e.identity WHERE e.rowid=NEW.rowid); END;

CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_ik_d1_erased_targets_update_replace BEFORE UPDATE ON ik_d1_erased_targets BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_erased_targets e JOIN ik_jobs j ON j.destination=e.destination JOIN ik_d1_plan_index i ON i.job_id=j.id AND i.target_identity=e.identity WHERE e.rowid=NEW.rowid); END;
