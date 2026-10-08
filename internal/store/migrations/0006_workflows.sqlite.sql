-- A Project's Steps are grouped into named Workflows (ADR 0019). Every Project's Steps become one
-- Workflow named Work. An ended Task keeps the Step it ended at, so it lands on the board of the
-- Workflow it ended in. SQLite cannot add a NOT NULL column without a default, so steps is rebuilt
-- (new table, copy, drop, rename; the runner checks foreign keys before commit); both variants make
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
SELECT substr(ts, 1, 8) || '-' || substr(ts, 9, 4) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-'
       || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       org_id, id, 'Work', 1, created_at
FROM (SELECT org_id, id, created_at, printf('%012x', created_at) AS ts FROM projects);

-- A place in a Project's Workflow. A Task at it is taken by a Member with its Skill.
CREATE TABLE steps_new (
    id          TEXT NOT NULL PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organisations (id),
    project_id  TEXT NOT NULL REFERENCES projects (id),
    -- The Workflow the Step is in, of the Step's own Project.
    workflow_id TEXT NOT NULL REFERENCES workflows (id),
    -- Unique in its Project ignoring case, checked in Go; the index holds the exact spelling.
    name        TEXT NOT NULL,
    -- Null for a hold: no one is offered a Task there, and a human moves it on.
    skill_id    TEXT REFERENCES skills (id),
    -- Place in its Workflow, 1 first: the board's column order.
    position    BIGINT NOT NULL,
    -- Where the canvas draws it, in whole pixels.
    x           BIGINT NOT NULL,
    y           BIGINT NOT NULL,
    created_at  BIGINT NOT NULL
);
INSERT INTO steps_new (id, org_id, project_id, workflow_id, name, skill_id, position, x, y, created_at)
SELECT st.id, st.org_id, st.project_id, w.id, st.name, st.skill_id, st.position, st.x, st.y, st.created_at
FROM steps st JOIN workflows w ON w.project_id = st.project_id;
DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE UNIQUE INDEX steps_project_name ON steps (project_id, name);
CREATE INDEX steps_workflow ON steps (workflow_id);

-- An ended Task's: the Step it ended at. Null on an open Task, on a Task ended from no Step, and
-- once that Step is gone.
ALTER TABLE tasks ADD COLUMN last_step_id TEXT REFERENCES steps (id) ON DELETE SET NULL;
UPDATE tasks SET last_step_id = (
    SELECT json_extract(a.payload, '$.from') FROM activity a
    WHERE a.subject_id = tasks.id AND a.kind IN ('task.completed', 'task.dropped')
    ORDER BY a.seq DESC LIMIT 1)
WHERE state <> 'open';
UPDATE tasks SET last_step_id = NULL
WHERE last_step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.id = tasks.last_step_id);
