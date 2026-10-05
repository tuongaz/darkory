-- Deactivating a Member (security review M4): an admin stops every credential of theirs at once.
-- The Member stays, with everything they did; deactivated_at is when an admin deactivated them,
-- NULL while active. The Claims the deactivation ends record it as member_deactivated.
ALTER TABLE members ADD COLUMN deactivated_at BIGINT;

-- A Member's open Sessions, most recently seen first: listSessions, and closing them all.
CREATE INDEX sessions_member_open ON sessions (org_id, member_id, last_seen_at) WHERE closed_at IS NULL;

-- SQLite cannot change a CHECK constraint in place, so claims is rebuilt with the same columns,
-- keys and indexes. No table refers to claims.
CREATE TABLE claims_new (
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
    how_ended     TEXT CHECK (how_ended IN ('released', 'handed_over', 'completed', 'lapsed', 'taken_back', 'dropped', 'token_revoked', 'session_closed', 'member_deactivated')),
    ended_by      TEXT REFERENCES members (id)
);
INSERT INTO claims_new (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at, ended_at, how_ended, ended_by)
SELECT id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at, ended_at, how_ended, ended_by FROM claims;
DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;
CREATE INDEX claims_task_holder ON claims (task_id, holder_id);
CREATE INDEX claims_holder ON claims (holder_id, started_at);
