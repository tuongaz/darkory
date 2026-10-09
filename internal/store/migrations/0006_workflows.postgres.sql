-- A Project's Steps are grouped into named Workflows (ADR 0019). Every Project's Steps become one
-- Workflow named Work. An ended Task keeps the Step it ended at, so it lands on the board of the
-- Workflow it ended in. The SQLite variant rebuilds steps to add workflow_id NOT NULL; both make
-- the same schema.
--
-- A Workflow's id is a UUIDv7 (invariant 3) whose time is its Project's created_at.

-- A named part of a Project's Workflow: a board and a canvas of its own.
CREATE TABLE workflows (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    -- Unique in its Project ignoring case, checked in Go; the index holds the exact spelling.
    name       TEXT NOT NULL,
    -- Place among the Project's Workflows, 1 first. The Project's Steps are ordered by their
    -- Workflow's position, then their own: "the first Step" reads that order.
    position   BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX workflows_project_name ON workflows (project_id, name);

INSERT INTO workflows (id, org_id, project_id, name, position, created_at)
SELECT substr(ts, 1, 8) || '-' || substr(ts, 9, 4) || '-7' || substr(u, 16), org_id, id, 'Work', 1, created_at
FROM (SELECT org_id, id, created_at, lpad(to_hex(created_at), 12, '0') AS ts, gen_random_uuid()::text AS u FROM projects) p;

-- The Workflow the Step is in, of the Step's own Project.
ALTER TABLE steps ADD COLUMN workflow_id TEXT REFERENCES workflows (id);
UPDATE steps SET workflow_id = w.id FROM workflows w WHERE w.project_id = steps.project_id;
ALTER TABLE steps ALTER COLUMN workflow_id SET NOT NULL;
CREATE INDEX steps_workflow ON steps (workflow_id);

-- An ended Task's: the Step it ended at. Null on an open Task, on a Task ended from no Step, and
-- once that Step is gone.
ALTER TABLE tasks ADD COLUMN last_step_id TEXT REFERENCES steps (id) ON DELETE SET NULL;
UPDATE tasks SET last_step_id = e.from_step
FROM (SELECT DISTINCT ON (a.subject_id) a.subject_id, a.payload::jsonb ->> 'from' AS from_step
      FROM activity a WHERE a.kind IN ('task.completed', 'task.dropped')
      ORDER BY a.subject_id, a.seq DESC) e
WHERE tasks.id = e.subject_id AND tasks.state <> 'open'
  AND EXISTS (SELECT 1 FROM steps s WHERE s.id = e.from_step);

-- The FK's SET NULL and `moves` look Tasks up by the Step they ended at.
CREATE INDEX tasks_last_step ON tasks (last_step_id) WHERE last_step_id IS NOT NULL;
