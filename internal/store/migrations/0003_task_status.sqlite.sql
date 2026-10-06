-- Tasks have a Status the Organisation defines (ADR 0012). The rules read a Status's kind, never
-- its name. The schema is the same on both engines; the seed and the backfill differ, because a
-- migration makes its ids and reads the time in SQL, which each engine spells its own way.

CREATE TABLE statuses (
    id         TEXT NOT NULL PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('backlog', 'todo', 'in_progress', 'done', 'dropped')),
    -- Place in the Organisation's list, 1 first; "the first todo Status" is the lowest.
    position   BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX statuses_org_name ON statuses (org_id, name);

-- Null only between this statement and the backfill below: every Task is filed with a Status.
-- SQLite cannot add a NOT NULL column without a default, and the schemas must stay alike.
ALTER TABLE tasks ADD COLUMN status_id TEXT REFERENCES statuses (id);
CREATE INDEX tasks_status ON tasks (org_id, status_id);

-- The six defaults for every Organisation. Ids are shaped as UUIDv7: the time in milliseconds,
-- then random hex.
INSERT INTO statuses (id, org_id, name, kind, position, created_at)
SELECT substr(x.t, 1, 8) || '-' || substr(x.t, 9, 4) || '-7' || substr(x.r, 1, 3) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(x.r, 4, 3) || '-' || substr(x.r, 7, 12),
    x.org_id, x.name, x.kind, x.position, x.now
FROM (
    SELECT o.id AS org_id, d.name, d.kind, d.position, n.now,
        printf('%012x', n.now) AS t, lower(hex(randomblob(9))) AS r
    FROM organisations o
    CROSS JOIN (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now) n
    CROSS JOIN (
        SELECT 'Backlog' AS name, 'backlog' AS kind, 1 AS position
        UNION ALL SELECT 'Todo', 'todo', 2
        UNION ALL SELECT 'In progress', 'in_progress', 3
        UNION ALL SELECT 'In review', 'in_progress', 4
        UNION ALL SELECT 'Done', 'done', 5
        UNION ALL SELECT 'Dropped', 'dropped', 6
    ) d
) x;

-- Each Task by rule: done → Done, dropped → Dropped, open with a live Claim → In progress, else
-- Todo. A Claim is live while it has no expiry or its expiry is still ahead.
UPDATE tasks SET status_id = (
    SELECT s.id FROM statuses s WHERE s.org_id = tasks.org_id AND s.name = CASE
        WHEN tasks.state = 'done' THEN 'Done'
        WHEN tasks.state = 'dropped' THEN 'Dropped'
        WHEN tasks.claim_holder_id IS NOT NULL AND (tasks.claim_expires_at IS NULL
            OR tasks.claim_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) THEN 'In progress'
        ELSE 'Todo'
    END);
