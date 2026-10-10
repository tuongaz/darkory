# Darkory

Management for a software factory whose workforce mixes AI agents and humans. Members, human or agent, pull work from one shared record: each Project has one or more Workflows of Steps (Plan, Build, Review…), each with its own board; each Step carries a Skill; a Member claims a Task at a Step whose Skill they have, works it, and advances it along one of the Step's outcomes to the next Step, or into Done. Darkory never starts an agent.

The words used here (Member, Project, Task, Subtask, Step, Claim, advance, Takeable, Retrospective…) are defined in [`CONTEXT.md`](CONTEXT.md). The architecture decisions are in [`docs/adr/`](docs/adr/).

## Quickstart (Local)

```sh
make build                 # or: go build -o bin/darkory ./cmd/darkory   (Go 1.26.8 downloads itself)
bin/darkory init           # creates the Organisation and you, Project MAIN and its agents (--no-agents: MAIN alone); prints your token and a login link
bin/darkory serve          # listens on 0.0.0.0:7357, prints a fresh login link and opens it
```

The web app needs node for its build (`make web`); without it the binary serves a placeholder page and everything else works.

Set up a Project and an agent from the web app, or from the CLI:

```sh
export DARKORY_TOKEN=dk_...            # the token init printed
eval "$(bin/darkory prime)"            # a Session id for this shell, plus the working rules
bin/darkory project create WEB "Web"   # three Workflows: Implementation · Bug triage · Retrospective
bin/darkory member create eng-bot --kind agent
bin/darkory project add WEB eng-bot
bin/darkory grant eng-bot engineer
bin/darkory token issue eng-bot --name laptop --timeout 2m   # give this token to the agent
bin/darkory file --project WEB --title "Login page" --breakdown   # files its Breakdown Subtask at Plan too
bin/darkory workflow show WEB          # each Workflow's Steps, who takes each, and the outcomes out of each
```

## Keys in the web app

| Key | Does |
|---|---|
| ⌘K / Ctrl K | Search Tasks, Projects, Members and pages; go to one, switch Project, file a Task |
| C | File a Task in the current Project |
| G then P | Switch Project |
| G then I, M | Go to the Inbox or My work |
| G then T, B, W, A | Go to the current Project's Tasks, its board, its Workflows or its Agents |
| J or ↓, K or ↑ | Where Tasks are listed (a Project's Tasks or board, the Inbox, My work, a Parent's Subtasks): move to the next or previous Task; with its peek open, show that Task in it |
| Enter | Open the selected Task's peek |
| Esc | Close the peek; the focus returns to its Task |
| F | On a Project's Tasks or board: open the Filters |
| Space, ← or →, Space or Enter | On the board, with a card focused: pick the Task up, carry it to another Step, and move it there; Esc puts it back |
| ⌘Enter / Ctrl Enter | In a Task's Note box: add the Note |
| ? | List the keys |

The keys do nothing while you type in a field, while a dialog or menu is open, or while a Shift's terminal has the focus; Esc in a terminal you are watching hands the keys back.

## Connecting an agent

An agent needs `DARKORY_URL` (default `http://127.0.0.1:7357`), `DARKORY_TOKEN`, and a Session id from `eval "$(darkory prime)"`.

- **Shell agents** use the CLI: `darkory next` waits for a takeable Task and claims it, and `darkory heartbeat run --background` keeps its Claims alive. Every command has `--json`. The exit status is 3 when a rule refuses the call and 4 when there is nothing to do.
- **MCP clients** run `darkory mcp` over stdio with the same variables. It sends Heartbeats for its own Claims. `attach_evidence` reads only files under its working directory (`--evidence-root`).
- **Anything else** calls the HTTP API: [`api/openapi.yaml`](api/openapi.yaml), with `Authorization: Bearer <token>` and a `Darkory-Session` header on every request.

## The CLI

`darkory help` lists every command, and `darkory <command> --help` its flags. Every command takes `--json` (the `/v1` JSON instead of text), `--url`, `--token` and `--session`; the exit status is 0 done, 1 failed, 2 a usage error or a missing setting, 3 refused by a rule of the record, 4 nothing to do.

| Work | |
|---|---|
| `prime [--rules-only]` | print a fresh Session id to `eval`, and the working rules |
| `next [--wait 30s] [--timeout d] [--model label]` | wait for a takeable Task and claim it |
| `takeable`, `claim <task>`, `heartbeat <task>`, `heartbeat run [--background]`, `release <task> [--note]` | take work and keep or give up the Claim |
| `advance <task> [outcome] [--note]` | end your work along one of the Step's outcomes (`darkory show` lists them): to the next Step, or into Done |
| `move <task> <step> [--note]` | move a Task to any Step of its Workflow by hand, such as out of the Backlog |
| `complete <task> [--note]` | complete a Task you hold whose Step has one way into Done, or a Parent you own once its Subtasks have ended |
| `drop`, `take-back`, `rank <task> <position>`, `owner <task> <member>` | the Owner's and the Reporting line's authority |
| `file --title t (--project p \| --parent task \| --blocks task --aim m) [--step s] [--breakdown] [--blocked-by task,…] [--label l]… [--owner m] [--auto-complete] [--acceptance] [--workspace ws]…` | file a Task, a Subtask (splitting the Task when you hold it), or a question that blocks a Task; `--blocked-by` files it already blocked |
| `show <task>`, `tasks [--project p] [--parent task] [--workflow w] [--step s] [--filter field:op:values]…` | read Tasks: the Step, the Parent, the Subtasks, the Labels and the outcomes |
| `note`, `observe`, `observations <task> [--all]`, `attach <task> <file>`, `evidence get` | Notes, Observations and Evidence |
| `block <task> --by <task>`, `unblock` | Blocking |
| `propose <task> --skill s --base n --file f`, `proposal show <task\|id>` | a Retrospective's Skill proposals |
| `activity [--project p] [--task t] [--follow]` | the Activity trail, of a Project or of a Task and its Subtasks |

| Projects, Workflows and Labels | |
|---|---|
| `project create <KEY> <name> [--workflow default\|empty\|copy] [--copy-from p] [--member m]… [--workspace ws] [--color 0-11] [--auto-complete] [--acceptance]` | create a Project with its Workflows (admin) |
| `project list`, `project show <project>`, `project add\|remove <project> <member>`, `project set <project> [--name] [--color 0-11] [--workspace] [--auto-complete=…] [--acceptance=…]` | Projects, their Members, their colour and the defaults a Task filed in them takes |
| `workflow show <project> [--workflow w] [--body]` | each Workflow's Steps (under its name when there are two or more), their Skills and takers, what waits and works at each, and the Connectors out of each, one into another Workflow as `bug → Bugs › Investigate`; `--workflow` shows one; `--body` prints them all as `workflow set` reads them |
| `workflow set <project> --file path\|-` | replace the Project's Workflows (admin): `{"workflows": [{"id", "name", "position"}…], "steps": [{"id", "workflow", "name", "skill", "position", "x", "y"}…], "connectors": [{"from", "to", "name", "position"}…], "moves": {deleted Step id: Step}}`, Workflows, Steps and Skills by name or id, `to` any Step of any Workflow or left out for Done |
| `label create <name> --color #rrggbb [--project p]`, `label list`, `label update`, `label delete` | the Organisation's and a Project's Labels |
| `label set <task> <label,…>` | set the Labels a Task carries (`""` for none) |

Members, Skills, tokens, sign-in, Workspaces, agents and the Runner's Shifts have their commands too (`member`, `skill`, `grant`, `report-to`, `token`, `login`, `session`, `workspace`, `agent`, `shifts`); `darkory help` lists them.

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
