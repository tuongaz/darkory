# One Task moves through Skills; questions and escalations are Tasks

**Amended on 2026-10-07 by [ADR 0016](0016-workflow-of-steps.md) and [ADR 0015](0015-projects-tasks-subtasks.md):** the chain of Skills is the Project's Workflow of Steps, a Handover is advancing along a Connector, and a question joins the blocked Task's Parent as a Subtask. The principle — one Task, moved, never split per stage — stands.

A Task is handed over by moving the same Task to the next Skill (build, then QA, then review, and back again), rather than splitting each stage into its own Task. A Member who is stuck, needs confirmation, or finds a Task unachievable files a new Task aimed at a Skill or a named Member (their Reporting line, the Feature owner) and lets it block their own. This keeps one Task's context, Notes, and Evidence in one place, and keeps blocking between Tasks as the only waiting mechanism, so the takeable query stays a single rule. The no-self-review rule follows from it: a Member who has held a Task under one Skill can take it again only under that Skill, so a builder can take fixes back and can never take a review of the same Task.

A question or escalation Task joins the Feature of the Task it blocks, even when that Feature has ended, and the Member it is aimed at can take it from any Team.

Revised 2026-10-05 by the [independent architecture review](../../.scratch/darkory-architecture/issues/13-independent-architecture-review.md). The no-self-review rule first read "cannot take it at the stage they handed it to", which let a builder with two Skills take a later review stage of their own Task. The home of a question Task was not stated.

## Considered Options

- **One Task per stage, chained by blocking.** Reviews are planned up front, but a QA failure spawns new Tasks and one piece of work scatters.
- **A separate "waiting on" state with an addressee.** More explicit, but a second blocking mechanism with its own inbox.
- **No self-review only at the stage handed to.** Simpler to check, but a builder could review their own work one stage later.
