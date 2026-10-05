# Darkory architecture

Label: wayfinder:map

## Destination

A locked set of architecture decisions for Darkory: the hard-to-reverse choices (deployment topology, storage, agent interface, identity, domain model, human surface, runtime), each recorded as an ADR in `docs/adr/`. Feature scope stays open; nothing gets built on this map.

## Notes

**Domain.** Darkory is management for a software factory whose workforce mixes agents and humans. The organisation is a core of the model; tracking work is one tool inside it. Glossary lives in [`CONTEXT.md`](../../CONTEXT.md); use its terms.

**Skills.** `/grilling` and `/domain-modeling` for every HITL ticket. `/research` for research tickets; link the resulting file from the ticket. A decision that meets the ADR bar in `/domain-modeling` gets an ADR in `docs/adr/`.

**Fixed while charting (do not reopen without the human):**

- Darkory is pull-based. Members come to it for work; it never starts an agent.
- It runs on both cloud and local.
- Teams from day one, and Teams mix agents and humans.
- One Member type, fully symmetric: a human and an agent have identical abilities.
- The organisation model must support Skills (formerly "Specialities", renamed in ticket 03) and Reporting lines.
- Nothing else is fixed. Language, storage, agent interface, and human surface are all open.

**MVP flow the architecture must support (the human's sketch, 2026-10-04; input, not decisions):**

1. Team Members are specialists; each agent Member has skills.
2. Work starts as a Feature. An engineer agent breaks it down into Tasks.
3. An agent picks up each Task and works it, then passes it on: QA to verify, UI/UX review if needed, security review if needed.
4. A Feature is done when it carries a full test report with screenshots.
5. A Feature owner (human or agent) decides to ship.
6. After each Feature, a retrospective captures what to improve. Issues loop back and the factory improves itself.

**Why build rather than adopt.** Agent-native primitives are first-class (atomic claim, native blocking, a "what is takeable now" query). Local-first with zero setup. Lightweight: no cycles, roadmaps, or triage. The human wants to own it as a product.

**How this map is stored.** Local markdown. Tickets are `issues/NN-<slug>.md` with `Type:`, `Status:`, and `Blocked by:` lines near the top.

- Frontier: tickets with `Status: open` whose every `Blocked by` ticket is `resolved`. Lowest number first.
- Claim: set `Status: claimed` and save before any work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`, then add a line to Decisions so far below.

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [Domain model: how the organisation connects to work](issues/03-domain-model-organisation-and-work.md) — Features own Tasks; one Task moves through Skills by Handover; questions and escalations are blocking Tasks; claims never lapse (revised by Deployment topology: may lapse on a missed heartbeat); Darkory stores company Skills and Evidence (revised by Independent architecture review: no self-review is one Skill per Member per Task; a Task stores open, done or dropped).
- [Survey how existing agent-workforce tools are built](issues/01-survey-existing-agent-workforce-tools.md) — no surveyed tool combines pull, a shared server and an org model; vendors keep an accountable human beside agents; claims, IDs and local↔cloud sync are where tools broke and rewrote.
- [Research storage and sync options for cloud and local](issues/02-research-storage-and-sync-options.md) — only a single authority guarantees one claim holder; offline claims get refused, queued or merged; zero setup and one shared record pull against each other; takeable-now is easy in any SQL store.
- [Deployment topology: one Darkory for cloud and local Members](issues/04-deployment-topology.md) — one Install is the single authority per Organisation; Local is a single open-source binary, Cloud is the same server hosted for many Organisations; no offline mode; core doesn't depend on transport; Claims may lapse on a missed heartbeat (Temporal-style) (revised by Independent architecture review: export and import no longer offered; storage, Evidence store and sign-in are settings of an Install).
- [Storage, source of truth, and atomic claim](issues/05-storage-source-of-truth-and-atomic-claim.md) — SQLite on Local, Postgres on Cloud with one portable schema; claim is one conditional `UPDATE … RETURNING`; lapse and takeable computed at read time; UUIDv7 plus display keys; `org_id` with row-level security; Activity log written in the same transaction (revised by Independent architecture review: writes within an Organisation run one at a time; the row-level security policies live in the Cloud repo; every Claim leaves its own row).
- [Agent interface: how agent Members talk to Darkory](issues/06-agent-interface.md) — HTTP+JSON is canonical (spec-first OpenAPI, `/v1`), CLI and MCP are thin clients in one `darkory` binary; `next` long-polls and claims as it returns; one operation set for humans and agents; idempotency key on every write (revised by Independent architecture review: CLI and MCP are written on the generated client; every request carries a Session id; `next` takes the token's default heartbeat timeout).
- [Human surface: what human Members use](issues/08-human-surface.md) — a web app embedded in the `darkory` binary, calling the same `/v1` operations; nothing is UI-only (bootstrap via `darkory init` or Cloud signup); live updates over an SSE stream of Activity.
- [Language and runtime](issues/09-language-and-runtime.md) — Go core as one static binary (pure-Go SQLite, pgx, oapi-codegen, official MCP SDK); React + Vite + TypeScript web app embedded; binaries for six platforms plus a container image (revised by Independent architecture review: Python weighed and declined; Cloud builds its own image).
- [Member identity and auth across cloud and local](issues/07-member-identity-and-auth.md) — one Member runs many Sessions, timed Claims bind to the Session; agents use `dk_` tokens, humans a login code or link (none on Local localhost); domain relations plus one admin mark; everyone reads the Organisation, works only in own Teams (revised by Independent architecture review: a Session is an id sent with the token, with no exchange; localhost needs a startup link; a named relation outranks the Team limit).
- [License, updates, and the open-source boundary](issues/11-license-updates-and-open-source-boundary.md) — AGPL-3.0 core with a CLA; billing, signup, multi-Organisation hosting and ops tooling closed; no auto-update (`darkory update`, verified); embedded portable migrations, backed up and run at startup on Local (revised by Independent architecture review: the spec and generated clients are permissive; row-level security policies are closed).
- [Retrospective and learning: how the factory improves itself](issues/12-retrospective-and-learning.md) — retro is an auto-filed Task on an ended Feature; Members log Observations while working, marked reviewed after the retro; Skill changes are reviewed versions via Handover; problems become new Features (revised by Independent architecture review: Darkory also files a Breakdown Task with each Feature; the Feature owner can take an unstaffed Retrospective; a Feature ships only when its Tasks have ended; a Claim can carry a model label).
- [Independent architecture review](issues/13-independent-architecture-review.md) — fifteen decisions at the seams between earlier ones: a Session is an id sent with the token; a startup link on localhost; a named relation outranks Team; Install settings instead of fixed editions; writes within an Organisation run one at a time; Breakdown Task; Feature-end rules; an optional model label on Claims; Go and SQLite kept. Eight small rules are still open, listed under Not yet specified.

## Not yet specified

Small rules the [Independent architecture review](issues/13-independent-architecture-review.md) found and nobody has decided. Its research file holds a suggestion for most of them.

- Whether an ended Feature keeps its Rank, which orders its Retrospective in `next`.
- The order of `next` for a Member in two Teams, and among the Tasks of one Feature.
- What happens when two Retrospectives each propose the next version of the same company Skill.
- Whether a Heartbeat that arrives after expiry, when nobody has re-claimed, revives the Claim.
- Which Member a link printed by `darkory login` signs in.
- Whether the Feature owner's fallback also covers a Break down Task that nobody in the Team can take.
- Who publishes a Skill version when the Feature owner wrote the proposal and no other Member of the Team has `skill-review`.
- Whether the embedded migration set may carry per-engine statements where SQLite's `ALTER TABLE` cannot do what an expand-then-contract change needs.

## Out of scope

- **Launching or supervising agent runs.** Darkory never starts an agent; ruled out when the product was named.
- **Capacity, cost, and track record.** Work-in-progress limits, availability, token budgets, and Member performance history. The human ruled that the architecture need not support them.
- **Feature list and UI design.** The destination is architecture only.
- **Building the MVP.** A separate effort after this map is done.
- [Organisation export and import format](issues/10-organisation-export-import-format.md) — not needed for now; UUIDv7, `org_id` and Evidence by reference keep a move possible later, so the format is a build-time detail.
