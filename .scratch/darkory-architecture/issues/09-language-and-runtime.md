# Language and runtime

Type: grilling
Status: resolved
Blocked by: 04, 05, 06, 08

## Question

Which language and runtime is Darkory built in?

The choice is constrained by the decisions before it: the deployment topology, the storage engine, the agent interface, and the human surface.

Decide:

- The language and runtime for the core.
- Whether the human surface shares it.
- How it is delivered to a local user (single binary, package, container).

Constraint from [Storage, source of truth, and atomic claim](05-storage-source-of-truth-and-atomic-claim.md): the runtime needs mature SQLite and Postgres drivers, and Local must embed SQLite in a single binary.

Constraint from [Agent interface: how agent Members talk to Darkory](06-agent-interface.md): one static `darkory` binary is server, CLI and MCP server, with no runtime to preinstall; the runtime needs solid OpenAPI code generation (server stubs and client), HTTP long-polling holding many open requests cheaply, and an MCP implementation.

Constraint from [Human surface: what human Members use](08-human-surface.md): the binary embeds a static web app bundle and serves it; the server holds many SSE streams and long-polls cheaply and wakes them across processes on Cloud (for example Postgres `LISTEN/NOTIFY`). Open here: the web app's own framework and build, and whether it shares the core's language.

## Answer

ADR: [Go core, React web app, delivered as one binary](../../../docs/adr/0007-go-core-react-web-single-binary.md).

- **Core:** Go. One static `darkory` binary: server, CLI, MCP server.
  - SQLite `modernc.org/sqlite` (pure Go, no C code anywhere in the build); Postgres `pgx` with `LISTEN/NOTIFY`.
  - `oapi-codegen` for server stubs and Go client; official Go MCP SDK.
  - Web bundle compiled in with `embed`.
- **Web app:** React + Vite + TypeScript SPA, TypeScript client generated from `openapi.yaml`. Does not share the core's language.
- **Delivery:** binaries for macOS, Linux, Windows on arm64 and amd64 via release page, install script and Homebrew; a container image of the same binary for servers and Cloud.
