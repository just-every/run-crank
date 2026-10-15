CREATE TABLE IF NOT EXISTS oc_idp_grants (
 issuer TEXT NOT NULL, client_id TEXT NOT NULL, jti TEXT NOT NULL, subject TEXT NOT NULL, sector_id TEXT NOT NULL,
 PRIMARY KEY(issuer,client_id), UNIQUE(issuer,jti)
);
