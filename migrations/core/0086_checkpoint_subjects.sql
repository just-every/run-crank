-- Earlier maintenance sealed checkpoint chunks independently of their subject
-- index. Rebuild the index for retained sealed runs, including already-sealed
-- pages, before subject erasure can report a complete preview.
UPDATE crank_wf_runs SET payload_index=NULL
WHERE payload_key IS NOT NULL
  AND EXISTS(SELECT 1 FROM crank_request_checkpoint_chunks p WHERE p.run_id=crank_wf_runs.id);
