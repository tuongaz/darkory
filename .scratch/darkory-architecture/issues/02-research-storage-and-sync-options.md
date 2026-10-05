# Research storage and sync options for cloud and local

Type: research
Status: resolved
Blocked by: none

## Question

Which storage and sync options can hold one shared record that Members reach from both cloud and local, and what does each demand?

Candidates to cover: a single SQLite file, SQLite with replication or sync (libSQL, LiteFS, cr-sqlite and similar), Postgres, git-backed files (markdown or JSONL), and local-first sync engines built on CRDTs. Add any other serious option the search turns up.

For each, record:

- How a claim stays atomic when two Members claim the same work at once.
- What happens when a local Member is offline, and what happens on reconnect.
- What a brand-new local user has to install or run.
- What running it in the cloud for a Team involves.
- How well it serves a "what is takeable now" query over blocking relations.
- Maturity and known failure modes from primary sources.

End with a short comparison, not a recommendation; the decision belongs to later tickets.

## Answer

Full findings: [Storage and sync options for cloud and local](../research/02-storage-and-sync-options.md) (read 2026-10-04). It covers SQLite on its own and with sync (Litestream, LiteFS, rqlite and dqlite, libSQL, Turso, cr-sqlite), Postgres, PGlite and embedded Postgres, Dolt, git-backed files, and the sync engines (Replicache, Zero, Electric, PowerSync, InstantDB, Convex, Automerge, Yjs, Jazz). It ends with a comparison and makes no recommendation.

Gist:

- **One holder means one authority.** Every option that guarantees one holder per Task runs the claim's compare-and-swap on a single authority: a server, a primary, or a Raft leader. Options that let a claim commit offline resolve double claims afterwards.
- **An offline claim is refused, queued, or merged.**
  - Refused: Zero, and Jazz 2.0 for exclusive writes.
  - Queued, then confirmed or undone on reconnect: PowerSync, Replicache, InstantDB, Convex.
  - Merged by a rule: Automerge, Yjs, cr-sqlite, Turso Sync.
- **How the losing Member learns it lost varies.**
  - Explicit error: Zero, Jazz, Convex.
  - The claim silently disappears: Replicache, PowerSync.
  - A conflict record is written: Dolt, Automerge.
  - Nothing tells it: cr-sqlite, Yjs.
- **Zero setup and one shared record work against each other.** Stores that need no install (a SQLite file, PGlite, git, CRDT libraries) either stay on one machine or merge after the fact. Stores that keep the claim on a server mostly need Postgres, a sync service and an API, or a vendor's hosted endpoint.
- **The takeable-now query is easy in SQL.** It is a one-hop `NOT EXISTS`. Only document and CRDT stores need a client-side index over all Tasks and blocker links.
- **Several agents on one laptop break single-process stores.** PGlite corrupts a data directory that two processes share. libSQL warns against opening its file while it syncs.
- **Many projects have changed status recently.**
  - Replicache's repo was archived on 2026-06-10.
  - cr-sqlite is paused.
  - Fly no longer supports LiteFS.
  - libSQL is deprioritised in favour of Turso's rewrite.
  - Turso is joining Supabase.
  - Jazz 2.0 is in alpha.
- **Mature and stable:** Postgres, SQLite, rqlite, and Zero (GA since March 2026).
