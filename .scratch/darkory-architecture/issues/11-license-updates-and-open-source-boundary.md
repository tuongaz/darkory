# License, updates, and the open-source boundary

Type: grilling
Status: resolved
Blocked by: none

## Question

Under what terms does Local ship, how does it stay current, and where does open source end and Cloud begin?

Decide:

- The license of the open-source server (permissive, copyleft such as AGPL, or source-available).
- How a Local binary is updated: self-update command, package managers only, or manual.
- What, if anything, is Cloud-only (multi-Organisation hosting, billing, S3 Evidence, SSO), and whether Cloud-only code lives in the same repo.
- How schema migrations run when a Local user upgrades.

Constraint from [Language and runtime](09-language-and-runtime.md): Local is one Go binary distributed via release page, install script and Homebrew, plus a container image.

## Answer

ADR: [AGPL core, closed Cloud operations, embedded migrations](../../../docs/adr/0009-agpl-core-closed-cloud-operations.md).

- **License:** AGPL-3.0; contributor license agreement for outside contributions.
- **Boundary:** the whole product is open (Postgres, S3 Evidence, emailed login links, GitHub and Google sign-in included). Closed, in a private repo importing the core as a Go library: billing, signup, multi-Organisation hosting, operations tooling.
- **Updates:** never automatic. Homebrew and container via their own tools; install-script users run `darkory update` (checksum and signature verified). "Update available" notice in web app and CLI, off by flag.
- **Migrations:** one numbered set embedded in the binary, portable across SQLite and Postgres.
  - Local: back up the SQLite file and migrate at startup; refuse an older binary on a newer database.
  - Cloud: `darkory migrate` as its own step before rollout; expand-then-contract.

**Revised 2026-10-05 by [Independent architecture review](13-independent-architecture-review.md):**

- **License.** `openapi.yaml` and the generated clients carry a permissive license such as Apache-2.0. The server stays AGPL-3.0.
- **Boundary.** The Postgres row-level security policies live in the private repo and are not part of the embedded migration set.
