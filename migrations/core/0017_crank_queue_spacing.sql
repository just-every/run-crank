-- A shared named queue has one spacing policy. Changing it while runs arrive
-- would change the promises made by other workflows already using that queue.
CREATE TRIGGER crank_queue_spacing_immutable
BEFORE UPDATE OF spacing_seconds ON crank_delay_queues
WHEN NEW.spacing_seconds != OLD.spacing_seconds
BEGIN
 SELECT RAISE(ABORT, 'queue_spacing_conflict');
END;
