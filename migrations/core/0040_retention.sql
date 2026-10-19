-- DATA-003: owner-chosen retention. Expiry clears a finished run's values in place
-- and records when; the run, its step statuses, times and audit stay.
ALTER TABLE crank_wf_runs ADD COLUMN payload_expired_at TEXT;
ALTER TABLE crank_wf_runs ADD COLUMN files_expired_at TEXT;
ALTER TABLE crank_runs ADD COLUMN payload_expired_at TEXT;
CREATE INDEX crank_wf_runs_retention ON crank_wf_runs(finished_at) WHERE payload_expired_at IS NULL;

-- Legal holds keep every matching run (by exact identifier or whole workflow)
-- out of every expiry until the owner releases the hold.
CREATE TABLE crank_legal_holds (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('subject','workflow')),
 subject TEXT, subject_encoded TEXT, subject_digest TEXT, workflow_id TEXT,
 reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 released_by TEXT, released_at TEXT,
 CHECK((kind='subject' AND subject_digest IS NOT NULL AND workflow_id IS NULL) OR (kind='workflow' AND workflow_id IS NOT NULL AND subject IS NULL))
);

-- Historical snapshot payloads stay immutable, except that a run's own items may
-- be cleared to '{}' once that run's payload has expired.
DROP TRIGGER crank_historical_payload_immutable;
CREATE TRIGGER crank_historical_payload_immutable BEFORE UPDATE OF batch_id,source_id,ordinal,payload_json ON crank_historical_items
WHEN NOT (NEW.payload_json='{}' AND NEW.batch_id IS OLD.batch_id AND NEW.source_id IS OLD.source_id AND NEW.ordinal IS OLD.ordinal
 AND EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=OLD.run_id AND r.payload_expired_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'crank_historical_payload_immutable'); END;

-- DATA-003 sensitive data: a workflow's owner-chosen data class. Financial and
-- health workflows publish or resume only while the owner's attestation for that
-- class (named provider agreements and data location) is recorded.
ALTER TABLE crank_workflows ADD COLUMN data_class TEXT NOT NULL DEFAULT 'none' CHECK(data_class IN ('none','customer','financial','health'));
CREATE TABLE crank_data_attestations (
 data_class TEXT PRIMARY KEY CHECK(data_class IN ('financial','health')),
 agreements_json TEXT NOT NULL, data_location TEXT NOT NULL,
 attested_by TEXT NOT NULL, attested_at TEXT NOT NULL
);
