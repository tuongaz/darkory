# Go core, React web app, delivered as one binary

The core is Go, built as one static `darkory` binary that is the server, the CLI and the MCP server. SQLite is `modernc.org/sqlite` (pure Go, so builds need no C toolchain and cross-compile from one machine); Postgres is `pgx`, including `LISTEN/NOTIFY` for cross-process wake. Server stubs and the Go client are generated from `openapi.yaml` with `oapi-codegen`; MCP uses the official Go SDK. Goroutines keep thousands of open long-polls and SSE streams cheap.

The web app is a React + Vite + TypeScript single-page app using a TypeScript client generated from the same `openapi.yaml`, built to static files and compiled into the binary with `embed`. It does not share the core's language.

Local is delivered as prebuilt binaries for macOS, Linux and Windows on arm64 and amd64 (release page, install script, Homebrew), plus a container image holding only that binary for servers and Cloud.

## Considered Options

- **Rust.** Meets every constraint with the smallest binary, but slower to build features in.
- **TypeScript compiled with Bun.** One language with the web app, but a 60–100 MB binary and a younger long-running-server path.
- **Server-rendered web (Go templates, htmx).** Would be a private HTML path beside `/v1`.
- **Svelte, Solid, Vue, or deferring the framework.** Fine, but smaller ecosystems; fixing one now saves a later debate.
- **Container-only or `go install` delivery.** Docker breaks zero setup on a laptop; `go install` needs a toolchain.
