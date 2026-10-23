CREATE TABLE IF NOT EXISTS ik_door_archives (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, namespace TEXT NOT NULL,
    upload_id TEXT NOT NULL, tool TEXT NOT NULL, taken_at TEXT NOT NULL, name TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL, total_bytes INTEGER NOT NULL, total_chunks INTEGER NOT NULL,
    counts_json TEXT NOT NULL, UNIQUE(installation_id,namespace,upload_id));
CREATE TABLE IF NOT EXISTS ik_door_archive_chunks (
    archive_id TEXT NOT NULL REFERENCES ik_door_archives(id), ordinal INTEGER NOT NULL,
    sha256 TEXT NOT NULL, size INTEGER NOT NULL, base64 TEXT NOT NULL,
    PRIMARY KEY(archive_id,ordinal));
