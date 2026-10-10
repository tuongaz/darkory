# MVP build status

**2026-10-10, later:** the ten follow-ups of the dogfood review, picked by the owner ("Do all, plan and implement"): the Task carries its pull request and the owner's merge is a row in Needs you with Merge as its act; a company Skill belongs to a Project (ADR 0020); the queue behind a busy agent is on the Agents page and an agent may run several Shifts (ADR 0013 amended); a Shift's log is the Claim's, not the Task's Evidence; Markdown renders in Notes and bodies; Answer is one act; Evidence shows itself; Activity groups a Shift's end; the Workflows list's acts read as acts; "working" in place of "lapses in". Plan: [`dogfood-followups-plan.md`](dogfood-followups-plan.md); board https://claude.ai/artifact/B4fd93WZDiAa7Xgd6iQesX. The build added what the reviews asked: merging is a human's act, recorded as the one who asked, for the number and address the Owner read, under one lock per Task; a pull request from a fork, into another base or on another branch is never a Task's; an agent's `merged` write is checked through the Runner beside the server when one is attached (and not when none is: a `darkory runner` on another machine has no Runner there to ask); Evidence carries the Claim it was attached under (`claim_id`), so a Shift's log sits on its own Claim however late it arrives. A Task with pull requests in two Workspaces carries the one its address names. Migration 0008 applies on the owner's next `make dev`; the Install's `enably-*` company Skills then need `darkory skill set <skill> --project MAIN`.

**2026-10-10:** the product ran its own repository: Project DARK on the owner's Install, three Tasks (a sidebar trigger, the owner's "cannot delete a Workflow" report, and a Runner defect the run found) taken through Implementation and Bug triage by the roster and merged (PRs #7, #8, #9; main b79defb). The review, with a verdict per requirement and the UI/UX findings, is [`dogfood-2026-10-10.md`](dogfood-2026-10-10.md). Before it, the same day: the sample Workflows (PR #6, [`sample-workflows-plan.md`](sample-workflows-plan.md)).

State on 2026-10-09, at the end of the first build and the Named Workflows build (ADR 0019). The plans are [`plan.md`](plan.md) and [`named-workflows-plan.md`](named-workflows-plan.md).

## Built

- **Server:** all 63 `/v1` operations; none answers 501.
  - Claims, `next` long-poll, Heartbeats and lapses.
  - Handover with no self-review, Blocking with the cycle check, questions and escalations, take-back.
  - Feature rank, ship and drop with their cascades, the Break down and Retrospective Tasks, Observations, Skill versions with review, the model label.
  - Notes, Evidence, Activity with SSE, idempotency keys.
  - Tokens, Sessions, login links, admin, Member deactivation.
- **Storage:** SQLite and Postgres from one schema. Every write in an Organisation runs one at a time behind its counter row (ADR 0011), and the hot paths take one round trip on Postgres.
- **Install settings:** Evidence on disk or S3-compatible storage, emailed sign-in over SMTP, cross-process wake through Postgres `LISTEN/NOTIFY`, and `darkory migrate`.
- **Surfaces:**
  - The CLI, with every operation.
  - `darkory prime`.
  - `darkory mcp`, whose tools cover the agent operations.
  - The embedded React web app.
- **Delivery:** goreleaser for six platforms, a container image, `install.sh`, and `darkory update` with checksum and ed25519 signature checks.
- **Workflows (ADR 0019):** a Project's Steps are grouped into one or more named Workflows, each with its own board and canvas; a Connector may lead into a Step of another Workflow; `workflow show` reads one or all; the software preset's Workflow is named Software and `setup.sh` keeps every other Workflow on a re-run; migration 0006 names every existing Workflow Work.

## How it was checked

- `make check`: unit, rule and race tests on SQLite and on Postgres 14. The race suite runs 50 claimers on one Task and 20 `next` callers over 10 Tasks, and checks that Activity is gapless in commit order, among others.
- `make e2e` and `make e2e-pg` run the real binary. They cover:
  - the map's six-step MVP flow through the CLI and `darkory mcp`;
  - a heartbeat killed mid-Claim;
  - two server processes on one Postgres;
  - a 2-minute soak with 40 Sessions on each engine, whose invariants all held.
- `cd web && npm run e2e`: Chromium against the real binary through the same flow.
- The S3 and SMTP tests run against MinIO and Mailpit in Docker (`DARKORY_TEST_S3=1`, `DARKORY_TEST_SMTP=1`).
- An independent security review is in [`security-review.md`](security-review.md). It found no critical or high findings. Every medium and low finding is fixed with a regression test, apart from the two listed under "Not built".

## Not built

- GitHub and Google sign-in. The sign-in setting leaves room for them.
- Cloud's private repo: billing, signup, many Organisations per Install, and the row-level security policies.
- Export and import.
- A cap on connections per client address.
- A separate signing job behind a GitHub Environment.
- `darkory update` on Windows has been cross-compiled but never run.

## Decisions made during the build that change product rules

These were made while you were away; each has its line in [`decisions.md`](decisions.md), and you may want to revisit them.

- **Skill review fallback.** A skill-review Task falls to the Feature owner only when no Member of the whole Organisation has skill-review (security review M1). Only a Retrospective Task can carry a Skill proposal. ADR 0010 and `CONTEXT.md` are reworded to match.
- **Login links show a page first.** Opening a link no longer signs in; the page's "Sign in as …" button does (a POST), which stops login CSRF. This moved redemption from GET to POST in `/v1`.
- **Browser Sessions expire** after 30 days unused or 90 days in all, and an admin can deactivate and reactivate a Member.
- **`Referrer-Policy` is `same-origin`**, not `no-referrer`: with `no-referrer`, Chromium sends `Origin: null` from the sign-in page and the button is refused.
- **Each Member may hold 16 Activity streams and 16 waiting `next` calls** at once; one more gets 429 `too_many_requests` (`DARKORY_MAX_WAITING`).

## Known limitations

- A Claim made with an explicit `--timeout` shorter than the token's default can lapse before `heartbeat run` lists it. Giving the token the default timeout avoids this.
- Activity `at` times can be slightly out of `seq` order under load; `seq` is the true order.
- Rate limits and the email cap are kept per server process, so with several processes the real ceilings multiply.
- Under heavy contention on SQLite (3,000 Tasks in a minute), `next` reached a p99 of about 1.4 s.

## Before the first release

1. Run `go run ./tools/keygen`. Store the private key as the repository secret `DARKORY_SIGNING_KEY` and the public key as the variable `DARKORY_RELEASE_PUBLIC_KEY`.
2. Create the repository `tuongaz/homebrew-tap`.
3. Push a tag `v0.1.0`. The release workflow builds and signs it.
4. Make the `ghcr.io` image public after its first push.
