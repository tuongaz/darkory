-- The pull request a Task's branch lands through, in a Workspace in pull_request mode, as the
-- Runner read it on GitHub: its number and address, and whether it is open or merged. All three
-- are null until the Runner has seen one, and are written together.
ALTER TABLE tasks ADD COLUMN pull_request_number BIGINT;
ALTER TABLE tasks ADD COLUMN pull_request_url TEXT;
ALTER TABLE tasks ADD COLUMN pull_request_state TEXT CHECK (pull_request_state IN ('open', 'merged'));

-- The Project a company Skill belongs to; null for a generic Skill and for a company Skill of the
-- whole Organisation. A Step of one Project cannot carry another's (ADR 0020). No backfill: a
-- company Skill already here stays the Organisation's until an admin sets its Project.
ALTER TABLE skills ADD COLUMN project_id TEXT REFERENCES projects (id);

-- What a piece of Evidence is: 'evidence' about the work, attached by the holder or a Member, or
-- 'log', a Shift's terminal log the Runner attaches when the Shift ends, which belongs to the
-- Claim the Shift worked under and is not the Task's Evidence. The Runner has named its logs
-- shift-<KEY>-<agent>-<HHMMSS>.log since it first attached them, so those already here are logs.
ALTER TABLE evidence ADD COLUMN kind TEXT NOT NULL DEFAULT 'evidence' CHECK (kind IN ('evidence', 'log'));
UPDATE evidence SET kind = 'log' WHERE filename LIKE 'shift-%-%.log';
