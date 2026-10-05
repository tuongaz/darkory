GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/tuongaz/darkory/internal/version.Version=$(VERSION)
# The Postgres that test-pg runs against; its role must be able to create databases.
TEST_POSTGRES_URL ?= postgres://dk@localhost:54329/postgres?sslmode=disable
GENERATED := client/client.gen.go internal/server/gen/server.gen.go

.PHONY: gen gen-check build vet test test-pg check

## gen: regenerate the Go client and the server interface from api/openapi.yaml
gen:
	$(GO) generate ./client ./internal/server/gen

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
