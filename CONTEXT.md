# Darkory

Management for a software factory whose workforce is a mix of agents and humans. The organisation is a core of the model; tracking work is one tool inside it. Agents are first-class citizens, not integrations.

## Language

### Organisation

**Organisation**:
The company running a software factory. It holds the Teams, Members, company Skills, and Reporting lines.
_Avoid_: Tenant, account, workspace

**Member**:
A human or an agent in an Organisation, belonging to one or more Teams. Both kinds have identical abilities: either can file, claim, block, and complete work, and either can hand work to the other.
_Avoid_: User, bot, worker, assignee

**Team**:
A group of Members, mixing agents and humans, that shares a body of work. Every Feature belongs to exactly one Team, and only its Members can take its Tasks.
_Avoid_: Workspace

**Skill**:
Something a Member is good at. A generic Skill (QA) is what a Member arrives with; a company Skill (QA at this company) builds on a generic one and adds the company's own knowledge. The Skill a Task needs decides who can take it.
_Avoid_: Speciality, capability, tag, role, playbook

**Reporting line**:
The relation between a Member and the Member who directs them. Either end can be a human or an agent, and it may cross Teams; a stuck Member escalates along it.
_Avoid_: Hierarchy, owner

### Work

**Tracker**:
The part of Darkory that holds the shared record of work. Members pull from it; it never starts an agent.
_Avoid_: Orchestrator, scheduler, runner

**Feature**:
A shippable outcome with exactly one owner. It is broken down into Tasks and is never claimed itself.
_Avoid_: Epic, project, story

**Task**:
The unit of work a Member claims and works. Every Task belongs to exactly one Feature.
_Avoid_: Issue, ticket, job, sub-issue

**Claim**:
A Member's exclusive hold on a Task; at most one Member holds a Task at a time. The Member may attach a heartbeat timeout when claiming. If so, the Claim is bound to the Session that made it and lapses when no Heartbeat arrives in time; otherwise it is bound to the Member. It also ends when the Member releases, hands over, or completes the Task, when it is taken back, or when the token or Session it is bound to is revoked.
_Avoid_: Assignment, lock, lease

**Session**:
One running copy of a Member, opened by exchanging the Member's token. A Member can have many Sessions at once; a Claim with a heartbeat timeout belongs to one of them.
_Avoid_: Run, instance, connection

**Heartbeat**:
A signal from the Member holding a Claim that it is still working the Task. A missed Heartbeat ends a Claim that carries a timeout; the lapse is recorded.
_Avoid_: Ping, keepalive

**Takeable**:
A Task is takeable by a Member when it is open, not blocked, not claimed, and either needs a Skill the Member has or is aimed at that Member by name. A Member who handed a Task over cannot take it at the stage they handed it to: no one judges their own work.
_Avoid_: Available, ready, free

**Handover**:
Passing a Task on to another Skill: the holder ends their Claim and sets the Skill the Task needs next. The same Task moves through build, review, and back again.
_Avoid_: Transfer, reassignment, escalation

**Blocking**:
A relation between two Tasks: a blocked Task is not takeable until every Task blocking it has ended. It may cross Features; Features never block each other directly.
_Avoid_: Dependency, waiting-on

**Escalation**:
A stuck Member filing a Task aimed at someone above them, on their Reporting line or the Feature owner, and letting it block their own Task. Questions to any other Member work the same way.
_Avoid_: Ping, flag, help request

**Dropped**:
How a Task ends when it will not be done, decided by the Feature owner. A Task ends either done or dropped.
_Avoid_: Cancelled, won't-do, abandoned

**Feature owner**:
The one Member, human or agent, with authority over a Feature: deciding to ship or drop it, dropping its Tasks, and answering escalations about it. Ownership is not a Claim and can be passed on.
_Avoid_: Assignee, lead, PM

**Shipped**:
How a Feature ends when its owner decides it is ready. A Feature ends either shipped or dropped.
_Avoid_: Released, closed, done

**Evidence**:
A report, screenshot, or log attached to a Task or Feature, recording who attached it. Darkory keeps it; the Feature owner judges it.
_Avoid_: Artifact, attachment, proof

**Rank**:
The single order of Features within a Team; a Task sorts by its Feature's Rank. It is the only notion of priority.
_Avoid_: Priority, urgency, severity

**Note**:
An entry in a Task's running log, written by whoever is working it, so context survives a Handover.
_Avoid_: Comment, thread, message

**Observation**:
An entry on a Task, marked worked or didn't work, recording who wrote it and the Skill they worked under. It feeds the Feature's Retrospective, which marks it reviewed; unlike a Note, it is not for carrying context across a Handover.
_Avoid_: Lesson, learning, feedback

**Retrospective**:
The Task Darkory files on a Feature when it ships or drops, needing the retro Skill. It reads the Feature's Observations, may propose a new Skill version, and files new Features for problems found. The only Task an ended Feature can hold.
_Avoid_: Retro meeting, post-mortem, review

**Skill version**:
One published revision of a company Skill. A change is proposed by a Retrospective and published only when a Member with the skill-review Skill, other than its author, completes the review. Every Claim records the version it worked under.
_Avoid_: Revision, edit

**Activity**:
The append-only trail of every change to the record: who did what and when. That includes claims, lapses, take-backs, Handovers, blocks, ships and drops. It is written with the change it describes, and is never the source of truth.
_Avoid_: Audit log, event, history

### Deployment

**Install**:
One running Darkory server: the single source of truth for the Organisations it holds. Every Claim runs on it.
_Avoid_: Instance, node, replica

**Local**:
The open-source Darkory server, self-hosted by its user. It holds exactly one Organisation.
_Avoid_: Desktop, offline mode

**Cloud**:
The same Darkory server, hosted for many Organisations that don't want to run it themselves.
_Avoid_: SaaS, hosted edition
