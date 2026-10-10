-- The Skill kind company is own: a Skill is generic, what a Member arrives with, or own, ours,
-- belonging to a Project or to the whole Organisation and built on a generic one (decisions,
-- "Dogfood follow-ups"). SQLite cannot change a CHECK in place, so skills is rebuilt (new table,
-- copy, drop, rename; the runner checks foreign keys before commit) and the old CHECK refuses
-- 'own' until then, so the kind is renamed in the copy; both variants make the same schema.

CREATE TABLE skills_new (
    id              TEXT NOT NULL PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organisations (id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('generic', 'own')),
    base_skill_id   TEXT REFERENCES skills (id),
    -- breakdown, acceptance, retro and skill-review: Darkory relies on them, so they cannot be
    -- removed.
    builtin         BOOLEAN NOT NULL DEFAULT FALSE,
    current_version BIGINT NOT NULL,
    created_by      TEXT REFERENCES members (id),
    created_at      BIGINT NOT NULL,
    -- The Project an own Skill belongs to; null for a generic Skill and for an own Skill of the
    -- whole Organisation (ADR 0020).
    project_id      TEXT REFERENCES projects (id)
);
INSERT INTO skills_new (id, org_id, name, kind, base_skill_id, builtin, current_version, created_by, created_at, project_id)
SELECT id, org_id, name, CASE kind WHEN 'company' THEN 'own' ELSE kind END, base_skill_id, builtin, current_version,
       created_by, created_at, project_id
FROM skills;
DROP TABLE skills;
ALTER TABLE skills_new RENAME TO skills;
CREATE UNIQUE INDEX skills_org_name ON skills (org_id, name);
