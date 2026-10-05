# Survey how existing agent-workforce tools are built

Type: research
Status: resolved
Blocked by: none

## Question

How are existing tools that coordinate agent work built, and what did each architecture cost them?

Cover trackers that agents pull from and tools that model a workforce of agents: for example Linear's agent support, GitHub Issues with agent assignment, Beads, Paperclip, Vibe Kanban, Backlog.md. Add any others the search turns up; drop any that prove irrelevant.

For each, record:

- Where the record lives and what the source of truth is.
- How agents connect (CLI, MCP, HTTP API, files).
- How a claim works and whether two agents can claim the same work.
- How blocking and "what is takeable now" are expressed.
- How humans and agents are modelled, and whether there is any organisation model (teams, specialities, reporting lines).
- Deployment shape: cloud only, local only, or both.
- Known failure modes and complaints from primary sources.

End with the patterns that recur and the choices that tools later regretted.

## Answer

Full findings: [research/01-agent-workforce-tools.md](../research/01-agent-workforce-tools.md) (nine tools, primary sources, 2026-10-04).

- **Pull + shared server + org model is unoccupied.** Every shared tool with first-class agents (Linear, GitHub, Jira, Plane, Paperclip) pushes work by assign/mention plus webhook. Pull "ready" queues (Beads `bd ready`, Taskmaster, Backlog.md) are local only and have no org model. Only Paperclip models roles and reporting lines.
- **No tool treats humans and agents symmetrically.** Linear, GitHub and Jira all keep an accountable human beside the agent. GitHub re-added the human as co-assignee in 2025-12.
- **"Atomic" claims shipped broken twice.** Beads let N of 8 callers win; Backlog.md let 6 of 6 win. The fix is a single conditional write with a rows-affected check, tested under real concurrency.
- **Sequential IDs collided** in every multi-writer local-first tool (Beads, Backlog.md, Taskmaster).
- **Local + cloud sync is the expensive axis.** Beads spent Jan–Apr 2026 rewriting storage and sync (SQLite+JSONL+daemon → Dolt; embedded mode flip-flopped). Vibe Kanban's forced local→server move angered users, then the shared board was sunset. Paperclip avoids sync: one Postgres, embedded locally or hosted.
- **A cached "blocked" flag goes stale** (Beads #6716). Computing readiness at read time avoids it.
- **Claims leak without leases.** Paperclip has at least four stale-lock bugs and tasks stranded in waiting states. Hosted tools enforce liveness (Linear 10 s ack, GitHub 59 min cap).
- **Agent identity** ranges from caller-asserted (Beads) to API keys plus short-lived run tokens (Paperclip) and OAuth app tokens (Linear, Plane).
- **Agent interface:** in local tools the default is a CLI with JSON output plus a primer command. Hosted tools use HTTP and webhooks. MCP is optional everywhere.
