# Domain model: how the organisation connects to work

Type: grilling
Status: resolved
Blocked by: none

## Question

What is the minimal set of entities and relations that connects the organisation (Team, Member, Speciality, Reporting line) to work (the unit of work, claim, blocking)?

Decide at least:

- The name of the unit of work, and what it is.
- What a claim is, and what it means for work to be takeable.
- What blocking is, and between what.
- How a Speciality gates which work a Member can pull and who work can be handed to.
- Whether work has levels. The human's MVP sketch (see the map's Notes) has a Feature that an engineer agent breaks down into Tasks.
- What a handover between Specialities is (build, then QA, then UI/UX review, then security review), and how it differs from escalation along a Reporting line.
- What a Feature owner is: a relation beyond claim and Reporting line that carries the authority to decide to ship. The owner can be a human or an agent, which is consistent with symmetric Members.
- Whether a Skill is the same thing as a Speciality or a separate thing an agent Member is equipped with. The human's sketch uses both words; the glossary currently lists "Skill" under Avoid.
- Whether a Member can belong to more than one Team, and whether Reporting lines cross Teams.
- Where the organisation side ends: what is deliberately left out so Darkory stays lightweight.

Update `CONTEXT.md` as each term settles.
- Whether "accountable Member" is a separate relation from "Member doing the work". Every surveyed vendor keeps an accountable human beside the agent; a separate relation might give the same benefit without breaking symmetry. See [Survey how existing agent-workforce tools are built](01-survey-existing-agent-workforce-tools.md).
- What "blocked" must name to be valid: a blocking item, or an owner and an action. Paperclip found that free-text "blocked" strands work.

## Answer

Resolved by grilling with the human, 2026-10-04. Terms are defined in [`CONTEXT.md`](../../../CONTEXT.md); the shape of handover and escalation is recorded in [ADR 0001](../../../docs/adr/0001-one-task-moves-through-skills.md).

- **Unit of work: two fixed levels.** A **Feature** is a shippable outcome with one Feature owner; it is never claimed. A **Task** is what a Member claims and works; every Task belongs to exactly one Feature.
- **Claim.** Exclusive, atomic, one Member per Task. It never lapses on its own; it ends by release, Handover, completion, or take-back up the Reporting line. A heartbeat may be added later; the model must leave room for it.
- **Takeable.** Open, not blocked, not claimed, and either needs a Skill the Member has or is aimed at that Member by name; and the Member did not hand it over to its current stage.
- **Skill gating.** A Task needs exactly one Skill for now; widening to a set later must stay possible. "Speciality" is renamed **Skill**: a generic Skill (QA) plus a company Skill that builds on it with the Organisation's own knowledge. Darkory stores company Skills; retro lessons are written into them.
- **Handover.** The same Task moves to the next Skill; the holder picks the next Skill, which is how a Task's reviews are decided. Handover targets a Skill only, not a named Member.
- **No self-review.** A Member who handed a Task over cannot take it at the next stage; a builder can take it back when it is handed back for fixes. Feature owners may ship Features they worked on.
- **Blocking.** Task-to-Task only, may cross Features; Features never block Features; cycles refused.
- **Questions, escalation, unachievable.** All are Tasks aimed at a Skill or a named Member (Reporting line or Feature owner) that block the asker's Task; the asker keeps their Claim. Unachievable Tasks are escalated to the Feature owner, who may **drop** them.
- **Endings.** A Task ends done or dropped. A Feature ends shipped or dropped.
- **Feature owner.** One Member, human or agent per Feature, default the filer. Authority: ship or drop the Feature, drop its Tasks, answer escalations about it. Not a Claim; passable by the owner or taken back up the Reporting line.
- **Evidence.** Reports, screenshots, logs attached to a Task or Feature, recording who attached them. Darkory stores (including binary files) but does not judge; the owner does. Consequence for ticket 05: binary storage.
- **Organisation and Teams.** An Organisation holds Teams, Members, company Skills, and Reporting lines. A Member can belong to several Teams; a Feature belongs to exactly one Team and only its Members take its Tasks; Reporting lines cross Teams.
- **Boundary.** Kept: **Rank** (single order of Features within a Team; Tasks sort by it) and **Notes** (running log on a Task). Left out: priority levels, estimates, due dates, labels, custom fields, custom Task states (fixed: open, claimed, done, dropped), sprints, cycles, roadmaps, triage, threaded comments, watchers.

**Revised 2026-10-05 by [Independent architecture review](13-independent-architecture-review.md):**

- **Claim.** It may lapse on a missed heartbeat ([ADR 0003](../../../docs/adr/0003-claims-can-lapse-on-missed-heartbeat.md)). Take-back is by the Reporting line or the Feature owner.
- **Takeable.** A Skill-matched Task is takeable only within the Member's Teams; a Task aimed at a Member by name is takeable from any Team.
- **No self-review.** One Skill per Member per Task: a Member who has held a Task under one Skill can take it again only under that Skill. This replaces "cannot take it at the next stage".
- **Task states.** A Task stores open, done or dropped. "Claimed" is derived from the Claim and is not a stored state.
- **Endings.** A Feature ships only when every one of its Tasks has ended. Dropping a Feature drops its open Tasks.
- **Breakdown.** Darkory files a "Break down" Task with every Feature ([ADR 0010](../../../docs/adr/0010-retrospectives-observations-skill-versions.md)).
- **Takeable, exceptions.** The Feature owner can take a Task of their Feature when no Member of its Team has the Skill it needs, and Skill review can be taken from any Team.
- **Rank.** An ended Feature keeps its place in the order.
