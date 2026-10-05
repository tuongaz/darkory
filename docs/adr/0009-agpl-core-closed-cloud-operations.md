# AGPL core, closed Cloud operations, embedded migrations

The Darkory server is open source under AGPL-3.0, so anyone may run, change and self-host it, but anyone offering a modified version as a hosted service must publish their changes. Every feature a Member or admin touches is in the open core, including Postgres, S3 Evidence, emailed login links, and GitHub and Google sign-in. What Cloud sells is running it: billing, signup, hosting many Organisations in one Install, and operations tooling live in a private repo that imports the open core as a Go library. Outside contributions require a contributor license agreement so that combination stays possible.

Local never updates itself. Homebrew and container users update with their own tools; install-script users run `darkory update`, which verifies the release's checksum and signature before swapping the binary. The web app and CLI show a notice when a newer release exists, which a flag turns off.

Schema migrations are one numbered set embedded in the binary, portable across SQLite and Postgres. On Local, `darkory serve` backs up the SQLite file and migrates at startup, and refuses to start an older binary against a newer database. On Cloud, `darkory migrate` runs as its own step before a rollout, and migrations are written expand-then-contract so old and new servers coexist.

## Considered Options

- **MIT or Apache-2.0.** Most adoption, but anyone can host a competing Cloud without contributing back.
- **Source-available (FSL, BSL).** Protects Cloud, but is not open source.
- **Everything open, or classic open core.** The first gives away the business; the second is a constant judgement over which features to withhold.
- **Automatic or manual-only updates.** Auto-restarts risk Claims mid-work and silent schema changes; manual-only leaves Installs stale.
- **Always-explicit migrations, or one set per engine.** A forgotten manual step on every Local upgrade; two migration sets that drift.
