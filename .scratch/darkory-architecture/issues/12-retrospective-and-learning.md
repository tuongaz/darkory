# Retrospective and learning: how the factory improves itself

Type: grilling
Status: resolved
Blocked by: none

## Question

How does a retrospective fit the work model, and how do its lessons change company Skills?

[Domain model: how the organisation connects to work](03-domain-model-organisation-and-work.md) settled that retro lessons are written into company Skills, which Darkory stores.

Decide:

- Whether a retrospective is a Feature, a Task, or its own thing, and what triggers it after a Feature ships or drops.
- Who runs it: the Feature owner, a Member with a retro Skill, or anyone.
- How a change to a company Skill is proposed, reviewed and accepted, and whether Skills are versioned so a Member sees which version it worked under.
- How issues found in a retro loop back as new work.

Constraint from earlier tickets: humans and agents are symmetric, everything is reachable over `/v1`, and every change is recorded in Activity.

## Answer

ADR: [Retrospectives are Tasks fed by Observations; Skill changes are reviewed versions](../../../docs/adr/0010-retrospectives-observations-skill-versions.md).

- **Retrospective:** a Task needing the `retro` Skill, filed by Darkory on a Feature when it ships or drops. The only Task an ended Feature can hold.
- **Observation:** an entry on a Task marked *worked* or *didn't work*, recording author and Skill. Any Member writes them while working. The retro reads all of a Feature's Observations; completing it marks them reviewed (hidden, never reused, kept for tracing).
- **Skill changes:** the retro proposes a new company Skill version and hands over to `skill-review` (no self-review). Completing review publishes version N+1. Each Claim records the Skill version it worked under.
- **Loop back:** problems become new Features in the Team, ranked as usual, linked "from retrospective of <Feature>".
