-- The first schema, shared by SQLite and Postgres.
--
-- Conventions (docs/build/plan.md, invariant 3): ids are TEXT UUIDv7, times are BIGINT Unix
-- milliseconds, durations are BIGINT milliseconds, and every table carries org_id. Primary key
-- columns are declared NOT NULL because SQLite would otherwise let them hold NULL.
--
-- A pointer that would close a loop between two tables (tasks.claim_id and claims.task_id,
-- features.from_retrospective_task_id and tasks.feature_id) has no foreign key: Postgres needs
-- the referenced table to exist first, and one shared file cannot add it afterwards on SQLite.

CREATE TABLE organisations (
    id         TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    -- The counter every write takes first (ADR 0011). Its value numbers Activity.
    seq        BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE members (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    email      TEXT,
    admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
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

CREATE TABLE teams (
    id          TEXT NOT NULL PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organisations (id),
    -- Prefix of the Team's display keys: WEB in WEB-42.
    key_prefix  TEXT NOT NULL,
    name        TEXT NOT NULL,
    -- The last display-key number allocated; Features and Tasks share it.
    last_number BIGINT NOT NULL DEFAULT 0,
    created_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX teams_org_key_prefix ON teams (org_id, key_prefix);
CREATE UNIQUE INDEX teams_org_name ON teams (org_id, name);

CREATE TABLE team_members (
    org_id    TEXT NOT NULL REFERENCES organisations (id),
    team_id   TEXT NOT NULL REFERENCES teams (id),
    member_id TEXT NOT NULL REFERENCES members (id),
    added_at  BIGINT NOT NULL,
    PRIMARY KEY (team_id, member_id)
);
CREATE INDEX team_members_member ON team_members (member_id, team_id);

CREATE TABLE skills (
    id              TEXT NOT NULL PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organisations (id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('generic', 'company')),
    base_skill_id   TEXT REFERENCES skills (id),
    -- breakdown, retro and skill-review: Darkory relies on them, so they cannot be removed.
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

CREATE TABLE features (
    id                         TEXT NOT NULL PRIMARY KEY,
    org_id                     TEXT NOT NULL REFERENCES organisations (id),
    team_id                    TEXT NOT NULL REFERENCES teams (id),
    display_key                TEXT NOT NULL,
    title                      TEXT NOT NULL,
    description                TEXT NOT NULL DEFAULT '',
    owner_id                   TEXT NOT NULL REFERENCES members (id),
    state                      TEXT NOT NULL CHECK (state IN ('open', 'shipped', 'dropped')),
    -- Position in the Team's Rank, 1 first; renumbered on a move. Ended Features keep theirs.
    rank                       BIGINT NOT NULL,
    from_retrospective_task_id TEXT,
    filed_by                   TEXT NOT NULL REFERENCES members (id),
    created_at                 BIGINT NOT NULL,
    ended_at                   BIGINT
);
CREATE UNIQUE INDEX features_org_display_key ON features (org_id, display_key);
CREATE INDEX features_team_rank ON features (team_id, rank);
CREATE INDEX features_owner ON features (owner_id);

CREATE TABLE tasks (
    id                    TEXT NOT NULL PRIMARY KEY,
    org_id                TEXT NOT NULL REFERENCES organisations (id),
    feature_id            TEXT NOT NULL REFERENCES features (id),
    display_key           TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN ('work', 'breakdown', 'retrospective')),
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    -- Only open, done or dropped. Claimed and lapsed follow from the claim_ columns (ADR 0004).
    state                 TEXT NOT NULL CHECK (state IN ('open', 'done', 'dropped')),
    -- The Skill the Task needs now; null when it is aimed at a Member.
    skill_id              TEXT REFERENCES skills (id),
    aimed_at_id           TEXT REFERENCES members (id),
    filed_by              TEXT NOT NULL REFERENCES members (id),
    -- Filed or last handed over; `next` gives a tie to the Task that has waited longest.
    waiting_since         BIGINT NOT NULL,
    created_at            BIGINT NOT NULL,
    ended_at              BIGINT,
    -- The current Claim, copied from its claims row. Null holder: unclaimed. A claim_expires_at
    -- at or before now: lapsed, and takeable again. Null claim_expires_at: no heartbeat timeout.
    claim_id              TEXT,
    claim_holder_id       TEXT REFERENCES members (id),
    claim_session_id      TEXT REFERENCES sessions (id),
    claim_skill_id        TEXT REFERENCES skills (id),
    claim_timeout_ms      BIGINT,
    claim_expires_at      BIGINT,
    -- The Claim the last claiming UPDATE replaced, so whoever meets a lapsed Claim first can
    -- record the lapse: RETURNING gives only new values on SQLite (ADR 0004).
    outgoing_claim_id     TEXT,
    outgoing_holder_id    TEXT REFERENCES members (id),
    outgoing_expires_at   BIGINT
);
CREATE UNIQUE INDEX tasks_org_display_key ON tasks (org_id, display_key);
CREATE INDEX tasks_feature ON tasks (feature_id, state);
-- The takeable query: open Tasks needing a Skill, and open Tasks aimed at a Member.
CREATE INDEX tasks_open_skill ON tasks (org_id, skill_id) WHERE state = 'open';
CREATE INDEX tasks_open_aimed_at ON tasks (aimed_at_id) WHERE state = 'open' AND aimed_at_id IS NOT NULL;
CREATE INDEX tasks_claim_holder ON tasks (claim_holder_id) WHERE claim_holder_id IS NOT NULL;
CREATE INDEX tasks_claim_session ON tasks (claim_session_id) WHERE claim_session_id IS NOT NULL;
-- The visibility sweeper looks for Claims that have expired.
CREATE INDEX tasks_claim_expires ON tasks (claim_expires_at) WHERE claim_expires_at IS NOT NULL;

-- Every Claim, current and ended (ADR 0004). The no-self-review check reads these.
CREATE TABLE claims (
    id            TEXT NOT NULL PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organisations (id),
    task_id       TEXT NOT NULL REFERENCES tasks (id),
    holder_id     TEXT NOT NULL REFERENCES members (id),
    session_id    TEXT NOT NULL REFERENCES sessions (id),
    skill_id      TEXT REFERENCES skills (id),
    skill_version BIGINT,
    model_label   TEXT,
    timeout_ms    BIGINT,
    started_at    BIGINT NOT NULL,
    ended_at      BIGINT,
    how_ended     TEXT CHECK (how_ended IN ('released', 'handed_over', 'completed', 'lapsed', 'taken_back', 'dropped', 'token_revoked', 'session_closed')),
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

CREATE TABLE observations (
    id                  TEXT NOT NULL PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES organisations (id),
    task_id             TEXT NOT NULL REFERENCES tasks (id),
    feature_id          TEXT NOT NULL REFERENCES features (id),
    author_id           TEXT NOT NULL REFERENCES members (id),
    skill_id            TEXT REFERENCES skills (id),
    outcome             TEXT NOT NULL CHECK (outcome IN ('worked', 'didnt_work')),
    body                TEXT NOT NULL,
    created_at          BIGINT NOT NULL,
    -- The Retrospective that reviewed it; null until then.
    reviewed_by_task_id TEXT REFERENCES tasks (id),
    reviewed_at         BIGINT
);
CREATE INDEX observations_feature ON observations (feature_id, created_at);
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

CREATE TABLE evidence (
    id           TEXT NOT NULL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    feature_id   TEXT NOT NULL REFERENCES features (id),
    -- Null when attached to the Feature itself.
    task_id      TEXT REFERENCES tasks (id),
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    -- Where the Evidence store keeps the file.
    blob_key     TEXT NOT NULL,
    attached_by  TEXT NOT NULL REFERENCES members (id),
    created_at   BIGINT NOT NULL
);
CREATE INDEX evidence_feature ON evidence (feature_id);
CREATE INDEX evidence_task ON evidence (task_id) WHERE task_id IS NOT NULL;

-- Append-only; seq comes from organisations.seq in the same write (ADR 0011).
CREATE TABLE activity (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    seq        BIGINT NOT NULL,
    -- Null when Darkory acted, as when recording a lapse.
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
