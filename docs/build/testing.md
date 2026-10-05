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
- `internal/server`: health, the 501 answer of every operation not yet built, JSON 404s under `/v1`, and the web app at `/`, through the generated Go client where it applies.
- `web/src/**/*.test.ts(x)`: the web app against a stubbed `fetch` (`src/test/api.ts`) and a fake `EventSource` (`src/test/eventSource.ts`): the signed-out page on 401, the board in Rank order, refusals shown with their code, admin hidden from non-admins, a token's secret shown once, and Activity events refetching open views.
