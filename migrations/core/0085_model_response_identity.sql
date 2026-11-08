-- A bounded provider response identifier survives interruption of the later
-- step-result transaction. Model text and credentials never enter this field.
ALTER TABLE crank_wf_attempts ADD COLUMN response_identity TEXT;
