CREATE TABLE rer_portability_state (
  id INTEGER PRIMARY KEY CHECK(id=1), source_identity TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
  import_job TEXT, applying INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rer_portability_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, phase TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL
);
CREATE TABLE rer_portability_parts (
  job TEXT NOT NULL REFERENCES rer_portability_jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(job,idx)
);
CREATE TABLE rer_portability_segments (
  job TEXT NOT NULL REFERENCES rer_portability_jobs(id) ON DELETE CASCADE,
  part INTEGER NOT NULL, segment INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,part,segment)
);
CREATE TABLE rer_portability_owned (
  job TEXT NOT NULL REFERENCES rer_portability_jobs(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(job,bucket,key)
);
CREATE TABLE rer_portability_journal (
  source TEXT NOT NULL, tombstone TEXT NOT NULL, PRIMARY KEY(source,tombstone)
);
CREATE TABLE rer_portability_epochs (source TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
CREATE TABLE rer_portability_guard (value INTEGER NOT NULL CHECK(value=1));
