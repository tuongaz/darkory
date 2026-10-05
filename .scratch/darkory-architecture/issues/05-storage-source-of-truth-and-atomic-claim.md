# Storage, source of truth, and atomic claim

Type: grilling
Status: resolved
Blocked by: 02, 03, 04

## Question

Where does the record live, and what guarantees that a claim is atomic?

Decide:

- The storage engine and the single source of truth, given the chosen deployment topology.
- How two Members claiming the same work at the same moment resolves to exactly one winner.
- How blocking relations and the "what is takeable now" query are served.
- How Evidence (reports, screenshots, logs) is stored. [Domain model: how the organisation connects to work](03-domain-model-organisation-and-work.md) settled that Darkory stores it, binary files included, not just links.
- How take-back and heartbeat lapse of a Claim are served. [Deployment topology: one Darkory for cloud and local Members](04-deployment-topology.md) settled that a Claim may carry a heartbeat timeout and lapses on a missed heartbeat; Claims without one must still be recoverable by hand. Paperclip leaked locks without this.
- How IDs are allocated without collisions across writers: hash IDs, a central allocator, or something else. Sequential IDs collided in every multi-writer local-first tool surveyed.
- Whether "takeable now" is computed at read time or materialised. Beads' cached blocked flag went stale under concurrent unblocking.

Evidence for all three: [Survey how existing agent-workforce tools are built](01-survey-existing-agent-workforce-tools.md).

Constraint from [Deployment topology: one Darkory for cloud and local Members](04-deployment-topology.md): one Install is the single authority, Local ships as a single binary with storage built in, and only the server process touches storage. Several local agent processes therefore never share a store directly. Cloud holds many Organisations in one Install.

## Answer

Resolved by grilling with the human, 2026-10-04. Recorded in [ADR 0004](../../../docs/adr/0004-sqlite-local-postgres-cloud.md). Terms are in [`CONTEXT.md`](../../../CONTEXT.md).

- **Engines.** SQLite on Local and Postgres on Cloud, with one shared schema, set of migrations and set of queries.
- **Atomic claim.** One conditional `UPDATE … RETURNING` that holds every takeable check. A loser gets an explicit "already claimed" error. One race test suite runs against both engines.
- **Lapse and take-back.** Lapse is computed at read time from `claim_expires_at`. A heartbeat that returns no row means the Claim is lost. The next claimer writes the lapse record, and a sweeper writes it for visibility only. Take-back is a conditional update by the Reporting line or the Feature owner.
- **Takeable now.** Computed at read time and never stored. Blocking is an edge table, and cycles are refused when an edge is added.
- **IDs.** A UUIDv7 internal ID plus a per-Team display key such as `WEB-42`.
- **Evidence.** Metadata in the database. Files go to S3 on Cloud and to local disk on Local.
- **Tenancy.** An `org_id` on every row, enforced by Postgres row-level security on Cloud.
- **History.** Current-state tables are the source of truth. An Activity row is written in the same transaction as each change.

**Revised 2026-10-05 by [Independent architecture review](13-independent-architecture-review.md):**

- **Engines.** SQLite is the default for a self-hosted Install, and Postgres can be set instead.
- **Writes.** Writes within one Organisation run one at a time, which also numbers Activity in commit order ([ADR 0011](../../../docs/adr/0011-organisation-writes-run-one-at-a-time.md)).
- **Atomic claim.** The claim also checks the Team for Skill-matched Tasks. A Task stores open, done or dropped; every Claim leaves a row of its own.
- **Lapse.** The claiming `UPDATE` copies the outgoing holder into a column, and the lapse record is written from it.
- **Tenancy.** Every query filters by `org_id`. The row-level security policies live in the private Cloud repo.
