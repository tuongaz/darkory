# The human surface is a web app embedded in the binary, live over SSE

Human Members use a web app compiled into the `darkory` binary and served by `darkory serve`, on Local and Cloud alike. It has no private path: it calls the same `/v1` operations agents use, and nothing is reachable only from it, Organisation admin included. Bootstrapping is outside the Organisation model: `darkory init` on Local (prints the first Member's token and a login link), signup on Cloud; Install settings and Cloud billing are not Organisation operations.

The web app sees changes live through a Server-Sent Events stream of Activity (`GET /v1/activity/stream`), open to any Member. Activity carries a per-Organisation sequence number, used as the SSE event id, so a dropped stream resumes with `Last-Event-ID`; a plain `GET /v1/activity?after=<cursor>` serves clients that cannot hold a stream. With several Cloud server processes, a change on one must wake streams and `next` long-polls on the others (for example Postgres `LISTEN/NOTIFY`); on Local the wake is in-process.

## Considered Options

- **A separate web app deployment.** Freer to build, but a second process breaks the single-binary Local.
- **A TUI or the CLI alone.** Cheap, but poor for reviewing screenshot Evidence and for non-developer Feature owners. The CLI still works for humans, since Members are symmetric.
- **Org admin only in the UI.** Simpler, but breaks Member symmetry.
- **Long-polled Activity, WebSockets, or polling for live updates.** Long-poll would reuse the `next` mechanism; SSE was chosen for the browser experience. WebSockets add two-way machinery nothing needs; polling lags.
