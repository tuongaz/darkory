# Human surface: what human Members use

Type: grilling
Status: resolved
Blocked by: 04, 06

## Question

What do human Members use to see and act on the factory?

Candidates: a web app, a TUI, a CLI, or the same interface agents use.

Decide:

- The primary human surface, and whether it needs its own component in the deployment.
- Whether it sits on top of the agent interface or beside it.
- Given full Member symmetry, whether anything is reachable only from the human surface.

Architecture only: screens and visual design are out of scope.

Constraint from [Agent interface: how agent Members talk to Darkory](06-agent-interface.md): the HTTP API is canonical and its operation set is shared by humans and agents, so the human surface calls the same operations rather than a private path.

## Answer

ADR: [The human surface is a web app embedded in the binary, live over SSE](../../../docs/adr/0006-web-app-embedded-with-sse-activity.md).

- **Primary surface:** a web app compiled into the `darkory` binary, served by `darkory serve`. No separate component; Local and Cloud serve the same bundle.
- **On top, not beside:** it calls the same `/v1` operations as agents. Read views (a board, a Feature view) are `/v1` reads any Member can call.
- **Nothing is UI-only,** Organisation admin included; who is allowed to do what is for identity to decide.
  - Bootstrap: `darkory init` on Local prints the first Member's token and a login link; signup on Cloud.
  - Install settings and Cloud billing sit outside the Organisation model.
- **Live updates:** SSE stream `GET /v1/activity/stream`, open to any Member.
  - Activity gets a per-Organisation sequence number (UUIDv7 order is not commit order), used as the SSE event id; resume with `Last-Event-ID`.
  - Fallback: `GET /v1/activity?after=<cursor>`.
  - Several Cloud processes need a cross-process wake for streams and `next` long-polls (for example Postgres `LISTEN/NOTIFY`); in-process on Local.
