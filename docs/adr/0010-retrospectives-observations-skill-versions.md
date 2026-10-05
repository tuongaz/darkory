# Retrospectives are Tasks fed by Observations; Skill changes are reviewed versions

When a Feature ships or drops, Darkory files one Task on it, "Retrospective: <Feature>", needing the `retro` Skill. It is an ordinary Task — takeable, claimed, worked, completed — and the only Task an ended Feature may hold. Filing it does not start anyone, so Darkory stays pull-based.

While working any Task, a Member records **Observations**: short entries marked *worked* or *didn't work*, recording who wrote them and the Skill they worked under. They are distinct from Notes, which carry context across a Handover. The retrospective reads every Observation from the Feature's Tasks; completing it marks them reviewed by that retrospective, so they leave active views and never feed another retro, but stay stored to explain why a Skill changed.

Company Skills are versioned. A retrospective proposes a new version and hands the Task over to the `skill-review` Skill; the no-self-review rule keeps the author from approving it. Completing the review publishes version N+1; handing back sends it for fixes. Each Claim records the Skill version it was worked under, so later retrospectives can judge whether a change helped. Problems that need work rather than a Skill change are filed as new Features in the Team, ranked as usual and linked to the retrospective that found them.

## Considered Options

- **A standing "Factory improvement" Feature per Team.** Keeps ended Features closed but creates a Feature that never ships.
- **A separate Retrospective entity.** Duplicates claim, Notes and Evidence for one case.
- **Manual retros only.** The improvement loop becomes skippable.
- **Delete Observations after the retro, or after a retention period.** Loses why a Skill changed; adds a cleanup job.
- **Direct Skill edits, or human-only approval.** No second reviewer on shared instructions; or breaks Member symmetry.
- **Retro files Tasks into the ended Feature, or Skill changes only.** Reopens shipped work; or loses problems found.
