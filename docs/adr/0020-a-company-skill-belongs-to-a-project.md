# A company Skill belongs to a Project

Renamed 2026-10-10: the kind `company` is `own` (decisions, "Dogfood follow-ups"); read "own Skill" for "company Skill" below.

A company Skill names the Project it belongs to, or names none and belongs to the whole Organisation. A Step keeps naming the generic Skill it carries (engineer, qa), and the Runner builds a Shift's prompt from that generic Skill and the agent's company Skill built on it **only when that company Skill is the Task's Project's, or the Organisation's**. A Step of one Project cannot carry a company Skill of another. Grants are unchanged: a Member holds a Skill by id, and Takeable reads the Step's Skill as before.

We chose this because the run of 2026-10-10 on the Darkory repo showed the gap: the Install's `qa` agent held `enably-qa`, the Sacca preset's company Skill on `qa`, and its Verify Shift on DARK-3 carried Sacca's stack steps into a Darkory Task, where the agent wrote that they "do not apply to this repo". The mechanism was exactly as built: the prompt took the agent's company Skill built on the Step's generic Skill, whatever the Project, because a company Skill had no Project to be of. A company Skill is a company's own knowledge of a capability, and in an Organisation of several Projects that knowledge is mostly a Project's (its repository, its stack, its checks); what is truly the whole company's can still say so by naming no Project. Keeping the Step on the generic Skill is what keeps a Step portable: the same Bug triage Workflow serves two Projects, and each Project's agents bring their own company Skill to it.

Decided on 2026-10-10, after the owner picked the follow-ups of the dogfood review ([`docs/build/dogfood-2026-10-10.md`](../build/dogfood-2026-10-10.md), issue 6).

## Considered Options

- **The Step names the company Skill.** Explicit, and already expressible (a Step may carry any Skill). But then every Workflow is a Project's own and cannot be shared or copied, and a Task's taker is whoever holds that one company Skill, so a Member who holds the generic one is refused a Task they could do.
- **A company Skill names several Projects.** A set where one name does: a Skill that serves two Projects is two Skills with two bodies the moment their stacks differ, which is the case the run found.
- **Leave it to the agent's grants: grant a company Skill only to agents of its Project.** The run's `qa` agent is in both Projects, and the roster is shared by design; grants say who may take, not what is true of a Task.
- **Filter in the prompt by Workspace instead of Project.** A Workspace is where a Shift works, not what the work is; a Project with two Workspaces would split its one company Skill.

## Consequences

- `Skill.project_id`, optional; `skill create --project`, `skill set --project`; the preset's `setup.sh` passes its Project. Existing company Skills stay the Organisation's until an admin sets their Project: the record cannot tell which Project an existing Skill was written for.
- The Runner's prompt includes a company Skill built on the Step's generic Skill only when its Project is the Task's or none; the Skills page and `member show` say the Project.
- `PUT …/workflow` refuses a Step carrying another Project's company Skill (`invalid`).
