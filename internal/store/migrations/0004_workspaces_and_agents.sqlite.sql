-- Agents on a Local Install (ADR 0013, ADR 0014): Workspaces, the Workspaces a Task names, a
-- Team's defaults, quick and ship-when-done Features, and the settings the Runner starts an
-- agent's sessions with. The statements are the same on both engines; the pair keeps the
-- pattern of 0002 and 0003, so either can diverge without renumbering.

-- A place a session works in, named on the Install; a git repository is the first kind.
CREATE TABLE workspaces (
    id             TEXT NOT NULL PRIMARY KEY,
    org_id         TEXT NOT NULL REFERENCES organisations (id),
    -- Unique ignoring case, checked in Go; it names the session's checkout directory.
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('git')),
    -- The repository's absolute path on the machine that runs the Install.
    path           TEXT NOT NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('plain', 'pull_request')),
    default_branch TEXT NOT NULL,
    created_at     BIGINT NOT NULL
);
CREATE UNIQUE INDEX workspaces_org_name ON workspaces (org_id, name);

-- The Workspaces a Task names, in the order named: the first is where its session starts.
CREATE TABLE task_workspaces (
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    task_id      TEXT NOT NULL REFERENCES tasks (id),
    workspace_id TEXT NOT NULL REFERENCES workspaces (id),
    position     BIGINT NOT NULL,
    PRIMARY KEY (task_id, workspace_id)
);
CREATE INDEX task_workspaces_workspace ON task_workspaces (org_id, workspace_id);

-- What a Task filed naming no Workspace names, and what a Feature filed without saying takes.
ALTER TABLE teams ADD COLUMN default_workspace_id TEXT REFERENCES workspaces (id);
ALTER TABLE teams ADD COLUMN ship_when_done BOOLEAN NOT NULL DEFAULT FALSE;

-- A quick Feature is filed with its one Task and no Break down, and has no Retrospective; one
-- with ship_when_done ships itself when its last open Task is completed. Both are set at filing.
ALTER TABLE features ADD COLUMN quick BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE features ADD COLUMN ship_when_done BOOLEAN NOT NULL DEFAULT FALSE;

-- An agent's settings for the Runner, as JSON text; null for humans and for agents the Runner
-- does not start.
ALTER TABLE members ADD COLUMN agent TEXT;
