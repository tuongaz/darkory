# AGPL core, closed Cloud operations, embedded migrations

The Darkory server is open source under AGPL-3.0, so anyone may run, change and self-host it, but anyone offering a modified version as a hosted service must publish their changes. Every feature a Member or admin touches is in the open core, including Postgres, S3 Evidence, emailed login links, and GitHub and Google sign-in. What Cloud sells is running it: billing, signup, hosting many Organisations in one Install, and operations tooling live in a private repo that imports the open core as a Go library. The Postgres row-level security policies that separate Organisations live there too: the open core filters every query by `org_id`, and the private repo adds the policies as a second lock, with a test that fails when a table carrying `org_id` has none. Outside contributions require a contributor license agreement so that combination stays possible. `openapi.yaml` and the clients generated from it carry a permissive license such as Apache-2.0, so that a program can import a client or generate its own without license questions.

Local never updates itself. Homebrew and container users update with their own tools; install-script users run `darkory update`, which verifies the release's checksum and signature before swapping the binary. The web app and CLI show a notice when a newer release exists, which a flag turns off.

Schema migrations are one numbered set embedded in the binary, covering SQLite and Postgres. A migration is written once where one statement serves both engines, and holds a SQLite variant and a Postgres variant under the same number where it cannot; a test checks that both engines end with the same schema. The row-level security policies are not part of the set. On Local, `darkory serve` backs up the SQLite file and migrates at startup, and refuses to start an older binary against a newer database. On Cloud, `darkory migrate` runs as its own step before a rollout, and migrations are written expand-then-contract so old and new servers coexist.

Revised 2026-10-05 by the [independent architecture review](../../.scratch/darkory-architecture/issues/13-independent-architecture-review.md): placed the row-level security policies in the private repo, where no earlier record had said which side owns them, and gave the spec and the generated clients a permissive license. Settled the same day: a migration may carry a variant per engine under one number, because SQLite's `ALTER TABLE` cannot make every change in place.

## Considered Options

- **MIT or Apache-2.0.** Most adoption, but anyone can host a competing Cloud without contributing back.
- **Source-available (FSL, BSL).** Protects Cloud, but is not open source.
- **Everything open, or classic open core.** The first gives away the business; the second is a constant judgement over which features to withhold.
- **Row-level security policies in the open migrations.** One schema to test, but the open core would carry a control that only Cloud needs.
- **AGPL for the spec and the clients too.** One license, but a program that imports a client may take on AGPL terms.
- **Automatic or manual-only updates.** Auto-restarts risk Claims mid-work and silent schema changes; manual-only leaves Installs stale.
- **Always-explicit migrations, or one set per engine.** A forgotten manual step on every Local upgrade; two migration sets that drift.
- **Shared statements only in migrations.** No variants to keep in step, but a change SQLite cannot make in place becomes build-a-new-table-and-copy on both engines, which rewrites and locks large tables on Cloud.
