-- Additive local-development storage. Apply explicitly to the local D1 database.
CREATE TABLE IF NOT EXISTS rer_mail_development_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rer_mail_development_outbox_order
  ON rer_mail_development_outbox(created_at DESC, sequence DESC);
