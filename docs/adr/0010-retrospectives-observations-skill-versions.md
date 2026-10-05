# Retrospectives are Tasks fed by Observations; Skill changes are reviewed versions

When a Feature ships or drops, Darkory files one Task on it, "Retrospective: <Feature>", needing the `retro` Skill. It is an ordinary Task — takeable, claimed, worked, completed — and the only open Task an ended Feature may hold, apart from question Tasks that block it. Filing it does not start anyone, so Darkory stays pull-based.

Darkory files one other Task itself, by the same mechanism. When a Feature is filed, it files "Break down: <Feature>", needing the `breakdown` Skill, and whoever takes it files the Feature's other Tasks. Without it a new Feature holds no Task, so no Member pulling work would ever see it, and nothing would stop two Members breaking down the same Feature.

A Feature can ship only when every one of its Tasks has ended. Dropping a Feature drops its open Tasks and ends their Claims. When no Member of the Feature's Team has the Skill a Retrospective needs (`retro`, or `skill-review` once a version is proposed), the Feature owner can take it, so the loop does not stall for want of a Member with the Skill. No-self-review still holds: an owner who wrote a proposal cannot also publish it, and that case still waits for a second Member.

While working any Task, a Member records **Observations**: short entries marked *worked* or *didn't work*, recording who wrote them and the Skill they worked under. They are distinct from Notes, which carry context across a Handover. The retrospective reads every Observation from the Feature's Tasks; completing it marks them reviewed by that retrospective, so they leave active views and never feed another retro, but stay stored to explain why a Skill changed.

Company Skills are versioned. A retrospective proposes a new version and hands the Task over to the `skill-review` Skill; the no-self-review rule keeps the author from approving it. Completing the review publishes version N+1; handing back sends it for fixes. Each Claim records the Skill version it was worked under, so later retrospectives can judge whether a change helped. Problems that need work rather than a Skill change are filed as new Features in the Team, ranked as usual and linked to the retrospective that found them.

Members do not share one AI model. Each agent chooses its own, for a Member, a Session or a single Task, and may change it; Darkory never chooses or calls one. A Claim can carry an optional **model label**, sent by the Member holding it, which Darkory stores and shows and never interprets. A human Member sends none, so Members stay symmetric. The label sits beside the Skill version for the same reason: without it a retrospective could not tell a Skill change from a model change. It records how work was done, not how well a Member performs, so it stays clear of the track record the map rules out. Advice on which model suits a kind of work belongs in the company Skill text, where it is versioned and reviewed like the rest.

Revised 2026-10-05 by the [independent architecture review](../../.scratch/darkory-architecture/issues/13-independent-architecture-review.md): added the Breakdown Task, the rules for ending a Feature that still has open Tasks, and the Feature owner's fallback. The first text called the Retrospective "the only Task an ended Feature may hold", which also ruled out asking a question about it. The model label was added the same day, after the human noted that Members run on different AI models, which can change with the Task.

## Considered Options

- **A standing "Factory improvement" Feature per Team.** Keeps ended Features closed but creates a Feature that never ships.
- **A separate Retrospective entity.** Duplicates claim, Notes and Evidence for one case.
- **Manual retros only.** The improvement loop becomes skippable.
- **Delete Observations after the retro, or after a retention period.** Loses why a Skill changed; adds a cleanup job.
- **Direct Skill edits, or human-only approval.** No second reviewer on shared instructions; or breaks Member symmetry.
- **Retro files Tasks into the ended Feature, or Skill changes only.** Reopens shipped work; or loses problems found.
- **The filer files a Feature's first Task by hand.** No new mechanism, but a Feature filed without one is invisible to `next`.
- **Show an unstaffed Retrospective, or accept the stall.** No fallback rule in the claim, but the loop waits on someone noticing.
- **Shipping drops open Tasks too, or neither ending is allowed while Tasks are open.** The first lets an owner ship over unfinished work; the second makes dropping a Feature a chore.
- **A model setting held by Darkory on the Member, Skill or Task.** One place to decide, but only advice, since Darkory never runs the agent, and close to supervising agent runs.
- **No record of the model.** Nothing to build, but a retrospective cannot separate a Skill change from a model change, and past Claims can never be labelled afterwards.
