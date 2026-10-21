ALTER TABLE crank_custom_versions ADD COLUMN consent_generation TEXT NOT NULL DEFAULT 'legacy:no-authority';
UPDATE crank_custom_versions SET status='needs_review',sandbox_json=NULL;
