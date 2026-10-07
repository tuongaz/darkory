-- Model v2 (ADR 0015, ADR 0016, docs/build/model-v2-plan.md): Teams become Projects; Features
-- become Tasks and their Tasks Subtasks; a Project's Workflow of Steps and Connectors replaces the
-- Statuses; Labels arrive. The data moves in the same transaction, so an Install keeps every
-- record. The two engines' files take the same steps in the same order; they differ where SQLite
-- changes a table by rebuilding it, which Postgres does with ALTER TABLE. Ids made here are
-- shaped as UUIDv7: the time in milliseconds, then random hex.

-- 1. Projects from Teams; what a Team's ship_when_done said, a Project's auto_complete says.
ALTER TABLE teams RENAME TO projects;
ALTER TABLE projects RENAME COLUMN ship_when_done TO auto_complete;
-- What a Task filed in the Project takes when its filer does not say: an Acceptance before its
-- Parent counts as done.
ALTER TABLE projects ADD COLUMN acceptance BOOLEAN NOT NULL DEFAULT FALSE;
ALTER INDEX teams_org_key_prefix RENAME TO projects_org_key_prefix;
ALTER INDEX teams_org_name RENAME TO projects_org_name;

ALTER TABLE team_members RENAME TO project_members;
ALTER TABLE project_members RENAME COLUMN team_id TO project_id;
ALTER INDEX team_members_member RENAME TO project_members_member;

-- 2. A Project's Workflow: its Steps and the Connectors between them.
CREATE TABLE steps (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    -- Unique in its Project ignoring case, checked in Go; the index holds the exact spelling.
    name       TEXT NOT NULL,
    -- Who takes a Task at the Step. Null for a hold: no one is offered a Task there.
    skill_id   TEXT REFERENCES skills (id),
    -- Place in the Workflow, 1 first: the board's column order, and "the first Step".
    position   BIGINT NOT NULL,
    -- Where the canvas draws it, in whole pixels.
    x          BIGINT NOT NULL,
    y          BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX steps_project_name ON steps (project_id, name);

-- A named way out of a Step: the outcome its holder names when they advance the Task.
CREATE TABLE connectors (
    id           TEXT NOT NULL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    project_id   TEXT NOT NULL REFERENCES projects (id),
    from_step_id TEXT NOT NULL REFERENCES steps (id),
    -- Null: into Done, which completes the Task.
    to_step_id   TEXT REFERENCES steps (id),
    -- Unique among the Connectors out of one Step ignoring case, checked in Go.
    name         TEXT NOT NULL,
    -- Place among the Connectors out of its Step, 1 first.
    position     BIGINT NOT NULL,
    created_at   BIGINT NOT NULL
);
CREATE UNIQUE INDEX connectors_from_name ON connectors (from_step_id, name);
CREATE INDEX connectors_project ON connectors (project_id);

-- A named, coloured mark on Tasks: a Project's own, or the Organisation's (project_id null) for
-- every Project. Unique by name among the Project's, or among the Organisation's, ignoring case,
-- checked in Go: a unique index would treat every null project_id as different.
CREATE TABLE labels (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT REFERENCES projects (id),
    name       TEXT NOT NULL,
    -- #rrggbb
    color      TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX labels_org_project ON labels (org_id, project_id);

-- 3. acceptance, a fourth builtin generic Skill: the Step carrying it is where Darkory files a
-- Parent's Acceptance. A generic Skill already named so becomes the builtin.
INSERT INTO skills (id, org_id, name, kind, base_skill_id, builtin, current_version, created_by, created_at)
SELECT substr(lpad(to_hex(n.now), 12, '0'), 1, 8) || '-' || substr(lpad(to_hex(n.now), 12, '0'), 9, 4) || '-7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr('89ab', 1 + floor(random() * 4)::int, 1)
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    o.id, 'acceptance', 'generic', NULL, TRUE, 1, NULL, n.now
FROM organisations o
CROSS JOIN (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now) n
WHERE NOT EXISTS (SELECT 1 FROM skills s WHERE s.org_id = o.id AND s.name = 'acceptance');
UPDATE skills SET builtin = TRUE WHERE name = 'acceptance' AND kind = 'generic';
INSERT INTO skill_versions (org_id, skill_id, version, body, proposal_id, published_by, published_at)
SELECT s.org_id, s.id, 1, 'Confirm a Parent as a whole before it is called done. Read the Parent, its Subtasks, their Notes and Evidence, '
    || 'and check that together they do what the Parent asks. Advance this Task into Done when they do. When something is missing, '
    || 'file a Subtask under the Parent for each thing, then advance this Task; Darkory files a new Acceptance once they are done.',
    NULL, NULL, s.created_at
FROM skills s
WHERE s.name = 'acceptance' AND s.builtin = TRUE AND NOT EXISTS (SELECT 1 FROM skill_versions v WHERE v.skill_id = s.id);

-- 4. Each Project's Workflow, derived from the Skills its Tasks have needed (tasks.skill_id) or
-- been claimed under (claims.skill_id), a company Skill counting as the generic Skill it builds
-- on, so that every open Task has a Step to stand at. One Step per Skill, named as the default
-- Workflow names it (Plan, Build, Review, Retro, Skill review, Acceptance) or else after the
-- Skill with its first letter capitalised; breakdown first, then the others in the order of
-- their first use, then review, retro and skill-review; and a Backlog hold first when an open
-- Task sat in a backlog-kind Status. Left to right, 240 px apart.
WITH used (project_id, skill_id, at) AS (
    SELECT f.team_id, t.skill_id, t.waiting_since FROM tasks t JOIN features f ON f.id = t.feature_id
    WHERE t.skill_id IS NOT NULL
    UNION ALL
    SELECT f.team_id, c.skill_id, c.started_at FROM claims c JOIN tasks t ON t.id = c.task_id JOIN features f ON f.id = t.feature_id
    WHERE c.skill_id IS NOT NULL
),
needed (project_id, skill_id, first_at) AS (
    SELECT u.project_id, COALESCE(s.base_skill_id, s.id), MIN(u.at) FROM used u JOIN skills s ON s.id = u.skill_id
    GROUP BY u.project_id, COALESCE(s.base_skill_id, s.id)
),
wanted (project_id, skill_id, name, class, first_at) AS (
    SELECT DISTINCT f.team_id, CAST(NULL AS TEXT), 'Backlog', 0, CAST(0 AS BIGINT)
    FROM tasks t JOIN features f ON f.id = t.feature_id JOIN statuses st ON st.id = t.status_id
    WHERE t.state = 'open' AND st.kind = 'backlog'
    UNION ALL
    SELECT n.project_id, n.skill_id,
        CASE s.name WHEN 'breakdown' THEN 'Plan' WHEN 'engineer' THEN 'Build' WHEN 'review' THEN 'Review' WHEN 'retro' THEN 'Retro'
            WHEN 'skill-review' THEN 'Skill review' WHEN 'acceptance' THEN 'Acceptance'
            ELSE upper(substr(s.name, 1, 1)) || substr(s.name, 2) END,
        CASE s.name WHEN 'breakdown' THEN 1 WHEN 'review' THEN 3 WHEN 'retro' THEN 4 WHEN 'skill-review' THEN 5 ELSE 2 END,
        n.first_at
    FROM needed n JOIN skills s ON s.id = n.skill_id
),
placed AS (
    SELECT w.project_id, w.skill_id, w.name, ROW_NUMBER() OVER (PARTITION BY w.project_id ORDER BY w.class, w.first_at, w.name) AS position
    FROM wanted w
)
INSERT INTO steps (id, org_id, project_id, name, skill_id, position, x, y, created_at)
SELECT substr(lpad(to_hex(n.now), 12, '0'), 1, 8) || '-' || substr(lpad(to_hex(n.now), 12, '0'), 9, 4) || '-7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr('89ab', 1 + floor(random() * 4)::int, 1)
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    p.org_id, pl.project_id, pl.name, pl.skill_id, pl.position, 240 * (pl.position - 1), 0, n.now
FROM placed pl JOIN projects p ON p.id = pl.project_id
CROSS JOIN (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now) n;

-- The Connectors: each work Step to the next ("pass"), the last to Done ("pass"), each after the
-- first back to the first ("needs changes"); breakdown and retro to Done ("done"); retro to
-- skill-review ("propose") and skill-review to Done ("publish") and back to retro ("needs
-- changes") when both are there.
WITH s AS (
    SELECT st.id, st.org_id, st.project_id, st.position, sk.name AS skill FROM steps st JOIN skills sk ON sk.id = st.skill_id
),
w AS (
    SELECT s.id, s.org_id, s.project_id, ROW_NUMBER() OVER (PARTITION BY s.project_id ORDER BY s.position) AS n,
        COUNT(*) OVER (PARTITION BY s.project_id) AS total
    FROM s WHERE s.skill NOT IN ('breakdown', 'retro', 'skill-review', 'acceptance')
),
edges (org_id, project_id, from_id, to_id, name, position) AS (
    SELECT a.org_id, a.project_id, a.id, b.id, 'pass', 1 FROM w a JOIN w b ON b.project_id = a.project_id AND b.n = a.n + 1
    UNION ALL
    SELECT w.org_id, w.project_id, w.id, CAST(NULL AS TEXT), 'pass', 1 FROM w WHERE w.n = w.total
    UNION ALL
    SELECT a.org_id, a.project_id, a.id, b.id, 'needs changes', 2 FROM w a JOIN w b ON b.project_id = a.project_id AND b.n = 1 WHERE a.n > 1
    UNION ALL
    SELECT s.org_id, s.project_id, s.id, CAST(NULL AS TEXT), 'done', 1 FROM s WHERE s.skill IN ('breakdown', 'retro')
    UNION ALL
    SELECT a.org_id, a.project_id, a.id, b.id, 'propose', 2 FROM s a JOIN s b ON b.project_id = a.project_id AND b.skill = 'skill-review'
    WHERE a.skill = 'retro'
    UNION ALL
    SELECT s.org_id, s.project_id, s.id, CAST(NULL AS TEXT), 'publish', 1 FROM s WHERE s.skill = 'skill-review'
    UNION ALL
    SELECT a.org_id, a.project_id, a.id, b.id, 'needs changes', 2 FROM s a JOIN s b ON b.project_id = a.project_id AND b.skill = 'retro'
    WHERE a.skill = 'skill-review'
)
INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at)
SELECT substr(lpad(to_hex(n.now), 12, '0'), 1, 8) || '-' || substr(lpad(to_hex(n.now), 12, '0'), 9, 4) || '-7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr('89ab', 1 + floor(random() * 4)::int, 1)
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    e.org_id, e.project_id, e.from_id, e.to_id, e.name, e.position, n.now
FROM edges e
CROSS JOIN (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now) n;

-- 5. Tasks absorb Features. A Task has a Project; a Subtask has a Parent, whose Owner it shares;
-- a Task with no Parent has a Rank; a Task that is not a Parent, not aimed and not ended is at a
-- Step. kind gains acceptance; skill_id goes, since a Task's Skill is its Step's.
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects (id);
-- Null for a Task with no Parent. One level: a Parent has none.
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks (id);
-- Null on a Parent, on a Task aimed at a Member, and on an ended Task.
ALTER TABLE tasks ADD COLUMN step_id TEXT REFERENCES steps (id);
-- When it reached its Step, so the time at each Step is exact.
ALTER TABLE tasks ADD COLUMN step_since BIGINT;
-- A Subtask's is its Parent's, kept in step by the write that passes ownership.
ALTER TABLE tasks ADD COLUMN owner_id TEXT REFERENCES members (id);
-- Position in the Project's Rank, 1 first, on a Task with no Parent; null on a Subtask, which
-- sorts by its Parent's. Ended Tasks keep theirs.
ALTER TABLE tasks ADD COLUMN rank BIGINT;
-- Filed with Break down on.
ALTER TABLE tasks ADD COLUMN breakdown BOOLEAN NOT NULL DEFAULT FALSE;
-- A Parent's: it completes itself when its last Subtask ends done.
ALTER TABLE tasks ADD COLUMN auto_complete BOOLEAN NOT NULL DEFAULT FALSE;
-- A Parent's: an Acceptance confirms it before it counts as done.
ALTER TABLE tasks ADD COLUMN acceptance BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN from_retrospective_task_id TEXT REFERENCES tasks (id);
-- Null for the Subtasks Darkory files itself: Breakdown, Acceptance, Retrospective.
ALTER TABLE tasks ALTER COLUMN filed_by DROP NOT NULL;

-- Every Feature that was not quick becomes a Task with no Parent: same id, key, title,
-- description, Owner, filer and times; shipped is done; Break down on when it had a Break down;
-- auto_complete from ship_when_done. (feature_id names itself until the column goes.)
INSERT INTO tasks (id, org_id, feature_id, project_id, parent_id, display_key, kind, title, description, state, step_id, step_since,
    aimed_at_id, owner_id, rank, breakdown, auto_complete, acceptance, from_retrospective_task_id, filed_by, waiting_since,
    created_at, ended_at)
SELECT f.id, f.org_id, f.id, f.team_id, NULL, f.display_key, 'work', f.title, f.description,
    CASE f.state WHEN 'shipped' THEN 'done' ELSE f.state END, NULL, NULL, NULL, f.owner_id, NULL,
    EXISTS (SELECT 1 FROM tasks b WHERE b.feature_id = f.id AND b.kind = 'breakdown'), f.ship_when_done, FALSE,
    f.from_retrospective_task_id, f.filed_by, f.created_at, f.created_at, f.ended_at
FROM features f WHERE f.quick = FALSE;

-- A Feature's Tasks become its Subtasks, with its Owner. A quick Feature goes: its Tasks stand
-- alone, taking its Owner and auto_complete, and its key is retired (last_number stands). An open
-- Task stands at the Step of the Skill it needed, or at Backlog when it sat in a backlog-kind
-- Status; one aimed at a Member, or ended, at none.
UPDATE tasks t SET project_id = f.team_id, parent_id = CASE WHEN f.quick THEN NULL ELSE f.id END, owner_id = f.owner_id,
    auto_complete = CASE WHEN f.quick THEN f.ship_when_done ELSE FALSE END,
    step_id = CASE
        WHEN t.state <> 'open' OR t.aimed_at_id IS NOT NULL THEN NULL
        WHEN EXISTS (SELECT 1 FROM statuses bs WHERE bs.id = t.status_id AND bs.kind = 'backlog')
            THEN (SELECT bst.id FROM steps bst WHERE bst.project_id = f.team_id AND bst.skill_id IS NULL)
        ELSE (SELECT sst.id FROM steps sst JOIN skills ssk ON ssk.id = t.skill_id
            WHERE sst.project_id = f.team_id AND sst.skill_id = COALESCE(ssk.base_skill_id, ssk.id))
    END
FROM features f WHERE f.id = t.feature_id AND t.id <> f.id;
UPDATE tasks SET step_since = waiting_since WHERE step_id IS NOT NULL;

-- The Rank: the Tasks with no Parent in their Features' order, a quick Feature's Tasks at its
-- place in the order they were filed. Where every Feature gave one such Task, each keeps its
-- Feature's rank.
UPDATE tasks SET rank = r.n
FROM (
    SELECT x.id, ROW_NUMBER() OVER (PARTITION BY x.project_id ORDER BY x.feature_rank, x.created_at, x.id) AS n
    FROM (
        SELECT f.id, f.team_id AS project_id, f.rank AS feature_rank, f.created_at FROM features f WHERE f.quick = FALSE
        UNION ALL
        SELECT t.id, f.team_id, f.rank, t.created_at FROM tasks t JOIN features f ON f.id = t.feature_id
        WHERE f.quick = TRUE AND t.id <> f.id
    ) x
) r
WHERE r.id = tasks.id;

-- A Parent names the Workspaces its Subtasks name, in the order they were first named.
INSERT INTO task_workspaces (org_id, task_id, workspace_id, position)
SELECT w.org_id, w.parent_id, w.workspace_id,
    ROW_NUMBER() OVER (PARTITION BY w.parent_id ORDER BY w.first_at, w.first_position, w.workspace_id)
FROM (
    SELECT tw.org_id, t.feature_id AS parent_id, tw.workspace_id, MIN(t.created_at) AS first_at, MIN(tw.position) AS first_position
    FROM task_workspaces tw JOIN tasks t ON t.id = tw.task_id JOIN features f ON f.id = t.feature_id
    WHERE f.quick = FALSE AND t.id <> f.id
    GROUP BY tw.org_id, t.feature_id, tw.workspace_id
) w;

-- 6. Evidence hangs on a Task only: Evidence on a Feature itself moves to the Task it became, or,
-- for a quick Feature, to its one Task.
UPDATE evidence e SET task_id = CASE WHEN f.quick
        THEN (SELECT q.id FROM tasks q WHERE q.feature_id = f.id ORDER BY q.created_at, q.id LIMIT 1)
        ELSE f.id END
FROM features f WHERE f.id = e.feature_id AND e.task_id IS NULL;
ALTER TABLE evidence DROP COLUMN feature_id;
ALTER TABLE evidence ALTER COLUMN task_id SET NOT NULL;
DROP INDEX evidence_task;
CREATE INDEX evidence_task ON evidence (task_id);

-- Observations hang on their Task, which they always named; the Retrospective of its Parent
-- reads them.
ALTER TABLE observations DROP COLUMN feature_id;

ALTER TABLE tasks ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE tasks DROP COLUMN feature_id;
ALTER TABLE tasks DROP COLUMN status_id;
ALTER TABLE tasks DROP COLUMN skill_id;
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('work', 'breakdown', 'acceptance', 'retrospective'));
CREATE INDEX tasks_parent ON tasks (parent_id, state);
CREATE INDEX tasks_project_rank ON tasks (project_id, rank);
CREATE INDEX tasks_owner ON tasks (owner_id);
-- The takeable query: open Tasks at a Step (open Tasks aimed at a Member have their own index).
CREATE INDEX tasks_open_step ON tasks (org_id, step_id) WHERE state = 'open';

-- A Claim also ends advanced (along a Connector: what a Handover was, and is recorded as now) or
-- split (its holder filed a Subtask under the Task).
ALTER TABLE claims DROP CONSTRAINT claims_how_ended_check;
UPDATE claims SET how_ended = 'advanced' WHERE how_ended = 'handed_over';
ALTER TABLE claims ADD CONSTRAINT claims_how_ended_check
    CHECK (how_ended IN ('released', 'advanced', 'completed', 'split', 'lapsed', 'taken_back', 'dropped', 'token_revoked',
        'session_closed', 'member_deactivated'));

-- Views are of the Tasks list only, of one Project or across them. Views of the Features list go;
-- a View's status: and status_kind: tokens go, since no Step has a Status's id or kind, and its
-- team: and feature: tokens become project: and parent:, which take the same ids.
DELETE FROM views WHERE entity = 'features';
ALTER TABLE views RENAME COLUMN team_id TO project_id;
ALTER TABLE views DROP CONSTRAINT views_entity_check;
ALTER TABLE views ADD CONSTRAINT views_entity_check CHECK (entity IN ('tasks'));
UPDATE views SET filters = COALESCE((
    SELECT json_agg(CASE
            WHEN substr(j.value, 1, 5) = 'team:' THEN 'project:' || substr(j.value, 6)
            WHEN substr(j.value, 1, 8) = 'feature:' THEN 'parent:' || substr(j.value, 9)
            ELSE j.value END ORDER BY j.ord)::text
    FROM json_array_elements_text(views.filters::json) WITH ORDINALITY AS j(value, ord)
    WHERE substr(j.value, 1, 7) <> 'status:' AND substr(j.value, 1, 12) <> 'status_kind:'), '[]');

DROP TABLE features;
DROP TABLE statuses;

-- 7. The Labels a Task carries. Filters and Views read them; Darkory's rules never do.
CREATE TABLE task_labels (
    org_id   TEXT NOT NULL REFERENCES organisations (id),
    task_id  TEXT NOT NULL REFERENCES tasks (id),
    label_id TEXT NOT NULL REFERENCES labels (id),
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label ON task_labels (label_id);
