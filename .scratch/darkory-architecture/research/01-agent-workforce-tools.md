# 01 — How existing tools coordinate agent work, and what their architectures cost them

Research date: 2026-10-04. Sources: official docs, repos, changelogs, issues, and maintainer posts only. Versions and dates are given where read. "Unverified" means I could not confirm the point from a primary source.

## Summary table

| Tool (version/date read) | Record location / source of truth | Agent interface | Claim and race behaviour | Blocking / "what can be taken now" | Human/agent and org model | Deployment |
|---|---|---|---|---|---|---|
| Linear Agents API (developer preview, docs read 2026-10-04) | Linear cloud DB (synced to clients by Linear's sync engine) | OAuth app with `actor=app`, GraphQL API, webhooks (`AgentSessionEvent`) | Push. Delegating an issue sets one `delegate` field, and the human stays `assignee`. No pull or claim API | Issue relations exist. No agent-facing "ready" query found | Agents are "app users", not seats or team members. Teams can be set at install. No reporting lines for agents | Cloud only |
| GitHub Issues + Copilot / Claude / Codex agents (2025-05 to 2026-02) | GitHub cloud. The PR is the work product | Assignee field (`copilot-swe-agent[bot]`), REST/GraphQL `agent_assignment`, @mention | Push. One issue can be assigned to several agents on purpose ("all three to compare") | `blocked-by` relations (GA 2025-08), `is:blocked` filter | Agent is a bot assignee. Since 2025-12 the human is added as co-assignee automatically | Cloud (GHES unverified) |
| Beads `bd` (v1.3.1, 2026-09-30; repo moved to gastownhall/beads) | Local Dolt SQL DB in `.beads/`. Synced with `bd dolt push/pull` via `refs/dolt/data`. JSONL is export only | CLI with `--json` (main path), MCP (`beads-mcp`), `bd serve` HTTP `/v0` | Pull. `bd update --claim` is a compare-and-set on `row_lock`. It was check-then-act until 2026 (#4657, #3575). Cross-clone races are unverified | `bd ready` lists items with no open blockers. It uses a denormalised `is_blocked` that has gone stale before | Assignee is a free string, "caller-asserted, not authenticated". No org model | Local-first. Optional shared `dolt sql-server` |
| Paperclip (v2026.1001.0, 2026-10-02) | Postgres (embedded by default, or external/Supabase) behind a Node server | HTTP API with agent API keys and run JWTs. Adapters push heartbeats to Claude Code, Codex, HTTP bots, etc. | Push (wake the assignee), then an atomic "checkout" with `checkoutRunId`. Losers get `409`. Lock cleanup has had several bugs | First-class `blockedByIssueIds`. Auto-wake when all blockers resolve | Single assignee: either `assigneeAgentId` or `assigneeUserId`. Org chart, roles, reporting lines and budgets for agents | Local (`local_trusted`) or self-hosted authenticated. Cloud has a waitlist |
| Vibe Kanban (sunset announced 2026-04-10) | Originally a local SQLite client. Moved to a forced client↔server model (Postgres + Electric) in early 2026. Remote side removed at sunset | Local web UI, local-only MCP (stdio) | Push. A human starts a workspace from an issue. No claim concept found | No blocking relation found in the issue-management doc | Humans are assignees. Agents are executors in workspaces, not members | Local, then cloud or self-host, now local workspaces only |
| Backlog.md (v1.53.0, 2026-09-24) | Markdown files in `backlog/` in the git repo. State is merged across active branches | CLI (default) with `--json`, MCP, local web UI | No claim primitive. Concurrent edits lose writes silently: "6 of 6 exit 0, 1 assignee survives" (#843) | Per-task `readiness.isReady` in `task view --json`. A list-level ready filter is unverified | Assignee strings like `@sara`. No org model | Local only (git as transport) |
| Taskmaster / claude-task-master (0.43.1, 2026-03-31; last push 2026-04-28) | `.taskmaster/tasks/tasks.json` (tagged contexts). Optional Hamster cloud briefs | MCP (`next_task`, `set_task_status` …) and CLI | No claim primitive. File lock plus atomic rename added in 0.42 to stop lost updates | `next_task` picks work whose dependencies are done. `tags --ready` (0.42.0) | No assignee or org model | Local file. Team mode goes through the Hamster cloud |
| Jira + Rovo / remote agents (docs read 2026-10-04) | Jira cloud | Forge `rovo:agentConnector`. Remote agents speak A2A 1.0 JSON-RPC | Push (`SendMessage` on assignment, mention, transition, board column) | Jira links. No agent-specific ready query found | Agent has an `agentAccountId` and an app system user. Sources disagree on whether agents sit in the assignee field (see section) | Cloud |
| Plane Agents (blog 2026-09-18) | Plane DB (cloud or self-hosted) | OAuth app with agent capability, bot token, `AgentRun` webhooks and activities (a Linear-like shape) | Push (assign, mention, trigger, schedule) | Plane relations. Not checked | Admin-created agents that members can bring in. Seat model unverified | Cloud and self-hosted (MCP server self-hostable) |

---

## Linear: Agents API / agent sessions

Verdict: agents are app users that the platform pushes work to. Linear deliberately keeps a human as owner. Cloud only.

- **Record:** Linear's hosted DB. Clients sync through Linear's own sync engine, described in [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine). Linear says large workspaces produce "close to one million sync actions per day" ([delta sync read path](https://linear.app/now/rebuilding-delta-sync-read-path)).
- **Agent connection:** an OAuth app installed with `actor=app`. Optional scopes are `app:assignable` and `app:mentionable`. `actor=app` cannot be combined with the admin scope ([Getting Started](https://linear.app/developers/agents)). The docs page is labelled "Developer Preview", and the API may change before GA (same page, read 2026-10-04).
- **Sessions:** an Agent Session is created automatically on mention or delegation. The webhook is `AgentSessionEvent` (`created`, `prompted`). The receiver must respond within 5 s, and the agent must emit an activity or set `externalUrls` within 10 s or the session is marked unresponsive. Session states are `pending/active/awaitingInput/error/complete/stale`. Activity types are `thought/elicitation/action/response/error`. The plan checklist must be replaced whole, not patched ([Agent interaction](https://linear.app/developers/agent-interaction)).
- **Claim / race:** push only. "Assigning an issue to your app now sets it as the `delegate`, not the `assignee`—so humans maintain ownership" ([Getting Started](https://linear.app/developers/agents)). The field is singular in the docs. Whether an issue can have more than one delegate is unverified. Agents have no pull or "next work" API.
- **Blocking:** Linear has issue relations. I found no agent-facing "ready" query (unverified).
- **Humans vs agents:** "Agents are not counted as billable seats". Admins choose which teams an agent can access, and agents "cannot sign in to the app, access admin functionality or manage users". A name collision gets a numeric suffix such as "Charlie1" ([AI Agents docs](https://linear.app/docs/agents-in-linear)). Agents have no reporting lines. In 2026 Linear added its own first-party coding agent ("coding sessions", 2026-06-11) ([changelog](https://linear.app/changelog/2026-06-11-coding-sessions)) and team-level controls such as "lead teams" ([2026-09-24](https://linear.app/changelog/2026-09-24-new-controls-for-linear-coding-agent)).
- **Deployment:** cloud only.
- **Failure modes / complaints:** the hard 10 s acknowledgement rule means a slow agent shows as unresponsive ([Agent interaction](https://linear.app/developers/agent-interaction)). I found no primary-source reversals.

## GitHub Issues with agent assignment (Copilot coding agent, Agent HQ)

Verdict: the agent is a bot assignee whose output is exactly one PR. GitHub allows several agents on one issue on purpose and later added the human back as co-assignee.

- **Record:** the GitHub issue, plus a PR as the work product. "Copilot can only work on one branch at a time and can open exactly one pull request to address each task" ([about coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)).
- **Agent connection:** the assignee field, the agents panel, `@copilot` on PRs, Slack/Teams, and automations (same page). The API can assign `copilot-swe-agent[bot]` with an `agent_assignment` object (`target_repo`, `base_branch`, `custom_instructions`, `custom_agent`, `model`) ([changelog 2025-12-03](https://github.blog/changelog/2025-12-03-assign-issues-to-copilot-using-the-api/)). Third-party Claude and Codex agents became available 2026-02-04 ([changelog](https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/), [3P agents docs](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)).
- **Execution:** an ephemeral GitHub Actions environment, one repo per run, with a 59-minute hard limit ([about coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)).
- **Claim / race:** push. Double assignment is a feature here: "Assign an issue to Copilot, Claude, Codex, or all three to compare results" ([GitHub blog 2026-02-04](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)). Nothing prevents two agents working the same issue.
- **Blocking:** "blocked by / blocking" relations went GA 2025-08-21, up to 50 per type, with `is:blocked` and `blocked-by:` filters ([changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)). Assignment does not check blockers (unverified).
- **Humans vs agents:** the agent is a bot account in the assignee list. Since 2025-12-18, "When you assign an issue to Copilot, you'll now automatically be added as an assignee yourself" so that `assignee:@me` still finds the work ([changelog](https://github.blog/changelog/2025-12-18-assigning-github-copilot-to-an-issue-now-adds-you-as-an-assignee/)). GitHub has no org model for agents beyond repo/enterprise policy ([agent management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management)).
- **Deployment:** github.com cloud. GHES support is unverified.
- **Failure modes:** assignment sometimes silently doesn't start ("retry by unassigning the issue and then reassigning it"). Actions workflows don't auto-run on Copilot pushes until a human approves. Copilot stops responding once the PR is closed. Sessions time out after 1 h ([troubleshooting](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent-to-work-on-tasks/troubleshooting-copilot-coding-agent)).
- **Reversal:** agent-only assignment was changed to agent plus human co-assignee (above).

## Beads (`bd`, steveyegge/beads → gastownhall/beads)

Verdict: the clearest pull-based "ready queue" for agents. It also has the most storage churn: SQLite+JSONL+daemon, then Dolt, with embedded-vs-server mode flipping twice in two months.

- **Record (v1.3.1):** "The local Dolt database is the source of truth". Sync is `bd dolt push/pull` against `refs/dolt/data` on the git remote. `.beads/issues.jsonl` "is an export… not the canonical cross-machine sync channel", and "JSONL import is upsert-only; it cannot infer that records absent from an export were deleted" ([sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)). There are two modes: embedded (single writer, the default) and `--server` (an external `dolt sql-server` "for multiple concurrent writers") ([README](https://github.com/gastownhall/beads/blob/main/README.md)).
- **Agent connection:** a CLI with JSON output. `bd prime` injects workflow context, and `bd setup claude|codex|…` installs hooks and AGENTS.md ([README](https://github.com/gastownhall/beads/blob/main/README.md)). There is also an MCP server (`beads-mcp` on PyPI, same README) and an HTTP API from `bd serve` (`/v0/beads/...`, `POST /v0/beads/issues:batchApply`) ([CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md), Unreleased/1.3.x).
- **Claim:** `bd update <id> --claim` "Atomically claim[s] a task (sets assignee + in_progress)" ([README](https://github.com/gastownhall/beads/blob/main/README.md)). The library contract describes an "atomic compare-and-set… A foreign holder refuses with… ErrAlreadyClaimed", and "the actor is caller-asserted provenance, not authenticated identity" ([issueops/claimer.go](https://github.com/gastownhall/beads/blob/main/issueops/claimer.go)).
  - **Race history:** #3575 (2026-04-28) reports a production overnight run where two agents claimed the same bead and opened near-identical PRs, wasting about 31 min ([#3575](https://github.com/gastownhall/beads/issues/3575)). #4657 (v0.58.0) load-tested claims: a 2-way race saw both win 5/5 times, and 8-way races saw 2, 3 and 7 winners ([#4657](https://github.com/gastownhall/beads/issues/4657), open). A maintainer later reported it "structurally fixed" by an `UPDATE … WHERE id=? AND row_lock=? AND status IN (…)` CAS ([#3575 comment](https://github.com/gastownhall/beads/issues/3575)).
  - **Cross-clone:** two clones claiming offline, then running `bd dolt pull`, is **unverified**. The CAS only covers one DB.
- **Blocking / ready:** `bd ready` lists "tasks with no open blockers". Dependency types include blocks, related and parent-child ([README](https://github.com/gastownhall/beads/blob/main/README.md)). Readiness relies on a denormalised `is_blocked` flag. Closing two blockers at once "could leave the dependent `is_blocked=1` and missing from `bd ready` until `bd recompute-blocked`" ([#6716 via CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)).
- **Humans vs agents / org:** assignee is a string. There are no teams or reporting lines in Beads itself. The roles (Mayor, crew, polecats) live in the separate Gas Town/Gas City orchestrator built on top ([#3575](https://github.com/gastownhall/beads/issues/3575)). Contributor and maintainer roles are detected from git remote credentials ([README](https://github.com/gastownhall/beads/blob/main/README.md)).
- **Deployment:** local CLI. It works without git (`BEADS_DIR`, `--stealth`) and can point at a shared Dolt server.
- **Storage timeline (all from [CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)):**
  - ≤0.20.0: sequential IDs (`bd-1`) with "collision remapping" on import. **0.20.1 (2025-10-31):** switched to hash IDs because they "dramatically reduce… merge conflicts in multi-worker/multi-branch workflows", removing "400+ lines of obsolete collision handling".
  - SQLite + JSONL in git, plus a background daemon/RPC and a "sync-branch" mode, through early 2026.
  - **0.49.3 (2026-01-31):** embedded became the default *Dolt mode* (as opposed to server mode). SQLite was still the default backend at this point.
  - **0.49.5 (2026-02-08):** embedded Dolt removed, server only. **0.49.6 (same day):** reverted, because "The v0.49.5 removal was premature".
  - **0.50.0 (2026-02-14):** Dolt became the default backend. Deleted the daemon/RPC (~19,663 lines) and the JSONL sync layer (~7,634 lines).
  - **0.53.0 (2026-02-18):** deleted the sync-branch pipeline (5,720 lines; "~11,000 lines total").
  - **0.56.0 (2026-02-23):** embedded Dolt removed **again** ("beads now requires a running Dolt SQL server"). The JSONL sync pipeline was fully removed and `bd sync` became a no-op.
  - **0.51.0 (2026-02-16):** the 8-phase cleanup ("Phase 6: Remove SQLite backend entirely") began. **0.58.0 (2026-03-02):** "Dolt is the only backend".
  - **0.63.3 (2026-03-30):** embedded mode became the default again. **1.0.0 (2026-04-02):** "embedded Dolt is the default on all platforms… critical reliability issues that affected the v0.55–v0.63 series have been resolved."
- **Post-Dolt sync pain:**
  - Per-clone `UUID()` primary keys on dependencies caused "`bd dolt pull` failed unrecoverably". This was fixed by deriving deterministic keys from `(issue_id, target)` (1.0.5/1.1.0-rc, [#4259](https://github.com/gastownhall/beads/issues/4259)).
  - Migrating each clone's schema independently "forks the schema and breaks `bd dolt pull`". There is now a gate that requires one designated migrator ([CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md), [README upgrade notes](https://github.com/gastownhall/beads/blob/main/README.md)).
  - Metadata merge conflicts led to the auto-push state being moved to a local file ([GH#2466](https://github.com/gastownhall/beads/issues/2466)).
  - A schema-version guard refuses to run older binaries against a migrated DB ([README](https://github.com/gastownhall/beads/blob/main/README.md)).
- **Ongoing:** server-mode operational issues are still open as of 2026-10, such as process detection and launchd-managed servers ([#7121](https://github.com/gastownhall/beads/issues/7121), [#6017](https://github.com/gastownhall/beads/issues/6017)).

## Paperclip (paperclipai/paperclip)

Verdict: the closest thing to an "AI company" control plane, with an org chart, budgets and governance. It is push/heartbeat-based with an atomic checkout lock. It treats humans and agents as different kinds of entity. Its bug load is concentrated in lock and wake-state recovery.

- **Record:** PostgreSQL via Drizzle. With no `DATABASE_URL` it starts an **embedded PostgreSQL**. It can also use Docker Postgres or hosted Postgres such as Supabase ([doc/DATABASE.md](https://github.com/paperclipai/paperclip/blob/master/doc/DATABASE.md)). It is a Node server plus React UI, and the repo was created 2026-03-02 ([README](https://github.com/paperclipai/paperclip/blob/master/README.md)).
- **Agent connection:** adapters (Claude Code, Codex, Cursor, Gemini, OpenCode, HTTP/webhook bots, plugins). "If it can receive a heartbeat, it's hired." Agents use agent API keys and "short-lived run JWTs". There is a "DB-backed wakeup queue with coalescing" ([README](https://github.com/paperclipai/paperclip/blob/master/README.md)).
- **Claim:** "Atomic task checkout. A single assignee and execution locks prevent competing runs from claiming the same task" ([README](https://github.com/paperclipai/paperclip/blob/master/README.md)). `checkoutRunId` is the ownership lock and `executionRunId` is the live run. Finalisation must "compare-and-clear lock columns". A checkout `409` "should mean a real live owner… Agents must treat that `409` as an ownership conflict and stop rather than retrying" ([execution-semantics.md, 2026-08-18](https://github.com/paperclipai/paperclip/blob/master/doc/execution-semantics.md)).
- **Blocking:** first-class `blockedByIssueIds`. An `issue_blockers_resolved` wake fires when the last blocker resolves. A "cancelled blocker edge remains unresolved". Moving to `blocked` requires a routable path: a blocker, or a structured `{owner, action}`. "Prose-only blocked… routes to nobody" and is rejected (same doc). Paperclip warns that parent/child is not dependency: "model that with blockers" (same doc).
- **Humans vs agents / org:** "An issue has at most one assignee. `assigneeAgentId`… `assigneeUserId`… both cannot be set at the same time. This is a hard invariant" (same doc). Humans and agents therefore live in separate columns and entity types. Agents have "roles, titles, reporting lines, permissions, and budgets". There are board approvals, "approve hires", multi-company tenancy, and cost tracking by agent/project/goal ([README](https://github.com/paperclipai/paperclip/blob/master/README.md)).
- **Deployment:** `local_trusted` (no login, loopback) or `authenticated` (`private`/`public`), with bind set to `loopback|lan|tailnet|custom`. A Cloud-managed mode signs users in through Paperclip Cloud ([DEPLOYMENT-MODES.md](https://github.com/paperclipai/paperclip/blob/master/doc/DEPLOYMENT-MODES.md)). The README links a Cloud waitlist.
- **Failure modes (issues):**
  - Lock leaks:
    - "Heartbeat release fails to clear `checkoutRunId` — causes silent agent stalls" ([#3819](https://github.com/paperclipai/paperclip/issues/3819), closed).
    - "executionRunId stale causes 409 checkout conflict" ([#2894](https://github.com/paperclipai/paperclip/issues/2894), closed).
    - "Orphan executionRunId locks issues indefinitely; no reaper / no operator force-release" ([#8696](https://github.com/paperclipai/paperclip/issues/8696), closed).
    - "Zombie executionRunId lock prevents subsequent heartbeats from claiming" ([#6399](https://github.com/paperclipai/paperclip/issues/6399), open).
  - Wake-state dead ends:
    - "Task permanently unrecoverable: pre-dispatch cancellation leaves a `replay: blocked` hold with no board, API, or comment path out" ([#13640](https://github.com/paperclipai/paperclip/issues/13640), open, 2026-09-18).
    - "Skipped handoff wake… is terminal: a reviewer handoff stalls silently" ([#13532](https://github.com/paperclipai/paperclip/issues/13532), open).
    - "Comment wakes fire on blocked/done/cancelled issues" ([#3433](https://github.com/paperclipai/paperclip/issues/3433), closed).
  - Cost: requests for an "Agent circuit breaker — automatic loop detection and token waste prevention" ([#390](https://github.com/paperclipai/paperclip/issues/390), open).
  - Security: run transcripts persisted raw secrets ([#8047](https://github.com/paperclipai/paperclip/issues/8047), open).
  - The execution-semantics doc itself has grown to about 1,500 lines of recovery rules ([doc](https://github.com/paperclipai/paperclip/blob/master/doc/execution-semantics.md)).

## Vibe Kanban (BloopAI/vibe-kanban)

Verdict: it began as a local single-user board, forced a migration to client↔server for team planning, met user backlash, then announced its sunset. The local agent workspaces survived; the shared kanban did not.

- **Record:** a local SQLite DB via sqlx (dev seeds a blank DB) ([README](https://github.com/BloopAI/vibe-kanban/blob/main/README.md)). A `remote` crate uses Postgres (sqlx `postgres`) with ElectricSQL sync (migration `20251127000000_electric_support.sql`, `electric_proxy.rs`) ([crates/remote](https://github.com/BloopAI/vibe-kanban/tree/main/crates/remote)).
  - The maintainer described the data split in Feb 2026. Staying local: "Code; Codex/Claude/Etc... logs". Moving to cloud: "Issue title, descriptions; New accounts, organizations; A light record of workspaces" ([#2812 comment](https://github.com/BloopAI/vibe-kanban/issues/2812)).
- **Agent connection:** coding agents run inside "workspaces" (branch, terminal, dev server). A local MCP server (`npx vibe-kanban --mcp`) is "local-only… cannot be accessed via publicly accessible URLs" ([MCP doc](https://github.com/BloopAI/vibe-kanban/blob/main/docs/integrations/vibe-kanban-mcp-server.mdx)).
- **Claim:** none found. A human creates a workspace from an issue.
- **Blocking:** none found in the [issue-management doc](https://github.com/BloopAI/vibe-kanban/blob/main/docs/issue-management.mdx). Columns are To do / In progress / In review / Done, with priority and assignee fields.
- **Humans vs agents:** issues are assigned to "a team member". Agents are execution backends (10+ supported), not members (same doc).
- **Deployment:** first local only, then cloud or self-hosted server (`VK_SHARED_API_BASE`). Now "Sunset project routes to export-only page" (commit list since 2026-04, [repo commits](https://github.com/BloopAI/vibe-kanban/commits/main)).
- **What it cost (dates side by side; no causal link is claimed):**
  - v0.1.13 (Feb 2026): users were "forced to migrate my local projects to the cloud". The maintainer's reason was team planning and review: "That's what makes the architectural change necessary". A contributor said "I had to create my own fork which removes those migrations" ([#2812](https://github.com/BloopAI/vibe-kanban/issues/2812)).
  - After migration, the MCP server "cannot access Cloud Projects", so Claude Desktop "lost visibility" ([#2553](https://github.com/BloopAI/vibe-kanban/issues/2553)).
  - "Bring back old UI" drew 39 comments ([#2687](https://github.com/BloopAI/vibe-kanban/issues/2687)).
  - 2026-04-10, sunset announcement: "the vast majority are free users and we couldn't find a business model". Remote kanban data was kept for 30 days and then deleted, while local workspaces "continue to function" ([shutdown post](https://www.vibekanban.com/blog/shutdown)).
  - Afterwards: "Can we get back the local only projects?… I just want to have a local db". Users called self-hosting overkill, with complaints of a "domain name with dozen of subdomains and ton of ssl certs" ([#3354](https://github.com/BloopAI/vibe-kanban/issues/3354), user comments).

## Backlog.md (MrLesk/Backlog.md)

Verdict: Markdown in git, local only, readable by humans and agents. It has no claim primitive. Its team topology (several clones plus a server agent) produces ID collisions and lost writes that the owner chose to repair rather than design out.

- **Record (v1.53.0):** "Everything is stored as human-readable Markdown in a project-local backlog folder". Sequential IDs look like `TASK-1`. Git is optional (`--no-git`) ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)). Task state is reconciled across branches through `checkActiveBranches` (default true), `activeBranchDays` (30) and `remoteOperations` (git fetch). `autoCommit` defaults to false ([ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)).
- **Agent connection:** "CLI instructions are the default AI setup. MCP remains supported". The MCP server follows the client's workspace roots. The web UI binds to 127.0.0.1 ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)).
- **Claim:** none. The workflow advice is "One task at a time… one PR per task" ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)). Six concurrent self-assigns gave "all 6 exit 0… 1 assignee survives". `task edit` lost writes 12/12 times when run simultaneously, because the create-time lock "was never applied to the edit path" ([#843](https://github.com/MrLesk/Backlog.md/issues/843), closed 2026-08-07).
- **Blocking:** `--dep` dependencies. Task view JSON has `readiness` {`isReady`, `isBlocked`, `blockingDependencies`, `missingDependencies`}, "derived from the whole visible corpus at read time and never stored" ([CLI-INSTRUCTIONS](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)). A list-level "ready" filter is unverified.
- **Humans vs agents:** assignee strings (`-a @sara`). No teams or reporting lines.
- **Deployment:** local only, "no server, no account"; git is the transport.
- **Failure modes:**
  - "Sequential ID allocation (`max + 1`) cannot be made safe in Backlog.md's own target topology: multiple writers (humans on separate machines + AI agents on a server)". This was "hit… in production twice". The owner replied: "We are keeping incremental numeric task IDs. The recovery path will be… `backlog doctor` diagnosis and repair" ([#711](https://github.com/MrLesk/Backlog.md/issues/711)).
  - Cross-branch scanning makes any uncommitted task edit return `409` "ambiguous"; another user hit this with just two worktrees ([#818](https://github.com/MrLesk/Backlog.md/issues/818)).
  - New IDs reuse archived IDs ([#997](https://github.com/MrLesk/Backlog.md/issues/997), open).

## Taskmaster (eyaltoledano/claude-task-master)

Verdict: a single JSON file read by agents over MCP. The owner acknowledged early that team use needs a central DB, and the answer became a separate cloud product (Hamster). Activity slowed after March 2026 (last release 0.43.1 on 2026-03-31, last push 2026-04-28).

- **Record:** `tasks.json` in `.taskmaster/`. v0.17.0 (2025-06-15) introduced "Tagged Lists" (`{ "master": {tasks…}, "feature-xyz": {…} }`) with `state.json` tracking the current tag, and tags mapping to git branches (`--from-branch`) ([CHANGELOG](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md)).
- **Agent connection:** an MCP server with tools such as `get_tasks`, `next_task`, `set_task_status` and `expand_task`, plus a CLI (same CHANGELOG).
- **Claim:** no claim primitive. 0.42.0 added "cross-process file locking", "temp file + rename", and "Re-read file inside lock" because "multiple Claude Code windows write to tasks.json simultaneously" and lost data (PR #1566/#1569, [CHANGELOG](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md)).
- **Blocking:** task dependencies. `next_task` uses them, and 0.42.0 added `tags --ready`, which "Excludes deferred/blocked tasks" (same CHANGELOG).
- **Humans vs agents:** no assignee or org model found.
- **Deployment:** local file. The team path goes through the Hamster cloud: "Skip Git prompts when using Hamster (not needed for cloud storage)", OAuth login, "Solo with Taskmaster or Together with Hamster" (≈0.31–0.39, same CHANGELOG).
- **Failure modes:** "if I am working with somebody and they update a task? Now its conflict armageddon in git". The owner replied: "Soon as there are different branches and people committing, the merge conflicts can happen and the value of a centralized database (ideally remote) is huge" ([#88](https://github.com/eyaltoledano/claude-task-master/issues/88)).

## Jira + Rovo / remote agents (Atlassian)

Verdict: agents are push-invoked through Forge and A2A. Atlassian's own sources disagree on whether an agent takes the assignee field.

- **Record:** Jira cloud.
- **Agent connection:** a Forge app with a `rovo:agentConnector` module acts as middleware. Remote agents implement A2A 1.0 JSON-RPC (`SendMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`). Jira calls `SendMessage` on "an assignment, comment @mention, workflow, manual trigger, or automation rule" and polls `GetTask` ([remote agents in Jira](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/)).
- **Claim:** push. I found no per-item concurrency limit (unverified).
- **Humans vs agents:** each agent has an `agentAccountId`. System-token calls are "attributed to 'App Name'" (same page). **The sources disagree on assignment:**
  - The Rovo support page says "Add an agent to the assignee field." ([Rovo agent on work items](https://support.atlassian.com/rovo/docs/collaborate-with-your-rovo-agent-on-work-items/), fetched 2026-10-04).
  - The Jira support doc describes a separate "Agents" section, where output is private until a human chooses "Publish" ([collaborate with AI agents](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/)).
  - The developer doc says remote agents "do not automatically appear in assignee fields" ([remote agents](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/)).
  - Not resolved.
- **Cost model:** Rovo credits per invocation, with accrual starting 2026-12-03 ([support doc](https://support.atlassian.com/jira-software-cloud/docs/collaborate-on-work-items-with-ai-agents/)).
- **Deployment:** cloud.

## Plane (makeplane/plane)

Verdict: an open-source tracker that copied the Linear-style agent-run model and can be self-hosted. Agents went live recently (2026-09-18), so I found no failure history yet.

- **Agent connection:** an OAuth app with agent capability and a bot token. Webhooks for `AgentRun` create and activity; the agent replies with activities ([building an agent](https://developers.plane.so/dev-tools/agents/building-an-agent)). A self-hostable MCP server ([MCP self-host](https://developers.plane.so/dev-tools/mcp-server-self-host)).
- **Claim / org:** assign, mention, trigger or schedule. "Admins create and configure agents, and members can bring them into their own work". Runs cost "roughly 20 to 40 credits" ([blog 2026-09-18](https://plane.so/blog/agents-are-now-live-in-plane)). Seat and member modelling for agents is unverified.
- **Deployment:** cloud and self-hosted (Docker/K8s/air-gapped) ([developers.plane.so](https://developers.plane.so/)).

## Dropped or only mentioned

- **Gas Town / Gas City (gastownhall):** an orchestrator built on Beads, with roles such as Mayor, crew and polecats. It appears only as the context for Beads' race reports ([#3575](https://github.com/gastownhall/beads/issues/3575)). Not researched separately, because the tracker layer is Beads.
- **kandev:** named only in a user comment as a local alternative to Vibe Kanban ([#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)). Not verified.
- **Generic agent frameworks** (CrewAI and similar): dropped. They coordinate agents inside one process and have no persistent shared work record.

---

## Patterns that recur

1. **Shared server + first-class agents ⇒ push.** Linear, GitHub, Jira, Plane and Paperclip all deliver work by assign/mention → webhook or wake. **Pull-based "ready" queues exist only in local, file- or DB-backed tools with no org model:** Beads `bd ready`, Taskmaster `next_task`, and Backlog.md `readiness`. In this sample, no tool combines pull, a shared server, and an org chart. That is a fact about the sample, not a recommendation.
2. **No tool models humans and agents symmetrically.**
   - Linear: agent = `delegate`, human stays `assignee`.
   - GitHub: agent is the assignee, and the human was re-added as co-assignee in 2025-12.
   - Jira: agents get a separate "Agents" section (sources conflict).
   - Paperclip: separate `assigneeAgentId` and `assigneeUserId` columns.
   - Agents are typically non-billable "app users" without login or admin rights (Linear). Org structure for agents (roles, reporting lines, budgets) exists only in Paperclip.
3. **Two races were rediscovered independently:**
   - (a) Sequential IDs collide across clones: Beads ≤0.20, Backlog.md #711, Taskmaster #88.
   - (b) Check-then-act claims let N callers "win": Beads #4657/#3575 (N winners), Backlog.md #843 (6/6 exit 0).
   - Fixes: Beads moved to hash IDs and a `row_lock` CAS. Taskmaster added file locks and atomic rename. Backlog.md fixed the edit lock but kept sequential IDs and chose repair tooling.
4. **Lock lifecycle is where push systems bleed.** Paperclip's checkout/execution locks need compare-and-clear, stale-lock adoption and a sweeper. They still leaked in at least four reported issues, and wake/hold states can strand tasks permanently (#13640, #13532).
5. **Derived "blocked" state drifts.** Beads' denormalised `is_blocked` went stale under concurrent unblocking (#6716). Backlog.md derives readiness at read time instead. Paperclip refuses "prose-only blocked" and requires a routable owner.
6. **Hard liveness contracts on agents.** Linear wants an ack within 10 s. GitHub caps sessions at 59 min. Paperclip turns dead `in_progress` into a health violation. All of them treat a silent agent as a state the system must detect.
7. **The CLI beats MCP as the default agent interface in local tools.** Backlog.md: "CLI instructions are the default AI setup". Beads leads with CLI plus `bd prime`/hooks. Both keep MCP as optional.

## Choices tools later regretted or reversed

| Tool | Choice | Reversal (date) | Source |
|---|---|---|---|
| Beads | Sequential IDs + import collision remapping | Hash IDs, remapping code deleted (0.20.1, 2025-10-31) | [CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md) |
| Beads | SQLite + JSONL-in-git as sync, background daemon/RPC, sync-branch | All deleted (~19.6k + 7.6k + ~11k lines) for Dolt-native push/pull (0.50–0.58, Feb–Mar 2026) | same |
| Beads | Embedded vs server Dolt | Embedded default Dolt mode (0.49.3, SQLite still default backend) → removed (0.49.5) → restored (0.49.6) → removed (0.56.0) → default again (0.63.3/1.0.0, 2026-04-02) | same |
| Beads | Random `UUID()` PKs on edges | Deterministic natural-key PKs after unrecoverable pulls (1.0.5/1.1.0) | same, [#4259](https://github.com/gastownhall/beads/issues/4259) |
| Beads | Check-then-act claim | `row_lock` CAS (2026) | [#3575](https://github.com/gastownhall/beads/issues/3575) |
| Vibe Kanban | Local-only client | Forced client↔server migration (Feb 2026), then remote removed at sunset (Apr 2026) | [#2812](https://github.com/BloopAI/vibe-kanban/issues/2812), [shutdown](https://www.vibekanban.com/blog/shutdown) |
| GitHub | Agent as sole assignee | Human auto-added as co-assignee (2025-12-18) | [changelog](https://github.blog/changelog/2025-12-18-assigning-github-copilot-to-an-issue-now-adds-you-as-an-assignee/) |
| Linear | Assigning to app = assignee | Assigning sets `delegate`; human keeps `assignee` | [developers/agents](https://linear.app/developers/agents) |
| Taskmaster | Single `tasks.json` | Tagged contexts (0.17), file locks (0.42), team mode moved to Hamster cloud | [CHANGELOG](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md), [#88](https://github.com/eyaltoledano/claude-task-master/issues/88) |
| Backlog.md | Create-only lock | Lock extended to edit path after silent lost writes (2026-08) | [#843](https://github.com/MrLesk/Backlog.md/issues/843) |

## Implications to weigh for Darkory (considerations, not decisions)

- **Pull + shared + org model is unexplored ground in this sample.** Beads shows the shape of a pull queue (`ready` → CAS `claim` → `close` releases dependents). Paperclip shows the shape of an org model. None of the sampled tools combines them.
- **"Agents symmetric with humans" goes against every major vendor's choice.** Linear, GitHub and Jira all keep a human owner next to the agent. Consider whether "accountable human" is a separate concept from "member doing the work", rather than a reason to break symmetry.
- **Claim must be a single conditional write with a rows-affected check, tested under real concurrency.** Two tools shipped "atomic" claims that were not. If agents can work offline, decide what a claim means across replicas. Beads leaves this open.
- **Identity:** Beads' actor is "caller-asserted, not authenticated". Paperclip uses agent API keys plus short-lived run JWTs, and Linear/Plane use OAuth app/bot tokens. Whichever Darkory picks decides whether a claim can be trusted.
- **IDs:** sequential, human-friendly IDs collided in every multi-writer, local-first tool. Options seen: hash IDs (Beads), keep sequential IDs plus a repair tool (Backlog.md), or a central allocator (implicit in the server tools).
- **Local + cloud is the expensive axis.** Beads spent Jan–Apr 2026 on sync and storage rewrites. Vibe Kanban's local→server migration angered its users. Paperclip avoids sync by running one Postgres, either embedded locally or hosted. Weigh "same server, different host" against "replicated local copies".
- **Derived readiness:** computing it at read time (Backlog.md) avoids the stale-cache bug Beads hit. Materialising it (Beads) needs a post-commit recheck under concurrent unblocking.
- **Liveness and lock leases:** claimed work needs an expiry or heartbeat plus an operator force-release. Paperclip's open lock bugs and Beads' TTL suggestion (#3575) point the same way.
- **"Blocked" should name a resolvable path** (a blocker item or an owner+action). Paperclip found that free-text "blocked" strands work.
- **Agent interface:** CLI with JSON plus a primer command (Beads `bd prime`) was the default in successful local tools. HTTP/webhook is the norm for hosted tools. MCP is optional everywhere.
