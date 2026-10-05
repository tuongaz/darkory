# Testing on both engines

Every store and core test runs on SQLite, and on Postgres as well when `DARKORY_TEST_POSTGRES_URL` is set ([plan invariant 3](plan.md#invariants)). Tests always run with the race detector.

## Running

```sh
make test       # every test, SQLite only; Postgres tests skip
make test-pg    # every test on SQLite and Postgres
make check      # generated code up to date, go vet, then both of the above
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
- `internal/server`: health, the 501 answer of every operation not yet built, JSON 404s under `/v1`, and the web app at `/`; through the generated Go client on both engines: no credential is 401 even from 127.0.0.1, a token without a Session is `session_required`, the claim path from filing a Feature to completing its Break down, idempotency keys, a login link signing a browser in, and the Activity stream resuming with `Last-Event-ID`. `security_test.go`: a cookie write from another origin, a sibling port or with no Origin or Referer is 403 while one from the Install's own origin passes and bearer writes need no Origin; JSON bodies need `application/json`; the Activity stream ends without sending more once its token is revoked or its Session closed. `flow_test.go`: health's sign-in modes and update notice; Activity read backwards and the stream from now; the Activity enums match the core; Evidence on both engines (the holder and Team rules, the size limit, path filenames, retries, nosniff attachments). `mvp_test.go`: the MVP flow through the generated client on both engines, from a human filing a Feature to a published Skill version and a later Claim under it. In `internal/core`, `TestRevocationStopsLongRequestsAndClaims` covers a waiting `next` and a claim from an ended Session.
- `cmd/darkory`: `init` runs once and prints a token and a login link; `serve` prints a startup link and opens it unless told not to, and with `--no-login-link` issues none.
- `web/src/**/*.test.ts(x)`: the web app against a stubbed `fetch` (`src/test/api.ts`) and a fake `EventSource` (`src/test/eventSource.ts`): the signed-out page on 401, the board in Rank order, refusals shown with their code, admin hidden from non-admins, a token's secret shown once, and Activity events refetching open views.
