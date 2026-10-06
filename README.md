# Darkory

Management for a software factory whose workforce mixes AI agents and humans. Members, human or agent, pull work from one shared record: they claim a Task, work it, and hand it to the next Skill (build, QA, review). Darkory never starts an agent.

The words used here (Member, Feature, Task, Claim, Handover, Takeable, Retrospective…) are defined in [`CONTEXT.md`](CONTEXT.md). The architecture decisions are in [`docs/adr/`](docs/adr/).

## Quickstart (Local)

```sh
make build                 # or: go build -o bin/darkory ./cmd/darkory   (Go 1.26.8 downloads itself)
bin/darkory init           # creates the Organisation and you, prints your token and a login link
bin/darkory serve          # listens on 0.0.0.0:7357, prints a fresh login link and opens it
```

The web app needs node for its build (`make web`); without it the binary serves a placeholder page and everything else works.

Set up a Team and an agent from the web app's Admin page, or from the CLI:

```sh
export DARKORY_TOKEN=dk_...            # the token init printed
eval "$(bin/darkory prime)"            # a Session id for this shell, plus the working rules
bin/darkory team create WEB "Web"
bin/darkory member create eng-bot --kind agent
bin/darkory team add WEB eng-bot
bin/darkory grant eng-bot breakdown
bin/darkory token issue eng-bot --name laptop --timeout 2m   # give this token to the agent
bin/darkory feature create --team WEB --title "Login page"   # files its Break down Task too
```

## Keys in the web app

| Key | Does |
|---|---|
| ⌘K / Ctrl K | Search Tasks, Features and Members; go to a page; file a Task or a Feature |
| C | File a Task |
| G then I, M, A, B | Go to the Inbox, My work, Agents, the current Team's board |
| J or ↓, K or ↑ | On a Team's Tasks (list or board): move to the next or previous Task; with its peek open, show that Task in it |
| Enter | Open the selected Task's peek |
| Esc | Close the peek; the focus returns to its Task |
| ? | List these keys |

The keys do nothing while you type in a field or while a dialog or menu is open.

## Connecting an agent

An agent needs `DARKORY_URL` (default `http://127.0.0.1:7357`), `DARKORY_TOKEN`, and a Session id from `eval "$(darkory prime)"`.

- **Shell agents** use the CLI: `darkory next` waits for a takeable Task and claims it, and `darkory heartbeat run --background` keeps its Claims alive. Every command has `--json`. The exit status is 3 when a rule refuses the call and 4 when there is nothing to do.
- **MCP clients** run `darkory mcp` over stdio with the same variables. It sends Heartbeats for its own Claims. `attach_evidence` reads only files under its working directory (`--evidence-root`).
- **Anything else** calls the HTTP API: [`api/openapi.yaml`](api/openapi.yaml), with `Authorization: Bearer <token>` and a `Darkory-Session` header on every request.

## Running it elsewhere

Storage, the Evidence store and sign-in are settings of an Install: SQLite or Postgres, local disk or S3-compatible storage, a printed link or an emailed one. Every setting is in [`docs/build/settings.md`](docs/build/settings.md). The container image is built from [`Dockerfile`](Dockerfile); it serves on port 7357 with its data in `/data`, and you create the Organisation once with `docker exec <container> /darkory init`. Releases are described in [`docs/build/release.md`](docs/build/release.md).

## Developing

```sh
make dev        # web app on http://127.0.0.1:7357 (reloads on save), server behind it on 7358 (restarts when Go code changes)
make serve      # the built binary on 7357, with the same Install (.dev/)
```

`make dev` creates its Install in `.dev/` the first time and keeps the token and first login link in `.dev/init.txt`. The server prints a fresh login link each time it restarts. To reach it through a proxy such as `tailscale serve`, put `PUBLIC_URL = https://<name>` in a `local.mk` file (not committed): login links and the Origin check of browser writes then use that address.

```sh
make check      # generated code is current, vet, tests on SQLite, and on Postgres when DARKORY_TEST_POSTGRES_URL is set
make e2e        # the real binary end to end, and a soak (DARKORY_E2E=1)
make web-check  # the web app
```

[`docs/build/testing.md`](docs/build/testing.md) explains the test suites. [`docs/build/plan.md`](docs/build/plan.md) gives the code layout and its invariants, and [`docs/build/decisions.md`](docs/build/decisions.md) logs the defaults chosen while building.

## License

The server, CLI and web app are AGPL-3.0 ([`LICENSE`](LICENSE)). The API spec in `api/` and the generated Go client in `client/` are Apache-2.0, so other programs can use them freely.
