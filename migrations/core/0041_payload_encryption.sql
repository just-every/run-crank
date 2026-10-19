-- DATA-003 scoped encryption: customer, financial and health payload values are sealed by
-- Crank under a per-installation, per-data-class key. The key material is itself
-- sealed under the installation secret (like connection credentials) and never
-- travels in an archive; destroyed keys keep their row without material.
CREATE TABLE crank_payload_keys (
 id TEXT PRIMARY KEY,
 data_class TEXT NOT NULL CHECK(data_class IN ('customer','financial','health')),
 status TEXT NOT NULL CHECK(status IN ('active','retiring','destroyed')),
 origin TEXT NOT NULL CHECK(origin IN ('created','imported')),
 sealed_iv TEXT, sealed_key TEXT,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 retired_at TEXT, destroyed_at TEXT,
 CHECK((status='destroyed' AND sealed_key IS NULL) OR (status!='destroyed' AND sealed_iv IS NOT NULL AND sealed_key IS NOT NULL))
);
CREATE UNIQUE INDEX crank_payload_keys_active ON crank_payload_keys(data_class) WHERE status='active';

-- The key a run's values were last sealed under by the re-seal pass or its first
-- write (NULL: plaintext or not yet migrated), and the identifier fields its blind
-- index was built from.
ALTER TABLE crank_wf_runs ADD COLUMN payload_key TEXT;
ALTER TABLE crank_wf_runs ADD COLUMN payload_index TEXT;
ALTER TABLE crank_wf_runs ADD COLUMN payload_failed_at TEXT;
-- A sealed (customer, financial or health) workflow's declared identifier fields (property names,
-- lower case, sorted). Their values are matched through the blind index.
ALTER TABLE crank_workflows ADD COLUMN identifier_fields_json TEXT NOT NULL DEFAULT '[]';

-- Keyed HMAC-SHA-256 digests of a sealed run's declared identifier values, per key.
CREATE TABLE crank_blind_index (
 run_id TEXT NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(run_id,key_id,digest)
);
CREATE INDEX crank_blind_index_digest ON crank_blind_index(key_id,digest);
-- The same digests of each open subject hold's identifier, so holds keep sealed runs.
CREATE TABLE crank_hold_digests (
 hold_id TEXT NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(hold_id,key_id)
);

-- Historical snapshot payloads stay immutable except for clearing after payload
-- expiry and re-sealing the same value under a data-class key (seal, rotate, unseal).
DROP TRIGGER crank_historical_payload_immutable;
CREATE TRIGGER crank_historical_payload_immutable BEFORE UPDATE OF batch_id,source_id,ordinal,payload_json ON crank_historical_items
WHEN NOT (NEW.batch_id IS OLD.batch_id AND NEW.source_id IS OLD.source_id AND NEW.ordinal IS OLD.ordinal AND (
 (NEW.payload_json='{}' AND EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=OLD.run_id AND r.payload_expired_at IS NOT NULL))
 OR substr(OLD.payload_json,1,28)='{"sealed":"crank-payload-v1"' OR substr(NEW.payload_json,1,28)='{"sealed":"crank-payload-v1"'))
BEGIN SELECT RAISE(ABORT,'crank_historical_payload_immutable'); END;
