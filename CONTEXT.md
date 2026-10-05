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
A group of Members, mixing agents and humans, that shares a body of work. Every Feature belongs to exactly one Team, and only its Members can take its Tasks by Skill; a Task aimed at a Member by name can be taken from any Team.
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
A Member's exclusive hold on a Task; at most one Member holds a Task at a time. The Member may attach a heartbeat timeout when claiming. If so, the Claim is bound to the Session that made it and lapses when no Heartbeat arrives in time; otherwise it is bound to the Member. It also ends when the Member releases, hands over, or completes the Task, when someone on the holder's Reporting line or the Feature owner takes it back, when the Task is dropped, or when the token or Session it is bound to is revoked.
_Avoid_: Assignment, lock, lease

**Session**:
One running copy of a Member, known by an id that copy chooses and presents with the Member's token. A Member can have many Sessions at once; a Claim with a heartbeat timeout belongs to one of them.
_Avoid_: Run, instance, connection

**Heartbeat**:
A signal from the Member holding a Claim that it is still working the Task. A missed Heartbeat ends a Claim that carries a timeout; the lapse is recorded.
_Avoid_: Ping, keepalive

**Takeable**:
A Task is takeable by a Member when it is open, not blocked, not claimed, and either is aimed at that Member by name or needs a Skill the Member has and belongs to a Feature in one of the Member's Teams. A Member who has held a Task under one Skill can take it again only under that Skill: no one judges their own work.
_Avoid_: Available, ready, free

**Handover**:
Passing a Task on to another Skill: the holder ends their Claim and sets the Skill the Task needs next. The same Task moves through build, review, and back again.
_Avoid_: Transfer, reassignment, escalation

**Blocking**:
A relation between two Tasks: a blocked Task is not takeable until every Task blocking it has ended. It may cross Features; Features never block each other directly.
_Avoid_: Dependency, waiting-on

**Escalation**:
A stuck Member filing a Task aimed at someone above them, on their Reporting line or the Feature owner, and letting it block their own Task. The new Task joins the Feature of the Task it blocks. Questions to any other Member work the same way.
_Avoid_: Ping, flag, help request

**Dropped**:
How a Task ends when it will not be done, decided by the Feature owner or brought about by its Feature being dropped. A Task ends either done or dropped.
_Avoid_: Cancelled, won't-do, abandoned

**Feature owner**:
The one Member, human or agent, with authority over a Feature: deciding to ship or drop it, dropping its Tasks, and answering escalations about it. Ownership is not a Claim and can be passed on.
_Avoid_: Assignee, lead, PM

**Shipped**:
How a Feature ends when its owner decides it is ready, which requires every one of its Tasks to have ended. A Feature ends either shipped or dropped; dropping it drops its open Tasks.
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

**Breakdown**:
The Task Darkory files on a Feature when the Feature is filed, needing the breakdown Skill. Whoever takes it files the Feature's other Tasks.
_Avoid_: Planning, decomposition, grooming

**Observation**:
An entry on a Task, marked worked or didn't work, recording who wrote it and the Skill they worked under. It feeds the Feature's Retrospective, which marks it reviewed; unlike a Note, it is not for carrying context across a Handover.
_Avoid_: Lesson, learning, feedback

**Retrospective**:
The Task Darkory files on a Feature when it ships or drops, needing the retro Skill. It reads the Feature's Observations, may propose a new Skill version, and files new Features for problems found. It is the only open Task an ended Feature can hold, apart from questions that block it; when no Member of the Team has the Skill it needs, the Feature owner can take it.
_Avoid_: Retro meeting, post-mortem, review

**Skill version**:
One published revision of a company Skill. A change is proposed by a Retrospective and published only when a Member with the skill-review Skill, other than its author, completes the review. Every Claim records the version it worked under.
_Avoid_: Revision, edit

**Model label**:
The name of the AI model an agent Member says it used while holding a Claim. It is optional, reported by the Member and never interpreted by Darkory; a human Member reports none.
_Avoid_: Engine, provider setting, model config

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
The hosted Darkory service: the same open-source server with closed additions, run for many Organisations that don't want to host it themselves.
_Avoid_: SaaS, hosted edition
