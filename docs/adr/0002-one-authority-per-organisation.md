# One authority per Organisation; one server for Local and Cloud

Each Darkory install is the single source of truth for the Organisation it holds, and every Claim runs on it. Members reach it from anywhere, whether a laptop or a cloud sandbox. There are no merging replicas and no offline mode: every write needs the server. The same open-source server ships in two forms. **Local** is self-hosted as a single binary with storage built in, and holds exactly one Organisation. **Cloud** is the same server hosted for many Organisations, for teams that don't want to run it themselves. A solo user is already an Organisation with one Team. Growing into a Team means running the install somewhere others can reach, or moving the whole Organisation to another install by export and import. The core does not depend on any transport: HTTPS, events and other connectors are adapters, and making the install reachable is the operator's job.

We chose this because a Claim must have at most one holder. The storage research ([02](../../.scratch/darkory-architecture/research/02-storage-and-sync-options.md)) found that only a single authority guarantees that. Replicas that merge resolve double claims after the fact, sometimes silently. Having one server for both editions avoids the split that forced Vibe Kanban's rewrite.

## Considered Options

- **Local-first replicas that sync (CRDTs, Dolt, git).** These would allow offline claims, but two holders get merged into one after the fact, sometimes silently.
- **Separate Local and Cloud products.** Local would be lighter at first, but there would be two products to keep in step.
- **A bundled relay so cloud agents can reach a Local install.** That would need no setup from the user, but it would make open-source Local depend on hosted infrastructure. Left as a possible later connector.
- **A read-only cache or queued offline writes.** These need a sync layer, and queued claims are where claims get silently undone. They can be added later as a client feature without changing the topology.
