-- Provider record identity can be matched case-insensitively without retaining it.
-- Existing observation keys hash the original spelling and cannot be backfilled.
CREATE TABLE crank_app_subjects (
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 record_subject_digest TEXT NOT NULL,
 PRIMARY KEY(workflow_id,record_id)
);
CREATE INDEX crank_app_subjects_digest ON crank_app_subjects(record_subject_digest);

CREATE TRIGGER crank_app_erased_subject_insert BEFORE INSERT ON crank_app_subjects
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER crank_app_erased_subject_update BEFORE UPDATE ON crank_app_subjects
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;

-- Fences survive a delayed poll commit and cannot be withdrawn or relabelled.
CREATE TRIGGER crank_app_erased_record_update BEFORE UPDATE ON crank_app_erased_records
BEGIN SELECT RAISE(ABORT,'crank_app_erased_record_immutable'); END;
CREATE TRIGGER crank_app_erased_record_delete BEFORE DELETE ON crank_app_erased_records
WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=OLD.workflow_id)
BEGIN SELECT RAISE(ABORT,'crank_app_erased_record_immutable'); END;
CREATE TRIGGER crank_app_erased_value_update BEFORE UPDATE ON crank_app_field_values
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER crank_app_erased_pending_update BEFORE UPDATE ON crank_app_pending_rows
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
