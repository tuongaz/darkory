-- Deactivating a Member (security review M4): an admin stops every credential of theirs at once.
-- The Member stays, with everything they did; deactivated_at is when an admin deactivated them,
-- NULL while active. The Claims the deactivation ends record it as member_deactivated.
ALTER TABLE members ADD COLUMN deactivated_at BIGINT;

-- A Member's open Sessions, most recently seen first: listSessions, and closing them all.
CREATE INDEX sessions_member_open ON sessions (org_id, member_id, last_seen_at) WHERE closed_at IS NULL;

ALTER TABLE claims DROP CONSTRAINT claims_how_ended_check;
ALTER TABLE claims ADD CONSTRAINT claims_how_ended_check
    CHECK (how_ended IN ('released', 'handed_over', 'completed', 'lapsed', 'taken_back', 'dropped', 'token_revoked', 'session_closed', 'member_deactivated'));
