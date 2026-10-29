ALTER TABLE bs_settings ADD COLUMN owner_id TEXT CHECK(owner_id IS NULL OR owner_id <> '');
ALTER TABLE bs_team ADD COLUMN business_id TEXT CHECK(business_id IS NULL OR business_id <> '');
ALTER TABLE bs_team ADD COLUMN business_role TEXT CHECK(business_role IS NULL OR business_role IN('admin','member'));
CREATE UNIQUE INDEX bs_team_business_id ON bs_team(business_id) WHERE business_id IS NOT NULL;
