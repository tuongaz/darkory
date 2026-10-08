# Named Workflows (ADR 0019) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Read `CLAUDE.md`, `CONTEXT.md`, `docs/adr/0019-named-workflows.md` and `docs/build/plan.md` first. Every word on screen, in the CLI and in the API's descriptions comes from `CONTEXT.md`.

**Goal:** A Project's Steps and Connectors are grouped into one or more named Workflows, each with its own board and canvas; a Connector may lead into a Step of another Workflow of the same Project; a Task's Workflow is that of its Step and is never stored.

**Architecture:** One new table, `workflows`, under `steps`; one write, `PUT /v1/projects/{project}/workflow`, still puts the Project's whole graph in place, with its Workflows, so a crossing Connector and the Step it reaches land in one transaction. A Workflow's `position` orders the Project's Steps (Workflow first, then Step), so "the first Step" and the builtin Steps keep their meaning. An ended Task keeps `last_step_id`, the Step it ended at, so a Done card lands on the board of the Workflow it ended in. The web shows one Workflow at a time, picked by a chip in the breadcrumb and `?workflow=`.

**Tech Stack:** Go 1.26 (`internal/core`, `internal/server`, `internal/cli`, `internal/mcp`, `internal/runner`), SQLite + Postgres from split migrations, oapi-codegen from `api/openapi.yaml`, React + TypeScript + Vitest + Playwright in `web/`.

**Rules of this build** (from `docs/build/ui-plan.md` and `CLAUDE.md`): worktree `/Users/tuongaz/dev/darkory-wt/named-workflows`, branch `named-workflows`; `main` receives merges only. Spec first: `api/openapi.yaml`, then `make gen` and `make web-gen`, generated code committed. Never `go build` at the checkout root without `-o`; never `git add -A`. Each phase ends green on `make check` (both engines; the `dk-pg` container is on 54329), `make web-check`, `make e2e`, `make e2e-pg`, and `cd web && npm run e2e`. Decisions go in `docs/build/decisions.md`, one line each with the reason. Commit per task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. TDD: write the failing test, see it fail, make it pass.

---

## Decisions taken for this build (write them in Task 0)

1. **The write stays the Project's whole graph.** `PUT …/workflow` takes `workflows` and every Step with its `workflow`; the editor edits one Workflow and saves whole. Why: a crossing Connector and the Step it reaches must land in one write, and a Workflow saved alone could not say where its Tasks go when it is deleted.
2. **A Workflow has a `position`; a Project's Steps are ordered by Workflow position, then Step position.** "The first Step" (a filed Task's default entry) and the first Step carrying `breakdown`, `acceptance` or `retro` read that order. Why: no new fact; the order the admin sees on the rail is the order the record reads.
3. **A Workflow sent without an `id` keeps the id of the Workflow with the same name, ignoring case; any other is new.** Why: as a Connector does; a preset re-run must never delete and recreate a Workflow, which would strand its Steps' Tasks.
4. **Migration 0006 names every existing Workflow "Work"; `default` and `empty` Projects start with one Workflow named "Work"; the software preset's is "Software".** Why: a Project's work; the name shows only when a Project has two or more.
5. **An ended Task keeps `last_step_id`, the Step it ended at, set in the same UPDATE that ends it; `moves` re-point it when its Step is deleted, and otherwise the FK sets it null.** Why: a Done card belongs on the board of the Workflow it ended in; the Stepper already says "A Step since removed".
6. **A Parent shows on the board of the Workflow that owns its least-advanced Subtask's Step.** Why: `placeOf` already puts it there; a Parent is at no Step.
7. **Step names stay unique per Project; Workflow names are unique per Project, ignoring case, 1–50 characters, never spelled as an id.** Why: a Step name must mean one place in `--step`, `move` and the filters.
8. **The board and the Workflow page show one Workflow at a time, picked by a chip in the breadcrumb (`?workflow=`, read long or short, the first by position until one is picked, then remembered per Project in the browser; hidden with one Workflow); the Tasks list stays the whole Project and prefixes each Step group with its Workflow when there are two or more.** Why: the owner wants a flow seen alone; the list is where everything is.
9. **On the line, a Connector into another Workflow is an exit chip `outcome → Workflow › Step`, and the Step it reaches carries an entry mark `from Workflow · outcome`.** Why: ADR 0019's Consequences; the line must never drop a Connector silently.
10. **The CLI's `workflow show` prints a heading per Workflow only when the Project has two or more, and a crossing outcome as `bug → Bugs › Investigate`.** Why: one Workflow needs no heading; the target's Workflow is what the reader needs.

---

## Phase 0 — Decisions and the ADR (docs)

### Task 0: Record the build decisions and amend ADR 0019's Consequences

**Files:**
- Modify: `docs/build/decisions.md` (append after the last line)
- Modify: `docs/adr/0019-named-workflows.md` (the `## Consequences` section)

**Step 1:** Append a heading `### Named Workflows (2026-10-09, ADR 0019)` and the ten decisions above to `docs/build/decisions.md`, one bullet each in the file's form: `- **Decision.** Why: reason.`

**Step 2:** In `docs/adr/0019-named-workflows.md`, replace the first Consequences bullet ("The Workflow editor, the board, `workflow show`, `workflow set` and `PUT …/workflow` work per Workflow…") and the fourth ("Today 'the first Step' is the first by position across the Project…") with:

```
- The write stays the Project's whole graph: `PUT …/workflow` carries the Workflows and every Step with its Workflow, so a crossing Connector and the Step it reaches land in one write. The editor edits one Workflow at a time and saves whole; the board reads one at a time, and `workflow show` reads one, or all under a heading each.
- A Workflow has a position, and a Project's Steps are ordered by Workflow position, then Step position: "the first Step" (a filed Task's default entry) and the Steps carrying `breakdown`, `acceptance` and `retro` read that order, so they keep their meaning with no new fact.
- An ended Task keeps the Step it ended at (`last_step_id`), so its card lands on the board of the Workflow it ended in; the Task is still at no Step.
```

Keep the other bullets (the crossing Connector drawn on both canvases; the build's remaining decisions in decisions.md) and remove the sentence that names "the migration's name for the existing Workflow" as open, since decision 4 settles it.

**Step 3:** Commit.
```bash
git add docs/build/decisions.md docs/adr/0019-named-workflows.md
git commit -m "Named Workflows: the build's decisions, and ADR 0019's Consequences read the whole-graph write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 1 — The contract (`api/openapi.yaml`, `make gen`, `make web-gen`)

### Task 1: The spec speaks Workflows

**Files:**
- Modify: `api/openapi.yaml` (lines noted below are from main at b54f69a; re-find by text)
- Test: `internal/server/gen/spec_test.go` (existing; it requires `format: id` on every id-like property)

**Step 1: Rename the response schema and add the named part.** Under `# ---- workflows` (around line 2853):

```yaml
    Workflows:
      type: object
      description: |
        A Project's Workflows, with every Step and Connector. The Steps are ordered by their
        Workflow's `position`, then their own; "the first Step" reads that order. Each
        Workflow's board shows its Steps in order, then Done.
      required: [project_id, workflows, steps, connectors]
      properties:
        project_id: {type: string, format: id}
        workflows:
          type: array
          description: The Workflows, by `position`.
          items: {$ref: "#/components/schemas/Workflow"}
        steps:
          type: array
          description: Every Step, by its Workflow's `position` then its own, each with what is happening at it now.
          items: {$ref: "#/components/schemas/WorkflowStep"}
        connectors:
          type: array
          description: Every Connector, by its Step's order, then its own `position`.
          items: {$ref: "#/components/schemas/Connector"}
    Workflow:
      type: object
      description: |
        A named set of Steps and the Connectors between them, drawn on a canvas and shown as the
        columns of its own board. A Project has one or more; a Connector may lead into a Step of
        another Workflow of the same Project, or into Done. A Task's Workflow is that of the Step
        it is at.
      required: [id, name, position]
      properties:
        id: {type: string, format: id}
        name:
          type: string
          description: Unique in its Project, ignoring case.
        position:
          type: integer
          format: int64
          description: Its place among the Project's Workflows, 1 first.
```

On `Step`: add `workflow_id: {type: string, format: id, description: The Workflow it belongs to.}` to `properties` and `required`; `name`'s description becomes `Unique in its Project, ignoring case.`; `position`'s becomes `Its place in its Workflow, 1 first.`

**Step 2: The write.** On `SetWorkflowBody`: `required: [workflows, steps, connectors]`; add

```yaml
        workflows:
          type: array
          minItems: 1
          description: |
            Every Workflow of the Project, one at least. One already there carries its `id`; one
            without an `id` keeps the id of the Workflow with the same name, ignoring case, unless
            another Workflow of the body carries it, and any other is new. One left out is deleted
            with its Steps, whose Tasks, open or ended there, need `moves`.
          items: {$ref: "#/components/schemas/WorkflowInput"}
```

`moves`' description: `Where the Tasks at a deleted Step go, the open ones and the ended ones that ended at it (`last_step_id`): the deleted Step's id to any Step of the body, by its id or its name in `steps`.` The `invalid` list gains `no Workflow at all`.

Add after `SkillGrantInput`:

```yaml
    WorkflowInput:
      type: object
      required: [name, position]
      properties:
        id:
          type: string
          format: id
          description: The id of a Workflow of the Project now; left out, the one with the same name keeps its id.
        name: {type: string, minLength: 1, maxLength: 50}
        position:
          type: integer
          format: int64
          minimum: 1
          description: Its place among the Workflows; distinct, and the Project numbers them 1, 2, 3… in this order.
```

On `StepInput`: `required: [workflow, name, position]`; add `workflow: {type: string, description: The Workflow it belongs to, by its id or its name in `workflows`.}`; `position`'s description: `The Step's place in its Workflow; distinct among that Workflow's Steps, numbered 1, 2, 3… in this order.`; `x`'s: `…a new one is drawn at (position − 1) × 448 in its Workflow.` On `ConnectorInput.to`: `The Step it leads to, by its id or its name in `steps`, in any Workflow of the body. Left out, it leads into Done.`

**Step 3: The operations.** `getWorkflow`: summary `Get a Project's Workflows with what is happening at each Step now`; response schema `Workflows`. `setWorkflow`: summary `Replace a Project's Workflows (admin)`; description: say the body is the Project's whole graph, a Workflow left out is deleted with its Steps (`step_in_use` as for a Step), a Workflow without `id` keeps the id of the one with the same name, a Connector may lead into a Step of another Workflow; add to the `invalid` list: "two Workflows share a name, ignoring case, or a `position`; a Step names a Workflow that is not in the body; two Steps of one Workflow share a `position`; a Workflow `id` the Project does not have, or given twice". Response schema `Workflows`. `createProject`'s description: "`default`: one Workflow named Work with Backlog · Plan · Build · Review · Retro · Skill review…; `empty`: one Workflow named Work with Backlog → Done; `copy`: every Workflow of `copy_from`."

**Step 4: The Task.** On `Task` (near `step_id`, ~line 3323): add

```yaml
        workflow_id:
          type: string
          format: id
          description: The Workflow of the Step the Task is at, or of the Step it ended at. Absent on a Parent, on a Task aimed at a Member, and when that Step was since deleted with no `moves` for it.
        last_step_id:
          type: string
          format: id
          description: The Step an ended Task ended at; `moves` re-points it when that Step is deleted. Absent while it is open, on a Task that ended at no Step (a Parent, a Task aimed at a Member), and when that Step was since deleted with no `moves` for it.
```

On `listTasks`: add a query parameter `workflow` beside `step`: `description: Only Tasks whose Workflow this is: by id, or by name together with `project`.` In the `filter` parameter's field list add `workflow`, an id field like `step` (`is|not|in|nin`, ids only; names belong to the query parameter), reading the Step the Task is at or ended at; `workflow:not:<id>` and `nin` also match a Task with no Workflow (a Parent, a Task aimed at a Member, an ended Task whose last Step was since deleted).

**Step 5: Activity.** In the `ActivityKind` payload notes for `workflow.changed`: `{workflows: [{id, name, position}], steps: [{id, workflow_id, name, skill_id, position}], connectors: […], moves?, tasks_moved?}`.

**Step 6: Regenerate and check the spec.**
```bash
make gen && make web-gen
go test ./internal/server/gen/
```
Expected: `spec_test.go` passes (every new id property has `format: id`). `go build ./...` will fail in `internal/server` and `internal/core` until Phase 3; that is expected. Do not fix them here.

**Step 7: Commit.**
```bash
git add api/openapi.yaml client/client.gen.go internal/server/gen/server.gen.go web/src/api/schema.gen.ts
git commit -m "API: a Project's Workflows, each named and positioned; a Step's Workflow; a Task's workflow_id and last_step_id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 2 — The record (migration 0006)

### Task 2: Migration 0006 on both engines, with its tests

**Files:**
- Create: `internal/store/migrations/0006_workflows.sqlite.sql`
- Create: `internal/store/migrations/0006_workflows.postgres.sql`
- Modify: `internal/store/migrate_test.go` (`TestTheSchemaHoldsItsChecks` inserts at 279-280 and 300-302 need `workflow_id`; add `TestMigration0006NamesTheWorkflowAndKeepsTheLastStep` modelled on `TestMigration0005ColoursTheProjectsInCreationOrder`, line 324)
- Test: `internal/store/schema_test.go` (`TestSchemaIsTheSameOnBothEngines` must stay green: same columns, indexes and foreign keys on both)

**Step 1: Write the failing migration test.** In `migrate_test.go`, add a test that loads 0001–0005 into an `fstest.MapFS`, migrates, seeds an Organisation, two Projects, three Steps (two in P1, one in P2), a Task at a Step, and an ended Task with an Activity entry `task.completed` whose payload is `{"from":"<step id>","since":1}`, then runs `s.Migrate` and asserts: each Project has exactly one row in `workflows` named `Work` at position 1 with the Project's `org_id`; every Step's `workflow_id` is its Project's Workflow; the ended Task's `last_step_id` is the payload's `from`; the open Task's `last_step_id` is null; `steps_project_name` still exists. Run it: `go test ./internal/store/ -run TestMigration0006 -v` → FAIL (no such table: workflows).

**Step 2: The Postgres file.**

```sql
-- 0006: a Project's Steps are grouped into named Workflows (ADR 0019). Every Project's Steps
-- become one Workflow named Work. An ended Task keeps the Step it ended at.
CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    name TEXT NOT NULL,             -- unique per Project ignoring case, checked in Go; the index holds the spelling
    position BIGINT NOT NULL,       -- place among the Project's Workflows, 1 first; orders the Project's Steps before their own position
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX workflows_project_name ON workflows (project_id, name);
INSERT INTO workflows (id, org_id, project_id, name, position, created_at)
SELECT gen_random_uuid()::text, org_id, id, 'Work', 1, created_at FROM projects;

ALTER TABLE steps ADD COLUMN workflow_id TEXT REFERENCES workflows (id);
UPDATE steps st SET workflow_id = w.id FROM workflows w WHERE w.project_id = st.project_id;
ALTER TABLE steps ALTER COLUMN workflow_id SET NOT NULL;
CREATE INDEX steps_workflow ON steps (workflow_id);

ALTER TABLE tasks ADD COLUMN last_step_id TEXT REFERENCES steps (id) ON DELETE SET NULL;
UPDATE tasks t SET last_step_id = sub.from_step
FROM (SELECT DISTINCT ON (a.subject_id) a.subject_id, a.payload::jsonb->>'from' AS from_step
      FROM activity a WHERE a.kind IN ('task.completed', 'task.dropped') ORDER BY a.subject_id, a.seq DESC) sub
WHERE t.id = sub.subject_id AND t.state <> 'open' AND sub.from_step IS NOT NULL
  AND EXISTS (SELECT 1 FROM steps s WHERE s.id = sub.from_step);
```

Check the `activity` table's column names in `0001_init.sql` first (`subject_id`, `kind`, `payload`, `seq`); adjust if they differ.

**Step 3: The SQLite file.** SQLite cannot add a NOT NULL column without a default, so `steps` is rebuilt; the migration runner turns `foreign_keys` off around a migration and runs `pragma_foreign_key_check` before commit (`internal/store/migrate.go`). Copy the `steps` column list from `0001_init.sql:176-191` exactly, adding `workflow_id` after `project_id`.

```sql
CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    name TEXT NOT NULL,
    position BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX workflows_project_name ON workflows (project_id, name);
INSERT INTO workflows (id, org_id, project_id, name, position, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
       || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       org_id, id, 'Work', 1, created_at FROM projects;

CREATE TABLE steps_new (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organisations (id),
    project_id TEXT NOT NULL REFERENCES projects (id),
    workflow_id TEXT NOT NULL REFERENCES workflows (id),
    name TEXT NOT NULL,
    skill_id TEXT REFERENCES skills (id),
    position BIGINT NOT NULL,
    x BIGINT NOT NULL,
    y BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
INSERT INTO steps_new (id, org_id, project_id, workflow_id, name, skill_id, position, x, y, created_at)
SELECT st.id, st.org_id, st.project_id, w.id, st.name, st.skill_id, st.position, st.x, st.y, st.created_at
FROM steps st JOIN workflows w ON w.project_id = st.project_id;
DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE UNIQUE INDEX steps_project_name ON steps (project_id, name);
CREATE INDEX steps_workflow ON steps (workflow_id);

ALTER TABLE tasks ADD COLUMN last_step_id TEXT REFERENCES steps (id) ON DELETE SET NULL;
UPDATE tasks SET last_step_id = (SELECT json_extract(a.payload, '$.from') FROM activity a
    WHERE a.subject_id = tasks.id AND a.kind IN ('task.completed', 'task.dropped') ORDER BY a.seq DESC LIMIT 1)
WHERE state <> 'open';
UPDATE tasks SET last_step_id = NULL
WHERE last_step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.id = tasks.last_step_id);
```

If `0001_init.sql`'s `steps` has any other index or column, mirror it in `steps_new`. `TestSchemaIsTheSameOnBothEngines` is the check.

**Step 4: Fix the raw inserts** in `TestTheSchemaHoldsItsChecks` (add a `workflows` row and `workflow_id` on each Step insert).

**Step 5: Run.**
```bash
go test ./internal/store/... -run 'TestMigration0006|TestSchemaIsTheSame|TestTheSchemaHoldsItsChecks|TestEveryTableCarriesOrgID' -v
DARKORY_TEST_POSTGRES_URL='postgres://dk@localhost:54329/postgres?sslmode=disable' go test ./internal/store/... -run 'TestMigration0006|TestSchemaIsTheSame|TestTheSchemaHoldsItsChecks' -v
```
Expected: PASS on both.

**Step 6: Commit.**
```bash
git add internal/store/migrations/0006_workflows.sqlite.sql internal/store/migrations/0006_workflows.postgres.sql internal/store/migrate_test.go
git commit -m "Record: workflows, a Step's workflow_id, a Task's last_step_id (migration 0006, both engines)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 3 — The rules (`internal/core`)

### Task 3: Types and reads: `Workflows`, `Workflow`, a Step's Workflow, the Project's order

**Files:**
- Modify: `internal/core/model.go:116-169` (types)
- Modify: `internal/core/workflow.go` (`stepCols`, `scanStep`, `getWorkflow`, `builtinStep`, `builtinStepSQL`, `defaultStep`)
- Modify: every file that names `core.Workflow`/`WorkflowDetail`/`WorkflowInput` (gopls rename; the compiler lists them)
- Test: `internal/core/workflow_test.go`

**Step 1: Rename, then add.** Rename the Go types: `Workflow` → `Workflows` (the Project's graph), `WorkflowDetail` → `WorkflowsDetail`, `WorkflowInput` → `WorkflowsInput`. Add:

```go
// Workflow is one named set of a Project's Steps (ADR 0019); its Position orders the Project's
// Steps before their own, so "the first Step" is the first of the first Workflow.
type Workflow struct {
	ID       string
	Name     string
	Position int64
}
```

`Step` gains `WorkflowID string` after `ID`. `Workflows` gains `Workflows []Workflow` before `Steps`. `WorkflowsInput` gains `Workflows []WorkflowInput`; `StepInput` gains `Workflow string` (id or name in Workflows). Add `type WorkflowInput struct { ID, Name string; Position int64 }`.

**Step 2: Failing tests.** In `workflow_test.go`, extend `workflowText` to print a heading per Workflow when there are two or more (`Work: Backlog · Plan …`), and add `TestWorkflowsHaveNamesAndOrder`: `f.project("WEB")` has one Workflow named `Work` at position 1 and every Step's `WorkflowID` is its id; `SetWorkflow` with two Workflows (`Triage` at 1 with Step `Triage`; `Bugs` at 2 with `Investigate`, `Fix`) and a Connector `Triage → Investigate "bug"` reads back Steps in the order Triage, Investigate, Fix; a filed Task starts at Triage; swapping the two Workflows' positions in one write makes a filed Task start at Investigate; swapping their *names* in one write succeeds (the rename trick). Run: `go test ./internal/core/ -run TestWorkflowsHaveNamesAndOrder` → FAIL.

**Step 3: Reads.**
- `stepCols = "st.id, st.workflow_id, st.name, st.skill_id, st.position, st.x, st.y"`; `scanStep` scans `WorkflowID`.
- `getWorkflow` reads `w.Workflows` with `SELECT id, name, position FROM workflows WHERE org_id = $1 AND project_id = $2 ORDER BY position, id`, then Steps `… FROM steps st JOIN workflows w ON w.id = st.workflow_id WHERE … ORDER BY w.position, st.position, st.id`, then Connectors `… JOIN steps st ON st.id = k.from_step_id JOIN workflows w ON w.id = st.workflow_id … ORDER BY w.position, st.position, k.position, k.id`.
- `builtinStep`: add `JOIN workflows w ON w.id = st.workflow_id` and `ORDER BY w.position, st.position, st.id`.
- `builtinStepSQL`: `(SELECT bs.id FROM steps bs JOIN workflows bw ON bw.id = bs.workflow_id WHERE bs.org_id = @org AND bs.project_id = @project AND bs.skill_id = … ORDER BY bw.position, bs.position, bs.id LIMIT 1)`. Invariant 4's round-trip test in `internal/core` must stay green (a subquery is still one statement).
- `defaultStep` is unchanged: the Steps arrive in Project order.
- Add `func (w Workflows) findWorkflow(ref string) (Workflow, bool)` (id, then name EqualFold) beside `find`.

**Step 4:** `go build ./internal/core/` compiles; run the test → still FAIL on SetWorkflow (Task 4). Commit the reads anyway once `go test ./internal/core/ -run 'TestNewProjectsWorkflow|TestWorkflowFacts'` passes with the seeded single Workflow (Task 4 does the write; if these fail only on the write path, finish Task 4 before committing).

### Task 4: The write: `resolveWorkflow`, `replaceWorkflow`, `sameWorkflow`, `seedWorkflow`

**Files:**
- Modify: `internal/core/workflow.go:238-287` (seed), `467-588` (replace), `590-738` (resolve), `778-801` (same)
- Test: `internal/core/workflow_test.go` (`TestSetWorkflow` and the new test from Task 3)

**Step 1: Failing tests** (add to `TestSetWorkflow` or beside it):
- A Workflow left out is deleted with its Steps; with open Tasks at one of them and no `moves` → `step_in_use`; with `moves` to a Step of another Workflow → moved, `task.moved` recorded with `workflow_changed: true`.
- A Workflow sent without an id but with a current name keeps its id; sent back exactly as read (ids stripped from Workflows, kept on Steps) → `sameWorkflow` true: no `workflow.changed`. A body that renames Workflow A (by id) from Work to Bugs and adds a new Workflow named Work without an id: the new one does not take A's id (another entry carries it) and is new.
- An empty `workflows` list → `invalid` "no Workflow at all".
- Renaming only a Workflow records `workflow.changed` whose payload has `workflows` with the new name and every Step with `workflow_id`.
- Two Workflows named alike ignoring case → `invalid`; a Step naming a Workflow not in the body → `invalid`; two Steps of one Workflow at one position → `invalid`; two Steps of different Workflows at position 1 → allowed.
- A Connector into a Step of another Workflow is kept, and `advance` along it moves the Task there (use `f.advance`).
- An ended Task at a deleted Step: with `moves`, its `last_step_id` becomes the target; without (no open Tasks there), it becomes null. (Needs Task 5's `last_step_id`; write the test now, make it pass in Task 5.)

**Step 2: `resolveWorkflow`.** `resolvedWorkflow` gains `workflows []Workflow`. Before the Steps:

```go
wfAt, err := places("two Workflows", len(w.Workflows), func(i int) int64 { return w.Workflows[i].Position })
// names: validWorkflowName("a Workflow's name", name); unique ignoring case → "two Workflows are named %q; names are unique, ignoring case"
// id given: must be in current.Workflows ("the Project has no Workflow %s; a new Workflow has no id"), once ("Workflow %s is in the body twice")
// id empty: the current Workflow with EqualFold name not yet claimed keeps its id; else newID()
// sort out.workflows by Position
```

Each Step's `Workflow` resolves against `Workflows{Workflows: out.workflows}.findWorkflow` → `invalid` "a Step names %q, which is not a Workflow of the body". Step positions: `places("two Steps in "+wf.Name, …)` **per Workflow** (group the Steps by resolved Workflow id first). Default `X = (pos-1)*stepSpacing` within the Workflow. Sort `out.steps` by (Workflow position, Step position). Everything else (Connectors across all Steps, `moves` to any Step of the body) is unchanged.

**Step 3: `replaceWorkflow`.** Deleted Workflows = current ones not kept. After `DELETE FROM connectors …`: `UPDATE workflows SET name = id WHERE org_id = $1 AND project_id = $2` (the rename trick, as for Steps); `INSERT INTO workflows` for new ones (name = id first); `UPDATE steps SET name = id …` as today; insert new Steps with `workflow_id`; move Tasks; delete deleted Steps; **delete deleted Workflows**; `UPDATE steps SET name, skill_id, workflow_id, position, x, y`; `UPDATE workflows SET name = $1, position = $2 WHERE org_id AND id`; insert Connectors. When `moves` has a target for a deleted Step, also `UPDATE tasks SET last_step_id = $to WHERE org_id = $1 AND last_step_id = $from`. Payload: `workflows: [{id, name, position}]`, each Step adds `workflow_id`.

**Step 4: `sameWorkflow`.** Compare `len(current.Workflows) == len(next.workflows)` and each by index (ID, Name, Position), and each Step's `WorkflowID` beside the other fields.

**Step 5: `seedWorkflow`.** `default`/`empty`: `Workflows: []WorkflowInput{{Name: "Work", Position: 1}}`, each Step `Workflow: "Work"`. `copy`: copy `w.Workflows` by name and position, each Step's `Workflow` the source Workflow's name. Add `const WorkflowFirstName = "Work"` and use it.

**Step 6: Run** `go test ./internal/core/ -run 'TestSetWorkflow|TestWorkflowsHaveNamesAndOrder|TestNewProjectsWorkflow' -v` → PASS (except the `last_step_id` cases). Then the whole package on both engines:
```bash
go test -race ./internal/core/
DARKORY_TEST_POSTGRES_URL='postgres://dk@localhost:54329/postgres?sslmode=disable' go test -race ./internal/core/
```

**Step 7: Commit.**
```bash
git add internal/core/
git commit -m "Core: a Project's Workflows are named and ordered; the write puts the whole graph in place; a Connector may cross

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: `last_step_id`, a Task's `workflow_id`, and the `workflow` filter

**Files:**
- Modify: every core UPDATE that sets `step_id = NULL` on an ending Task (`grep -n "step_id = NULL" internal/core/*.go`: complete in `advance.go`, drop and the Parent's cascade in `tasks.go`/`flow.go`, and any batch statement) → add `last_step_id = step_id,` before it in the same SET (SQL reads the old row on both engines, so the order inside SET does not matter)
- Modify: `internal/core/model.go` (`Task` gains `WorkflowID *string`, `LastStepID *string`)
- Modify: `internal/core/read.go:79-86` (`taskFrom`: `LEFT JOIN steps ls ON ls.id = t.last_step_id`; select `t.last_step_id`, `COALESCE(ts.workflow_id, ls.workflow_id)`)
- Modify: `internal/core/filter.go:195-208` (field `workflow`: an `idField` like `step` (`is|not|in|nin`, ids only) whose SQL is `(SELECT s.workflow_id FROM steps s WHERE s.id = COALESCE(t.step_id, t.last_step_id))`; `not` and `nin` match a null, so a Parent, an aimed Task and an ended Task whose last Step is gone match them)
- Modify: `internal/core/tasks.go:586-603` (the `workflow` list parameter beside `step`: an id, or a name with `project`, resolved against the Project's Workflows; it matches Tasks at a Step of that Workflow or ended at one)
- Test: `internal/core/flow_test.go` / `workflow_test.go`

**Step 1: Failing tests.** A Task advanced into Done has `LastStepID` = the Step it left and `WorkflowID` = that Step's Workflow; a dropped Task likewise; an open Task has `LastStepID` nil and `WorkflowID` its Step's; a Parent and an aimed Task have both nil. `ListTasks` with `Workflow: "Bugs"` (name, with project) lists the Tasks at Bugs' Steps and the Tasks that ended there; filter `workflow:nin:<id>` excludes them. Run → FAIL.

**Step 2:** Implement as listed. The Parent's drop cascade sets `last_step_id = step_id` on each open Subtask it drops too (same statement).

**Step 3: Run** the core package on both engines → PASS, including the deferred `last_step_id`/`moves` cases from Task 4 and the pgx round-trip count test (the SET gains a column, not a statement).

**Step 4: Commit.**
```bash
git add internal/core/
git commit -m "Core: an ended Task keeps the Step it ended at; a Task's workflow_id; the workflow filter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 4 — The server

### Task 6: Converters, handlers, and the server tests

**Files:**
- Modify: `internal/server/convert.go` (`stepOut` adds `WorkflowId`; `workflowOut` → builds `gen.Workflows` with `Workflows`; add `workflowRowOut`; `taskOut` adds `WorkflowId`, `LastStepId` via `shortid`)
- Modify: `internal/server/projects.go:70-110` (`GetWorkflow`/`SetWorkflow` decode `body.Workflows` → `core.WorkflowInput`; each `StepInput.Workflow`)
- Modify: `internal/server/tasks.go` (the `workflow` query parameter → `core` list input)
- Test: `internal/server/projects_test.go` (`TestWorkflowAndTasksThroughTheClient`, line 123) and `mvp_test.go:40-80` (bodies gain `workflows` and `workflow`)

**Step 1: Failing test.** Extend `TestWorkflowAndTasksThroughTheClient`: GET returns `workflows` `[{name: "Work", position: 1}]` and every Step's `workflow_id`; a PUT with two Workflows and a crossing Connector reads back in order; `tasks?workflow=Bugs&project=WEB` lists the Task after `advance bug`; `tasks?workflow=<id>` without project works; a done Task carries `last_step_id` and `workflow_id`. Run `go test ./internal/server/ -run TestWorkflowAndTasksThroughTheClient` → FAIL (compile).

**Step 2:** Implement; `go build ./...` must compile the whole module again (CLI and MCP may need the type renames from Task 3 to compile: do the minimal rename there now, their behaviour is Phase 5).

**Step 3: Run** `go test -race ./internal/server/ ./internal/core/` on both engines → PASS. Then `make check` (gen-check, vet, both engines) → green. Fix every test the renames broke (`cmd/darkory`, `internal/cli`, `internal/mcp`, `internal/runner`, `e2e` compile) with the smallest change: bodies gain `workflows: [{name: "Work", position: 1}]` and `workflow: "Work"` per Step.

**Step 4: Commit.**
```bash
git add internal/ cmd/ e2e/ tools/ examples/
git commit -m "Server: Workflows in GET and PUT; a Task's workflow_id and last_step_id; the workflow list parameter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 5 — CLI, MCP, Runner

### Task 7: `workflow show` per Workflow, `workflow set`'s body, `tasks --workflow`

**Files:**
- Modify: `internal/cli/projects.go:24-25, 198-331` (`workflow show <project> [--workflow name|id] [--body]`; `workflowBody` emits `workflows: [{id, name, position}]` and `workflow: <name>` per Step; `workflowSetHelp`; `printWorkflow`)
- Modify: `internal/cli/work.go:44, 695, 710` (`tasks --workflow`)
- Modify: `internal/cli/call.go:325-345` (the Step cache may also keep Workflow names, for `show`'s "Advance bug → Bugs › Investigate")
- Modify: `internal/cli/output.go:140-160` (the Advance line names a crossing target as `Workflow › Step`)
- Modify: `internal/cli/harness_test.go:104-117` (`webWorkflow` gains `workflows`/`workflow`)
- Test: `internal/cli/phase2_test.go` (`TestCommandsFormTheirRequests` rows 220-237; `TestWorkflowCommands` 520-620: exact text)

**Step 1: Failing tests.** `TestWorkflowCommands`: with one Workflow the text is unchanged (no heading); after `workflow set` with two Workflows the text reads

```
Triage
1   Triage           triage           0 waiting, 0 working
      bug → Bugs › Investigate
      question → Done
Bugs
1   Investigate      engineer         0 waiting, 0 working
      fix → Fix
2   Fix              engineer         0 waiting, 0 working
      done → Done
```

`workflow show WEB --workflow Bugs` prints only Bugs (no heading); `--body` round-trips through `workflow set` unchanged (no `workflow.changed`); `tasks --workflow Bugs --project WEB` lists the Task after `advance bug`; `show <task>` at Triage prints `Advance  bug → Bugs › Investigate · question → Done`. Run → FAIL.

**Step 2:** Implement. `printWorkflow` prints a heading line (the Workflow's name) before each Workflow's Steps only when the Project has two or more; Step numbers are the Step's position in its Workflow; a crossing target is `Workflow › Step`.

**Step 3:** `go test -race ./internal/cli/ ./cmd/...` on both engines → PASS. Update `README.md`'s CLI table rows for `workflow show`, `workflow set` and `tasks`.

**Step 4: Commit.**
```bash
git add internal/cli/ README.md
git commit -m "CLI: workflow show reads one Workflow or all with headings; the body carries workflows; tasks --workflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: MCP and the Runner's prompt name the Workflow a crossing outcome reaches

**Files:**
- Modify: `internal/mcp/tools.go:123-139, 391-401, 413-421, 516-525` (`stepOut` gains `Workflow string` (name); `workflow` tool returns `client.Workflows`; its description "Read a Project's Workflows: each Workflow's Steps in order…")
- Modify: `internal/runner/prompt.go:14-46, 204-226` and `internal/runner/session.go:948-955` (`PromptOutcome` gains `To string`, `"Bugs › Investigate"` when the target Step's Workflow differs from the Task's, else empty; the exit rules print `` `bug` (to Bugs › Investigate) ``)
- Modify: `internal/cli/remote/rules.go:18` ("A Task is at a Step of one of its Project's Workflows…")
- Test: `internal/mcp/mcp_test.go:276-287`, `internal/runner/prompt_test.go:21-77`

**Step 1: Failing tests** for the two texts. **Step 2:** Implement. **Step 3:** `go test -race ./internal/mcp/ ./internal/runner/ ./internal/cli/remote/` → PASS. **Step 4: Commit** `"MCP and Runner: a crossing outcome names the Workflow and Step it reaches"`.

---

## Phase 6 — Bots, presets, scripts and the Go end-to-end suite

### Task 9: Every writer of the body speaks Workflows

**Files:**
- Modify: `tools/bots/bot/preset.go:22-23, 56-85, 202-231`; `tools/bots/bot/accounting.go:16-38`; `tools/bots/bot/setup.go:354-421` (`Preset.Workflows []WorkflowSpec`, `WorkflowSpec.Name`; `setWorkflow` builds `workflows` and `workflow` per Step; gone Steps move to the first Step of the first Workflow)
- Modify: `e2e/harness_test.go:387-399` (`buildFlow` emits one Workflow `Work`), `e2e/bots_test.go:715-779` (`specStepNames`, `atOneStep`: a Step id belongs to any Workflow of the Project), `e2e/init_test.go:64-76` (the exact `workflow show` text stays, one Workflow → no heading)
- Modify: `examples/workflows/software/workflow.json` (`"workflows": [{"name": "Software", "position": 1}]`, each Step `"workflow": "Software"`), `web/src/components/workflowLine/workflows/software.json` (identical; `preset_test.go` pins them) and `sacca.json` (one Workflow `Work`), `examples/workflows/software/setup.sh:84-93` (the jq keeps Step ids by name as today; Workflows keep theirs by name through the server)
- Modify: `scripts/seed-sample.sh:97-243`, `web/e2e/compare.mjs`, `web/e2e/workflow.spec.ts` (SWL PUT), `web/e2e/workflowMock.ts`, `tasksMock.ts`, `lineMock.ts`, `panelsMock.ts` (bodies and mocks gain `workflows`/`workflow_id`)
- Modify: `docs/workflows/software.md` (the preset's Workflow is named Software; a note that Support, Bugs or Prototypes would be Workflows of their own)

**Step 1:** `go vet ./... && go test ./examples/... ./tools/...` → fix until green. **Step 2:** `make e2e` and `make e2e-pg` → green (TestBots, TestBotsAccounting, init, mvp, runner, soak). **Step 3: Commit** `"Bots, presets, scripts: every Workflow body names its Workflows"`.

### Task 10: `TestWorkflows` in the Go end-to-end suite

**Files:**
- Create: `e2e/workflows_test.go`

**Step 1:** Write the test (it runs under `DARKORY_E2E=1`, both engines): `init --no-agents`; `project create ACC Accounting --workflow empty --member ada`; `workflow set ACC --file -` with the body

```json
{"workflows": [{"name": "Triage", "position": 1}, {"name": "Bugs", "position": 2}],
 "skills": [{"name": "triage", "body": "Route it."}],
 "steps": [
   {"workflow": "Triage", "name": "Triage", "skill": "triage", "position": 1},
   {"workflow": "Bugs", "name": "Investigate", "skill": "engineer", "position": 1},
   {"workflow": "Bugs", "name": "Fix", "skill": "engineer", "position": 2}],
 "connectors": [
   {"from": "Triage", "to": "Investigate", "name": "bug", "position": 1},
   {"from": "Triage", "name": "question", "position": 2},
   {"from": "Investigate", "to": "Fix", "name": "fix", "position": 1},
   {"from": "Fix", "name": "done", "position": 1}],
 "grants": [{"member": "ada", "skill": "triage"}, {"member": "ada", "skill": "engineer"}]}
```

Then assert: `workflow show ACC` prints the two headings and `bug → Bugs › Investigate`; `file --project ACC --title "Totals round twice"` starts at Triage; `claim` + `advance bug` → `tasks --project ACC --workflow Bugs` lists it and `--workflow Triage` does not; `show` prints the Step `Investigate`; `advance fix`, `advance done` → the Task is done with `last_step_id` = Fix (`--json`) and `tasks --workflow Bugs --filter state:is:done` lists it; `workflow set` with the same body (no ids) → `activity --project ACC` has exactly one `workflow.changed`; `workflow set` deleting Fix with `"moves": {"<fix id>": "Investigate"}` → the done Task's `last_step_id` is Investigate; a body naming a Step's Workflow that is not in the body → exit 3 with `invalid`.

**Step 2:** `make e2e && make e2e-pg` → PASS. **Step 3: Commit** `"e2e: a Project with two Workflows and a crossing outcome, through the CLI"`.

---

## Phase 7 — The web app

Read `docs/build/decisions.md` sections "The Workflow line" and "The Workflow editor" first, then `web/src/components/workflowLine/{model,layout}.ts`, `web/src/screens/workflow/edit/draft.ts`, `web/src/screens/board/{model,derive}.ts`. Terse UI: icons and plain labels, no explanatory sub-lines, hover never moves anything (decisions.md 2026-10-09).

### Task 11: Types, fixtures and the line's model

**Files:**
- Modify: `web/src/api/client.ts` (aliases: `Workflows` for the response, `Workflow` for the named part; fix every import the typecheck lists)
- Modify: `web/src/test/fixtures.ts:58-73` (`workflow(p)` gains `workflows: [{id: "wf-work", name: "Work", position: 1}]` and `workflow_id: "wf-work"` on each Step; add `workflowsFixture(p)`: Triage / Bugs / Features / Prototypes / Support as in ADR 0019's thread, with a crossing Connector `Triage —bug→ Investigate`)
- Modify: `web/src/components/workflowLine/model.ts` (`LineWorkflow` gains `workflows`; `LineStep.workflow_id`; `startStep` reads the Project order; add `stepsOf(wf, workflowId)`)
- Test: `web/src/components/workflowLine/data.test.ts`, `layout.test.ts`

**Step 1:** `npm run typecheck` → fix until clean. **Step 2:** failing test: `startStep` on the five-Workflow fixture is Triage; after swapping Triage and Bugs positions it is Investigate. **Step 3:** implement. **Step 4:** `npm test -- workflowLine` → PASS. **Step 5: Commit** `"Web: the types and fixtures speak Workflows; the line's start Step reads the Project's order"`.

### Task 12: The line draws one Workflow, with exits and entries

**Files:**
- Modify: `web/src/components/workflowLine/layout.ts:173-192, 596-610` (`lineTopology(steps, connectors, …)` takes the drawn Steps and *all* Connectors: a Connector whose `from` is drawn and whose `to` is a Step not drawn becomes an **exit** chip `${name} → ${workflowName} › ${stepName}` on a branch row that ends off the line; a Connector whose `to` is drawn and whose `from` is not becomes an **entry** mark on the target Step, `from ${workflowName} · ${name}`, laid out like the "New Tasks start here" entry)
- Modify: `web/src/components/workflowLine/Horizontal.tsx`, `Vertical.tsx` (render the two)
- Modify: `web/src/components/workflowLine/useLineData.ts:46` (filter the Steps to the picked Workflow; pass every Connector)
- Test: `layout.test.ts` (exit and entry present; no Connector dropped: the count of drawn + exits + entries equals the Connectors touching the drawn Steps), `dense.test.ts` (no overlap with an exit chip), `vertical.test.tsx`

**Step 1:** failing tests. **Step 2:** implement. **Step 3:** `npm test -- workflowLine` → PASS. **Step 4: Commit** `"Web: a Connector into another Workflow is an exit chip, and the Step it reaches carries an entry"`.

### Task 13: The Workflow chip, the board per Workflow, the list's headings

**Files:**
- Create: `web/src/components/WorkflowChip.tsx` (a breadcrumb chip like `screens/workflow/ScopeChip.tsx`: the picked Workflow's name with a caret; a Command list of the Project's Workflows with a check; hidden when the Project has one; state in `?workflow=` read long or short (`lib/shortid.ts`), default the first by position, remembered per Project in `localStorage` key `darkory.workflow.<projectKey>` wrapped in try/catch)
- Modify: `web/src/screens/board/TasksPage.tsx:31-101` (the chip in `crumbs` after the Project; board view reads the picked Workflow)
- Modify: `web/src/screens/board/model.ts:15-58`, `derive.ts:13, 66, 255-268` (`boardColumns(workflowId)`: the picked Workflow's Steps by position, then "With <Member>", Done and Dropped holding only Tasks whose `workflow_id` is the picked one; `placeOf` unchanged: a Parent shows where its least-advanced Subtask's Step is, so on that Workflow's board only; the list groups by Step as today and prefixes the group label with `Workflow › ` when the Project has two or more)
- Modify: `web/src/screens/board/FileTaskDialog.tsx:106-120, 143, 389-405` (the Step `Select` groups Steps under their Workflow's name when there are two or more; a `+` on a column pre-picks that Step as today)
- Modify: `web/src/app/CommandMenu.tsx:72-73` (one `board` entry per Workflow when there are two or more: `${project.name} › ${workflow.name} board`)
- Test: `web/src/screens/board/tasks.test.tsx`, `derive.test.ts`, `fileTask.test.tsx`

**Step 1:** failing tests: with the five-Workflow fixture, the board shows Triage's one column, Done and Dropped; `?workflow=<bugs id>` shows Investigate and Fix; a done Task with `workflow_id` Bugs is in Bugs' Done column and not in Triage's; the chip lists five names and is absent on the one-Workflow fixture; the list shows `Bugs › Investigate` as a group label; the File Task Step picker has five groups. **Step 2:** implement. **Step 3:** `npm test -- board` → PASS; the "renames a column when the Workflow changes" test still passes. **Step 4: Commit** `"Web: the board shows one Workflow, picked by a chip; Done cards land on the Workflow they ended in"`.

### Task 14: The Workflow page shows one Workflow

**Files:**
- Modify: `web/src/screens/workflow/index.tsx:34-77` (the chip in `crumbs` before `ScopeChip`; `useLineData(projectKey, workflowId, scope, filter)`)
- Modify: `web/src/screens/workflow/Live.tsx`, `panels/*` (the panels read the picked Workflow's Steps), `flowEvents.ts` (a Task advancing along a crossing Connector leaves by the exit chip; one arriving lands by the entry)
- Test: `web/src/screens/workflow/livePage.test.tsx`, `liveFlow.test.ts`

**Step 1:** failing tests. **Step 2:** implement. **Step 3:** `npm test -- workflow` → PASS. **Step 4: Commit** `"Web: the Workflow page draws one Workflow at a time"`.

### Task 15: The editor: a Workflows rail, outcomes into other Workflows, changes described

**Files:**
- Modify: `web/src/screens/workflow/edit/draft.ts:20-32, 62, 99, 192-206, 462` (`Draft.wf.workflows`; `insertStep` into the picked Workflow; `saveBody` emits `workflows` and `workflow` per Step; `problem` checks Workflow names; `describeChanges` adds `Workflow added`, `Workflow renamed`, `Workflow deleted`, `Workflows reordered`, and says where New Tasks will start when that moves)
- Create: `web/src/screens/workflow/edit/WorkflowsRail.tsx` (above the Step list: the Workflows as a row of segments in order, the picked one `aria-current`; `+ Workflow` adds one named inline (default `Workflow 2`, `Workflow 3`…, the name field focused); a pencil on the picked segment renames inline; ← / → on the picked segment, or drag, reorders; a Remove (trash) opens `DeleteWorkflow`)
- Create: `web/src/screens/workflow/edit/DeleteWorkflow.tsx` (modelled on `DeleteStep.tsx`: lists its Steps, the Tasks at them with a Step to move them to, and the outcomes from other Workflows leading into them, each "Remove this outcome" or re-pointed; counts each as a change)
- Modify: `web/src/screens/workflow/edit/StepList.tsx` (lists the picked Workflow's Steps; Add Step adds into it), `edit/Outcomes.tsx:86-107` (the target `Select` groups: this Workflow's Steps, then each other Workflow's under its name, then Done), `edit/Preview.tsx` (draws the picked Workflow with exits and entries), `Editing.tsx`, `index.tsx:85-165` (`?workflow=` is the picked Workflow, `?step=` as today)
- Test: `web/src/screens/workflow/edit/draft.test.ts`, `workflow.test.tsx`, `edits.test.ts`

**Step 1:** failing tests: `saveBody` of the one-Workflow fixture emits `workflows: [{id, name: "Work", position: 1}]` and `workflow: "Work"` on each Step; adding a Workflow "Support" with a Step "Support" and an outcome `Support —bug→ Investigate` round-trips; renaming Work → Build counts one change "Workflow renamed"; reordering so Bugs is first says "New Tasks start at Investigate"; deleting Bugs with a Task at Fix needs a move and removes `Triage —bug→` unless re-pointed; `problem` refuses two Workflows named alike. **Step 2:** implement. **Step 3:** `npm test -- workflow` → PASS; `npm run typecheck && npm run lint` clean. **Step 4: Commit** `"Web: the editor edits one Workflow at a time, adds, renames, reorders and removes Workflows, and points outcomes across them"`.

### Task 16: Task dialogs, the Stepper, Agents, and the Vitest sweep

**Files:**
- Modify: `web/src/screens/task/dialogs.tsx:88-126, 180-225` (Advance names a crossing target `Bugs › Investigate`; Move's `Select` groups by Workflow when two or more), `Stepper.tsx`, `TaskLine.tsx` (a path that crosses shows the Workflow's name at the crossing)
- Modify: `web/src/screens/inbox/Agents.tsx:143-158, 342`, `AgentPeek.tsx:158, 226` (Steps prefixed `Workflow › ` when the Project has two or more)
- Test: the affected `*.test.tsx`

**Step 1:** failing tests. **Step 2:** implement. **Step 3:** `make web-check` → green. **Step 4: Commit** `"Web: Advance and Move name the Workflow a Step is in; Agents list Steps by Workflow"`.

### Task 17: Playwright `workflows.spec.ts` with screenshots

**Files:**
- Create: `web/e2e/workflows.spec.ts` (its own Install via `startInstall`; seeds Project `ACC` through `PUT /v1/projects/ACC/workflow` with the five Workflows from ADR 0019's thread: Triage [Triage (triage)]; Bugs [Investigate, Fix (engineer), Review (review), Verify (qa)]; Features [Build, Code review, QA, Release]; Prototypes [Sketch (design), Prototype review (review)]; Support [Support (support), Awaiting customer (hold), Ops (ops), Approve (finance)]; Connectors: Triage —bug→ Investigate, —feature→ Build, —prototype→ Sketch, —question→ Support; the rest within each Workflow; grants ada every Skill)
- Screenshots to `web/e2e/screenshots/workflows/`: `board-triage.png`, `board-bugs.png`, `board-support.png`, `chip-open.png`, `line-triage-exits.png`, `line-bugs-entry.png`, `editor-rail.png`, `editor-outcome-groups.png`, `file-task-step-groups.png`, `list-headings.png`, `phone-board-bugs.png` (390 px)
- Scenarios asserted: the chip lists five; the Triage board has one Step column; filing a Task lands it on Triage's board; `advance bug` through `/v1` moves its card to Bugs' board (and off Triage's) without reload; completing it at Verify puts it in Bugs' Done column only; the editor adds a Workflow "Ops" with a Step, saves, and the chip shows six; deleting it with a Task needs a move; the line of Triage shows four exit chips; the line of Bugs shows the entry from Triage; the board at 390 px does not scroll sideways (`scrollWidth === clientWidth`).

**Step 1:** write the spec (red). **Step 2:** `cd web && npm run e2e -- workflows.spec.ts` → PASS; look at every screenshot. **Step 3:** the whole suite `cd web && npm run e2e` → PASS. **Step 4: Commit** `"Web e2e: five Workflows in one Project, the chip, the boards, the exits and the editor's rail, with screenshots"`.

---

## Phase 8 — Proof, docs, PR

### Task 18: Real use cases on a live Install, with screenshots

**Step 1:** On a scratch Install in the scratchpad (never `.dev`): `darkory init --org Proof --name owner --data <scratch>/proof --no-agents` from a scratch git repository; `serve --runner=off --listen 127.0.0.1:0`; apply `examples/workflows/software/setup.sh` to a Project `SW` (its Workflow is named Software), then `workflow set` a second Workflow `Support` on `SW` with `Support —bug→ Triage` and `Support —answered→ Done`; run `go run ./tools/bots --preset software --pace fast --for 2m` against it (WEB and OPS on one Workflow each) to show nothing regresses; file three support Tasks and route one along `bug`.
**Step 2:** Shoot with Playwright (`web/e2e/compare.mjs` pattern or a one-off `proof.mjs` in the scratchpad): SW's Software board, SW's Support board, the Software line with the Support entry, Support's line with its exit, the editor's rail on SW, `workflow show SW` as text. Save under `web/e2e/screenshots/proof/`.
**Step 3:** Build an Artifact page (load the `artifact-design` skill first) with the screenshots inline and one line each on what it shows, and publish it for the owner.

### Task 19: Docs and the final checks

- `README.md`: the quickstart line (`project create WEB "Web"   # one Workflow, Work: Backlog · Plan · …`), the CLI table (`workflow show <project> [--workflow w] [--body]`, `workflow set` body with `workflows`, `tasks --workflow`), "Keys" unchanged.
- `docs/build/status.md`: a line under Built.
- `docs/build/decisions.md`: anything decided while building that this plan did not settle.
- Run everything once more on the final head: `make check`, `make web-check`, `make e2e`, `make e2e-pg`, `cd web && npm run e2e`. All green, or the final report says exactly what is not.
- Commit `"Docs: Workflows in the README and the status"`.

### Task 20: PR and merge

```bash
git push -u origin named-workflows
gh pr create --title "Named Workflows (ADR 0019)" --body-file <scratchpad>/pr.md
```

The body: what changed (record, API, CLI, MCP, Runner, web), the ten decisions, the checks run with their results, the Artifact link, and that the owner's `.dev` applies migration 0006 with a backup on the next `make dev` (serve refuses to start with migrations pending; `darkory migrate --data .dev` applies it by hand). End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then from the main checkout:

```bash
git merge --no-ff named-workflows -m "Merge named-workflows: a Project has one or more named Workflows, each with its own board and canvas (ADR 0019)"
git push
```

---

## Scenarios this build must show (the proof's checklist)

1. A fresh `init` on each engine: MAIN has one Workflow named Work; `workflow show MAIN` prints no heading; the web shows no chip.
2. The owner's kind of Install after 0006: every Project's Steps are in a Workflow named Work; every ended Task has `last_step_id`; nothing on screen changes while a Project has one Workflow.
3. A Project with five Workflows: each board shows its own Steps; Done cards sit on the Workflow they ended in; the list shows every Workflow with headings.
4. A Task filed at Triage, advanced along `bug`, appears on Bugs' board without reload and leaves Triage's.
5. The line of Triage shows an exit chip per crossing outcome; the line of Bugs shows the entry.
6. The editor adds, renames, reorders and removes a Workflow; reordering moves where New Tasks start and the chip says so; removing one with Tasks asks where they go and lists the outcomes it cuts.
7. `workflow set` with a body without Workflow ids changes nothing on a re-run; the software preset's `setup.sh` re-runs clean.
8. The bots' software and accounting presets run green on both engines.
9. The board at 390 px does not scroll sideways on any Workflow.
10. `make check`, `make web-check`, `make e2e`, `make e2e-pg`, Playwright: green on the final head.
