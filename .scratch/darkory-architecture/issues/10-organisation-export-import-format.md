# Organisation export and import format

Type: grilling
Status: closed (out of scope)
Blocked by: 05

## Question

What format moves a whole Organisation from one Install to another, for example from Local to Cloud?

[Deployment topology: one Darkory for cloud and local Members](04-deployment-topology.md) settled that growing from solo to Team, or moving between Local and Cloud, is an explicit export and import with no ongoing sync.

Decide:

- What the export covers: Teams, Members, company Skills, Reporting lines, Features, Tasks, Claims, Notes, Evidence including binary files, and history.
- How IDs survive the move without colliding with IDs already in the target Install.
- What happens to live Claims and heartbeats during the move.
- How Member credentials carry over or are reissued.

Constraints from [Storage, source of truth, and atomic claim](05-storage-source-of-truth-and-atomic-claim.md): internal IDs are UUIDv7 and need no remapping; display keys are scoped to the Organisation. An export is every row with that `org_id` plus the blobs those rows reference. Local is SQLite and Cloud is Postgres, so the format must not depend on either engine.

Constraint from [Member identity and auth across cloud and local](07-member-identity-and-auth.md): Member tokens and Sessions are not exported; after import, admins issue fresh tokens, and the Local owner becomes a Cloud human who signs in by login link.

## Out of scope

Ruled out of this map by the human (2026-10-05): export and import are not needed for now. The architecture already keeps the move possible later (UUIDv7 IDs, `org_id` on every row, Evidence by reference, no credentials travel), so the archive format is a build-time detail, decided if and when the feature is built.
