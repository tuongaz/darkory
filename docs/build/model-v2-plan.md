# Model v2: Projects, Tasks with Subtasks, Workflows of Steps

Decided with the owner on 2026-10-07 in a question-by-question session (nine decisions, listed at the end). This file is the brief every phase builds from. `CONTEXT.md` already speaks the new language and is the authority on words; [ADR 0015](../adr/0015-projects-tasks-subtasks.md) and [ADR 0016](../adr/0016-workflow-of-steps.md) record the two model changes; `decisions.md` takes the defaults chosen while building, one line each. `CLAUDE.md` holds the standard: never weigh implementation cost.

## What changes, in one screen

| Before | After |
|---|---|
| Team | **Project** — the web app's main context, with its own key, Workflow, Labels, Rank, Workspaces, Members |
| Feature → Task | **Task → Subtask**, one level. A Task with Subtasks is a **Parent**: never claimed, ends by its Owner's Complete or by Auto-complete, optionally after an **Acceptance** |
| Quick Feature | a Task with no Subtasks |
| Ship, `ship_when_done`, `feature/<KEY>` | **Complete**, `auto_complete`, branch `<KEY>` for every Task; a Parent's branch is its Subtasks' base |
| Status (kinds backlog/todo/in_progress/done/dropped) | **Step** of the Project's **Workflow**: name + at most one Skill + position + x/y. Waiting / working / blocked are derived from the Claim and Blocking, never stored |
| Handover to a Skill, `--status` | **Advance** along a **Connector** (a named outcome out of a step; into Done is Complete). A human may **move** a Task to any step by hand |
| — | **Labels** per Project and per Organisation |
| Admin | **Settings** area with its own nav (Account · Organisation · Projects) |

## The record

**No migration: every Install starts from a new database** (the owner, 2026-10-07: "no migration required, just start from scratch new DB"). The schema is rewritten as a single `0001_init.sql` for the v2 record, and 0002–0005 are deleted; `darkory init` seeds a fresh Install. Ids, times and `org_id` as before (plan.md invariant 3).

### Tables

- `projects` replaces `teams`: `id, org_id, key_prefix, name, last_number, default_workspace_id, auto_complete BOOLEAN, acceptance BOOLEAN, created_at`. `project_members` replaces `team_members`. `auto_complete` and `acceptance` are what a Task filed in the Project takes when its filer does not say.
- `tasks` absorbs `features`. Columns added: `project_id` (NOT NULL), `parent_id` (NULL for a top-level Task), `owner_id` (NOT NULL; a Subtask's is its Parent's, copied and kept in step by the owner-passing write), `rank` (top-level Tasks only; NULL on a Subtask), `auto_complete`, `acceptance`, `from_retrospective_task_id`, `step_id` (NULL on a Parent, on a Task aimed at a Member, and on an ended Task), `step_since`, `breakdown BOOLEAN` (filed with Break down on). Columns removed: `feature_id`, `status_id`. `kind` is `work | breakdown | acceptance | retrospective`. `skill_id` goes: a Task's Skill is its step's; `claims.skill_id` stays (the Skill the holder worked under, for no-self-review and the Skill version).
- `steps`: `id, org_id, project_id, name, skill_id NULL, position, x, y, created_at`; unique `(project_id, name)` ignoring case. A step with `skill_id` NULL is a hold.
- `connectors`: `id, org_id, project_id, from_step_id, to_step_id NULL, name, position, created_at`; `to_step_id` NULL means Done; unique `(from_step_id, name)` ignoring case.
- `labels`: `id, org_id, project_id NULL, name, color, created_at`; unique `(org_id, project_id, name)` ignoring case, `project_id` NULL for the Organisation's. `task_labels (task_id, label_id)`.
- `evidence.feature_id` and `observations.feature_id` go; both hang on `task_id` only (Evidence on a Parent is Evidence whose `task_id` is the Parent).
- `views.project_id`; `entity` is `tasks` only. There is no `statuses` table.

### A fresh schema

`0001_init.sql` carries the whole v2 record, with what 0002–0005 added folded in (member deactivation, Workspaces and `task_workspaces`, agent settings, Views). No upgrade path, no data move, no upgrade test: a test that `init` on a fresh database of each engine yields the seeded Organisation, the builtin Skills, `engineer` and `review`, and MAIN with the default Workflow is the proof. The owner's Sacca Install is re-created from scratch (M5).

### The default Workflow

> **2026-10-09:** a new Project now starts with two Workflows, Implementation (the Steps below) and Bug triage; `docs/build/sample-workflows-plan.md` and `decisions.md` › Sample Workflows.

`darkory init` seeds, beside the builtin Skills (`breakdown`, `retro`, `skill-review`, and now `acceptance`), the generic Skills `engineer` and `review` whether or not it seeds the roster. A new Project — `init`'s MAIN, "+ New Project", `project create` — starts with the **default Workflow** unless the creator picks **Copy from <Project>** or **Empty** (Backlog → Done, for a Project that builds its own):

```
Backlog (hold) · Plan (breakdown) · Build (engineer) · Review (review) · Retro (retro) · Skill review (skill-review)
Plan → Done "done" · Build → Review "pass" · Review → Done "pass" · Review → Build "needs changes"
Retro → Done "done" · Retro → Skill review "propose" · Skill review → Done "publish" · Skill review → Retro "needs changes"
```

No Acceptance step by default and `acceptance` off on the Project: a Project that wants one adds the step and turns it on. The roster's agents are as today (planner, builder, reviewer with `review` + `skill-review`, retro). Sample Workflows (2026-10-09): the planner also holds `triage`, and a fifth agent, `tester`, holds `qa`.

`darkory migrate` keeps its `--dry-run` for the releases to come; with one migration it applies 0001 to an empty database and nothing else.

### Rules (core)

Where a rule is unchanged it is not repeated; `docs/build/plan.md`'s invariants hold.

- **Takeable** (one SQL fragment, as before): open, `parent_id` or not — the Task has no Subtasks (`NOT EXISTS` child), not blocked, not claimed, and: aimed at the Member; or at a step whose Skill the Member has, in a Project the Member is in; or at a step whose Skill is skill-review, which the Member has, any Project; or owned by the Member and nobody in its Project has the step's Skill (skill-review: nobody in the Organisation). No-self-review: a Member who held the Task under one Skill may take it again only under that Skill (`claims.skill_id`).
- **Claim** records `skill_id` = the step's Skill (or NULL for an aimed Task). It no longer moves anything.
- **Advance** (`advance {outcome?, note?}`): holder only. The connector is the one out of the Task's step named `outcome`, or the only one when the step has exactly one and `outcome` is empty; else `no_connector` (the refusal lists the step's outcomes). To a step: `step_id`, `step_since`, `waiting_since` set; the Claim ends `advanced`; Activity `task.advanced {from, to, outcome}`. To Done (`to_step_id` NULL): the Task completes (below). An optional Note is written first, as Handover's was.
- **Complete** (`complete`): a worked Task — the holder, allowed only when exactly one connector leads to Done from its step (otherwise `use_advance`, naming the outcomes); a Parent — its Owner, refused `tasks_open` while a Subtask is open. A completed Task: `state` done, `ended_at`, `step_id` NULL. Then: a Parent with an open Acceptance rule (below) and Auto-complete follows its Subtasks.
- **Acceptance**: when a Subtask ends Done while its Parent is still open and has `acceptance` on, every other Subtask has ended, and the Project's Workflow has a step carrying the `acceptance` Skill, Darkory files one Subtask of kind `acceptance` at that step ("Acceptance: <Parent title>", filed by nobody, Owner the Parent's) — unless the Subtask that just ended is itself an Acceptance that ended Done. An Acceptance that ends Dropped files nothing more. `acceptance` is a builtin generic Skill (with breakdown, retro, skill-review).
- **Auto-complete**: when the last open Subtask of a Parent that is still open and has `auto_complete` ends Done, and no Acceptance is due, the Parent completes in the same write, as `ship_when_done` did. A Retrospective ending is a Subtask ending on an ended Parent: neither rule fires.
- **Proposals**: a Retrospective may carry one pending proposal **per Skill** (MAIN-1's Retrospective on 2026-10-07 found two Skills to change and could file only one); `propose` on a Skill that already has a pending proposal on the Task supersedes it, as today. Advancing into Done from the skill-review step publishes every pending proposal on the Task that is still current, and is refused `proposal_stale` with `details.proposals` naming the ones that are not. A Retrospective files new work as top-level Tasks of the Project (an ended Parent takes no new Subtasks but questions), which is what "files new Features" meant.
- **Skill review**: a Retrospective's `propose` is refused `no_step` unless a connector leads from its step to a step carrying `skill-review`; advancing along it is today's handover to skill-review, and advancing from that step into Done publishes the version (refused `proposal_stale` as today when the base is no longer current, the Task moved back along "needs changes" with the refusal as its Note). A step carrying skill-review is takeable from any Project by a Member who has the Skill.
- **Filing**: a Task filed without `step` starts at the first Step carrying a Skill that is not one of those Darkory files its own Subtasks at (breakdown, acceptance, retro, skill-review) — Build in the default Workflow; then the first Step with any Skill; then the first Step; a Workflow with no Steps refuses `no_step`. A Subtask filed without `workspaces` takes its Parent's (its branch starts from the Parent's); a top-level Task takes the Project's default. `Error` carries `details` for programs: `outcomes` on `no_connector` and `use_advance`, `proposals` on `proposal_stale`.
- **Breakdown**: `file` with `breakdown: true` files the Task and, in the same write, its Breakdown Subtask at the Project's breakdown step (refused `no_step` when the Workflow has none). The Task is a Parent from its first moment.
- **Retrospective**: when a Parent ends, done or dropped, and the Workflow has a retro step, Darkory files the Retrospective Subtask there. A Task without Subtasks files none.
- **Filing a Subtask** (`file` with `parent`): the Parent must be open and not itself a Subtask (`one_level`). Under a held Task: only its holder may, and the write ends their Claim `split` and writes the Note given; anyone in the Project under an unheld one. The first Subtask makes the Task a Parent: `step_id` NULL (Activity `task.became_parent`).
- **Move** (`step {step}`): any active Member of the Project or the Owner moves an unheld, open, non-Parent Task to any step of its Workflow, or out of a hold; a held Task may be moved only by whoever may take it back, and the write ends the Claim `taken_back` first. Activity `task.moved`. Moving into a step is the only way out of a hold.
- **Escalation / questions** (`file --blocks T --aim M`): the new Task's `parent_id` is T's, or NULL when T has none; `step_id` NULL (aimed).
- **Drop**: the Owner; a Parent's drop cascades to open Subtasks as a Feature's did.
- **Rank**: `rank` on top-level Tasks per Project; `rank {position}` as `/features/{feature}/rank` did; a Subtask sorts by its Parent's.
- **Owner**: `owner {member}` on a top-level Task updates it and its Subtasks in one write; a Subtask's Owner cannot be set directly (`use_parent`).
- **Labels**: `PUT /v1/tasks/{task}/labels {labels: [ids]}` by any Member of the Project; a Label must be the Project's or the Organisation's.
- **Workflow**: `PUT /v1/projects/{project}/workflow` replaces the whole thing (steps with ids for existing rows, connectors, positions), by an admin. Refused: `invalid` when a connector names a missing step or two connectors out of one step share a name; `step_in_use` when a deleted step has Tasks and `moves {from: to}` does not say where they go; `skill_in_use` never (a step's Skill may change; Tasks at it keep their place, and the next `next` reads the new Skill). The breakdown, acceptance and retro steps are the ones carrying those builtin Skills; a Workflow may have none of them. Activity `workflow.changed`.
- **Activity kinds**: `feature.*` → `task.*` (`task.filed` carries `parent`, `breakdown`, `auto_complete`, `acceptance`), `team.*` → `project.*`, `statuses.changed` → `workflow.changed`, `task.handed_over` → `task.advanced`, new `task.moved`, `task.split`, `task.became_parent`, `task.labels_set`, `label.*`. Darkory's own filings (Breakdown, Acceptance, Retrospective) have no actor.
- **Filters** (`internal/core/filter.go`, both lists are now one): `step:is|in|nin` (ids), `label:in|nin`, `parent:is:<id>|none`, `top:is:true` (top-level only), `kind` adds `acceptance`, `takeable_by:is:agents|humans|both` (who in the Project holds the step's Skill), `owner`, `rank`, `auto_complete`, `acceptance`; `status`, `status_kind`, `team`, `feature`, `quick`, `ship_when_done` go; `project` replaces `team`.

## `/v1`

Spec first: `api/openapi.yaml`, then `make gen` and `cd web && npm run gen`, generated code committed.

- `/v1/projects`, `/v1/projects/{project}` (GET, PATCH: name, default_workspace, auto_complete, acceptance), `/v1/projects/{project}/members/{member}` (PUT, DELETE), `/v1/projects/{project}/workflow` (GET, PUT), `/v1/projects/{project}/labels` (GET, POST), `/v1/labels` (GET, POST: the Organisation's), `/v1/labels/{label}` (PATCH, DELETE).
- `/v1/tasks` (GET with the filters above; POST files a Task or, with `parent`, a Subtask: `project`, `title`, `description`, `parent`, `owner`, `step`, `breakdown`, `auto_complete`, `acceptance`, `labels`, `workspaces`, `aim`, `blocks`, `note`), `/v1/tasks/{task}` (GET: `TaskDetail` carries `parent` brief, `subtasks` list, `step`, `labels`, `connectors` out of its step, `subtask_counts`), `/claim`, `/heartbeat`, `/release`, `/advance`, `/step`, `/complete`, `/drop`, `/take-back`, `/owner`, `/rank`, `/labels`, `/notes`, `/observations`, `/blockers/{blocker}`, `/skill-proposals`, `/evidence`. Gone: `/v1/features/*`, `/v1/statuses`, `/v1/tasks/{task}/status`, `/v1/tasks/{task}/handover`, `/v1/teams/*`.
- `/v1/me`: `projects` replaces `teams`; `organisations` (optional, absent on Local) lists `{id, name}` the sign-in identity reaches, for the switcher Cloud will show.
- `GET /v1/projects/{project}/workflow` also returns live facts per step: `tasks` (open Tasks at it), `working` (with a live Claim), `takers` (Members of the Project holding its Skill, with `kind`), `median_ms` (time at step over the last 30 days from `task.advanced`/`task.moved`/`task.filed` entries — Darkory records `step_since`, so the current dwell is exact).
- Task records carry `project_id`, `parent_id`, `owner_id`, `rank`, `step_id`, `step_since`, `labels` (ids), `kind`, `breakdown`, `auto_complete`, `acceptance`, `subtask_counts {open, working, done, dropped}` on a Parent.
- Error codes new: `no_connector`, `use_advance`, `no_step`, `one_level`, `held`, `step_in_use`, `use_parent`.

## CLI and MCP

- `project create|list|show|add|remove|set` replace `team *`; `workflow show <project>` (text: steps, skills, connectors, counts) and `workflow set <project> --file <json>` replace `workflow set`; `label create|list|set` (`darkory label set MAIN-4 bug,client-x`).
- `file` gains `--parent`, `--breakdown`, `--step`, `--label`, `--owner`, `--auto-complete`, `--acceptance`; `advance <task> [outcome] --note`; `move <task> <step>`; `complete` as today for holders (one connector to Done) and for Owners of Parents; `rank <task> <position>`; `owner <task> <member>`; `tasks` prints the step and the Parent; `show` prints Subtasks and the connectors out. Gone: `feature *`, `status`, `handover`, `workflow set` (the old form).
- MCP tools follow the CLI one for one: `advance`, `move_step`, `set_labels`, `file_task` with `parent`; `show_task` and `list_tasks` carry the step, the Parent and the outcomes. The `prime` rules text says: a Task is at a step; end your work with `advance <outcome>`; the outcomes are listed on the Task.

## Runner

- `next` is unchanged. The session's Checkout: branch `<KEY>` (lower-cased key, then the slug: `main-7-support-emoji`), from the Parent's branch when the Task is a Subtask (the Runner creates and pushes the Parent's branch `<PARENT-KEY>` from the default branch when the first Subtask's session needs it, as Break down did), else from the default branch. The ledger (`branches.json`) records both.
- On `advance` into Done, and on `complete`: merge the Task's branch into its base (plain mode) or read the merged pull request carrying the key (PR mode), as the review's Complete did; a Parent's Complete merges `<PARENT-KEY>` into the default branch or opens that pull request; conflicts reopen as before (a Note, the Task moved back to the first work step).
- The prompt says "Its Parent" where it said "Its Feature", lists the connectors out of the Task's step as the ways to end (`darkory advance <outcome>`), and for an Acceptance session checks out the Parent's branch with everything merged. `Nudge` wording: "advance it, complete it, or file a question".
- `ADR 0013`'s three-strikes question Task is filed as a Subtask of the Task's Parent (or standalone), aimed at the manager.
- **Progress must survive a long tool call.** MAIN-1's Retrospective (2026-10-07) measured 14 lapsed builder Claims out of 16: each session sat in one silent foreground `make verify` (~10.5 min) while the Runner reads progress from the transcript's modified time (stale after 2 min, the Claim's timeout 5 min), so the Runner stopped Heartbeats and the Claim lapsed mid-call. The Skill text now tells the agent to run long calls in the background with a Monitor, but the Runner must not depend on that: M3 makes a running tool call count as progress — the transcript's last entry is a `tool_use` without its `tool_result`, so the call is in flight; treat it as progress until the Claim's own timeout would end it, and say in the session log when it does — and extends the stale window for a session whose child processes are alive. Test it with a fake agent that blocks 6 minutes in one call.

## Web

Shell and routes per the sidebar sketch agreed in the session:

- **Switcher** at the top of the sidebar: the Project's mark and name; its menu: the Organisation's name heading (→ Organisation settings), the Projects, "+ New Project", and "Switch Organisation" only when `/v1/me.organisations` has more than one (never on Local). The current Project follows the record (opening `MAIN-2` from the Inbox switches to its Project) and is remembered per browser; routes stay `/projects/:key/...`.
- Under it: **Inbox**, **My work** (cross-Project, each row with its Project mark); then the Project's group: **Tasks** (list | board, `?view=`), **Workflow** (the live canvas), **Agents** (this Project's agents and sessions), **Activity** (this Project's), **Settings** (⚙ → `/settings/projects/:key`). Search ⌘K lists Projects to switch; `G` then a Project's key jumps.
- **Settings area** `/settings/*` with its own left nav: Account (profile, sign out) · Organisation (Members, Agents, Skills, Labels, Install — admins) · Projects (each: General with name, key, defaults; Workflow — the same canvas, editing; Members; Labels; Workspaces; "+ New Project"). `/admin/*` redirects. The footer's "Admin / Member" caption goes.
- **Tasks list** groups by step (hold steps and Done at the ends); a Parent row shows a progress mark (`3/5`) and expands its Subtasks; the **board**'s columns are the steps in list order plus Done; dragging a card to a column is `move` (refused drags toast the rule); a held card may be dragged only by whoever may take it back, and the toast says the Claim ends. **Display** keeps layout, grouping, Show toggles; **Filters** gain Step, Label, Parent, Takeable by; lose Status, Feature, Quick.
- **Task page and peek**: header with key, title, Labels, Owner, Parent (link), step; the **Subtasks** section as `List | Graph`: the graph lays Subtask nodes in their step's column (Done at the right) with Blocking arrows, takeable-now nodes highlighted, the rest dimmed, built on the same React Flow; a Parent's progress and its Acceptance/Retro Subtasks marked by kind; actions: Advance (a split button listing the outcomes), Move, Complete (Owner, Parents), Drop, Pass ownership, Rank; a stepper of the Task's path through the steps with time at each (from Activity and `step_since`).
- **Workflow canvas** (`@xyflow/react` 12, `base.css` bundled; `@dagrejs/dagre` for Tidy up): a step node shows name, Skill, the takers as mini avatars, counts (waiting · working), a warning when nobody holds its Skill; a hold step is drawn dashed; Done and Dropped are fixed terminal nodes at the right; connectors are labelled edges; Darkory's own arrows (Drop from anywhere) are dashed and not editable. Live mode (Project › Workflow) is read-only and refetches on `workflow.changed` and Task Activity. Editing mode (Settings › Workflow): click a step → side panel (name, Skill pick-or-create, the Project's Members with it, add a Member, create an agent — token shown once — outgoing connectors, delete with the move-Tasks-to prompt); click a connector → name, reconnect by dragging an end, delete; "+" on a node's handle → new step; Tidy up; positions saved on drop. Every change is one `PUT …/workflow`; what `/v1` would refuse is said in words first, as the Status editor did.
- **Marks**: every avatar round with a border; an agent's border is the AI gradient (`--agent-gradient`: violet-led blend, defined for both themes); the "working" glyph on a row or card rotates the same gradient only while an agent's Claim is live and heartbeating (a Runner session `running` counts), stops amber for `waiting`, red for `stalled`, grey for `ending`; a human's live Claim is a still single-colour ring; a standalone avatar (Agents page, canvas node, graph node) rotates its own border instead. `prefers-reduced-motion` stops the rotation. All in `globals.css` (the build forbids injected styles).
- **Inbox, My work, Agents, Activity** take the new words (Parent, step, advance, move); Agents shows each agent's Projects.
- Vitest beside each screen; Playwright scenarios updated and extended (below).

## Sacca

The owner's Install at `darkory/.dev` is **re-created from scratch** (no migration; the old one is parked beside `.dev.bak-20261007` as `.dev.v1-<date>`, with its `agents/*.token` files no longer valid). When `model-v2` merges into main and the owner's `make dev` restarts:

1. Stop the old server; park `.dev`; `darkory init --org Sacca --data .dev` from the enably-v2 directory (so it becomes the Workspace, as on 2026-10-07), Member `tuongaz` admin; `make dev` picks the new Install up.
2. `scripts/sacca-v2.sh` (committed, idempotent) sets up what `init`'s default does not: the generic `qa` Skill and the `qa` agent (sonnet-5-5) with `qa` + `acceptance`; the company Skills `enably-engineer|qa|review|breakdown|retro` from `.dev/skills/*.md` (the v2 texts: engineer ends with `advance pass` and never completes; qa `advance pass` / `advance fail`, and the Retrospective's unfiled change — capture every screenshot through ui-review's helper, run `review.py` before `verify.down`; review `gh pr merge` then `advance pass`; breakdown files Subtasks with `--parent`; retro in v2 words, filing follow-ups as top-level Tasks and one proposal per Skill); Workspace enably-v2 in `pull_request` mode; Project MAIN's Workflow: Backlog · Plan (breakdown) · Build (engineer) · QA (qa) · Review (review) · Acceptance (acceptance) · Retro (retro) · Skill review (skill-review); Build → QA "pass", QA → Review "pass", QA → Build "fail", Review → Done "pass", Review → Build "needs changes", Acceptance → Done "pass", Acceptance → Build "fail", plus the default's Plan, Retro and Skill review connectors; `acceptance` and `auto_complete` on for the Project; `local.mk` unchanged (`DARKORY_RUNNER_ENV=OPENROUTER_API_KEY`).
3. The old `feature/MAIN-1`, `MAIN-4/…`, `MAIN-5/…` branches and `.dev/workspaces/branches.json` are history: MAIN-1 shipped on the old model (pull request #1290 into main is the owner's to merge). The new ledger starts empty; the Runner's new branch names (`main-7-…`) cannot collide with them.
4. The first v2 Task is filed by the owner; the proof (below) runs on a separate test Install, never on Sacca's.

## Phases

Each phase in a worktree under `/Users/tuongaz/dev/darkory-wt/<name>`; main receives merges only; `make check`, `make web-check`, `make e2e`, `make e2e-pg` and `cd web && npm run e2e` green before a merge; decisions to `decisions.md`.

- **M1 record and `/v1`** — the fresh `0001_init.sql` on both engines; core rules and tests (every rule above, both orders of lapse/claim where a Claim is involved, the race suite, the fresh-`init` test); `openapi.yaml`, server, generated client; the Go e2e bots (`tools/bots`) and suites on steps and `advance`. Nothing else starts before M1's spec is merged.
- **M2 CLI and MCP** — commands, `prime` rules, tests, `README`.
- **M3 Runner** — branches, merges, prompt, Acceptance sessions, tests, `docs/build/settings.md`.
- **M4 Web** — four worktrees once M1 is merged: shell + switcher + settings area; Tasks list/board + Task page/peek + Subtask graph; Workflow canvas (live + editing); Inbox/My work/Agents/Activity + Filters/Views + marks. Then one integration pass.
- **M5 Sacca and proof** — migrate the owner's Install, rewrite the Skill texts, run the bots' accounting scenario (`e2e/bots_accounting_test.go` already sketches a non-coding Project) and the coding scenario end to end, Playwright scenarios with screenshots, an Artifact pairing each screen with its decision for the owner's review.

## Scenarios the proof must show

1. File a Task with Break down in Sacca; the planner files Subtasks; the builder advances `pass` to QA; qa `fail` returns it to Build with a Note; `pass` again; review merges and advances into Done; Acceptance runs; the Parent auto-completes; the Retro is filed.
2. The same in an accounting Project (Gather · Prepare · Partner review · Lodged) with human Members only: a human moves a Task out of Backlog, advances it, the partner completes it — no agent, no Workspace.
3. A standalone Task (no Subtasks) filed straight at Build, worked and completed by `advance` into Done, its branch merged.
4. The holder splits a held Task: the Claim ends `split`, the Task becomes a Parent, its Subtasks start at Build.
5. A question from a Subtask lands beside it under the same Parent; from a standalone Task it stands alone and blocks it.
6. Workflow editing: rename a step while the board is open (columns update live); delete a step with Tasks (the prompt asks where they go); add a step with a new Skill and a new agent; a step nobody holds shows the warning on the canvas and the list.
7. The board: drag between steps; a held card dragged by someone who may not take it back is refused with the rule; by the Owner, the Claim ends.
8. The Subtask graph: columns, arrows, the highlighted next ones, a running ring on the working node.
9. Marks: an agent's gradient border still and turning; a human's plain border; the session colours.
10. Settings area from both doors; `/admin/members` redirects; a non-admin sees Account and their Projects only.
11. A fresh `init` on each engine: the Organisation, the builtin Skills, `engineer` and `review`, the roster, MAIN with the default Workflow, the printed link; the Install checklist in the web app leads from there to the first Task.
12. Organisation switching: `organisations` absent → no row; present with two → the row shows (a test fixture, since Local never has two).

## The nine decisions, as taken

1. Task + Subtask, one level; a Parent is never claimed; the holder may split; Break down is a switch at filing.
2. Complete is the one verb; Feature, Quick and Ship go.
3. Team → Project, the main context; Inbox and My work cross-Project; Organisation switching built in, UI hidden.
4. Status dropped; a Workflow of Steps (name + one Skill) and Connectors (named outcomes); `advance`; Breakdown, Acceptance and Retro are steps carrying those Skills; a Parent may require an Acceptance before it counts as done.
5. Workflow canvas on React Flow: live in the Project's list, editing under Settings.
6. Task page: Subtasks as List | Graph, the graph over the Workflow's columns with Blocking arrows.
7. The working glyph spins the AI gradient only for an agent's live, heartbeating Claim; session state sets its colour.
8. All avatars round with a border; agents get the gradient border; takers as mini avatars.
9. Settings area with its own nav; Labels per Project and Organisation.
