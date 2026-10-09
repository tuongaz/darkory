# Sample Workflows — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development: one implementer, one code review, then the full gate.

**Goal:** A new Project starts with two Workflows instead of one: **Implementation** (today's default Steps) and **Bug triage** (Triage → Fix → Code review → Verify → Done, with outcomes that drop a report or cross into Implementation). The owner (2026-10-09): "Update the sample workflows: 1. A workflow for task implementation 2. A workflow for bug triage"; shape picked from three: "Two Workflows, linked".

**Architecture:** `project create --workflow default` (and init's MAIN, and + New Project) builds the graph from a planned list of Workflows instead of one planned Workflow; `empty` and `copy` are unchanged. Two generic Skills, `triage` and `qa`, join `engineer` and `review` in init's seed; the roster's planner holds `triage` and a fifth agent, `tester`, holds `qa` (amended after Task 1's review, below: the plan first gave `qa` to the reviewer, who could never take Verify after Code review). The spec's `NewWorkflow` description changes (text only; the enum stays), so the generators run. No migration: existing Projects keep their Workflows.

**Worktree:** `/Users/tuongaz/dev/darkory-wt/shell-nav`, branch `sample-workflows` from main 2f03ebc. Never `go build` at the checkout root without `-o`; never `git add -A`; commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Glossary words only on screen (`CONTEXT.md`): Workflow, Step, Task, Skill; the new words are names (Implementation, Bug triage, Triage, Fix, Code review, Verify) and Skill names (`triage`, `qa`), like `engineer`.

---

## The shape, exactly

Workflow 1, **Implementation** (position 1), Steps and places as today's `defaultWorkflow`:

| Step | Skill | x, y |
|---|---|---|
| Backlog | (hold) | 0, 0 |
| Plan | breakdown | 0, 128 |
| Build | engineer | 0, 256 |
| Review | review | 448, 256 |
| Retro | retro | 0, 384 |
| Skill review | skill-review | 448, 384 |

Connectors as today: Plan → Done `done`; Build → Review `pass`; Review → Done `pass`, Review → Build `needs changes`; Retro → Done `done`, Retro → Skill review `propose`; Skill review → Done `publish`, Skill review → Retro `needs changes`.

Workflow 2, **Bug triage** (position 2):

| Step | Skill | x, y |
|---|---|---|
| Triage | triage | 0, 0 |
| Fix | engineer | 448, 0 |
| Code review | review | 896, 0 |
| Verify | qa | 1344, 0 |

Connectors: Triage → Fix `bug`; Triage → Done `not a bug`; Triage → **Build** (Implementation) `feature`; Fix → Code review `ready`; Code review → Verify `pass`; Code review → Fix `needs changes`; Verify → Done `pass`; Verify → Fix `fail`.

Two facts the owner's preview got wrong, owned here: (1) a Project has one place where New Tasks start, the first Workflow's first Step carrying a working Skill, so with Implementation first (the owner's own numbering) New Tasks start at **Build**; a bug is filed at Triage from the Bug triage board's + or File Task with its Step. (2) Step names are unique per Project (`workflow.go` ~839: "two Steps are named …"), so the second review Step is **Code review**, as the seed's Features Workflow names it.

---

## Task 1: Go — the planned Workflows, the Skills, the roster, the spec, the CLI

**Files:** `internal/core/workflow.go` (~262–360), `internal/core/model.go:147-149` (comment only), `internal/core/install.go` (constants, `seededSkills`, roster at ~73–76), `api/openapi.yaml:2828-2836`, generated code (`make gen`, `cd web && npm run gen`), `internal/cli/projects.go:19,35`.

**Step 1: failing tests.** `internal/core/init_test.go`: the init proof asserts MAIN has two Workflows in order, Implementation then Bug triage, with the Steps and Connectors above (names, Skills, the crossing `feature` → Build), and that init seeds `triage` and `qa` (generic, not builtin) beside `engineer` and `review`; the roster's planner holds `breakdown` and `triage`, the reviewer `review`, `skill-review` and `qa`. `internal/core/workflow_test.go`: `project create --workflow default` yields the two; `empty` still yields one Workflow named Work (Backlog → Done); a Task filed into a default Project without `step` starts at Build. Run `go test ./internal/core/ -run 'Init|Default|Workflow' -count=1`; expect FAIL.

**Step 2: implement.**

`workflow.go`: keep `WorkflowFirstName = "Work"` (migration 0006 and `empty`); add
```go
// The two Workflows a default Project starts with (sample-workflows-plan.md).
const (
	WorkflowImplementation = "Implementation"
	WorkflowBugTriage      = "Bug triage"
)
type plannedWorkflow struct {
	name       string
	steps      []plannedStep
	connectors []plannedConnector // `to` may name a Step of another planned Workflow
}
var defaultWorkflows = []plannedWorkflow{ {Implementation…}, {Bug triage…} }
var emptyWorkflow = plannedWorkflow{name: WorkflowFirstName, steps: …Backlog…, connectors: …}
```
In the `default:` branch of the planner (~345): build `in.Workflows` from the planned list (positions 1, 2) and each Step's `StepInput.Workflow` from its planned Workflow's name; Step positions restart at 1 per Workflow; connectors by Step name as today (names are unique per Project). `empty` builds from `emptyWorkflow` alone. Update the doc comments (the one at ~278 names model-v2-plan; add this plan).

`model.go:147`: the comment says Work "names the one Workflow an empty Project starts with, as migration 0006 named every existing Workflow".

`install.go`: `SkillTriage = "triage"`, `SkillQA = "qa"`; `seededSkills` gains both, generic, bodies in the register of `engineer` and `review` (what to do, what Evidence, when to advance and along which outcome):
- triage: "Triage a reported problem. Read the Task, reproduce what it describes and record what you saw as a Note. Advance it along bug when it is a defect to fix, along feature when it asks for something new, or along not a bug when there is nothing to change, each with a Note saying why."
- qa: "Verify a fix. Read the Task and the Notes of the Fix and Code review, run the change on its branch, reproduce the original report and confirm it no longer happens, and attach what you ran as Evidence. Advance it along pass when the fix holds; along fail with a Note saying what still happens."
Roster: planner `Skills: {SkillBreakdown, SkillTriage}`; reviewer `{SkillReview, SkillSkillReview, SkillQA}`. Update the comment at ~24 ("The generic Skills engineer and review" → the four).

`api/openapi.yaml:2828-2836` `NewWorkflow.description`: "The Workflows a new Project starts with. `default`: Implementation (Backlog · Plan · Build · Review · Retro · Skill review, carrying `breakdown`, `engineer`, `review`, `retro`, `skill-review`) and Bug triage (Triage · Fix · Code review · Verify, carrying `triage`, `engineer`, `review`, `qa`; Triage's outcomes lead to Fix, to Done, or into Implementation's Build), with their Connectors; New Tasks start at Build. `empty`: one Workflow named Work, Backlog, a hold, → Done. `copy`: every Workflow of another Project, with its Steps and Connectors. `default` when not given." Then `make gen` and `cd web && npm run gen`; commit what changes (`gen-check` fails otherwise).

`internal/cli/projects.go:19`: "create a Project with its Workflows (admin)"; `:35`: "the Workflows: default (Implementation and Bug triage), empty (Backlog into Done), or copy (with --copy-from)". Check `cmd/darkory` and `docs/` for the same words (`grep -rn "first Workflow" cmd internal/cli docs/*.md README.md`).

**Step 3: run** `go test ./internal/core/ ./internal/cli/ -count=1`, then `grep -rn '"Work"\|WorkflowFirstName\|Skill review' --include='*_test.go' internal cmd e2e` and read each hit: tests that build their own graph are fine; tests that assume a default Project's first Step is Build still hold; tests that assume one Workflow named Work in a default Project change to Implementation (or to two Workflows). `go test ./... -count=1` green.

**Step 4: commit** by name: "Core: a new Project starts with two Workflows, Implementation and Bug triage; init seeds triage and qa; the planner and reviewer hold them".

## Task 1, amended after review (the controller's calls)

Two defects were the plan's, found at review of 71f89a6:

1. **`qa` goes to a fifth roster agent, `tester` (`claude-sonnet-5-5`), not the reviewer.** A Member who held a Task under one Skill takes it again only under that Skill (ADR 0001, CONTEXT.md), so a reviewer that took Code review under `review` can never take Verify under `qa`, and the planner (triage) and builder (engineer) are barred the same way: on a fresh init every bug stopped at Verify. The roster is planner (breakdown, triage), builder (engineer), reviewer (review, skill-review), tester (qa), retro (retro); init's print and roster table gain the row; docs that say "four agents" say five. Add a core test that walks one Task through Triage → Fix → Code review → Verify → Done with each seeded agent through `next` (bug, ready, pass, pass).
2. **The Skill names stay `triage` and `qa`; their bodies become outcome-agnostic**, in the register of `engineer` and `review`, which also name no outcome: a generic Skill is one capability shared across the Organisation, and presets (the software example, the bots, the seed) keep an existing Skill of the name, as they already do for `engineer` and `review`; a second near-name (`bug-triage`, `verify`) would put two Skills for one capability on an Install. Bodies: triage — "Triage a reported problem. Read the Task, reproduce what it describes and record what you saw as a Note; commit nothing on its branch. Advance it along the outcome that names what you found, with a Note saying why." qa — "Verify a fix. Read the Task and its Notes, run the change on its branch, reproduce the original report and confirm it no longer happens, and attach what you ran as Evidence. Advance it along the outcome that says whether the fix holds, with a Note of what still happens when it does not."

Also from the review: `e2e/bots_test.go:38-39`, `docs/build/testing.md:63` and `docs/build/decisions.md:250` say Setup keeps init's agents "with the same names and Skills" / "keeps init's planner, reviewer and retro": add "with exactly the preset's Skills"; `docs/workflows/software.md` gets a sentence that a Project on the default Workflows is refused (its Triage and Code review clash with the preset's Step names) and a fresh Project through `setup.sh` works; `e2e/preset_test.go`'s OLD comment says it hand-builds Work because of that clash; `internal/core/projects.go:40,120` say "its Workflows"; the `defaultStep` comment at `workflow.go:208` is rewrapped; `workProject`'s doc says it is frozen on purpose.

### Amended again after the final review (2026-10-10, the controller's call)

The bodies above named one kind of Task: "a reported problem", "a fix". A generic Skill is one capability shared across the Organisation, and the software preset's own `triage.md` ("Decide what a newly filed Task needs before anyone builds it…") and `qa.md` ("Verify what a Task built from its user's side…") read the same names for any Task; init's bodies would have superseded them with narrower ones. So the bodies describe the capability, not one use of it, and the preset's two files carry the same text, so one capability reads one way on every Install. Verbatim:

- triage: "Triage a newly filed Task. Read it; when it reports a problem, reproduce it and record what you saw as a Note; make its outcome checkable and judge its risk; commit nothing on its branch. Advance it along the outcome that names what you found, with a Note saying why."
- qa: "Verify what a Task changed, from its user's side. Read the Task and its Notes, run the change on its branch the way its user would, including the edges and the failure cases; when it fixes a report, reproduce the report and confirm it no longer happens. Attach what you ran as Evidence; never fix the code yourself. Advance it along the outcome that says whether the change holds, with a Note of what still happens when it does not."

Also from the final review: `api/openapi.yaml`'s `createProject` description still said "one Workflow named Work" (the generated client, server and `schema.gen.ts` with it); it names Implementation and Bug triage and that a Task filed without a Step starts at Build, then `make gen` and `npm run gen`. `docs/workflows/software.md` says init seeds `triage` and `qa` and the preset keeps them, as it does `engineer` and `review`. Six comments that said "the default Workflow" for a default Project say Workflows. decisions.md's two "default Workflow" lines (a new Project; init's MAIN) are struck as replaced.

## Task 2: Web — the dialog's words and the specs that knew one Workflow

**Files:** `web/src/app/NewProjectDialog.tsx:32` help → "Implementation · Bug triage" (terse, the two names); `web/src/api/schema.gen.ts` from `npm run gen` (Task 1); `web/e2e/init.spec.ts`, `web/e2e/avatar.spec.ts`, `web/e2e/workflow.spec.ts`, `web/e2e/workflows.spec.ts`, `web/e2e/settings.spec.ts`, `web/e2e/*.lab.ts`, `web/e2e/compare.mjs` (fine: position-based).

MAIN now has two Workflows, so every spec that treated MAIN as a Project of one changes: the Workflows list shows two rows (Implementation, Bug triage); the Workflow page shows the chip, not the plain name crumb; "Work" is "Implementation"; `workflowPage("MAIN")` (sorted by position) is Implementation. Test 13 of `workflows.spec.ts` ("a Project of one Workflow lists it, with + Workflow") needs a Project of one: create it in the spec with `--workflow empty` through the CLI/API the spec already uses (name it so the screenshot `list-one` still means that), or delete Bug triage from a fresh Project through the list's 🗑 and assert the one row. Unit tests use their own fixtures (`wf-work`) and are unaffected unless they assert the dialog's help text (`grep -rn "Backlog · Plan" web/src`).

Run `cd web && npm run typecheck && npm run lint && npx vitest run`, then `npm run build && npx playwright test`. Commit: "Web: the New Project dialog names Implementation and Bug triage; the specs know a default Project has two Workflows".

## Task 3: Docs, then the gate

- `docs/build/decisions.md`: a block `### Sample Workflows (2026-10-09)` after Named Workflows, one line each with its reason: the two Workflows and their Steps (why: the owner's ask and pick; Implementation first because New Tasks start in the first Workflow and the owner numbered it first); Code review not Review (why: Step names are unique per Project); `triage` and `qa` seeded and held by the planner and the reviewer (why: a sample Step no seeded agent can take waits on a human); `empty` keeps Work (why: migration 0006's name).
- `docs/build/model-v2-plan.md` "The default Workflow" section: a dated paragraph pointing here.
- `CONTEXT.md`: unchanged unless a glossary term is touched (check "Workflow" and "Skill" entries name "Work" or the default's Steps).
- The gate, full, from the worktree root: `make web-check`, `cd web && npm run e2e`, `make check`, `make e2e`, `make e2e-pg`. Then PR (body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), merge `--no-ff` from the main checkout, push.

## State

Plan written 2026-10-09 on `sample-workflows` (65a2060).

- **Task 1** (Go): 71f89a6. Review found two defects that were the plan's, not the build's: Critical, the reviewer holding `qa` could never take Verify after Code review (ADR 0001's self-review rule), so every bug stopped there on a fresh init; Important, `triage`/`qa` bodies named one outcome each while a generic Skill of that name may already exist on an Install and presets keep it. Both amended above (the controller's calls: a fifth roster agent `tester`; outcome-agnostic bodies) and fixed in 40b3440 with a walk test Triage → Fix → Code review → Verify → Done on the seeded agents, plus the stale comments and docs the review listed. Bots' Setup revokes Skills a Spec does not name: 8fd0df3.
- **Task 2** (Web): fd4e94f (the dialog's help, the specs on a two-Workflow MAIN; Project ONE on `empty` for the Project-of-one tests). Follow-up for the fifth agent: da58137 (init.spec asserts the five roster rows whole; session.spec pauses tester with the other roster agents; comments).
- **Task 3** (Docs, gate): b11de16. The final review of the branch (2f03ebc..b11de16) found: Critical, `createProject`'s spec description still said one Workflow named Work (a spec-first miss; the plan asked for the grep); Important, init's `triage`/`qa` bodies named a reported problem and a fix while the preset's own files read the names for any Task; Important, two decision lines unstruck; Minor, the owner's Install has no tester (for the PR's notes), six "default Workflow" comments. Amended above (bodies describe the capability; the preset's files carry the same text) and fixed in 2e39f72 (spec, gen, bodies, preset files, software.md, comments); the decision lines and this record in the commit after it. The gate ran on the final head; its results are in PR #6.
