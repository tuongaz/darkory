# Agents on a Local Install — build plan

A Local Install should come up with agents ready: file a Feature, and agents break it down, build it, review it and ship it, with a human steering from the Inbox and the Board. Decided with the human on 2026-10-07 in a question-by-question interview; the decisions are in [ADR 0013](../adr/0013-a-runner-starts-agent-sessions.md) (how sessions run) and [ADR 0014](../adr/0014-feature-branches-and-shipping.md) (how code lands). Read [`plan.md`](plan.md) for the layout and invariants, and [`ui-plan.md`](ui-plan.md) for the rules of the build (worktrees only, both engines, spec first, commits per phase). This plan is written for a coding team first, but every abstraction is named so a bookkeeping firm fits later: the thing a session works in is a **Workspace**, of which a git repository is the first kind.

## Decisions (as taken)

| # | Decision | Taken |
|---|---|---|
| D1 | What runs an agent | A per-agent **command template** (pluggable); Claude Code is the default; each agent has a **model**. External agents (not started by Darkory) keep working as today. |
| D2 | What a session works in | **Workspaces**: a list on the Install, each of a kind (`git` now), with a Team default; a Task names **one or more**; the runner prepares a workspace directory with one checkout per Workspace. |
| D3 | Who pulls and starts | A **runner inside `darkory serve`** (on by default on Local when agents are configured); the same loop as `darkory runner` for a worker machine later. The runner calls `next` per agent, then starts the session with the Task in hand. |
| D4 | What `init` seeds | Team `MAIN`; the current git repository as the first Workspace; agents `planner` (breakdown), `builder` (engineer), `reviewer` (review, skill-review), `retro` (retro), reporting to the first human; tokens in `<data>/agents/`. |
| D5 | How a session runs and ends | Interactive Claude Code **in tmux** `dk-<TASK-KEY>`; the prompt carries the Skill text, the record and the exit rules; the agent ends the Task itself through MCP (complete / hand over / a question), the runner then exits the session (0) and attaches the log as Evidence. Turn ended without a decision → nudge twice → release with a Note. |
| D6 | Watching and joining | **xterm.js in the web** over a WebSocket to `tmux attach` (admins read-write, others read-only, a Note on join); `darkory join <task>` in a shell. |
| D7 | Permissions | `--dangerously-skip-permissions` by default (A); the worktree and the exit rules are the fence; an allowlist mode later. |
| D8 | Heartbeats | **Gated on the transcript file's modified time** (`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, the id chosen by the runner with `--session-id`): changed within 2 min → heartbeat; stale → heartbeats stop and the Claim lapses on the 5-minute rule. **No hooks.** No time budget. |
| D9 | Where code lands | Break down creates `feature/<KEY>` per Workspace the Feature touches; a review Task completing merges the Task branch into it; **Ship** merges to `main` (a PR when the Workspace is in `pull_request` mode). |
| D10 | Small work | A **quick** Feature: no Break down, one Task filed with it, no feature branch, no Retrospective; review-complete merges to `main` and ships. |
| D11 | Limits | One session per agent at a time; parallelism = more agents. |
| D12 | Where agent settings live | On the Member record, through `/v1`, edited in Admin; tokens on disk. |
| D13 | Hands-off shipping | `ship_when_done` per Feature (Team default, off): the last Task ending Done ships. Quick Features always do. |
| D14 | Done from the repo | Key in the branch and PR name (`WEB-12/cart-page`); for a `pull_request` Workspace, **the PR's merge completes the review Task** (a `gh` poll on Local, a webhook on Cloud); the feature branch's PR merging is Ship. |

## Model additions (CONTEXT.md carries the terms)

- **Workspace** `{id, org_id, name, kind: git, path, mode: plain | pull_request, default_branch, created_at}`; `teams.default_workspace_id`; `task_workspaces (task_id, workspace_id)` — a Task names one or more; default the Team's.
- **Feature** gains `quick` (bool) and `ship_when_done` (bool); `teams.ship_when_done` default.
- **Member** gains agent settings (agents only): `agent: {command, args[], model, env{}, unattended: true, paused: false}`; `command` is a template with `{prompt_file}`, `{workspace}`, `{session_id}`, `{model}`; the default renders to `claude --session-id {session_id} --model {model} --dangerously-skip-permissions --mcp-config <file> --append-system-prompt-file {prompt_file}` (flags verified against Claude Code 2.1.289: `--session-id`, `--model`, `--mcp-config`, `--settings`, `--append-system-prompt`, `--add-dir`, `--dangerously-skip-permissions`).
- **Runner sessions** (read model, not Activity): `{task_id, member_id, session_id, host, tmux, started_at, state: running | nudged | ending, log_path}` served by `GET /v1/runner/sessions` (always 200: `{items, runner: bool}`, `runner: false` when no Runner is attached); the terminal at `GET /v1/runner/sessions/{task}/terminal` (WebSocket); `POST …/nudge` and `POST …/stop` for admins.
- **Merges and sessions** are recorded as Notes on the Task ("Merged <branch> into <target> at <sha>", the conflict, "<name> joined the session") and the session log as Evidence; a conflict files a new work Task on the Feature ("Resolve the merge of <branch> into <target>") because a Done Task never reopens. To write those Notes the runner acts as the Member whose token it holds, so **a Note on a Task nobody holds is allowed for the Feature's owner and any active Member of the Feature's Team** (a held Task keeps the holder-only rule).
- Activity kinds: `workspace.added/changed/removed`, `member.agent_changed`, `team.changed`.

## `/v1` additions (spec first, then `make gen`, `npm run gen`)

`GET/POST /v1/workspaces`, `PATCH/DELETE /v1/workspaces/{ws}`; `workspaces` on `FileTaskBody`, `TaskDetail.workspaces`; `quick`, `ship_when_done` on `FileFeatureBody` and `Feature`; `default_workspace`, `ship_when_done` on Team; `PATCH /v1/members/{m}/agent`; `GET /v1/runner/sessions`, `…/{task}/terminal` (WebSocket, cookie or token, Origin-checked), `…/{task}/nudge`, `…/{task}/stop`; `darkory join <task> [--readonly]`, `darkory runner [--member …]`, `darkory workspace add|list|remove`, `darkory feature create --quick --skill … --ship-when-done`, `darkory file --workspace …`.

## The runner

One goroutine per agent Member whose settings exist and are not paused, started by `serve` (`--runner=off` disables; `darkory runner` runs the same with tokens read from `<data>/agents/` or `--token`):

1. `next` as the agent (wait 30 s, loop) with the agent's model label; the Claim's Heartbeat timeout is 5 min.
2. **Workspace:** for each Workspace the Task names (default the Team's): `git worktree add <data>/workspaces/<task-key>/<ws-name> -b <task-key>/<slug>` from the Feature's branch (`feature/<FEATURE-KEY>`, created at Break down from the default branch) or from the default branch for a quick Feature. Everything under `<data>/workspaces/` is the runner's; it never touches a branch it did not create and never force-pushes.
3. **Prompt file** (`<data>/sessions/<task-key>/prompt.md`): the Skill's current text (the company version when one exists), the Task (key, title, description, Status), its Feature (key, title, description, quick or not), the Notes so far, the Evidence list, the Workspace paths and branches, the working rules `darkory prime --rules-only` prints, and the **exit rules**: commit on the branch, never push `main`; attach the test log as Evidence; end the Task yourself — `complete --note`, or `handover --skill review --status "In review"`, or `file --aim <your manager> --blocks <task>` when stuck, then stop; write a short `note` at each milestone.
4. **Start:** `tmux new-session -d -s dk-<TASK-KEY> -c <first workspace> <command>` with `DARKORY_URL`, `DARKORY_TOKEN`, `DARKORY_SESSION` in the environment, the MCP config pointing at `darkory mcp --no-heartbeat` (the session's own keeper would otherwise mask a lapse), and `tmux pipe-pane -o 'cat >> <data>/sessions/<task-key>/pane.log'`. Without tmux on the machine: the command runs as a child process with the log file; the web says the session cannot be joined.
5. **Heartbeat loop** every 30 s: if the transcript file (`~/.claude/projects/<slug of the cwd>/<session-id>.jsonl`; a generic command may name its own progress file in `agent.progress_file`) changed within 2 min → `heartbeat`; otherwise send none. The transcript's last record also says whether the turn ended (an assistant message with no pending tool use).
6. **Turn ended, Task still held by this Session** → `tmux send-keys` one nudge ("You stopped without ending the Task: complete it, hand it over, or file a question."), at most twice, 2 min apart; then `release --note "session ended without a decision; last lines: …"`.
7. **Claim ended** (seen on the Activity stream: completed, handed over, released, taken back, lapsed) → `tmux send-keys '/exit' Enter`, wait up to 30 s, kill the tmux session, attach `pane.log` as Evidence on the Task, remove the worktrees once the branch is merged or the Task ended Dropped (keep them while a Task is open).
8. **Merges** (D9, D10, D13, D14): on a review Task completing → merge the Task branch into the feature branch (or `main` for quick) in each Workspace, write the merge Note; conflict → abort, a Note on the reviewed Task, and a new work Task on the Feature needing the build Skill with the conflict in its description. On Ship (or `ship_when_done` when the last Task ends Done) → merge the feature branch into the default branch, or open a PR (`gh pr create`) when the Workspace is `pull_request`. For a `pull_request` Workspace the runner polls `gh pr list --state merged` every 60 s and completes the review Task whose key the PR carries.
9. **Silent exits:** three releases without a decision on one Task → file a question aimed at the Feature owner and leave the Task in Todo.

## Web

- **Session panel** on the Task peek and page when a runner session exists: host, started, state, `darkory attach WEB-12`, and the **terminal** (xterm.js over the WebSocket; read-only unless admin). A Note "tuongaz joined the session" when a client attaches.
- **Agents page:** session column (running since, View), Pause/Resume per agent (admins), New agent → the Member dialog gains the agent settings.
- **Admin → Workspaces** (list, add with path and mode, Team defaults) and the agent settings on the Member page (command, model, paused, unattended).
- **File Feature:** Quick and Ship-when-done switches; **File Task:** Workspaces (multi-select, default the Team's). The Feature page shows the feature branch and the merge Activity; a Task shows its branch and merge state.

## Phases

- **R0 — Spec and model.** Migration 0004 (workspaces, task_workspaces, feature flags, team defaults, member agent settings as JSON), the `/v1` additions, generated code, CLI commands, MCP (`workspaces` in `show_task`), `init` seeding the Team, the Workspace from the current repo, the roster and its tokens. Tests on both engines.
- **R1 — Runner core**, with a **fake agent** (a script that acts through the CLI: note, attach, complete / handover / question) so the loop is tested end to end on both engines without a model: `next` → workspace → start → heartbeat gating → exit → Evidence; nudge and release; the merge flow (feature branch, review-complete merge, conflict, Ship, quick, ship-when-done); the `gh` poll stubbed. `darkory runner` and `--runner=off`.
- **R2 — tmux and the terminal**: tmux sessions, `pipe-pane`, `darkory join`, the WebSocket terminal endpoint, xterm.js panel, Agents page state, admin nudge/stop. A real Claude Code smoke run by hand against a scratch Install, recorded as evidence.
- **R3 — Web settings**: Admin → Workspaces, agent settings on the Member page, File Feature/Task switches, Session panel polish.
- **R4 — Proof**: the fake-agent scenarios in `e2e/`, the bots extended to run under the runner, Playwright scenarios below, screenshots, and a review round against Linear's conventions by a reviewer who did not build it. The proof covers **two kinds of Organisation**, each a preset of `tools/bots` (`--preset software | accounting`) that seeds Teams, Skills, Statuses, Workspaces and Features and runs agents and human personas against them:
  - *Software team* (today's preset): Web and Platform Teams, build/review/qa Skills, a git Workspace, Features broken down and shipped on feature branches.
  - *Accounting firm*: Teams Bookkeeping and Tax; Skills `bookkeeping`, `reconciliation`, `tax-review`, `lodgement`, `client-comms`; Statuses Awaiting client · Todo · In progress · In review · Lodged · Dropped; a git Workspace of client folders (workpapers as files); Features such as "Q1 BAS — Client X" and "FY26 accounts — Client Y", quick Features for one-off fixes, `ship_when_done` on routine lodgements; agents draft and reconcile, humans review and lodge, a client question blocks a step. Screenshots of the Board, Inbox, Agents and a Task's record with that data are part of the evidence, and the review scores them too.

## Scenarios

1. Fresh `init` in a git repo, `serve`: Team `MAIN`, four agents, the Workspace; the Agents page shows them idle.
2. File a Feature: the planner's session starts within 30 s; the Session panel shows it; Break down completes with Tasks; `feature/<KEY>` exists.
3. A build Task: the builder's session commits on `<TASK-KEY>/…`, attaches the test log, hands over to review; the review completes and the branch is merged into the feature branch; `task.merged` in Activity.
4. Ship merges the feature branch into `main`; `ship_when_done` ships without a click; a quick Feature ships on review-complete.
5. The agent stops without a decision: nudge, nudge, release with a Note; the Task returns to Todo.
6. The transcript goes stale: heartbeats stop, the Claim lapses, the session is killed, the log is Evidence.
7. Take back from the Agents page while a session runs: the session ends, the log is attached.
8. Join the terminal from the web as admin and type; a Note records it; a non-admin's terminal is read-only.
9. A merge conflict: the build Task returns to Todo with the conflict Note; the next session resolves it.
10. `pull_request` Workspace: the PR's merge completes the review Task.
11. Two builders, one Feature, two Workspaces named on one Task: one workspace directory with two checkouts.
12. `darkory runner` on the same machine with the server's `--runner=off`: identical behaviour.

## Not now

Allowlist permissions (B/C), workers on other machines (the terminal relay and token hand-off), Workspace kinds other than git, templates and recurrence, due dates, Task forms, Clients, Cloud.

## Found while building

### R3 — Workspaces, agent settings and the switches in the web (2026-10-07)

- `GET /v1/tasks` has no `workspace` filter, so the Workspaces table's counts and the Remove pre-check read every Task in the browser.
- `Feature` carries no `workspaces`; whether a Feature has a feature branch is worked out from its Tasks' Workspaces.
- `TaskDetail` carries no `branch`; the web copies the Runner's slug rule (`web/src/lib/branch.ts`) and will drift if the Runner's changes — a `branch` on the detail would fix it.
- No endpoint returns the Install's default agent command; New Member relies on the PATCH filling in defaults.
- New Member gives every agent settings, and `/v1` had no way to take them away; `DELETE /v1/members/{member}/agent` was added for it, and New Member gained a "Run with the Runner" switch (default on).
- With the Runner on by default, the Playwright harness must start `serve --runner=off`, or every agent the specs create gets a session.
