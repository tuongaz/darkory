-- Files: bytes an Organisation keeps, referenced by id, such as a Member's avatar. The bytes live
-- in the Install's file store (on disk under <data>/files, or an S3-compatible bucket), under
-- blob_key; only what describes them is here. A deleted file keeps its row, marked, so its id
-- never names other bytes; its bytes are removed after the write that deletes it (purged_at),
-- and a removal that failed is tried again on the next.
CREATE TABLE files (
    id           TEXT NOT NULL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organisations (id),
    name         TEXT NOT NULL,
    -- The type the server found by reading the bytes, never the one the uploader claimed.
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    -- What the file was uploaded as: general, or avatar (checked, and made a 256-pixel square).
    purpose      TEXT NOT NULL CHECK (purpose IN ('general', 'avatar')),
    blob_key     TEXT NOT NULL,
    created_by   TEXT NOT NULL REFERENCES members (id),
    created_at   BIGINT NOT NULL,
    deleted_at   BIGINT,
    deleted_by   TEXT REFERENCES members (id),
    purged_at    BIGINT
);
CREATE INDEX files_org ON files (org_id, created_at);

-- A Member's avatar: a file uploaded as one, shown in place of their initials. Null for none.
ALTER TABLE members ADD COLUMN avatar_file_id TEXT REFERENCES files (id);
