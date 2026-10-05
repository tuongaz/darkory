# Deployment topology: one Darkory for cloud and local Members

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

How is Darkory deployed so that Members in the cloud and Members on local machines share one record?

Candidate shapes: one hosted service that everything connects to; a self-hostable server that runs locally or in the cloud; local-first replicas that sync.

The answer must hold for: Teams from day one, agents in cloud sandboxes and on laptops at the same time, and the goal of local-first with zero setup.

Decide:

- Where the source of truth lives.
- What a brand-new local user has to run.
- What a local Member can do while offline.
- What changes when a solo setup grows into a Team.

## Answer

Resolved by grilling with the human, 2026-10-04. Recorded in [ADR 0002](../../../docs/adr/0002-one-authority-per-organisation.md) and [ADR 0003](../../../docs/adr/0003-claims-can-lapse-on-missed-heartbeat.md). Terms are in [`CONTEXT.md`](../../../CONTEXT.md).

- **Source of truth.** Each Install is the single authority for its Organisation, and every Claim runs on it. There are no merging replicas.
- **Editions.** One open-source server. **Local** is self-hosted as a single binary with storage built in, and holds one Organisation. **Cloud** is the same server hosted for many Organisations, for teams that don't want to run it. The agent interface is identical in both.
- **New local user.** Runs one command (something like `darkory serve`) and needs nothing else.
- **Offline.** No offline mode: every write needs the server. A Member's own work, such as code in git, continues outside Darkory.
- **Solo to Team.** The model doesn't change. A solo user is already an Organisation with one Team. Growing means running the Install where others can reach it, or moving the Organisation to another Install or Cloud by export and import.
- **Transport.** The core does not depend on any transport: HTTPS, events and other connectors are adapters that can be added later. Reaching the Install is the operator's job.
- **Pull, Temporal-style.** Agents pull work and are never started by Darkory. A Claim may carry a heartbeat timeout set by the claiming Member; a missed heartbeat ends the Claim, the Task becomes takeable again, and the lapse is recorded. A Claim without a timeout never lapses. This partly reverses ticket 03; see ADR 0003.

**Revised 2026-10-05 by [Independent architecture review](13-independent-architecture-review.md):**

- **Solo to Team.** Export and import are out of scope ([ticket 10](10-organisation-export-import-format.md)), so the only way to grow is to run the Install where others can reach it. A Local Organisation cannot move to Cloud for now.
- **Editions.** Storage, Evidence store and sign-in are independent settings of an Install; Local is the default profile. Cloud is built from a private repo that imports the server, so it is the same server and not the same binary.
