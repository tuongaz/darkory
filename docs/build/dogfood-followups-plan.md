# Dogfood follow-ups — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development: one implementer per task, one code review per task, a final review, then the full gate.

**Goal:** The ten follow-ups the owner picked ("Do all, plan and implement", 2026-10-10) from the review of the run on the Darkory repo ([`dogfood-2026-10-10.md`](dogfood-2026-10-10.md)): the Task carries its pull request and the owner's merge is a row in Needs you; a company Skill belongs to a Project; the queue behind a busy agent is visible and an agent may run several Shifts; a Shift's log is the Claim's, not the Task's Evidence; Markdown renders; Answer is one act; Evidence shows itself; Activity groups a Shift's end; the Workflows list's acts read as acts; jargon off the owner's screens.

**Board:** https://claude.ai/artifact/B4fd93WZDiAa7Xgd6iQesX (the frame is the spec for the web tasks; every element's line and words are there). Fixture: the actual DARK-1 … DARK-4 run.

**Architecture:** one spec edit carries every schema change, then one `make gen`. Migration `0008_followups` adds the Task's pull request, the Skill's Project and the Evidence kind. Core and server first, the Runner second, the web third, docs with the model changes. The Runner discovers a worked Task's pull request on GitHub (the agent opens it inside its Shift; the Runner's own `CreatePR` is only for a Parent's Complete) and writes it onto the Task; it merges through a new `runnerapi` verb beside Nudge and Stop.

**Worktree:** `/Users/tuongaz/dev/darkory-wt/dogfood-followups`, branch `dogfood-followups` from main d53492f. Never `go build` at the checkout root without `-o`; never `git add -A`; commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Words on screen from `CONTEXT.md` (Task, Claim, Shift, Evidence, Note, Skill, Project, Workspace, Heartbeat, Session, Workflow, Step; "pull request" as the Complete entry already uses it). Never weigh cost (`CLAUDE.md`). `rm -rf web/test-results` before a Playwright run; one Playwright run at a time.

---

## The model changes, exactly

### Task.pull_request (item 1)

```yaml
PullRequest:
  type: object
  description: |
    The pull request a Task's branch lands through, in a Workspace in `pull_request` mode, as the
    Runner read it on GitHub: written when it finds one open for the branch and again when it is
    merged. Absent until the Runner has seen one.
  required: [number, url, state]
  properties:
    number: {type: integer, format: int64}
    url: {type: string}
    state: {$ref: "#/components/schemas/PullRequestState"}
PullRequestState:
  type: string
  enum: [open, merged]
  x-enum-varnames: [PullRequestOpen, PullRequestMerged]
```

`Task.pull_request: {$ref PullRequest}` (optional). Operation `PUT /v1/tasks/{task}/pull-request`, `operationId: setTaskPullRequest`, body `SetTaskPullRequestBody {number, url, state}` (all required), idempotency key as other writes; allowed to the Task's Owner or any Member of its Project, held or not (the next holder may already have the Task when the Runner reads the pull request); the Task may be open or ended. The `url` is that pull request's own page, `https://<host>/<owner>/<repo>/pull/<number>` with the body's number, no query, fragment or trailing slash, on `github.com` or the host `GH_HOST` names (its host part, port included when it has one; a scheme in it is ignored); anything else is refused `invalid`. An agent's write of `merged` is checked on GitHub when a Runner is attached: the server asks `runnerapi.PullRequest(taskID, number)` (`Number`, `URL`, `State` open/merged/closed, `Head`, `Base`; `ErrNoPullRequest` when no Workspace of the Task has it) and refuses `conflict` unless GitHub has it merged ("GitHub has #7 open, not merged") and `invalid` unless its head starts with `branch.Prefix(key)` ("pull request #7's branch dark-9-other is not DARK-3's"); a human's write, a write of `open` and a write with no Runner attached are not checked. Refused `invalid` when the Task names no Workspace in `pull_request` mode (through its own `workspace_ids`, else its Project's default). Writing the same values again is a no-op that returns the Task and records nothing. Records `task.pull_request_opened` (first write of `open`, payload `number`, `url`) or `task.pull_request_merged` (a write of `merged`, payload `number`, `url`); a write of `open` over `merged` is refused `conflict` ("#7 is already merged"). Operation `POST /v1/tasks/{task}/pull-request/merge`, `operationId: mergeTaskPullRequest`: allowed to a human who is the Task's Owner or an admin, never an agent. The server calls `runnerapi.Merge(taskID, number)` with the number the record carries; the Runner checks on GitHub that the pull request's head starts with the Task's branch prefix (`branch.Prefix(key)`: a branch is named from the title when it is made, and a renamed Task's still starts with its key) and that its base is the branch's own base (the Parent's branch for a Subtask, else the Workspace's default branch), then merges as the identity its `gh` signs in as, and writes nothing. The server then records the merge of that number as the caller (`RecordMerge`: state, `task.pull_request_merged`, the Note "<Workspace>: #<n> merged", one write), holding one merge per Task at a time; errors `no_runner` (none attached, as `/v1/runner` answers), `not_found` (the Task carries no open pull request), `conflict` (a mismatch or GitHub's refusal: the message is the Runner's, as it read it from `gh`). Returns the Task.

(Security review of the spec commit, 2026-10-10, asked for the address rule, a merge by a human only, the merge recorded as the one who asked, and the head checked against the Task's branch; the code review of 2026-10-10 added the number in the address, the key prefix, the merge recorded for its number under one lock per Task, and the check of an agent's `merged` write through the Runner.)

Filter field `pull_request` on `listTasks`: `is`/`not` with `open`, `merged`, `none` (no pull request). The Inbox reads `state=done&filter=owner:is:<me>&filter=pull_request:is:open`.

Columns on `tasks`: `pull_request_number BIGINT`, `pull_request_url TEXT`, `pull_request_state TEXT CHECK (pull_request_state IN ('open', 'merged'))`, all null until written.

### Skill.project_id (item 2, ADR 0020)

`Skill.project_id` (optional, `format: id`): "The Project a company Skill belongs to; absent for a generic Skill and for a company Skill of the whole Organisation." `CreateSkillBody.project` (optional, "id or key of the Project; only for a company Skill"). New operation `PATCH /v1/skills/{skill}`, `operationId: updateSkill`, body `UpdateSkillBody {project: string}` ("id or key; `""` makes it the Organisation's"), admin; refused `invalid` on a generic Skill. Records `skill.changed` (payload `project_id`, or `null`).

Rules: a Step of one Project cannot carry a company Skill of another (`workflow.go`'s validation, refused `invalid`: "<skill> is <Project>'s company Skill"). A Member may be granted any Skill as today (grants are by Skill id; Takeable is unchanged). The Runner's prompt carries a company Skill built on the Step's generic Skill only when it names no Project or the Task's. `member show` and the Skills page say the Project.

Column: `skills.project_id TEXT REFERENCES projects (id)`, null. No backfill: an existing company Skill stays the Organisation's until an admin sets its Project (`darkory skill set <skill> --project <key>`). `examples/workflows/software/setup.sh` passes `--project "$project"` on its company Skills.

### Evidence.kind (item 4)

```yaml
EvidenceKind:
  type: string
  description: |
    `evidence`: attached by the Task's holder or a Member about the work. `log`: a Shift's
    terminal log, attached by the Runner when the Shift ends; it belongs to the Claim the Shift
    worked under and is not counted or listed as the Task's Evidence.
  enum: [evidence, log]
  x-enum-varnames: [EvidenceKindEvidence, EvidenceKindLog]
```

`Evidence.kind` (required). `attachTaskEvidence` gains query parameter `kind` (`EvidenceKind`, default `evidence`). The Activity payload of `task.evidence_attached` gains `kind`. Column `evidence.kind TEXT NOT NULL DEFAULT 'evidence' CHECK (kind IN ('evidence', 'log'))`, with the backfill `UPDATE evidence SET kind = 'log' WHERE filename LIKE 'shift-%-%.log'` (the Runner's `SessionLogName` shape, `shift-<KEY>-<agent>-<HHMMSS>.log`). The prompt's `## Evidence` lists `evidence` only.

### AgentSettings.shifts (item 3)

`AgentSettings.shifts` (required, integer, minimum 1, maximum 8): "How many Shifts the Runner runs for the agent at once, one Session and one Claim each; 1 unless set." `SetAgentSettingsBody.shifts` (optional, same bounds). Stored in the members.agent JSON as `shifts`; absent reads as 1. CLI `agent set --shifts n`. ADR 0013 gains a dated amendment.

### Activity kinds

`task.pull_request_opened`, `task.pull_request_merged`, `skill.changed` join the enum; the description's list of payloads names theirs. `internal/core/activity.go`'s kinds list too.

---

## Task 1: spec, migration, core, server, CLI (record)

**Files:** `api/openapi.yaml`; `internal/store/migrations/0008_followups.sql` (one file, both engines; the engines' SQL is the same for these statements, as `0007` is); `internal/core/model.go`, `read.go` (Task read SQL), `tasks.go` (`SetPullRequest`), `filter.go` (`pull_request`), `skills.go` (`CreateSkill` with project, `UpdateSkill`), `workflow.go` (the company Skill rule), `evidence.go` (kind), `agents.go` (shifts), `activity.go`; `internal/server/tasks.go` (`SetTaskPullRequest`, `MergeTaskPullRequest`), `evidence.go` (kind), `members.go` or wherever Skills are served (`UpdateSkill`), `convert.go`; `internal/runnerapi/runnerapi.go` (`Merge(taskID string, number int64) error`, `PullRequest(taskID string, number int64) (PullRequest, error)`, `ErrNoPullRequest`); `internal/cli/work.go` (`pr set`, `pr merge`, `attach --kind`), `admin.go` (`skill create --project`, `skill set`), `agents.go` (`agent set --shifts`); tests beside each.

**Steps**

1. Edit the spec as above; `make gen`; commit the spec and the generated files.
2. Write the failing tests: `TestSetPullRequest` (Owner, Project Member, a stranger refused, open then merged, open over merged refused, no `pull_request` Workspace refused, same values a no-op), `TestPullRequestFilter`, `TestCompanySkillProject` (create with project, update, a Step of another Project refused, prompt rule is the Runner's), `TestEvidenceKind` (attach with kind, default, migration backfill on a seeded `shift-X-1-a-000000.log`), `TestAgentShifts` (default 1, bounds). `go test ./internal/core/... ./internal/server/...` fails for the right reason.
3. Migration, model, reads, writes, handlers; green.
4. CLI verbs with their tests in `internal/cli`; `darkory prime` and the MCP tools unchanged except `attach --kind`.
5. `make check`; commit.

The Runner's `PullRequest` is a stub until Task 2 lands, so Task 1 and Task 2 ship in one pull request, never apart: with the stub attached, every agent's `merged` write would be refused.

Rules that must hold: every write under the Organisation's counter as today (ADR 0011); `recordByCaller` for the Activity entries; the Task read adds the three columns to every SELECT that builds a `Task` (`tasksWhere`); `convert.go` maps them.

## Task 2: the Runner

**Files:** `internal/runner/record.go` (`Attach` gains kind; `SetPullRequest`; `Task` list by filter), `session.go` (`attachLog` kind=log; the company Skill rule in `prompt`; pull request discovery at the Shift's end), `merge.go` (`pollOnce` records open and merged pull requests on their Tasks; `completeByPR` unchanged), `github.go` (`PRsForBranch(repo, branch) ([]PullRequest, error)` through `gh pr list --head <branch> --state all --json number,url,state,mergedAt`; `MergePR(repo string, n int64) error` through `gh pr merge <n> --merge`), `runner.go` (`Merge(taskID, number)` and `PullRequest(taskID, number)` for `runnerapi`; one pull loop per Shift slot), `agent.go` (`run` starts `shifts` loops, each with its own pull Session, each honouring Paused and a settings change that lowers the count: a loop above the count exits after its Shift), `prompt.go` (`## Evidence` lists `evidence` only); tests: `pr_test.go`, `prompt_test.go` (goldens), `sessions_test.go` (two Shifts for one agent on two Tasks at once; one slot leaves the second Task waiting).

**Discovery rule:** when a Shift ends in a Workspace in `pull_request` mode, the Runner lists the pull requests whose head is the Task's branch; the newest open one is written `open`; a merged one `merged`. The poller does the same every `Poll` for every Task of the Workspace whose branch has a pull request it has not recorded in that state (a `seen` map of `repo#number:state`), so a pull request merged by hand on a Done Task becomes `merged` within a minute. `Merge(taskID, number)` reads the pull request on GitHub in the Task's Workspaces (`PullRequest`), checks that its head starts with the Task's branch prefix and that its base is the branch's own base (the Parent's branch for a Subtask, else the Workspace's default branch), runs `gh pr merge <n> --merge`, and records nothing: the server writes `merged`, the Activity entry and the Note "<Workspace>: #<n> merged" as the caller. `PullRequest(taskID, number)` is the same read, for the server's check of an agent's `merged` write; every `merged` write the Runner makes comes back into it through the server before the write returns, so the Runner holds no lock across a write.

**Shifts:** `AgentSettings.Shifts` read with the settings; the agent's `run` keeps `shifts` loops; `r.sessions` is keyed by Session id already, so two Shifts for one agent coexist; the Agents page reads them as a list (Task 4).

## Task 3: docs and the model's words

**Files:** `docs/adr/0020-a-company-skill-belongs-to-a-project.md` (format of 0019: the decision, why, decided on, Considered Options: the Step names the company Skill; a Skill names several Projects; leave it to the agent's grants); `docs/adr/0013-a-runner-starts-agent-sessions.md` (dated amendment: "Amended 2026-10-10: an agent's settings say how many Shifts the Runner runs for it at once, 1 unless set; one Session per Claim stands"); `CONTEXT.md` (Skill: "a company Skill … belongs to one Project, or to the whole Organisation"; Shift: "its log is kept with the Claim it worked under" in place of "its log becomes Evidence on the Task"; Evidence unchanged); `docs/build/decisions.md` (block "Dogfood follow-ups (2026-10-10)": one line per item with the reason, the Merge act's line naming the identity it merges as, the Markdown subset, the Activity fold rule, the "working / lapses in" rule); `internal/cli/remote/rules.go` (Markdown: "Notes, Task bodies and questions may use Markdown: paragraphs, code spans, fenced code, lists, emphasis and links; nothing else renders"; the log: "the Runner attaches your Shift's log itself; attach what you ran"); `docs/build/status.md` (a dated paragraph). Goldens in `internal/runner/testdata` re-generated when the rules change.

## Task 4: web, the record's new facts

**Files:** `web/src/screens/inbox/Inbox.tsx`, `derive.ts`, `parts.tsx` (the merge row: chip `#7 open` linking to the pull request, "Awaits your merge", the Done time, act Merge when `useRunnerSessions().data.runner` is true else the link; `Decision` kind `merge`); `web/src/screens/task/TaskProperties.tsx` (facts line chip after the branch; rail Workspace group row "Pull request"), `TaskActions.tsx` (Merge as the Owner's primary while open and a Runner is attached; toast on refusal in GitHub's words), `dialogs.tsx` (Merge confirm: "Merge #7 into main", the Workspace's default branch); `web/src/screens/inbox/Agents.tsx`, `derive.ts` (under the hold, `↳ KEY title · waits at Step · age` for the open, unheld, unblocked Tasks at a Step whose Skill the agent has, in this Project, while it holds another; `runner.filter(member_id)` in place of `find`, every Shift listed), `AgentPeek.tsx` (same); `web/src/screens/task/Stepper.tsx`, `TaskLine.tsx` (the waiting token's note "waits for <agent>" when every taker holds another Task); `web/src/screens/settings/AgentSettings.tsx` (Shifts, a number field between Model and Unattended, "at once"); `web/src/screens/settings` Skills pages (Project column; the create form's Project select for a company Skill); `web/src/screens/task/record.ts`, `TaskRecord.tsx` (an Evidence of kind `log` is a chip `Shift log · size` on its Claim's end row, never an Evidence row; `EvidenceCount` and the list's count exclude logs); `web/src/screens/board/bits.tsx`. Tests beside each (`Inbox.test.tsx`, `Agents.test.tsx`, `task.test.tsx`, `derive` tests).

## Task 5: web, Markdown

`npm i react-markdown remark-gfm` (pinned); `web/src/components/Markdown.tsx`: `allowedElements` p, ul, ol, li, code, pre, em, strong, a, br; `unwrapDisallowed`; `skipHtml`; links `http:`/`https:` only (others rendered as text), `target="_blank" rel="noreferrer noopener"`; no images, no headings (rendered as paragraphs); `className="prose-dk"` with the record's type scale. Used for `task.description` (`TaskView.tsx:242`), Note bodies and Observation bodies (`TaskRecord.tsx`), the Answer dialog's question body. CSP: nothing external. Tests: a Note with a code span, a list, an `http` link, a `javascript:` link (text), an image (text), raw HTML (text).

## Task 6: web, the acts and the words

- **Answer** (`parts.tsx` `AnswerButton` → `AnswerDialog` in `web/src/screens/inbox`): title "Answer <KEY>", the question's title in full and its body (Markdown), "From <asker> · blocks <KEY> <title>", field "Your answer", foot "Answers and ends <KEY>", Cancel · Answer. On Answer: claim → `POST complete {note}`; a refusal stops the chain, the dialog stays open with the refusal under the field; a claim that landed before a refused complete leaves the owner holding the question, which the dialog says ("You hold DARK-4; complete it from its page"). The peek keeps the Note composer for the record.
- **Evidence** (`TaskRecord.tsx`, `record.ts`): consecutive Evidence (kind `evidence`) by one attacher inside one Claim fold into one row "<name> attached N Evidence" (one Evidence keeps today's row); under it: images (`content_type` image/png, jpeg, gif, webp) as 148×92 thumbnails (`object-fit: cover; object-position: top`, `loading="lazy"`, name and size under, the whole a link to the file); text files (`text/*`, `application/json`) under 20 kB fetched and shown in a box of at most 112px with a fade and "open ↗" at the right; everything else name · size · open as today. The download stays `attachment`; `<img>` renders it regardless (verify in Playwright).
- **Activity** (`wording.ts`, `derive.ts`, `Activity.tsx`): fold rule: entries with the same `actor_id` and `subject_id` from a `task.claimed` entry to the entry that ends that Claim (`task.released`, `task.advanced`, `task.completed`, `task.split`, `task.lapsed` with that `claim_id` or holder) fold into the Claim-end row: "asked <KEY>" for a `task.filed` whose `blocks` names this Task, "N Notes" for `task.note_added`, a chip per `task.evidence_attached` of kind `evidence`, "Shift log · size" last for kind `log`; a `task.evidence_attached` of kind `log` arriving after the Claim's end row is its own row "<agent> · Shift log · size on <KEY> · the Shift that ended <time>". The Kind and Member filters apply to the entries before folding; the count under the list says "55 entries · 31 rows". Tests on the DARK-2 sequence.
- **Workflows list** (`WorkflowsList.tsx`): row icons `text-muted-foreground` at rest, `text-foreground` while the row is `:hover` or `:focus-within` (ground `bg-accent/60` as today), the ⋯ menu at every width after them; no size or position change on hover.
- **Jargon** (`HeartbeatMeter.tsx`, `bits.tsx`, `TaskList.tsx`, `Agents.tsx`, `AgentPeek.tsx`, `TaskProperties.tsx`): the compact variant reads "● working <age of the hold>" (`started_at`), in `text-state-done`; when the Claim lapses within 60 s it reads "● lapses in 40s" in `text-state-claimed`; the bar variant keeps the bar and says the same words; a human's Claim with no `expires_at` shows no Heartbeat and no Session row in the rail and the peek; an agent's keeps both.

Tests beside each; Playwright: `web/e2e/inbox.spec.ts` (Answer dialog end to end on the real binary; the merge row through `darkory pr set` with `--runner=off`, the act is the link), `tasks.spec.ts` (the chip on the Task page; the Evidence thumbnail renders: `img.naturalWidth > 0`), `workflows.spec.ts` (the acts at rest and on hover: computed colour differs, position does not).

## Task 7: the gate

`rm -rf web/test-results`; `make check`, `make web-check`, `make e2e`, `make e2e-pg`, `cd web && npm run e2e` (one Playwright run at a time); the goldens; `make gen-check`. Then the final review, the PR (`gh pr create`, body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`), merge, memory.

## Out of scope (stated)

The Workflow's page as where a Project opens: the owner's call, reverses round 3; not built. The strip's "+1" and the floating crossing chip: not among the ten.

## State

Filled in as the tasks land.
