-- A Member's Sessions, open or ended: listSessions counts both and pages the ended ones. Ended
-- Sessions accumulate (a CLI command without DARKORY_SESSION makes one), so the count must not
-- read the whole table.
CREATE INDEX sessions_member ON sessions (org_id, member_id, last_seen_at);
