# SQLite on Local, Postgres on Cloud: one portable schema, single-statement claim

Local stores the record in SQLite, inside the single binary. Cloud stores it in Postgres. Both engines share one schema, one set of migrations and one set of queries, and every rule must behave the same on both.

- **Claim.** A claim is one conditional `UPDATE … WHERE … RETURNING`. The `WHERE` holds every takeable check: open; unclaimed or lapsed; the needed Skill or aimed at the Member; no unfinished blocker; no self-review. One row back wins. No row means an explicit "already claimed" error, and the loser stops instead of retrying. One race test suite runs against both engines.
- **Heartbeat lapse.** Computed at read time from `claim_expires_at`, so correctness needs no background job. A heartbeat is a conditional update scoped to the holder. If it returns no row, the Member has lost the Claim. The next claimer writes the lapse record, and a sweeper writes it for visibility only. Take-back is a conditional update by the Reporting line or the Feature owner.
- **Takeable now.** Computed at read time and never stored. Blocking is an edge table, and a recursive CTE refuses cycles when an edge is added.
- **IDs.** A UUIDv7 internal ID, plus a per-Team display key such as `WEB-42` that the server allocates in the creating transaction.
- **Evidence.** Metadata in the database. Files go behind a blob-store interface: S3-compatible storage on Cloud, local disk on Local.
- **Tenancy.** An `org_id` on every row. On Cloud, Postgres row-level security enforces it; on Local it is constant.
- **History.** Current-state tables are the source of truth. Each change appends an Activity row in the same transaction.

We picked SQLite for Local because it needs nothing installed. We picked Postgres for Cloud for its managed operations and multi-tenancy. The cost is two engines. Keeping every rule to a single portable statement contains that cost: no engine-specific locking, no stored flags that can go stale (Beads' `is_blocked`), and no reaper that correctness depends on (Paperclip's leaked locks).

## Considered Options

- **SQLite everywhere, one file per Organisation.** One engine and physical isolation, but less standard Cloud operations.
- **Postgres everywhere, with embedded Postgres or PGlite on Local.** One engine, but a heavier Local, or one that is pre-1.0 and tied to a JS runtime.
- **Explicit locks or version-number concurrency.** Engine-specific code or retry loops. Check-then-act let several Members win the same claim in Beads.
- **A stored takeable flag; a reaper for lapses.** Both are known failure modes in the survey.
- **A schema or database per Organisation in Cloud.** Stronger isolation, but migrations and pooling per tenant.
- **Event sourcing.** A full trail, but claims would run against a projection.
