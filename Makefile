GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/tuongaz/darkory/internal/version.Version=$(VERSION)
# The Postgres that test-pg runs against; its role must be able to create databases.
TEST_POSTGRES_URL ?= postgres://dk@localhost:54329/postgres?sslmode=disable
GENERATED := client/client.gen.go internal/server/gen/server.gen.go

.PHONY: gen gen-check build vet test test-pg check e2e e2e-pg web web-gen web-check

## gen: regenerate the Go client and the server interface from api/openapi.yaml
gen:
	$(GO) generate ./client ./internal/server/gen

## web: build the web app into web/dist/app, which the next build embeds (needs node)
web:
	cd web && npm ci && npm run build

## web-gen: regenerate the web app's TypeScript client from api/openapi.yaml (needs node)
web-gen:
	cd web && npm run gen

## web-check: typecheck, lint and test the web app (needs node)
web-check:
	cd web && npm run typecheck && npm run lint && npm test

## gen-check: fail when the committed generated code differs from what gen produces
gen-check: gen
	@if [ -n "$$(git status --porcelain -- $(GENERATED))" ]; then \
		echo "generated code is out of date; run make gen and commit:"; \
		git status --short -- $(GENERATED); \
		exit 1; \
	fi

## build: build bin/darkory
build:
	$(GO) build -ldflags "$(LDFLAGS)" -o bin/darkory ./cmd/darkory

vet:
	$(GO) vet ./...

## test: run every test on SQLite
test:
	$(GO) test -race ./...

## test-pg: run every test on SQLite and Postgres
test-pg:
	DARKORY_TEST_POSTGRES_URL='$(TEST_POSTGRES_URL)' $(GO) test -race ./...

## check: what every phase ends green on
check: gen-check vet test test-pg

## e2e: build the binary and run the end-to-end suite and the soak against it, on SQLite
## (DARKORY_E2E_SOAK=2m sets the soak's length, DARKORY_E2E_RACE=1 builds the binary with -race)
e2e:
	DARKORY_E2E=1 $(GO) test -count=1 -v -timeout 30m ./e2e/

## e2e-pg: the end-to-end suite and the soak on Postgres, with two server processes too
e2e-pg:
	DARKORY_E2E=1 DARKORY_E2E_POSTGRES_URL='$(TEST_POSTGRES_URL)' $(GO) test -count=1 -v -timeout 30m ./e2e/
