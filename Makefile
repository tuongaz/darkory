GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/tuongaz/darkory/internal/version.Version=$(VERSION)
# The Postgres that test-pg runs against; its role must be able to create databases.
TEST_POSTGRES_URL ?= postgres://dk@localhost:54329/postgres?sslmode=disable
# How long the Go tests may run: under -race on a loaded machine the core package takes more than
# go test's default 10 minutes on both engines.
TEST_TIMEOUT ?= 30m
GENERATED := client/client.gen.go internal/server/gen/server.gen.go web/src/api/schema.gen.ts

# Local settings for dev and serve, such as PUBLIC_URL; local.mk is not committed.
-include local.mk
# Where dev and serve keep their Install.
DEV_DATA ?= .dev
# The address browsers use. Set it to the HTTPS name a proxy gives the Install (for example
# PUBLIC_URL = https://<machine>.<tailnet>.ts.net with `tailscale serve --bg --https=443
# http://127.0.0.1:7357`), so login links and the Origin check of writes use it.
PUBLIC_URL ?= http://127.0.0.1:7357

.PHONY: gen gen-check build vet test test-pg check e2e e2e-pg web web-gen web-check dev dev-api dev-web dev-init serve

## gen: regenerate the Go client, the server interface and the web app's TypeScript client from
## api/openapi.yaml (needs node for the web's)
gen:
	$(GO) generate ./client ./internal/server/gen
	cd web && npm run gen

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
	$(GO) test -race -timeout $(TEST_TIMEOUT) ./...

## test-pg: run every test on SQLite and Postgres
test-pg:
	DARKORY_TEST_POSTGRES_URL='$(TEST_POSTGRES_URL)' $(GO) test -race -timeout $(TEST_TIMEOUT) ./...

## check: what every phase ends green on
check: gen-check vet test test-pg

## e2e: build the binary and run the end-to-end suite and the soak against it, on SQLite
## (DARKORY_E2E_SOAK=2m sets the soak's length, DARKORY_E2E_RACE=1 builds the binary with -race)
e2e:
	DARKORY_E2E=1 $(GO) test -count=1 -v -timeout 30m ./e2e/

## e2e-pg: the end-to-end suite and the soak on Postgres, with two server processes too
e2e-pg:
	DARKORY_E2E=1 DARKORY_E2E_POSTGRES_URL='$(TEST_POSTGRES_URL)' $(GO) test -count=1 -v -timeout 30m ./e2e/

## dev: work on the server and the web app without rebuilding by hand. The web app runs on 7357
## (Vite: changes show on save) and proxies /v1 to the server on 7358, which is rebuilt and
## restarted when Go code changes. Ctrl-C stops both. The Install lives in $(DEV_DATA). An earlier
## run of this checkout that is still going is stopped first.
dev: dev-init
	@test web/node_modules/.package-lock.json -nt web/package-lock.json || (cd web && npm ci)
	@trap 'kill 0' INT TERM; \
	$(MAKE) --no-print-directory dev-api & \
	$(MAKE) --no-print-directory dev-web & \
	wait

## dev-api: the server alone on 7358, rebuilt and restarted when Go code changes. Each start opens
## the sign-in link in a browser; DEV_BROWSER=0 only prints it (handy while editing Go code, since
## every rebuild is a start).
DEV_BROWSER ?= 1
dev-api: dev-init
	@scripts/dev-stop.sh api
	DARKORY_PUBLIC_URL='$(PUBLIC_URL)' DARKORY_NO_UPDATE_CHECK=1 \
		$(GO) run ./tools/devrun -o $(DEV_DATA)/bin/darkory -pkg ./cmd/darkory -- \
		serve --data $(DEV_DATA) --listen 127.0.0.1:7358 $(if $(filter 0,$(DEV_BROWSER)),--no-browser)

## dev-web: the web app alone on 7357, proxying /v1 to the server on 7358
dev-web:
	@scripts/dev-stop.sh web
	cd web && VITE_PORT=7357 DARKORY_URL=http://127.0.0.1:7358 npm run dev

## dev-init: create the Install in $(DEV_DATA) once; its token and first login link are kept in $(DEV_DATA)/init.txt
dev-init:
	@test -f $(DEV_DATA)/darkory.db || { mkdir -p $(DEV_DATA) && umask 077 && \
		$(GO) run ./cmd/darkory init --data $(DEV_DATA) | tee $(DEV_DATA)/init.txt; }

## serve: build bin/darkory and run it on 7357 with the Install in $(DEV_DATA) (run make web first for the real web app)
serve: build dev-init
	DARKORY_PUBLIC_URL='$(PUBLIC_URL)' bin/darkory serve --data $(DEV_DATA)
