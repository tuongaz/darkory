-- How far each Member has read a Project's Activity: the seq of the newest entry they have seen
-- there, so the Project's page can tell them what happened since they looked. It only moves
-- forward. Like a View it is a Member's preference, not the record: no Activity is written about it.
CREATE TABLE project_seen (
    org_id     TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    member_id  TEXT NOT NULL REFERENCES members (id),
    seq        BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (project_id, member_id)
);
