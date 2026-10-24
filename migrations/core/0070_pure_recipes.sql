ALTER TABLE crank_subflow_versions ADD COLUMN recipe_json TEXT;
CREATE TRIGGER crank_recipe_immutable BEFORE UPDATE OF recipe_json ON crank_subflow_versions
BEGIN SELECT RAISE(ABORT,'recipe_versions_are_immutable'); END;
