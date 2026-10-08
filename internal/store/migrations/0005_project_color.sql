-- A Project's colour: the hue of its mark, one of twelve around the wheel by index (0 red through
-- 11 pink; the app draws them). Stored, so a Project keeps its colour whoever looks and whatever
-- else the Organisation holds. A new Project takes the hue farthest from those its Organisation's
-- Projects already have, the lowest index on a tie (core.pickProjectColor). Starting from none,
-- that rule gives the k-th Project the k-th index of 0 6 3 9 1 2 4 5 7 8 10 11, then again from
-- 0; the Projects already here take it in the order they were created.
ALTER TABLE projects ADD COLUMN color BIGINT NOT NULL DEFAULT 0 CHECK (color >= 0 AND color < 12);

UPDATE projects SET color = (
    SELECT CASE (r.n - 1) % 12
        WHEN 0 THEN 0 WHEN 1 THEN 6 WHEN 2 THEN 3 WHEN 3 THEN 9 WHEN 4 THEN 1 WHEN 5 THEN 2
        WHEN 6 THEN 4 WHEN 7 THEN 5 WHEN 8 THEN 7 WHEN 9 THEN 8 WHEN 10 THEN 10 ELSE 11 END
    FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY created_at, id) AS n FROM projects) r
    WHERE r.id = projects.id
);
