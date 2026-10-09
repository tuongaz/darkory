-- A Task's Subtasks, by its Organisation first: every read of them names the org_id, and the
-- Workflow a Parent is listed in reads its open Subtasks at a Step on every list. Keyed by the
-- Parent alone, SQLite, which keeps no statistics, read them through tasks_open_step, every open
-- Task of the Organisation; with org_id leading, this index matches all three terms on both
-- engines. It replaces tasks_parent, so a write maintains no more indexes than before.
DROP INDEX tasks_parent;
CREATE INDEX tasks_org_parent ON tasks (org_id, parent_id, state);
