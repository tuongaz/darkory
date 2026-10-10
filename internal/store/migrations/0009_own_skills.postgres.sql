-- The Skill kind company is own: a Skill is generic, what a Member arrives with, or own, ours,
-- belonging to a Project or to the whole Organisation and built on a generic one (decisions,
-- "Dogfood follow-ups"). The old CHECK refuses 'own', so it goes before the rename and its
-- successor, under the same name, comes after. The SQLite variant rebuilds skills; both make the
-- same schema.
ALTER TABLE skills DROP CONSTRAINT skills_kind_check;
UPDATE skills SET kind = 'own' WHERE kind = 'company';
ALTER TABLE skills ADD CONSTRAINT skills_kind_check CHECK (kind IN ('generic', 'own'));
