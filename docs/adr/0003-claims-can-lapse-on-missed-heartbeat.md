# Claims can lapse on a missed heartbeat

A Member may attach a heartbeat timeout to a Claim when making it: the call names one, or else the default stored on the Member's token applies ([ADR 0008](0008-members-act-through-sessions.md), added 2026-10-05). While working, the Member sends heartbeats. If none arrives within the timeout, the Claim lapses: the Task becomes takeable again, and the lapse is written to the record so that the Feature owner can see it. A Claim made without a timeout never lapses on its own. A heartbeat that arrives after the timeout is refused, even when nobody has re-claimed the Task: the Claim ended at expiry, the lapse is recorded, and the Member may claim again if the Task is still takeable (settled 2026-10-05). This follows Temporal: workers pull work and heartbeat while they hold it, and a timed-out activity goes back to other workers. Darkory still never starts an agent.

This partly reverses [Domain model: how the organisation connects to work](../../.scratch/darkory-architecture/issues/03-domain-model-organisation-and-work.md), which ruled that claims never lapse and left room for a heartbeat later. The timeout belongs to the Claim, not to the kind of Member. Members stay symmetric: agents normally set one, and a human can choose not to.

## Considered Options

- **Every Claim must heartbeat.** Simpler, but a human who steps away loses their Task.
- **Claims never lapse; a missed heartbeat only flags the Task as stale.** Safer, but a crashed agent holds its Task until a human takes it back.
- **A late heartbeat revives the Claim when nobody has re-claimed.** Kinder to a slow agent, but the Task was takeable in between and the silence leaves no trace.
