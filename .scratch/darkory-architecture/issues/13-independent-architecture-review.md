# Independent architecture review

Type: review
Status: resolved
Blocked by: none

## Question

Before any code is written, what does a reader who took no part in the decisions find wrong with them?

Look for:

- Contradictions: two documents that cannot both be true.
- Gaps: something a builder would have to decide on day one that no document decides.
- Hard-to-reverse decisions that look wrong, or whose stated reason does not hold up.
- Conflicts with the rules fixed in the map's Notes.
- Factual claims about tools and libraries that are wrong.

## Answer

Reviewed and decided with the human, 2026-10-05. Findings, sources and experiments: [research/03-independent-architecture-review.md](../research/03-independent-architecture-review.md). One new ADR: [Writes within an Organisation run one at a time](../../../docs/adr/0011-organisation-writes-run-one-at-a-time.md). The other decisions revise ADRs 0001 to 0010 in place; where a decision changed, the ADR carries a note dated 2026-10-05 saying what changed. Terms are in [`CONTEXT.md`](../../../CONTEXT.md).

The review found the core choices sound and no decision that breaks a fixed rule. The problems were at the seams between decisions made in sequence.

**Decisions**

- **Session.** A Session is an id the running copy chooses and sends with the Member's token on every request. There is no exchange call and no short-lived credential. The CLI reads the id from `DARKORY_SESSION`, and `darkory prime` prints one. (ADR 0008, ADR 0005)
- **Localhost.** `darkory serve` prints and opens a one-time link at start. A request with no credential is never a Member, on localhost too. (ADR 0008)
- **Teams.** A named relation (aimed at, Feature owner, Reporting line) outranks Team membership. Skill-matched Tasks stay limited to the Team. A question or escalation Task joins the Feature of the Task it blocks, ended or not. (ADR 0008, ADR 0001)
- **Local.** Storage, Evidence store and sign-in are independent settings of an Install, and Local is the default profile: SQLite, local disk, a printed link. A Local Organisation cannot move to Cloud for now, because export and import are out of scope. (ADR 0002)
- **Local's database.** SQLite stays. Postgres through Docker and Postgres started by the binary were both priced and declined. (ADR 0004)
- **Writes.** Writes within one Organisation run one at a time: every write transaction first increments a counter row on the Organisation, which also numbers Activity in commit order. (ADR 0011)
- **Row-level security.** The policies live in the private Cloud repo. The open core filters every query by `org_id`, and the Cloud repo tests that every table carrying `org_id` has a policy. (ADR 0009, ADR 0004)
- **Retrospective.** When no Member of the Feature's Team has the Skill a Retrospective needs, the Feature owner can take it. (ADR 0010)
- **Breakdown.** Filing a Feature also files a "Break down" Task needing the `breakdown` Skill. (ADR 0010)
- **Heartbeats.** `next` and `claim` use a default timeout stored on the token unless the call names one. `darkory mcp` sends Heartbeats for its Session; the CLI has a background heartbeat command. (ADR 0005, ADR 0008)
- **Feature end.** A Feature ships only when every one of its Tasks has ended. Dropping a Feature drops its open Tasks and ends their Claims. (ADR 0010)
- **No self-review.** One Skill per Member per Task: a Member who has held a Task under one Skill can take it again only under that Skill. (ADR 0001)
- **License.** `openapi.yaml` and the generated clients carry a permissive license such as Apache-2.0. The server stays AGPL-3.0. (ADR 0009)
- **Language.** Go stands. Python was weighed and declined. (ADR 0007)
- **AI models.** Each agent chooses its own model, for a Member, a Session or a single Task; Darkory never chooses or calls one. A Claim can carry an optional model label that Darkory stores and never interprets, and advice on which model to use lives in the company Skill text. (ADR 0010)

**Corrections made to earlier text**

- A Task stores open, done or dropped; "claimed" is derived, so it cannot go stale when a Claim lapses. (ADR 0004)
- Every Claim leaves a row of its own, so the Skill version and the no-self-review check never read Activity. (ADR 0004)
- Take-back is by the Reporting line or the Feature owner. (`CONTEXT.md`, ADR 0004)
- The claiming `UPDATE` copies the outgoing holder into a column, because `RETURNING` cannot give old values on both engines. (ADR 0004)
- The CLI and MCP server are written on the generated Go client; they are not generated. (ADR 0005)
- Export and import are no longer offered as a way to grow. (ADR 0002)
- Cloud is the same server and not the same binary. (`CONTEXT.md`, ADR 0002, ADR 0007)
- The Retrospective is the only open Task an ended Feature can hold. (`CONTEXT.md`, ADR 0010)
- The operation set and the Claim guard in ticket 06 are extended there.

**Still open**

Small rules the review found and nobody has decided. Each has a suggestion in the research file.

- Whether an ended Feature keeps its Rank, which orders its Retrospective in `next`.
- The order of `next` for a Member in two Teams, and among the Tasks of one Feature.
- What happens when two Retrospectives each propose the next version of the same company Skill.
- Whether a Heartbeat that arrives after expiry, when nobody has re-claimed, revives the Claim.
- Which Member a link printed by `darkory login` signs in.
- Whether the Feature owner's fallback also covers a Break down Task that nobody in the Team can take.
- Who publishes a Skill version when the Feature owner wrote the proposal and no other Member of the Team has `skill-review`.
- Whether the embedded migration set may carry per-engine statements where SQLite's `ALTER TABLE` cannot do what an expand-then-contract change needs.
