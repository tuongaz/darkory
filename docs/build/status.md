# MVP build status

State on 2026-10-06, at the end of the first build. The plan is [`plan.md`](plan.md).

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

## Before the first release

1. Run `go run ./tools/keygen`. Store the private key as the repository secret `DARKORY_SIGNING_KEY` and the public key as the variable `DARKORY_RELEASE_PUBLIC_KEY`.
2. Create the repository `tuongaz/homebrew-tap`.
3. Push a tag `v0.1.0`. The release workflow builds and signs it.
4. Make the `ghcr.io` image public after its first push.
