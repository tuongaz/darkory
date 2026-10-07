-- Views: a saved set of filters, sort and display for a list, kept by one Member for themselves.
-- A View is a Member's preference, not the record, so no Activity is written about it. The
-- statements are the same on both engines; the pair keeps the pattern of 0002 to 0004, so either
-- can diverge without renumbering.

CREATE TABLE views (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    -- The list it is of; its filters are that list's filter tokens.
    entity     TEXT NOT NULL CHECK (entity IN ('tasks', 'features')),
    -- The Team whose list it is; null for a list across Teams.
    team_id    TEXT REFERENCES teams (id),
    -- Unique per Member, list and Team, ignoring case, checked in Go.
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
