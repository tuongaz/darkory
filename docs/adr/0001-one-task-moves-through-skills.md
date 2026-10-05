# One Task moves through Skills; questions and escalations are Tasks

A Task is handed over by moving the same Task to the next Skill (build, then QA, then review, and back again), rather than splitting each stage into its own Task. A Member who is stuck, needs confirmation, or finds a Task unachievable files a new Task aimed at a Skill or a named Member (their Reporting line, the Feature owner) and lets it block their own. This keeps one Task's context, Notes, and Evidence in one place, and keeps blocking between Tasks as the only waiting mechanism, so the takeable query stays a single rule. The no-self-review rule follows from it: a Member who handed a Task over cannot take it at the stage they handed it to.

## Considered Options

- **One Task per stage, chained by blocking.** Reviews are planned up front, but a QA failure spawns new Tasks and one piece of work scatters.
- **A separate "waiting on" state with an addressee.** More explicit, but a second blocking mechanism with its own inbox.
