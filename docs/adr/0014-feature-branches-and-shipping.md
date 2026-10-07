# A Feature has a branch, and Ship merges it

In a git Workspace, a Feature's work lands in two steps that follow the record's own gates. Break down creates `feature/<FEATURE-KEY>` from the default branch in every Workspace the Feature touches. Each Task's session works on its own branch, named with the Task's key, in its own worktree. When the Task's **review completes** — the reviewer's Complete, or, for a Workspace in `pull_request` mode, the merge of the pull request that carries the key — the Runner merges the Task branch into the feature branch and records it on the Task; a conflict reopens the build Task with a Note. **Ship** merges the feature branch into the default branch, or opens the pull request that does; a Feature filed with `ship_when_done` ships itself when its last Task ends Done. (Amended 2026-10-07: a work Task completed by its own holder, without review, has its branch merged all the same, the merge Note saying so, since a Feature called done with its work left on a branch is a silent loss.) The Runner never force-pushes and never touches a branch it did not create.

A **quick** Feature is the small change that fits one branch: it is filed with its one Task and no Break down, works on a Task branch straight off the default branch, has no feature branch and no Retrospective, and ships when that Task's review completes. Every Task still belongs to exactly one Feature, so a fix keeps its own record, Rank, owner and Activity.

We chose this because the human wanted "file a Feature and it gets done" with no git from them until the end, and the record already had two gates worth keeping as the only ones: review by a Member with the Skill, and Ship by the owner. Merging on review-complete and on Ship makes those gates the merge points, so the feature branch is where a person looks at the whole change before it lands, and nothing lands that the record has not called done. Reading the merge back from the repository — Linear's convention of the key in the branch and pull request — lets a human merging on GitHub count the same as a reviewer completing, while an agent's work still ends through MCP, because a merge cannot say "won't do".

Decided on 2026-10-07; the question-by-question record is in `docs/build/agents-plan.md`.

## Considered Options

- **Task branches that a person merges one by one.** Safe, but every Task needs the human, which is the loop the plan exists to remove.
- **Straight to the default branch on review-complete.** Fewest steps, but no place to see a Feature as a whole before it lands, and no branch to drop with a dropped Feature.
- **A standing "Fixes" Feature per Team for small work.** No model change, but a Feature that never ends, a Rank slot it holds forever, and no record per fix; the quick Feature keeps the record honest with three rules keyed on one flag.
