# Writes within an Organisation run one at a time

Every write transaction begins by incrementing a counter row on its Organisation. On Postgres the writes of one Organisation therefore queue behind each other, as they already do on SQLite, where only one write transaction runs at a time. The number the counter returns is the Activity sequence number, so Activity is numbered in commit order. Heartbeats write no Activity and skip the counter; reads never wait; Organisations do not wait on each other.

We chose this because [ADR 0004](0004-sqlite-local-postgres-cloud.md) requires every rule to behave the same on both engines, and three did not. With concurrent writes on Postgres, two-session experiments showed that:

- Activity numbered from a sequence can commit out of order, so a stream resumed with `Last-Event-ID` never receives one event.
- Two Blocking edges added at the same moment can each pass the cycle check and form a cycle.
- `next` can return nothing while Tasks are still takeable.

With the counter taken first, all three behaved correctly. Display keys are allocated under the same order.

The cost is a ceiling on one Organisation's write rate. Measured on a local Postgres with 1 ms added per statement to stand in for a network hop, the ceiling was about 240 writes a second when a write takes four round trips while holding the counter, and several thousand when the write is sent as one. So the server sends each write transaction in one round trip, keeps Evidence uploads outside it, and has a waiting `next` check with a read before it tries to write. The counter is internal and not part of `/v1`, so it can be replaced later without breaking clients.

SQLite is opened with immediate transactions and a busy timeout (`_txlock=immediate` and `busy_timeout` in `modernc.org/sqlite`). With the driver's defaults, about half of concurrent claims failed with "database is locked" instead of "already claimed", though never with two winners.

Method and figures are in [research 03](../../.scratch/darkory-architecture/research/03-independent-architecture-review.md). Decided in the [independent architecture review](../../.scratch/darkory-architecture/issues/13-independent-architecture-review.md), 2026-10-05.

## Considered Options

- **Concurrent writes, with a separate fix for each rule.** No ceiling (18,210 writes a second in the same test), but a mechanism each for the sequence, the cycle check, `next` and display keys, some of them Postgres-only, and the problem returns with every later rule that reads before it writes.
