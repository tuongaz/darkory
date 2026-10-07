-- Model v2 (ADR 0015, ADR 0016, docs/build/model-v2-plan.md): Teams become Projects; Features
-- become Tasks and their Tasks Subtasks; a Project's Workflow of Steps and Connectors replaces the
-- Statuses; Labels arrive. The data moves in the same transaction, so an Install keeps every
-- record. The two engines' files take the same steps in the same order; they differ where SQLite
-- changes a table by rebuilding it. SQLite drops a column only when nothing refers to it, so
-- tasks, evidence, observations, claims and views are rebuilt (new table, copy, drop, rename,
-- indexes again); the migration runner turns foreign keys off around a migration and checks them
-- all before it commits. Ids made here are shaped as UUIDv7: the time in milliseconds, then
-- random hex.

-- 1. Projects from Teams; what a Team's ship_when_done said, a Project's auto_complete says.
-- Renaming a table carries the rename into every foreign key that names it.
ALTER TABLE teams RENAME TO projects;
ALTER TABLE projects RENAME COLUMN ship_when_done TO auto_complete;
-- What a Task filed in the Project takes when its filer does not say: an Acceptance before its
-- Parent counts as done.
ALTER TABLE projects ADD COLUMN acceptance BOOLEAN NOT NULL DEFAULT FALSE;
DROP INDEX teams_org_key_prefix;
DROP INDEX teams_org_name;
CREATE UNIQUE INDEX projects_org_key_prefix ON projects (org_id, key_prefix);
CREATE UNIQUE INDEX projects_org_name ON projects (org_id, name);

ALTER TABLE team_members RENAME TO project_members;
ALTER TABLE project_members RENAME COLUMN team_id TO project_id;
DROP INDEX team_members_member;
CREATE INDEX project_members_member ON project_members (member_id, project_id);

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
SELECT substr(printf('%012x', n.now), 1, 8) || '-' || substr(printf('%012x', n.now), 9, 4) || '-7'
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1)
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || lower(hex(randomblob(6))),
    o.id, 'acceptance', 'generic', NULL, TRUE, 1, NULL, n.now
FROM organisations o
CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now) n
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
    SELECT DISTINCT f.team_id, CAST(NULL AS TEXT), 'Backlog', 0, 0
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
SELECT substr(printf('%012x', n.now), 1, 8) || '-' || substr(printf('%012x', n.now), 9, 4) || '-7'
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1)
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || lower(hex(randomblob(6))),
    p.org_id, pl.project_id, pl.name, pl.skill_id, pl.position, 240 * (pl.position - 1), 0, n.now
FROM placed pl JOIN projects p ON p.id = pl.project_id
CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now) n;

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
SELECT substr(printf('%012x', n.now), 1, 8) || '-' || substr(printf('%012x', n.now), 9, 4) || '-7'
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1)
    || substr(lower(hex(randomblob(2))), 1, 3) || '-' || lower(hex(randomblob(6))),
    e.org_id, e.project_id, e.from_id, e.to_id, e.name, e.position, n.now
FROM edges e
CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now) n;

-- 5. Tasks absorb Features. A Task has a Project; a Subtask has a Parent, whose Owner it shares;
-- a Task with no Parent has a Rank; a Task that is not a Parent, not aimed and not ended is at a
-- Step. kind gains acceptance; skill_id goes, since a Task's Skill is its Step's.
CREATE TABLE tasks_new (
    id                         TEXT NOT NULL PRIMARY KEY,
    org_id                     TEXT NOT NULL REFERENCES organisations (id),
    project_id                 TEXT NOT NULL REFERENCES projects (id),
    -- Null for a Task with no Parent. One level: a Parent has none.
    parent_id                  TEXT REFERENCES tasks (id),
    display_key                TEXT NOT NULL,
    kind                       TEXT NOT NULL CHECK (kind IN ('work', 'breakdown', 'acceptance', 'retrospective')),
    title                      TEXT NOT NULL,
    description                TEXT NOT NULL DEFAULT '',
    -- Only open, done or dropped. Claimed and lapsed follow from the claim_ columns (ADR 0004).
    state                      TEXT NOT NULL CHECK (state IN ('open', 'done', 'dropped')),
    -- Null on a Parent, on a Task aimed at a Member, and on an ended Task.
    step_id                    TEXT REFERENCES steps (id),
    -- When it reached its Step, so the time at each Step is exact.
    step_since                 BIGINT,
    aimed_at_id                TEXT REFERENCES members (id),
    -- A Subtask's is its Parent's, kept in step by the write that passes ownership.
    owner_id                   TEXT NOT NULL REFERENCES members (id),
    -- Position in the Project's Rank, 1 first, on a Task with no Parent; null on a Subtask, which
    -- sorts by its Parent's. Ended Tasks keep theirs.
    rank                       BIGINT,
    -- Filed with Break down on.
    breakdown                  BOOLEAN NOT NULL DEFAULT FALSE,
    -- A Parent's: it completes itself when its last Subtask ends done.
    auto_complete              BOOLEAN NOT NULL DEFAULT FALSE,
    -- A Parent's: an Acceptance confirms it before it counts as done.
    acceptance                 BOOLEAN NOT NULL DEFAULT FALSE,
    from_retrospective_task_id TEXT REFERENCES tasks (id),
    -- Null for the Subtasks Darkory files itself: Breakdown, Acceptance, Retrospective.
    filed_by                   TEXT REFERENCES members (id),
    -- Filed, or last moved to a Step; `next` gives a tie to the Task that has waited longest.
    waiting_since              BIGINT NOT NULL,
    created_at                 BIGINT NOT NULL,
    ended_at                   BIGINT,
    -- The current Claim, copied from its claims row. Null holder: unclaimed. A claim_expires_at
    -- at or before now: lapsed, and takeable again. Null claim_expires_at: no heartbeat timeout.
    claim_id                   TEXT,
    claim_holder_id            TEXT REFERENCES members (id),
    claim_session_id           TEXT REFERENCES sessions (id),
    claim_skill_id             TEXT REFERENCES skills (id),
    claim_timeout_ms           BIGINT,
    claim_expires_at           BIGINT,
    -- The Claim the last claiming UPDATE replaced, so whoever meets a lapsed Claim first can
    -- record the lapse: RETURNING gives only new values on SQLite (ADR 0004).
    outgoing_claim_id          TEXT,
    outgoing_holder_id         TEXT REFERENCES members (id),
    outgoing_expires_at        BIGINT
);

-- Every Feature that was not quick becomes a Task with no Parent: same id, key, title,
-- description, Owner, filer and times; shipped is done; Break down on when it had a Break down;
-- auto_complete from ship_when_done.
INSERT INTO tasks_new (id, org_id, project_id, parent_id, display_key, kind, title, description, state, step_id, step_since,
    aimed_at_id, owner_id, rank, breakdown, auto_complete, acceptance, from_retrospective_task_id, filed_by, waiting_since,
    created_at, ended_at)
SELECT f.id, f.org_id, f.team_id, NULL, f.display_key, 'work', f.title, f.description,
    CASE f.state WHEN 'shipped' THEN 'done' ELSE f.state END, NULL, NULL, NULL, f.owner_id, NULL,
    EXISTS (SELECT 1 FROM tasks b WHERE b.feature_id = f.id AND b.kind = 'breakdown'), f.ship_when_done, FALSE,
    f.from_retrospective_task_id, f.filed_by, f.created_at, f.created_at, f.ended_at
FROM features f WHERE f.quick = FALSE;

-- Its Tasks become its Subtasks, with its Owner. A quick Feature goes: its Tasks stand alone,
-- taking its Owner and auto_complete, and its key is retired (last_number stands). An open Task
-- stands at the Step of the Skill it needed, or at Backlog when it sat in a backlog-kind Status;
-- one aimed at a Member, or ended, at none.
INSERT INTO tasks_new (id, org_id, project_id, parent_id, display_key, kind, title, description, state, step_id, step_since,
    aimed_at_id, owner_id, rank, breakdown, auto_complete, acceptance, from_retrospective_task_id, filed_by, waiting_since,
    created_at, ended_at, claim_id, claim_holder_id, claim_session_id, claim_skill_id, claim_timeout_ms, claim_expires_at,
    outgoing_claim_id, outgoing_holder_id, outgoing_expires_at)
SELECT t.id, t.org_id, f.team_id, CASE WHEN f.quick THEN NULL ELSE f.id END, t.display_key, t.kind, t.title, t.description, t.state,
    CASE
        WHEN t.state <> 'open' OR t.aimed_at_id IS NOT NULL THEN NULL
        WHEN EXISTS (SELECT 1 FROM statuses bs WHERE bs.id = t.status_id AND bs.kind = 'backlog')
            THEN (SELECT bst.id FROM steps bst WHERE bst.project_id = f.team_id AND bst.skill_id IS NULL)
        ELSE (SELECT sst.id FROM steps sst JOIN skills ssk ON ssk.id = t.skill_id
            WHERE sst.project_id = f.team_id AND sst.skill_id = COALESCE(ssk.base_skill_id, ssk.id))
    END, NULL,
    t.aimed_at_id, f.owner_id, NULL, FALSE, CASE WHEN f.quick THEN f.ship_when_done ELSE FALSE END, FALSE, NULL, t.filed_by,
    t.waiting_since, t.created_at, t.ended_at, t.claim_id, t.claim_holder_id, t.claim_session_id, t.claim_skill_id,
    t.claim_timeout_ms, t.claim_expires_at, t.outgoing_claim_id, t.outgoing_holder_id, t.outgoing_expires_at
FROM tasks t JOIN features f ON f.id = t.feature_id;
UPDATE tasks_new SET step_since = waiting_since WHERE step_id IS NOT NULL;

-- The Rank: the Tasks with no Parent in their Features' order, a quick Feature's Tasks at its
-- place in the order they were filed. Where every Feature gave one such Task, each keeps its
-- Feature's rank.
UPDATE tasks_new SET rank = r.n
FROM (
    SELECT x.id, ROW_NUMBER() OVER (PARTITION BY x.project_id ORDER BY x.feature_rank, x.created_at, x.id) AS n
    FROM (
        SELECT f.id, f.team_id AS project_id, f.rank AS feature_rank, f.created_at FROM features f WHERE f.quick = FALSE
        UNION ALL
        SELECT t.id, f.team_id, f.rank, t.created_at FROM tasks t JOIN features f ON f.id = t.feature_id WHERE f.quick = TRUE
    ) x
) r
WHERE r.id = tasks_new.id;

-- A Parent names the Workspaces its Subtasks name, in the order they were first named.
INSERT INTO task_workspaces (org_id, task_id, workspace_id, position)
SELECT w.org_id, w.parent_id, w.workspace_id,
    ROW_NUMBER() OVER (PARTITION BY w.parent_id ORDER BY w.first_at, w.first_position, w.workspace_id)
FROM (
    SELECT tw.org_id, t.feature_id AS parent_id, tw.workspace_id, MIN(t.created_at) AS first_at, MIN(tw.position) AS first_position
    FROM task_workspaces tw JOIN tasks t ON t.id = tw.task_id JOIN features f ON f.id = t.feature_id
    WHERE f.quick = FALSE
    GROUP BY tw.org_id, t.feature_id, tw.workspace_id
) w;

-- 6. Evidence hangs on a Task only: Evidence on a Feature itself moves to the Task it became, or,
-- for a quick Feature, to its one Task.
CREATE TABLE evidence_new (
    id           TEXT NOT NULL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    task_id      TEXT NOT NULL REFERENCES tasks (id),
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    -- Where the Evidence store keeps the file.
    blob_key     TEXT NOT NULL,
    attached_by  TEXT NOT NULL REFERENCES members (id),
    created_at   BIGINT NOT NULL
);
INSERT INTO evidence_new (id, org_id, task_id, filename, content_type, size, sha256, blob_key, attached_by, created_at)
SELECT e.id, e.org_id,
    COALESCE(e.task_id, CASE WHEN f.quick
        THEN (SELECT q.id FROM tasks q WHERE q.feature_id = f.id ORDER BY q.created_at, q.id LIMIT 1)
        ELSE f.id END),
    e.filename, e.content_type, e.size, e.sha256, e.blob_key, e.attached_by, e.created_at
FROM evidence e JOIN features f ON f.id = e.feature_id;

-- Observations hang on their Task, which they always named; the Retrospective of its Parent
-- reads them.
CREATE TABLE observations_new (
    id                  TEXT NOT NULL PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES organisations (id),
    task_id             TEXT NOT NULL REFERENCES tasks (id),
    author_id           TEXT NOT NULL REFERENCES members (id),
    skill_id            TEXT REFERENCES skills (id),
    outcome             TEXT NOT NULL CHECK (outcome IN ('worked', 'didnt_work')),
    body                TEXT NOT NULL,
    created_at          BIGINT NOT NULL,
    -- The Retrospective that reviewed it; null until then.
    reviewed_by_task_id TEXT REFERENCES tasks (id),
    reviewed_at         BIGINT
);
INSERT INTO observations_new (id, org_id, task_id, author_id, skill_id, outcome, body, created_at, reviewed_by_task_id, reviewed_at)
SELECT id, org_id, task_id, author_id, skill_id, outcome, body, created_at, reviewed_by_task_id, reviewed_at FROM observations;

-- A Claim also ends advanced (along a Connector: what a Handover was, and is recorded as now) or
-- split (its holder filed a Subtask under the Task).
CREATE TABLE claims_new (
    id            TEXT NOT NULL PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organisations (id),
    task_id       TEXT NOT NULL REFERENCES tasks (id),
    holder_id     TEXT NOT NULL REFERENCES members (id),
    session_id    TEXT NOT NULL REFERENCES sessions (id),
    -- The Skill of the Step it was taken at: no-self-review and the Skill version read it.
    skill_id      TEXT REFERENCES skills (id),
    skill_version BIGINT,
    model_label   TEXT,
    timeout_ms    BIGINT,
    started_at    BIGINT NOT NULL,
    ended_at      BIGINT,
    how_ended     TEXT CHECK (how_ended IN ('released', 'advanced', 'completed', 'split', 'lapsed', 'taken_back', 'dropped',
        'token_revoked', 'session_closed', 'member_deactivated')),
    ended_by      TEXT REFERENCES members (id)
);
INSERT INTO claims_new (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at,
    ended_at, how_ended, ended_by)
SELECT id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at, ended_at,
    CASE how_ended WHEN 'handed_over' THEN 'advanced' ELSE how_ended END, ended_by
FROM claims;

-- Views are of the Tasks list only, of one Project or across them. Views of the Features list go;
-- a View's status: and status_kind: tokens go, since no Step has a Status's id or kind, and its
-- team: and feature: tokens become project: and parent:, which take the same ids.
CREATE TABLE views_new (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    -- The list it is of; its filters are that list's filter tokens.
    entity     TEXT NOT NULL CHECK (entity IN ('tasks')),
    -- The Project whose list it is; null for a list across Projects.
    project_id TEXT REFERENCES projects (id),
    -- Unique per Member, list and Project, ignoring case, checked in Go.
    name       TEXT NOT NULL,
    -- A JSON array of filter tokens, checked by the list's grammar when saved.
    filters    TEXT NOT NULL,
    -- As the client wrote them, never read by the server: text, and a JSON object.
    sort       TEXT,
    display    TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
INSERT INTO views_new (id, org_id, member_id, entity, project_id, name, filters, sort, display, created_at, updated_at)
SELECT v.id, v.org_id, v.member_id, v.entity, v.team_id, v.name,
    COALESCE((SELECT json_group_array(CASE
            WHEN substr(j.value, 1, 5) = 'team:' THEN 'project:' || substr(j.value, 6)
            WHEN substr(j.value, 1, 8) = 'feature:' THEN 'parent:' || substr(j.value, 9)
            ELSE j.value END ORDER BY j.key)
        FROM json_each(v.filters) j
        WHERE substr(j.value, 1, 7) <> 'status:' AND substr(j.value, 1, 12) <> 'status_kind:'), '[]'),
    v.sort, v.display, v.created_at, v.updated_at
FROM views v WHERE v.entity = 'tasks';

-- The old tables go, and the new take their names.
DROP TABLE evidence;
DROP TABLE observations;
DROP TABLE claims;
DROP TABLE views;
DROP TABLE tasks;
DROP TABLE features;
DROP TABLE statuses;
ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE evidence_new RENAME TO evidence;
ALTER TABLE observations_new RENAME TO observations;
ALTER TABLE claims_new RENAME TO claims;
ALTER TABLE views_new RENAME TO views;

CREATE UNIQUE INDEX tasks_org_display_key ON tasks (org_id, display_key);
CREATE INDEX tasks_parent ON tasks (parent_id, state);
CREATE INDEX tasks_project_rank ON tasks (project_id, rank);
CREATE INDEX tasks_owner ON tasks (owner_id);
-- The takeable query: open Tasks at a Step, and open Tasks aimed at a Member.
CREATE INDEX tasks_open_step ON tasks (org_id, step_id) WHERE state = 'open';
CREATE INDEX tasks_open_aimed_at ON tasks (aimed_at_id) WHERE state = 'open' AND aimed_at_id IS NOT NULL;
CREATE INDEX tasks_claim_holder ON tasks (claim_holder_id) WHERE claim_holder_id IS NOT NULL;
CREATE INDEX tasks_claim_session ON tasks (claim_session_id) WHERE claim_session_id IS NOT NULL;
-- The visibility sweeper looks for Claims that have expired.
CREATE INDEX tasks_claim_expires ON tasks (claim_expires_at) WHERE claim_expires_at IS NOT NULL;
CREATE INDEX evidence_task ON evidence (task_id);
CREATE INDEX observations_task ON observations (task_id);
CREATE INDEX claims_task_holder ON claims (task_id, holder_id);
CREATE INDEX claims_holder ON claims (holder_id, started_at);
CREATE INDEX views_member ON views (org_id, member_id, entity);

-- 7. The Labels a Task carries. Filters and Views read them; Darkory's rules never do.
CREATE TABLE task_labels (
    org_id   TEXT NOT NULL REFERENCES organisations (id),
    task_id  TEXT NOT NULL REFERENCES tasks (id),
    label_id TEXT NOT NULL REFERENCES labels (id),
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label ON task_labels (label_id);
