# Projects hold Tasks, and a Task may have Subtasks

The record has one unit of work, the **Task**, in one container of work, the **Project**. A Task belongs to exactly one Project and may be filed under another Task of that Project, which makes it a **Subtask** and the other its **Parent**; a Subtask has no Subtasks of its own. A Parent is never claimed: it ends when its Owner completes it, which requires every Subtask to have ended, or by **Auto-complete** when its last Subtask ends Done, optionally after an **Acceptance** Subtask that Darkory files so a Member confirms the whole. A Task without Subtasks is claimed, worked and completed by its holder. **Complete** is the one verb for ending a Task Done, and in a git Workspace it merges the Task's branch into its base: a Subtask's into its Parent's branch, a top-level Task's into the default branch, or it opens the pull request that does.

This supersedes the Feature and Team of [ADR 0001](0001-one-task-moves-through-skills.md) and [ADR 0014](0014-feature-branches-and-shipping.md): a Feature is now a Parent Task, a quick Feature a Task with no Subtasks, Ship is Complete, `ship_when_done` is `auto_complete`, `feature/<KEY>` is `<KEY>`, and a Team is a Project, which the web app treats as its main context. Everything a Feature carried — Owner, Rank, Break down, Retrospective, the branch — a Task carries; everything a Team carried — key, Members, default Workspace, defaults — a Project carries, plus its Workflow and Labels ([ADR 0016](0016-workflow-of-steps.md)).

We chose this because two nouns for one shape confused the person using it: a Feature was "a group of Tasks with an owner", a quick Feature "a Task pretending not to have a group", and "Feature" itself named software, where the same record must serve an accounting Project whose unit of work is a client's return. One entity with an optional parent is what Linear, Asana and Jira each converged on; keys already shared one sequence per Team, so the merge costs the record nothing it did not already do. "Team" named people, but what it held — key, Rank, default Workspace — was a body of work, which is why "how do I add a project?" was asked of a screen that listed Teams. One level of nesting is a deliberate stop: Rank, branches and Retrospectives would otherwise recurse, and boards with unbounded nesting stop reading.

Decided on 2026-10-07 with the owner; the question-by-question record is in [`docs/build/model-v2-plan.md`](../build/model-v2-plan.md).

## Considered Options

- **Keep Feature and Task, hide the Feature for single-Task work.** A half-day change, and an illusion: the hidden group leaks into Activity, search and ownership, and "Feature" stays on every other screen.
- **Make the group optional on a Task.** A standalone Task then needs a Project, Owner and Rank of its own, which is a Task behaving like a Feature — the same model with two tables.
- **Team plus Project under it (Asana).** Four layers where, for the cases at hand, people and work coincide: the Tax team is the Tax project.
- **Unbounded nesting (Linear's sub-issues).** Rejected for the recursion it forces on Rank, branches and Retrospectives.
