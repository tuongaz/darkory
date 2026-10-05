# 03 — Independent review of the architecture decisions

Review date: 2026-10-05. Reviewer: an AI assistant that took no part in the decisions. Scope: `map.md`, the twelve tickets, ADRs 0001 to 0010, `CONTEXT.md` and both research files, as they stood before the review. Line numbers refer to those versions. Tool claims were checked against the primary sources named in the fact-check table. "Verified" means checked in the files, a primary source, or an experiment; "inferred" means reasoned from them.

The findings below are as written before the human answered. The answers are in [Independent architecture review](../issues/13-independent-architecture-review.md), and the experiments are described at the end of this file.

**Verdict at the time of review: no, not yet.** The core choices hold up. The gaps are where one decision meets another, and the biggest is that identity was decided after the interface and storage it depends on: no document says how an agent holding only `DARKORY_TOKEN` becomes a Session, so the auth layer and the claim statement cannot be written.

---

## Needs your decision: before any code

### 1. An agent with only a token has no way to be a Session
*Verified in the documents.*

- **Wrong:** Ticket 06 gives an agent two settings, a URL and a token sent as a bearer credential. ADR 0008, decided later, binds every timed Claim to a Session "opened by exchanging" the token. No document says how the exchange happens, where the CLI keeps the Session between `darkory next` and `darkory heartbeat` (each is a new process), or what `/v1` does with a bare `dk_` token. If a bare token is accepted, two copies of one Member are one Session, which is the "Sessions ignored" option ADR 0008 rejected.
- **Also:** a Session is "short-lived" and "renews while in use", and a Claim lapses on a missed Heartbeat. No document relates the two timers. If the Session expires first, the agent returns as a new Session and is locked out of its own Task.
- **Files:** `issues/06` lines 36 to 38, ADR 0005, ADR 0008, `CONTEXT.md` (Session, Claim).
- **Why it matters:** it blocks the auth middleware, the claim statement, and the CLI.
- **Fix:** keep the token as the only credential. A Session is an id the client chooses and sends with every request, created on first use. The CLI reads it from `DARKORY_SESSION`, and `darkory prime` prints a new one. A Session lives while it holds a Claim; drop "short-lived, renews".

### 2. On localhost, any process without a token is the admin human
*Text verified; the consequence is inferred.*

- **Wrong:** ADR 0008 says "Local on `localhost` needs no login: the browser is the one human Member." The server cannot tell the browser from an agent's `curl`. An agent on the same laptop that leaves out its token acts as the admin: it can issue tokens, grant itself Skills, take back Claims, ship Features, and so review its own work. The same hole opens when a tunnel or reverse proxy forwards to localhost, and to any web page open in that browser.
- **Files:** ADR 0008 line 5, `issues/07` lines 33 and 34.
- **Why it matters:** on Local, agent tokens and the no-self-review rule become advisory. The symmetric-Member rule holds in the text and fails in practice.
- **Fix:** `darkory serve` prints and opens a one-time link at start, as `darkory init` already does, and the browser keeps a cookie. A request with no credential is never a Member. Setup stays at one command.

### 3. The Team rule contradicts escalation
*Verified in the documents.*

- **Wrong:** `CONTEXT.md` Team says "only its Members can take its Tasks". `CONTEXT.md` Takeable has no Team condition, and neither does the `WHERE` list in ADR 0004. Reporting lines cross Teams, and an Escalation is a Task aimed at someone on that line. A Task aimed at a manager in another Team is untakeable under one definition and takeable under the other.
- **Same clash in three more places:** a Feature owner outside the Team; take-back along a Reporting line against "shaping work is limited to one's own Teams" (ADR 0008); and no document says which Feature a question Task belongs to. On an ended Feature a Member working the Retrospective cannot ask a question at all, because questions are Tasks (ADR 0001) and the Retrospective is "the only Task an ended Feature may hold" (ADR 0010).
- **Files:** `CONTEXT.md` lines 18, 56, 68; ADR 0001; ADR 0004 line 5; ADR 0008 line 7; ADR 0010 line 3.
- **Why it matters:** this is the `WHERE` clause of the claim.
- **Fix:** one precedence rule. A named relation (aimed at, Feature owner, Reporting line) beats Team membership; Skill-matched Tasks stay limited to the Team. A question Task lives in the Feature of the Task it blocks, ended or not.

### 4. "Local" names three different things
*Verified in the documents.*

- **Wrong:**
  - `CONTEXT.md`: Local is self-hosted and holds one Organisation.
  - ADR 0004: Local is SQLite and local disk.
  - ADR 0008: Local has no login on localhost and a printed link beyond it; emailed links and GitHub or Google sign-in are "on Cloud".
  - ADR 0009: Postgres, S3, emailed links, and GitHub and Google sign-in are all in the open core.
- **Correction to your lead:** ADR 0002 does not say a growing team must move to Cloud. It gives two paths: run the Install where others can reach it, or export and import.
  - Path 1 exists, but no document says how a second human signs in to a self-hosted Install: who runs `darkory login`, for which Member, and whether a self-hoster can turn on emailed links.
  - Path 2 is gone. The map ruled export and import out, so a Local Organisation cannot move to Cloud. ADR 0002 line 3 and `issues/04` line 30 still promise it.
- **Also:** Cloud is not "the same server" (`CONTEXT.md` line 122) or "that binary" (ADR 0007 line 7). ADR 0009 makes it a different binary built from a private repo.
- **Why it matters:** it sets the configuration surface and the test matrix, and decides whether "Teams from day one" holds on Local for more than one human.
- **Fix:** make storage (SQLite or Postgres), Evidence store (disk or S3), and sign-in (startup link, emailed link, GitHub or Google) independent Install settings. "Local" is the default profile and "Cloud" is the hosted service. Only many Organisations in one Install is closed.

### 5. Postgres does not behave like SQLite for three rules
*Verified by experiment.*

- **Wrong:** ADR 0004 says "every rule must behave the same on both" and that each rule is "a single portable statement". SQLite runs one write at a time. Postgres does not. A claim is also a transaction, not a statement: the `UPDATE`, an Activity row, an idempotency record, and a sequence number.

| Rule, two concurrent callers on Postgres | Result |
|---|---|
| Activity numbered from a `SEQUENCE` | The slow transaction takes 1; the fast one takes 2 and commits first. A reader at cursor 2 never receives 1, so `Last-Event-ID` resume loses events. |
| Cycle check when adding a Blocking edge | "A blocks B" and "B blocks A" both pass the check. Both Tasks are blocked for good. |
| `next` (pick the top-ranked takeable Task and claim it) | The second caller gets zero rows while four Tasks are still takeable. "The loser stops instead of retrying" is right for `claim` and wrong for `next`. |
| `claim` on a named Task | Correct: one winner, and the loser gets zero rows. |
| Per-Team display key such as `WEB-42` (not run; inferred) | ADR 0004 does not say how the number is allocated. If it reads the highest number so far, two concurrent filers get the same one. |

- **SQLite side** (300 Tasks, 16 concurrent claimers each): never two winners in any configuration. With driver defaults, 2,422 of 4,800 attempts failed with "database is locked" instead of "already claimed". A `busy_timeout` alone still left 2,179 failures (code 517) when the transaction reads before it writes. `_txlock=immediate` with `busy_timeout` gave zero failures.
- **Files:** ADR 0004, ADR 0006 line 5, `issues/05`, `issues/08` line 33.
- **Fix:** the first statement of every write transaction increments a counter row on the Organisation (`UPDATE … SET activity_seq = activity_seq + 1 … RETURNING`). It is portable SQL. In reruns it fixed the first three rows of the table: numbers came out in commit order, the second `next` caller claimed the next Task, and the second edge was refused. It covers display keys the same way. The cost is that one Organisation's writes run one at a time. Heartbeats write no Activity and can skip it. Open SQLite with `_txlock=immediate` and a `busy_timeout`.

---

## Needs your decision: before the code it touches

### 6. One portable migration set cannot hold row-level security, and no document says which side of the open/closed line owns it
*Verified in the documents and the Postgres manual.*

- **Wrong:** ADR 0009 requires "one numbered set … portable across SQLite and Postgres" and rejects one set per engine. ADR 0004 enforces tenancy with Postgres row-level security. `CREATE POLICY` exists only in Postgres. SQLite's `ALTER TABLE` cannot change constraints, which expand-then-contract migrations need.
- **Boundary:** hosting many Organisations is closed (ADR 0009), yet `org_id` and row-level security sit in the open storage decision. No document says who owns the policy statements, who may create a second Organisation, or how a request maps to an Organisation. Policies kept in the private repo are a second migration set that must follow every open table.
- **Postgres facts:** table owners bypass policies unless the table has `FORCE ROW LEVEL SECURITY`; superusers and `BYPASSRLS` roles always bypass; a table with no policy denies everything. The server must not connect as the table owner and must set the Organisation in each transaction.
- **Fix:** reword to one logical schema and one migration numbering, with per-engine SQL where the engines differ, tested on both. Every open query filters by `org_id` (SQLite needs that anyway). Policies ship in the open Postgres migrations as a second lock. The private repo adds only Organisation creation, signup, and billing. On those terms the boundary is coherent.

### 7. The retrospective can stall silently, and it strains four definitions
*Text verified; the consequences are inferred.*

- **No one holds the Skill.** If no Member of the Feature's Team has `retro`, the Task is never takeable and no one is told. Publishing a Skill version needs a second Member in the same Team holding `skill-review`. ADR 0010 rejected manual retros because "the improvement loop becomes skippable"; this skips it too.
- **Rank.** A Task "sorts by its Feature's Rank", and no document says whether an ended Feature keeps one.
- **"The only Task an ended Feature can hold"** is false as written: it also holds its done and dropped Tasks. It means the only open Task.
- **"An ordinary Task"** whose completion marks Observations reviewed and may publish a Skill version. The Task needs a kind.
- **Two retros** can each propose version N+1 of the same company Skill from version N. There is no rule for the second.
- **Fix:** when no Member of the Team holds the needed Skill, the Feature owner can take the Task. Ended Features keep their Rank. A proposal records its base version, and publishing refuses a stale base.

### 8. Feature breakdown, step 2 of the MVP flow, has no pull path
*Verified in the documents.*

- **Wrong:** a Feature "is never claimed itself" and `next` returns only Tasks. A new Feature with no Tasks is invisible to every agent, and nothing stops two agents breaking down the same Feature.
- **Files:** `map.md` line 27, `CONTEXT.md` line 36.
- **Fix:** filing a Feature also files a "Break down" Task that needs a breakdown Skill, the same mechanism as the retrospective.

### 9. No document says who sends Heartbeats, and `next` has no timeout
*Inferred.*

- **Wrong:** `next` "claims as it returns", but only `claim` is listed with a heartbeat timeout. A Task claimed through `next` would be untimed, so a crashed agent holds it until someone takes it back. An agent driven through the CLI is a model calling `darkory` between other tool calls, and nothing sends a Heartbeat during a 20-minute build.
- **Files:** `issues/06` lines 26 to 29, ADR 0003.
- **Fix:** `next` takes the same timeout, with a default stored on the token. `darkory mcp` is long-running and sends Heartbeats for its Session's Claims; the CLI gets a background `darkory heartbeat --every`.

### Smaller gaps, one line each

*All inferred: each is something the documents do not say.*

1. **Feature end.** No rule for open or claimed Tasks when a Feature ships or drops. Suggest: shipping needs every other Task ended; dropping a Feature drops its open Tasks.
2. **No-self-review.** "Cannot take it at the stage they handed it to" lets a builder take a later review stage of their own Task. Suggest: no review stage of a Task you worked.
3. **Order in `next`.** Rank is per Team; a Member in two Teams has no merged order, and Tasks inside one Feature have none.
4. **Licence of the client.** With the Go client and `openapi.yaml` under AGPL, a program that imports the client may take on AGPL terms; I have no source that settles it. Suggest a permissive licence for the spec and clients.
5. **Late Heartbeat.** No rule for a Heartbeat that arrives after expiry when nobody has re-claimed. Suggest: refuse it, so a lapse is always a lapse.

---

## Plain document corrections

*All verified against the files. Rows 8 and 9 are also verified against the tools' own documentation.*

| # | Where | Correction |
|---|---|---|
| 1 | `issues/03` line 44: states "open, claimed, done, dropped" | A stored `claimed` state goes stale when a Claim lapses, which ADR 0004 forbids. Store open, done, dropped; derive claimed. |
| 2 | ADR 0004: Claim as columns on the Task | ADR 0010 needs the Skill version of every Claim, and no-self-review needs handover history; Activity "is never the source of truth". Add a claims table, one row per Claim. |
| 3 | `issues/03` line 33 against ADR 0004 line 6 | Take-back is "up the Reporting line" in one and "the Reporting line or the Feature owner" in the other. Pick one and put it in `CONTEXT.md`. |
| 4 | `issues/03` line 33; `research/02` line 7 and pattern 8 | Still say Claims never lapse. Add "revised by ADR 0003". |
| 5 | ADR 0002 line 3; `issues/04` line 30 | Still promise export and import. Mark as not available. |
| 6 | `issues/06` lines 27 to 32 | Operation set lacks: Session, token issue and revoke, Member, Team, Skill and Reporting-line admin, grant a Skill, `observe`, read a Skill and its versions, propose a version, take-back, pass Feature ownership. `/v1` is additive, so this is a list to extend. |
| 7 | `issues/06` line 33 | "Every write on a held Task is refused unless the caller holds its Claim" contradicts `drop` by the Feature owner and take-back. List the exceptions. |
| 8 | ADR 0005 line 3 | CLI and MCP are not "generated from that spec". oapi-codegen generates Go server stubs, clients and types. They are hand-written on the generated client. |
| 9 | ADR 0004 line 6 | "The next claimer writes the lapse record" cannot learn the lapsed holder from `RETURNING` (new values only on SQLite; old values only from Postgres 18). Copy the old holder into a column in the same `UPDATE`. |

---

## Fact check of tool and library claims

| Claim | Result | Source |
|---|---|---|
| `modernc.org/sqlite` is pure Go and covers the six platforms | Correct. "CGo-free port"; darwin, linux and windows on amd64 and arm64; bundles SQLite 3.53.4; BSD-3-Clause. | pkg.go.dev/modernc.org/sqlite (v1.60.1) |
| SQLite with concurrent writers | One write transaction at a time. The driver's default `_txlock` is `deferred`, which fails on read-then-write. See finding 5. | sqlite.org/lang_transaction.html, sqlite.org/c3ref/busy_handler.html, my test |
| oapi-codegen gives server stubs and a Go client | Correct. Go only; OpenAPI 3.0 and 3.1 ("initial" 3.1 support). No TypeScript, CLI or MCP output. | github.com/oapi-codegen/oapi-codegen README |
| Official Go MCP SDK | Correct. `modelcontextprotocol/go-sdk`, v1.7+, stdio transport, MCP spec 2026-07-28. Apache-2.0 and MIT. | github.com/modelcontextprotocol/go-sdk README |
| Row-level security enforces tenancy | Works, with the three caveats in finding 6. Unique and foreign-key checks bypass it. | postgresql.org/docs/current/ddl-rowsecurity.html |
| `LISTEN/NOTIFY` wakes other processes | Works. Delivered at commit, in commit order; payload under 8,000 bytes. `LISTEN` never works through transaction pooling, so each server process needs one direct connection. A commit that notified takes a database-wide exclusive lock, so those commits run one at a time across all Organisations. Acceptable for the MVP; the wake is internal and replaceable. | postgresql.org/docs/current/sql-notify.html, pgbouncer.org/features.html, `src/backend/commands/async.c` |
| AGPL core with a private repo importing it | Holds. "The developer itself is not bound by it." The CLA must grant the right to license contributions under other terms, and the core must never import a GPL or AGPL library. The named dependencies are all permissive. | gnu.org/licenses/agpl-3.0.txt section 13, gnu.org/licenses/gpl-faq.html |
| Temporal comparison in ADR 0003 | Correct. A heartbeat timeout of 0 disables the timer; cancellation reaches a worker when it heartbeats. | docs.temporal.io/encyclopedia/detecting-activity-failures |
| SSE for the browser | Six connections per browser per domain without HTTP/2. Local on plain `http://localhost` is HTTP/1.1, so a seventh tab hangs. Share one stream across tabs. | developer.mozilla.org EventSource |

---

## Sound: no problems found

- One authority per Organisation and no offline mode (ADR 0002).
- The claim on a named Task as one conditional `UPDATE … RETURNING`: one winner on both engines in my tests.
- Takeable computed at read time, UUIDv7 with display keys, Evidence behind a blob interface.
- HTTP as the canonical contract, `/v1` additive, idempotency keys, long-poll `next` (ADR 0005).
- The web app embedded and calling the same `/v1` (ADR 0006).
- Heartbeat lapse, and binding by timeout so that Members stay symmetric (ADR 0003, ADR 0008). The rule is sound; its mechanics are findings 1 and 9.
- The research files: the claims the ADRs draw from them match what the files record.
- AGPL with a CLA, no automatic update, refusing an older binary on a newer database (ADR 0009).
- Lapse at read time against revocation "at once": no conflict, provided revocation clears the Claims in its own transaction.
- **Fixed rules.** No decision breaks pull-based: filing the retrospective starts no one, and SSE and long-poll are opened by the Member. Symmetric Members hold in the text; finding 2 breaks them in practice on Local. Cloud and local both hold, subject to finding 4.

---

## Go or Python

**Recommendation: stay with Go.** ADR 0007 weighed Rust and TypeScript and never considered Python.

1. **Delivery decides it.** ADRs 0005 and 0007 require one static binary that is server, CLI and MCP server, on six platforms, with no runtime to preinstall. Go builds all six from one machine, and the SQLite driver needs no C. Python cannot: PyInstaller output "is specific to the active operating system and the active version of Python", so each platform is built on that platform, and a one-file build unpacks to a temp folder at every start, which every `darkory heartbeat` call would pay. Other Python packagers exist; each needs either a build per platform or a runtime in the sandbox.
2. **Concurrency is not the deciding factor.** Idle long-polls and SSE streams are cheap in Python's asyncio too. Go's edge is smaller: each request is plain blocking code, and the race detector covers the claim test suite. Python's built-in SQLite driver blocks and needs a thread pool.
3. **Postgres is a draw.** `pgx` and `psycopg` are both first-rate. Python's real advantage is SQLAlchemy with Alembic, which handles the two-engine differences in finding 6 better than anything in Go. That is a cost of choosing two engines, not of choosing Go.
4. **"AI friendly."** Darkory's server never calls a model, so Python's AI libraries have nothing to attach to, and both languages have an official MCP SDK. For agents writing the code, my judgement (not a sourced fact) is that Go's compiler and single formatting style catch more agent mistakes before runtime.

Python becomes the better choice only if you drop single-binary delivery or drop SQLite, and both are decided. Agent authors who want Python can get a client generated from `openapi.yaml` later.

---

## Decisions the review asked for

All thirteen are answered in [ticket 13](../issues/13-independent-architecture-review.md), with one more that came up on the way (which database Local uses).

**Before any code**

1. Session: may a Session be a client-chosen id sent with the token (recommended), or do you want an explicit exchange call?
2. Localhost: may `darkory serve` require a one-time startup link, so that no request without a credential is ever a Member (recommended)?
3. Teams: does a named relation (aimed at, Feature owner, Reporting line) beat Team membership (recommended)?
4. Local: are storage, Evidence store and sign-in independent Install settings, with Local as the default profile (recommended), and do you accept that a Local Organisation cannot move to Cloud in the MVP?
5. Writes: do you accept that writes within one Organisation run one at a time, on Postgres as on SQLite (recommended)?

**Before the code it touches**

6. Row-level security: do the policies ship in the open Postgres migrations (recommended) or in the private repo?
7. Retrospective: when no Member of the Team holds `retro` or `skill-review`, may the Feature owner take the Task (recommended)?
8. Breakdown: does filing a Feature also file a "Break down" Task (recommended)?
9. Heartbeats: does `next` take a timeout with a default stored on the token (recommended)?
10. Feature end: must every other Task have ended before a Feature ships, and does dropping a Feature drop its open Tasks (recommended)?

**Any time before release**

11. No-self-review: does it cover every review stage of a Task the Member worked (recommended), or only the stage they handed it to?
12. Licence: do `openapi.yaml` and the generated clients get a permissive licence (recommended)?
13. Language: does Go stand (recommended)?

---

## Questions raised while deciding

### Would dropping SQLite remove the write-order problem?

No. The counter row in finding 5 protects Postgres, not SQLite: SQLite passed every test, and Cloud is Postgres under every option. One engine would only make the rule-by-rule fixes cheaper, because Postgres-only tools would stop costing portability. Three ways to run Local were priced:

| Path | Starting on a laptop | Cost |
|---|---|---|
| Keep SQLite (chosen) | One binary, one command, nothing else | Two engines: per-engine SQL where they differ, and tests on both. |
| Postgres through Docker | Install Docker, then start two containers | Reverses "needs nothing else" (`issues/04` line 28) and "Docker breaks zero setup on a laptop" (ADR 0007 line 15). Docker Desktop is free only for "fewer than 250 employees AND less than $10 million in annual revenue" ([Docker Desktop license](https://docs.docker.com/subscription/desktop-license/)). |
| Postgres started by the binary | One command, no Docker; the first run downloads Postgres | [`fergusstrange/embedded-postgres`](https://github.com/fergusstrange/embedded-postgres) v1.34.0 (2026-03-18) downloads Postgres 18.3 from Maven and caches it in the home directory; persistent data needs `DataPath` set outside its runtime folder. The [binaries it uses](https://repo1.maven.org/maven2/io/zonky/test/postgres/) have no Windows arm64 build. A child Postgres process to manage; `research/02` records start and stop hangs in the npm equivalent. |

SQLite was kept because zero setup is a stated reason to build (`map.md` line 33), and because SQLite can be dropped later far more cheaply than it can be added.

### What do serial writes cost?

Measured with `pgbench` on the local Postgres described below. Each transaction updated one Task row and inserted one Activity row; the serial variant first incremented the Organisation's counter row.

| Case, one Organisation | 1 client | 8 clients | 32 clients | 100 clients |
|---|---|---|---|---|
| No added delay, concurrent | 8,811/s | 23,863/s | 23,335/s | 20,493/s |
| No added delay, serial | 6,811/s | 6,972/s | 4,983/s | 1,797/s |
| 1 ms per statement, concurrent | 146/s | 1,506/s | 5,694/s | 18,210/s |
| 1 ms per statement, serial, four round trips inside the counter | 148/s | 246/s | 240/s | 224/s |
| 1 ms per statement, serial, write sent as one statement | 702/s | 5,699/s | 14,313/s | 6,257/s |

- A lone write took 0.15 ms with the counter and 0.11 ms without.
- With 100 clients writing without pause and 1 ms per statement, the average wait was 447 ms for four round trips inside the counter and 16 ms for one.
- Fifty Organisations with 100 clients between them reached 10,220 writes a second with four round trips, so Organisations do not wait on each other.
- Caveat: "On macOS, write caching can be prevented by setting `wal_sync_method` to `fsync_writethrough`" ([Postgres manual](https://www.postgresql.org/docs/current/wal-reliability.html)), and this test ran with `open_datasync`, so commits here are faster than on a cloud disk. On Cloud the one-statement figure is likely nearer 500 to 1,000 a second (estimate, not measured).
- Demand, as an assumption: one write every 10 seconds per working agent gives 10 writes a second for 100 agents.

### How does Go work with AI?

The server never calls a model and never starts an agent, so the AI sits in the agents, which can be written in any language and reach Darkory over HTTP, MCP or the CLI. Where AI does touch the server's code: the official Go MCP SDK (v1.7+); a Python client can be generated from `openapi.yaml`; and if the server ever calls a model, official Go SDKs exist ([Claude SDK for Go](https://github.com/anthropics/anthropic-sdk-go) v1.78.0, [OpenAI Go](https://github.com/openai/openai-go) v3.71.1, both released in the week of the review).

### Do different AI models per Member, Session or Task change anything?

The human noted that Members will not share one AI model, and that the model can change with the Task. No decision has to change: the server never calls a model, so the choice sits in each agent. It does touch the retrospective loop. ADR 0010 has every Claim record its Skill version "so later retrospectives can judge whether a change helped"; if the model also varies, a retrospective cannot tell a Skill change from a model change. Three treatments were weighed:

| Treatment | Cost |
|---|---|
| Agents report a model label on the Claim; advice on models lives in the company Skill text (chosen) | One optional field that Darkory stores and never interprets. |
| Darkory holds a model setting on the Member, Skill or Task | Only advice, since Darkory never runs the agent, and close to "launching or supervising agent runs", which the map rules out. |
| Darkory knows nothing about models | Nothing to build; retrospectives stay blind to the model, and past Claims can never be labelled afterwards. |

---

## Experiments

### SQLite race test

`modernc.org/sqlite` v1.60.1 (SQLite 3.53.4), Go 1.26.0, WAL mode, `database/sql` with its default unlimited pool. 300 Tasks; for each, 16 goroutines ran the claim at the same moment. The claim was `UPDATE task SET holder = ? WHERE id = ? AND holder IS NULL RETURNING id`, in a transaction that also inserted an Activity row.

| Configuration | Winners | Clean "already claimed" | "database is locked" errors | Tasks with two winners |
|---|---|---|---|---|
| Transaction reads, then writes; driver defaults | 300 | 2,078 | 2,422 | 0 |
| Same, with `busy_timeout` 5 s | 300 | 2,321 | 2,179 (code 517) | 0 |
| Transaction writes first; `busy_timeout` 5 s | 300 | 4,500 | 0 | 0 |
| Transaction reads, then writes; `_txlock=immediate`, `busy_timeout` 5 s | 300 | 4,500 | 0 | 0 |
| Bare statement, no transaction; driver defaults | 300 | 1,698 | 2,802 | 0 |
| Bare statement; `busy_timeout` 5 s | 300 | 4,500 | 0 | 0 |

### Postgres two-session tests

PostgreSQL 14.17, local, default Read Committed isolation. In each test the first session ran its statement inside a transaction and held it open for two seconds; the second session ran its statement half a second in.

| Test | Statement | Result for the second session |
|---|---|---|
| `claim` on a named Task | `UPDATE task SET holder = 'b' WHERE id = 1 AND holder IS NULL RETURNING id` | Zero rows. One winner. |
| `next` | `UPDATE task SET holder = 'b' WHERE id = (SELECT id FROM task WHERE holder IS NULL ORDER BY rank LIMIT 1) AND holder IS NULL RETURNING id` | Zero rows, with four of five Tasks still unclaimed. |
| Activity from a sequence | `INSERT INTO activity (who) VALUES (…)` on a `bigserial` column | The second session committed number 2 first. A reader then at cursor 2 asked for numbers above 2 after the first session committed number 1, and got nothing. |
| Cycle check | `INSERT INTO blocks SELECT 'B', 'A' WHERE NOT EXISTS (<recursive path from A to B>)` against a pending "A blocks B" | Inserted. Both edges stored. |
| Counter row | `UPDATE org SET seq = seq + 1 WHERE id = 1 RETURNING seq`, then the insert | Waited 1.51 s for the first session to commit, then took the next number. |
| `next`, counter taken first | As above, after the counter update | Claimed Task 2. |
| Cycle check, counter taken first | As above, after the counter update | Refused. One edge stored. |

### Benchmark

`pgbench` for six seconds per case against the same Postgres, with `fsync=on`, `synchronous_commit=on` and `wal_sync_method=open_datasync`; 100,000 Task rows and 50 Organisation rows. The added 1 ms per statement used `\sleep 1 ms` between statements, inside the transaction where the case says so.
