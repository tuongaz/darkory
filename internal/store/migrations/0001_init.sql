-- The schema of model v2 (ADR 0015, ADR 0016, docs/build/model-v2-plan.md), shared by SQLite and
-- Postgres. Every Install starts from it: Projects hold Tasks, a Task may have Subtasks, and each
-- Project's Workflow of Steps and Connectors says where a Task is.
--
-- Conventions (docs/build/plan.md, invariant 3): ids are TEXT UUIDv7, times are BIGINT Unix
-- milliseconds, durations are BIGINT milliseconds, and every table carries org_id. Primary key
-- columns are declared NOT NULL because SQLite would otherwise let them hold NULL.
--
-- A pointer that would close a loop between two tables (tasks.claim_id and claims.task_id) has no
-- foreign key: Postgres needs the referenced table to exist first, and one shared file cannot add
-- it afterwards on SQLite. A table may name itself (tasks.parent_id).
--
-- Names unique ignoring case — a Workspace's, a Step's in its Project, a Connector's out of its
-- Step, a Label's among its Project's or the Organisation's, a View's among its Member's — are
-- checked in Go, under the write: SQLite's lower() folds ASCII only, an expression index reads
-- differently on the two engines, and a unique index treats every null as different.

CREATE TABLE organisations (
    id         TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    -- The counter every write takes first (ADR 0011). Its value numbers Activity.
    seq        BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE members (
    id             TEXT NOT NULL PRIMARY KEY,
    org_id         TEXT NOT NULL REFERENCES organisations (id),
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    email          TEXT,
    admin          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     BIGINT NOT NULL,
    updated_at     BIGINT NOT NULL,
    -- When an admin deactivated the Member, stopping every credential of theirs at once (security
    -- review M4); null while active. The Member stays, with everything they did.
    deactivated_at BIGINT,
    -- An agent's settings for the Runner, as JSON text; null for humans and for agents the Runner
    -- does not start.
    agent          TEXT
);
CREATE UNIQUE INDEX members_org_name ON members (org_id, name);
CREATE UNIQUE INDEX members_org_email ON members (org_id, email) WHERE email IS NOT NULL;

CREATE TABLE tokens (
    id                           TEXT NOT NULL PRIMARY KEY,
    org_id                       TEXT NOT NULL REFERENCES organisations (id),
    member_id                    TEXT NOT NULL REFERENCES members (id),
    name                         TEXT NOT NULL,
    -- SHA-256 of the secret, hex. The secret itself is never stored.
    secret_hash                  TEXT NOT NULL,
    prefix                       TEXT NOT NULL,
    default_heartbeat_timeout_ms BIGINT,
    created_by                   TEXT REFERENCES members (id),
    created_at                   BIGINT NOT NULL,
    last_used_at                 BIGINT,
    revoked_at                   BIGINT
);
CREATE UNIQUE INDEX tokens_secret_hash ON tokens (secret_hash);
CREATE INDEX tokens_member ON tokens (org_id, member_id);

CREATE TABLE sessions (
    id           TEXT NOT NULL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    member_id    TEXT NOT NULL REFERENCES members (id),
    -- The id the running copy chose (Darkory-Session); server-chosen for browser Sessions.
    chosen_id    TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('token', 'browser')),
    token_id     TEXT REFERENCES tokens (id),
    -- Browser Sessions: SHA-256 of the cookie secret, hex.
    cookie_hash  TEXT,
    created_at   BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    closed_at    BIGINT
);
CREATE UNIQUE INDEX sessions_open_chosen_id ON sessions (member_id, chosen_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX sessions_cookie_hash ON sessions (cookie_hash) WHERE cookie_hash IS NOT NULL;
CREATE INDEX sessions_token ON sessions (token_id) WHERE token_id IS NOT NULL;
-- A Member's open Sessions, most recently seen first: listSessions, and closing them all.
CREATE INDEX sessions_member_open ON sessions (org_id, member_id, last_seen_at) WHERE closed_at IS NULL;

CREATE TABLE login_links (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    -- SHA-256 of the code in the link, hex.
    code_hash  TEXT NOT NULL,
    -- Null when the server printed it at start.
    created_by TEXT REFERENCES members (id),
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at    BIGINT
);
CREATE UNIQUE INDEX login_links_code_hash ON login_links (code_hash);

-- A place a session works in, named on the Install; a git repository is the first kind (ADR 0013).
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

-- A body of work with the Members who do it: its own key, Workflow, Labels, Rank and Workspaces.
CREATE TABLE projects (
    id                   TEXT NOT NULL PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES organisations (id),
    -- Prefix of the Project's display keys: MAIN in MAIN-42.
    key_prefix           TEXT NOT NULL,
    name                 TEXT NOT NULL,
    -- The last display-key number allocated; a Project's Tasks and Subtasks share it.
    last_number          BIGINT NOT NULL DEFAULT 0,
    -- The Workspace a Task filed in the Project names when it names none.
    default_workspace_id TEXT REFERENCES workspaces (id),
    -- What a Task filed in the Project takes when its filer does not say: it completes itself
    -- when its last Subtask ends done; an Acceptance confirms it before it counts as done.
    auto_complete        BOOLEAN NOT NULL DEFAULT FALSE,
    acceptance           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           BIGINT NOT NULL
);
CREATE UNIQUE INDEX projects_org_key_prefix ON projects (org_id, key_prefix);
CREATE UNIQUE INDEX projects_org_name ON projects (org_id, name);

CREATE TABLE project_members (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    added_at   BIGINT NOT NULL,
    PRIMARY KEY (project_id, member_id)
);
CREATE INDEX project_members_member ON project_members (member_id, project_id);

CREATE TABLE skills (
    id              TEXT NOT NULL PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organisations (id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('generic', 'company')),
    base_skill_id   TEXT REFERENCES skills (id),
    -- breakdown, acceptance, retro and skill-review: Darkory relies on them, so they cannot be
    -- removed.
    builtin         BOOLEAN NOT NULL DEFAULT FALSE,
    current_version BIGINT NOT NULL,
    created_by      TEXT REFERENCES members (id),
    created_at      BIGINT NOT NULL
);
CREATE UNIQUE INDEX skills_org_name ON skills (org_id, name);

CREATE TABLE member_skills (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    skill_id   TEXT NOT NULL REFERENCES skills (id),
    granted_by TEXT REFERENCES members (id),
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (member_id, skill_id)
);
CREATE INDEX member_skills_skill ON member_skills (skill_id, member_id);

-- One row per Member who has someone directing them.
CREATE TABLE reporting_lines (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    member_id  TEXT NOT NULL PRIMARY KEY REFERENCES members (id),
    manager_id TEXT NOT NULL REFERENCES members (id),
    set_by     TEXT REFERENCES members (id),
    set_at     BIGINT NOT NULL
);
CREATE INDEX reporting_lines_manager ON reporting_lines (manager_id);

-- A place in a Project's Workflow. A Task at it is taken by a Member with its Skill.
CREATE TABLE steps (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    -- Unique in its Project ignoring case, checked in Go; the index holds the exact spelling.
    name       TEXT NOT NULL,
    -- Null for a hold: no one is offered a Task there, and a human moves it on.
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
-- every Project. A name is unique among the Organisation's Labels and each Project's taken with
-- them, ignoring case, checked in Go.
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

-- The unit of work. A Subtask has a Parent, whose Owner it shares; a Task with no Parent has a
-- Rank; a Task that is not a Parent, not aimed at a Member and not ended is at a Step.
CREATE TABLE tasks (
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

-- The Labels a Task carries. Filters and Views read them; Darkory's rules never do.
CREATE TABLE task_labels (
    org_id   TEXT NOT NULL REFERENCES organisations (id),
    task_id  TEXT NOT NULL REFERENCES tasks (id),
    label_id TEXT NOT NULL REFERENCES labels (id),
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label ON task_labels (label_id);

-- The Workspaces a Task names, in the order named: the first is where its session starts.
CREATE TABLE task_workspaces (
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    task_id      TEXT NOT NULL REFERENCES tasks (id),
    workspace_id TEXT NOT NULL REFERENCES workspaces (id),
    position     BIGINT NOT NULL,
    PRIMARY KEY (task_id, workspace_id)
);
CREATE INDEX task_workspaces_workspace ON task_workspaces (org_id, workspace_id);

-- Every Claim, current and ended (ADR 0004). The no-self-review check reads these.
CREATE TABLE claims (
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
    -- advanced: along a Connector to a Step; completed: into Done; split: its holder filed a
    -- Subtask under the Task.
    how_ended     TEXT CHECK (how_ended IN ('released', 'advanced', 'completed', 'split', 'lapsed', 'taken_back', 'dropped',
        'token_revoked', 'session_closed', 'member_deactivated')),
    ended_by      TEXT REFERENCES members (id)
);
CREATE INDEX claims_task_holder ON claims (task_id, holder_id);
CREATE INDEX claims_holder ON claims (holder_id, started_at);

-- task_id is blocked by blocker_task_id until the blocker ends.
CREATE TABLE blocks (
    org_id          TEXT NOT NULL REFERENCES organisations (id),
    task_id         TEXT NOT NULL REFERENCES tasks (id),
    blocker_task_id TEXT NOT NULL REFERENCES tasks (id),
    added_by        TEXT NOT NULL REFERENCES members (id),
    added_at        BIGINT NOT NULL,
    PRIMARY KEY (task_id, blocker_task_id)
);
CREATE INDEX blocks_blocker ON blocks (blocker_task_id);

CREATE TABLE notes (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    task_id    TEXT NOT NULL REFERENCES tasks (id),
    author_id  TEXT NOT NULL REFERENCES members (id),
    skill_id   TEXT REFERENCES skills (id),
    body       TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX notes_task ON notes (task_id, created_at);

-- Observations feed the Retrospective of their Task's Parent (ADR 0010).
CREATE TABLE observations (
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
CREATE INDEX observations_task ON observations (task_id);

CREATE TABLE skill_proposals (
    id                TEXT NOT NULL PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES organisations (id),
    skill_id          TEXT NOT NULL REFERENCES skills (id),
    task_id           TEXT NOT NULL REFERENCES tasks (id),
    based_on_version  BIGINT NOT NULL,
    body              TEXT NOT NULL,
    author_id         TEXT NOT NULL REFERENCES members (id),
    state             TEXT NOT NULL CHECK (state IN ('pending', 'published', 'superseded')),
    published_version BIGINT,
    created_at        BIGINT NOT NULL,
    decided_at        BIGINT
);
CREATE INDEX skill_proposals_task ON skill_proposals (task_id);
CREATE INDEX skill_proposals_skill ON skill_proposals (skill_id);

CREATE TABLE skill_versions (
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    skill_id     TEXT NOT NULL REFERENCES skills (id),
    version      BIGINT NOT NULL,
    body         TEXT NOT NULL,
    -- Null for version 1, which is written when the Skill is created.
    proposal_id  TEXT REFERENCES skill_proposals (id),
    published_by TEXT REFERENCES members (id),
    published_at BIGINT NOT NULL,
    PRIMARY KEY (skill_id, version)
);

-- Evidence hangs on a Task; Evidence on a Parent is Evidence whose Task is the Parent.
CREATE TABLE evidence (
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
CREATE INDEX evidence_task ON evidence (task_id);

-- Append-only; seq comes from organisations.seq in the same write (ADR 0011).
CREATE TABLE activity (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    seq        BIGINT NOT NULL,
    -- Null when Darkory acted, as when recording a lapse or filing its own Subtasks.
    actor_id   TEXT REFERENCES members (id),
    kind       TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    -- JSON object.
    payload    TEXT NOT NULL,
    at         BIGINT NOT NULL,
    PRIMARY KEY (org_id, seq)
);
CREATE INDEX activity_subject ON activity (subject_id);

-- A write's first response, kept 24 hours so a retry with the same key gets it back.
CREATE TABLE idempotency_keys (
    org_id          TEXT NOT NULL REFERENCES organisations (id),
    member_id       TEXT NOT NULL REFERENCES members (id),
    idempotency_key TEXT NOT NULL,
    -- SHA-256 of method, path and body, hex: a key reused for another request is refused.
    request_hash    TEXT NOT NULL,
    status          BIGINT NOT NULL,
    response        TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    PRIMARY KEY (member_id, idempotency_key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- Views: a saved set of filters, sort and display for the Tasks list, kept by one Member for
-- themselves. A View is a Member's preference, not the record, so no Activity is written about it.
CREATE TABLE views (
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
CREATE INDEX views_member ON views (org_id, member_id, entity);
