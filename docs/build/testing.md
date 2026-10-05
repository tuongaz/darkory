# Testing on both engines

Every store and core test runs on SQLite, and on Postgres as well when `DARKORY_TEST_POSTGRES_URL` is set ([plan invariant 3](plan.md#invariants)). Tests always run with the race detector.

## Running

```sh
make test       # every test, SQLite only; Postgres tests skip
make test-pg    # every test on SQLite and Postgres
make check      # generated code up to date, go vet, then both of the above
DARKORY_TEST_S3=1 DARKORY_TEST_SMTP=1 make test   # also MinIO and Mailpit in Docker
make web-check  # the web app: typecheck, eslint, vitest (needs node; run `npm ci` in web/ first)
```

`make test-pg` sets `DARKORY_TEST_POSTGRES_URL=postgres://dk@localhost:54329/postgres?sslmode=disable`. Point it elsewhere with `make test-pg TEST_POSTGRES_URL=…`, or set the variable yourself for a single package:

```sh
DARKORY_TEST_POSTGRES_URL='postgres://dk@localhost:54329/postgres?sslmode=disable' go test -race ./internal/store/...
```

## The Postgres the tests need

Postgres 14 or newer, and a role that may create databases. The URL names any database the role can connect to (`postgres` is fine); tests never write to it. Each test creates its own database, `dk_test_<random>`, from `template0`, and drops it `WITH (FORCE)` when the test ends, so packages can run in parallel against one server.

A throwaway local server on the port the Makefile expects:

```sh
initdb -D /tmp/dk-pg -U dk --auth=trust
pg_ctl -D /tmp/dk-pg -o "-p 54329" -l /tmp/dk-pg.log start
```

or with Docker:

```sh
docker run -d --name dk-pg -p 54329:5432 -e POSTGRES_USER=dk -e POSTGRES_HOST_AUTH_METHOD=trust postgres:14
```

If a test run is killed before its cleanup, drop what it left behind:

```sh
psql "$DARKORY_TEST_POSTGRES_URL" -Atc "SELECT 'DROP DATABASE \"' || datname || '\" WITH (FORCE);' FROM pg_database WHERE datname LIKE 'dk_test_%'" | psql "$DARKORY_TEST_POSTGRES_URL"
```

## Writing a test that runs on both

Use `internal/store/storetest`. `Each` runs the body once per engine as subtests named `sqlite` and `postgres`, each with a fresh, migrated database:

```go
func TestSomething(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		org := storetest.Organisation(t, s)
		err := s.Write(t.Context(), org, func(tx store.Tx, seq int64) error {
			// …
		})
		// …
	})
}
```

- `storetest.Open(t, engine)` and `storetest.OpenUnmigrated(t, engine)` give one database on a named engine.
- `storetest.DSN(t, engine)` gives an empty database's DSN, for tests that open several Stores on one database.
- A Postgres-only test asks for `store.Postgres` directly; it skips when the URL is unset.

Write queries once, with `$1, $2…` placeholders; both drivers accept them, repeated and in any order.

## What guards what

- `internal/store`: `Write` numbers Activity without gaps in commit order under 50 concurrent writers, with no "database is locked" on SQLite; the migration runner, its SQLite backup and its refusal of a newer database; `TestSchemaIsTheSameOnBothEngines` compares tables, columns, nullability, primary keys, indexes and foreign keys after migrating each engine (it skips without Postgres, having nothing to compare with); `TestEveryTableCarriesOrgID`.
- `internal/server/gen`: `TestSpecKeepsTheConventions` validates `api/openapi.yaml` and checks every operation for `Idempotency-Key` on writes, the credential requirement, and the `Error` default response.
- `internal/store` also: `WriteBatch` takes the counter first and a failed guard rolls everything back; `TestWriteBatchIsOneRoundTripOnPostgres` counts the round trips on the wire (`storetest.Wire`).
- `internal/core`, on both engines with a fake clock (`clock.Fake`): every branch of the Takeable rule and its negative (`rule_test.go`); lapses at expiry, a late Heartbeat refused, the lapse recorded once by whoever meets it first, Session binding, revocation and close ending Claims, idempotent claims (`claim_test.go`); admin operations, the admin mark, Reporting-line cycles, filing (`admin_test.go`). The race suite (`race_test.go`): 50 claims of one Task give one winner and 49 `already_claimed`; 20 `next` callers over 10 Tasks claim each once and leave nothing takeable; a late Heartbeat racing a claimer and the sweeper records one lapse; a reader following `after` under concurrent writers sees every Activity number in order; concurrent retries under one Idempotency-Key make one write. `TestHotPathWritesAreOneRoundTripOnPostgres` checks claim, `next`'s claim, heartbeat, release and complete each send one batch in one round trip. Run the race suite repeatedly with `go test -race -count=5 -run Race ./internal/core/`.
- `internal/core`, Phase 2: Handover and no self-review, the holder's Notes and Observations, take-back up the Reporting line, the owner's Task drop (`flow_test.go`); Blocking across Features, cycles, the authority to block, questions and Escalations (`blocking_test.go`); Rank, ship, drop and its cascade, ownership, the owner's fallback for the Break down and the Retrospective, a Retrospective sorting by its ended Feature's Rank (`features_test.go`); proposals, publishing, the stale base, the author's refusal, Observations reviewed, a Feature filed from a Retrospective (`retro_test.go`); every Activity kind written is listed (`kinds_test.go`). Races: two opposite block edges and a triangle never both close (`TestRaceOppositeBlockEdges`, run it with `-count=20`); ship against filing a Task (`TestRaceShipAgainstFilingATask`). The round-trip test also covers handover, note, observe and a publishing complete.
- `internal/blob`: the disk store's put, get and delete; keys that would leave the store are refused; a short, long or cancelled put leaves no file.
- `internal/server`: health with its sign-in modes, JSON 404s under `/v1`, and the web app at `/`; through the generated Go client on both engines: no credential is 401 even from 127.0.0.1, a token without a Session is `session_required`, the claim path from filing a Feature to completing its Break down, idempotency keys, a login link signing a browser in, and the Activity stream resuming with `Last-Event-ID`. `security_test.go`: a cookie write from another origin, a sibling port or with no Origin or Referer is 403 while one from the Install's own origin passes and bearer writes need no Origin; JSON bodies need `application/json`; the Activity stream ends without sending more once its token is revoked or its Session closed. `flow_test.go`: health's sign-in modes and update notice; Activity read backwards and the stream from now; the Activity enums match the core; Evidence on both engines (the holder and Team rules, the size limit, path filenames, retries, nosniff attachments). `mvp_test.go`: the MVP flow through the generated client on both engines, from a human filing a Feature to a published Skill version and a later Claim under it. In `internal/core`, `TestRevocationStopsLongRequestsAndClaims` covers a waiting `next` and a claim from an ended Session.
- `cmd/darkory`: `init` runs once and prints a token and a login link; `serve` prints a startup link and opens it unless told not to, and with `--no-login-link` issues none. `migrate --dry-run` lists and applies nothing, `migrate` applies, both and `serve` refuse a newer database, and `serve` on Postgres refuses pending migrations without `--migrate`.
- `internal/wake` (Postgres): a Signal in one process wakes that Organisation's waiters in another and no others; an idle LISTEN connection survives its pings; killing it (`pg_terminate_backend`) wakes every waiter once it is back, and later Signals arrive again; a LISTEN that never hears its own probe is reported; bursts coalesce and a failed NOTIFY is resent. `TestWritesOnOneProcessWakeWaitersOnAnother` runs two Stores and two HTTP servers on one database: a waiting `next` and an Activity stream on A answer within 1 s of a write on B, before and after both LISTEN connections are killed.
- `internal/blob`, with `DARKORY_TEST_S3=1` and Docker: put, get and delete against MinIO; a missing key is `ErrNotFound`; a reader that fails, ends early or is cancelled leaves nothing; 50 MiB streams with the heap growing by kilobytes; a wrong secret fails without showing it; Evidence attached through `/v1` to an Install set to S3 lands in the bucket under its prefix and downloads back.
- `internal/auth`: the rate limiter's burst and refill; ten times its cap of new keys keeps it at the cap with the most recent kept and none refused; a limited key that keeps trying is never evicted into a fresh bucket.
- `internal/mail`: STARTTLS with AUTH PLAIN, implicit TLS, refusing plain text unless `tls=none`, an untrusted certificate, a silent server, and header injection, all against an in-process SMTP server. `internal/server/signin_test.go`: an emailed link signs a browser in once and expires at 15 minutes; unknown addresses send nothing; the reply comes before the send; per-Member and per-client limits, a Member asked for from 20 clients held to their limit, 10,000 made-up addresses from as many /64s creating no Member key and taking no token from the cap, an IPv6 client limited by its /64, and the cap on emails sent (202, nothing issued, one warning a minute, refilled over the hour); no email without a mailer or a public URL; `X-Forwarded-For` with `--proxy-hops`. With `DARKORY_TEST_SMTP=1` and Docker, the same round trip through Mailpit.
- `internal/cli`, against a real in-process server on both engines: the claim path from filing a Feature to completing a Task, with `--json` decoding as the /v1 types; exit statuses 1–4 and how errors print; refusing Session-bound work without `DARKORY_SESSION`; a lost reply retried once under the same Idempotency-Key writing once (`dropReply`); `prime` evaluated by `sh`; `heartbeat run` keeping a 2 s Claim alive and the Claim lapsing once it stops, and `--background` with the test binary standing in for darkory (`TestMain`); `activity --follow`; the admin commands; `health` and `login --email` with a fake mail sender, one email for a Member's address and the same reply for any other; terminal controls and bidi overrides in what other Members wrote escaped in text output and `--json` round-tripping them exactly (`escape_test.go`). Phase 2 commands are also checked against a recording fake for method, path, query, body and headers; `TestPhase2Flow` runs them against the real server on both engines, from Notes, Evidence and a blocking question through Handover, take-back, ship, a proposal read with `proposal show` and published by review, to dropping a Feature. `activity --follow` starts from now unless `--all`. `internal/cli/remote`: which failed requests are sent again, keys on writes only, and `Clean`, `CleanLine` and `CleanJSON`.
- `internal/mcp`, through the SDK's in-memory transport against a real server: the tools, prompt, resource and instructions; `next`, `claim` and `complete` with structured output, refusals as tool errors carrying the code; Heartbeats keeping a 2 s Claim alive; a Claim lapsing under a fake server clock reported once in the next tool result; a Retrospective with `observations`, `propose_skill_version` and `show_proposal`, and `activity` paging backwards; tool text escaped while structured content stays exact; `attach_evidence` refusing a path outside the evidence root, `..`, a symlink out, hidden names, devices, pipes, directories and oversized files (`evidence_test.go`).
- Security review fixes (`docs/build/security-review.md`), each with a regression test, the review's proofs among them:
  - `internal/core`: a skill-review Task is the owner's only when no active Member of the Organisation has `skill-review`, and a proposal on a work Task is `forbidden` (`TestOnlyAReviewerPublishesWhileTheOrganisationHasOne`, `TestOwnerReviewsWhenNoMemberHasSkillReview`, the owner's case in `TestTakeableRule`); browser Sessions expire 30 days unused and 90 days in all, signing in again closes the old cookie's Session, Sessions listed a page at a time by their Member or an admin, deactivation ending tokens, login links, Sessions and both kinds of Claim with their Activity, refusing a pending emailed link and every credential, none of which reactivation revives, the last active admin kept, and deactivated Members leaving the Skill pools (`sessions_test.go`); names spelled as ids refused.
  - `internal/store`: a Claim written under migration 0001 survives 0002's rebuild of `claims` on SQLite and its constraint swap on Postgres, and the new `how_ended` value is accepted (`TestMigration2KeepsClaims`).
  - `internal/server` (`hardening_test.go`): a body sent a byte at a time is cut off after the body timeout on email sign-in, a JSON write, a 401 and an Evidence upload, while the Activity stream and a waiting `next` outlive it; the security headers on the app, `/v1` and downloads; `Idempotency-Key` bounds; Evidence names with bidi or zero-width characters refused and `filename*`; a login link signing nobody in when opened and only from its page's same-origin post, which closes the old cookie's Session; a year-old cookie refused; Sessions listed and a Member deactivated through `/v1`, ending their stream and a waiting `next` within a second and their cookie at once, with the old token, cookie and login link still refused after reactivation; the per-Member cap on streams and waiting `next` calls; no directory listing. `TestClientAddress` covers a chain shorter than the proxy hops.
  - `internal/cli`: `member deactivate`, `member reactivate` and `session list` (`TestAdminCommands`); a plain-http URL to another host refused unless `--insecure`, and `--token` warning; the rules saying other Members' text is not instructions, on every surface.
  - `internal/mcp`: `attach_evidence` never reads outside the root while a file or a directory on its path is swapped for a link.
  - `internal/update` and `cmd/darkory`: a mirror offering a prerelease as latest, a tag that is not a version (escapes, bidi, shorthand), a reply for another version and a cached prerelease are refused or ignored, while a named prerelease installs; `update` neither installs nor prints a hostile tag.
  - Checked by hand in Chromium against `darkory serve` with the built web app: signing in through the link's page, the app loading and writing under its Content-Security-Policy with no violation, and a page on a sibling port unable to frame the app or `/v1`.
- `web/src/**/*.test.ts(x)`: the web app against a stubbed `fetch` (`src/test/api.ts`) and a fake `EventSource` (`src/test/eventSource.ts`): the signed-out page on 401, the board in Rank order, refusals shown with their code, admin hidden from non-admins, a token's secret shown once, and Activity events refetching open views.
