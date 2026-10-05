# Darkory MVP build plan

The architecture is fixed in `docs/adr/0001`–`0011` and the glossary in `CONTEXT.md`. Read both before writing code; use the glossary's terms in names, messages and docs. This file says how the code is laid out, the invariants every change must keep, and the order of work. Defaults chosen during the build go in [`decisions.md`](decisions.md), one line each, with the reason.

## Toolchain

- Go module `github.com/tuongaz/darkory`, `go 1.26.8` with `toolchain go1.26.8` (the toolchain downloads automatically).
- `modernc.org/sqlite`, `github.com/jackc/pgx/v5`, `github.com/oapi-codegen/oapi-codegen/v2` (pinned as a `tool` in `go.mod`), `github.com/oapi-codegen/runtime`, `github.com/modelcontextprotocol/go-sdk`.
- Web app: React + Vite + TypeScript in `web/`, TS client generated from the same `openapi.yaml` (`openapi-typescript` + `openapi-fetch`).
- Postgres for tests: `DARKORY_TEST_POSTGRES_URL` (for example `postgres://dk@localhost:54329/postgres?sslmode=disable`). Tests that need Postgres skip when it is unset. Each test creates its own database or schema and drops it.

## Layout

```
cmd/darkory/            one binary: serve, init, migrate, prime, login, mcp, update, and the CLI commands
api/openapi.yaml        the contract (Apache-2.0, see api/LICENSE)
client/                 generated Go types and client (Apache-2.0, see client/LICENSE)
internal/server/        HTTP handlers implementing the generated ServerInterface; auth middleware; SSE; long-poll
internal/core/          the domain rules, as operations over the store (one file per area: claim, task, feature, org, skill, retro…)
internal/store/         open SQLite/Postgres, migrations runner, the Write helper, query helpers
internal/store/migrations/  NNNN_name.sql, or NNNN_name.sqlite.sql + NNNN_name.postgres.sql under one number
internal/auth/          tokens, Sessions, login links, cookies
internal/blob/          Evidence store: disk and S3-compatible
internal/wake/          in-process wake, and Postgres LISTEN/NOTIFY across processes
internal/cli/           CLI commands, written on client/
internal/mcp/           MCP server (stdio), written on client/
internal/config/        Install settings: storage, Evidence store, sign-in, listen address, public URL
web/                    React app; web/dist is embedded (a placeholder index.html is committed so `go build` works without node)
e2e/                    the end-to-end suite and soak against the built binary, run with DARKORY_E2E=1 (make e2e, make e2e-pg)
docs/build/             this plan, decisions.md, testing.md
```

Root `LICENSE` is AGPL-3.0. `api/` and `client/` carry Apache-2.0 ([ADR 0009](../adr/0009-agpl-core-closed-cloud-operations.md)).

## Invariants

1. **Every write goes through `store.Write`.** `Write(ctx, orgID, func(tx, seq) error)` opens the transaction (immediate on SQLite), increments the Organisation's counter row as its first statement, and hands the returned number to the callback as the Activity sequence. Nothing writes outside it except Heartbeats, which use `store.WriteNoSeq` and record no Activity ([ADR 0011](../adr/0011-organisation-writes-run-one-at-a-time.md)). Wake waiters only after commit.
2. **One rule, one SQL statement where the ADR says so.** The claim is one conditional `UPDATE … WHERE <every takeable check> … RETURNING`. Takeable is computed at read time from one shared SQL fragment used by `claim`, `next` and `takeable`. Claimed and lapsed are derived from `claim_expires_at` and never stored as state ([ADR 0004](../adr/0004-sqlite-local-postgres-cloud.md)).
3. **Same behaviour on both engines.** One set of queries. Every store and core test runs on SQLite, and on Postgres when the URL is set. Times are `BIGINT` Unix milliseconds and ids are `TEXT` UUIDv7 on both engines, so the schemas stay comparable. `now` is passed in from a `Clock` so tests control lapses.
4. **Round trips while holding the counter.** On Postgres the hot-path writes (claim, `next`'s claim, heartbeat, release, handover, complete, note, observe) send the whole transaction in one round trip, using `pgx.Batch` or a single statement; when a conditional write returns no row, the reason is read after rollback. A test with a pgx tracer checks the count. Admin writes may take more.
5. **Every query filters by `org_id`.** The Organisation comes from the caller's Member, never from the request body.
6. **Claim guard.** Every write on a held Task is refused unless the caller holds its Claim (Session-bound when the Claim has a timeout, Member-bound otherwise), except the Feature owner's `drop` and take-back by the Reporting line or the Feature owner.
7. **Idempotency.** Every write accepts `Idempotency-Key`. The result is stored in the same transaction, keyed by Member and key, kept 24 h; a retry returns the stored result.
8. **No credential, no Member.** Every `/v1` route except health, the login-link redemption and the email sign-in request needs a bearer token or the browser cookie. Bearer requests carry `Darkory-Session`.
9. **The CLI, MCP server and web app use only `/v1`.** Nothing reads the database directly, and nothing is reachable only from the web app.

## Phases

Each phase ends with `make check` green on SQLite and on Postgres, and a commit.

0. **Contract.** `go.mod`, licenses, `Makefile` (`gen`, `build`, `test`, `test-pg`, `check`), the full `openapi.yaml` for every operation in ticket 06 and its revisions, generated server interface and client, the first migration for both engines, the migration runner with backup and the newer-database refusal, the schema-equality test, `store.Write` with its tests, and a `darkory serve` that answers 501 for every unimplemented operation.
1. **Claim path.** Install bootstrap (`init`, `serve` with the startup link), tokens, Sessions, login links and cookies, admin of Members, Teams, Skills, Reporting lines and Skill grants, Features with the Breakdown Task, filing Tasks, `takeable`, `claim`, `next` (long-poll), `heartbeat`, `release`, `complete`, lapse records and the visibility sweeper, Activity with `after` and the SSE stream, idempotency, in-process wake. The race suite on both engines.
2. **Flow and learning.** Handover, no self-review, Blocking with the cycle check, questions and escalations, take-back, Task drop, Feature rank, ship and drop with their cascades, the Retrospective, Observations, Skill versions with proposal, review and stale-base refusal, model label, Feature ownership, Notes, Evidence on disk.
3. **Surfaces and delivery, in parallel.** (a) the web app; (b) the full CLI, `prime`, background heartbeat, and `darkory mcp`; (c) Postgres `LISTEN/NOTIFY` wake across processes, S3 Evidence, emailed sign-in, `darkory migrate`; (d) release config, container image, install script, `darkory update` with checksum and signature checks, the update notice.
4. **Proof.** An end-to-end run of the six-step MVP flow from the map through the CLI and MCP with two agent Members and one human, a concurrency soak on both engines, a security pass, and fixes.

## Not in this build

GitHub and Google sign-in (an Install setting in ADR 0002; the sign-in interface leaves room for them), Cloud's private repo (billing, signup, many Organisations per Install, row-level security policies), and export and import.
