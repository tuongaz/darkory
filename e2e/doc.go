// Package e2e proves Darkory works as a whole: it builds the real darkory binary, runs `init` and
// `serve` as processes, and drives them only through the CLI, `darkory mcp` over stdio, and, for
// the soak, the generated client package. It imports nothing under internal/.
//
// The tests run only with DARKORY_E2E=1 (make e2e), on SQLite, or on Postgres when
// DARKORY_E2E_POSTGRES_URL names a server whose role may create databases (make e2e-pg).
package e2e
