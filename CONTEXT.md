# Darkory

Management for a workforce that is a mix of agents and humans. The organisation is a core of the model; tracking work is one tool inside it. Agents are first-class citizens, not integrations.

## Language

### Organisation

**Organisation**:
The company running the workforce. It holds the Projects, Members, company Skills, and Reporting lines.
_Avoid_: Tenant, account, workspace

**Member**:
A human or an agent in an Organisation, belonging to one or more Projects. Both kinds have identical abilities: either can file, claim, block, and complete work, and either can hand work to the other.
_Avoid_: User, bot, worker, assignee

**Avatar**:
The picture shown for a Member in place of their initials: a File uploaded as one, a square image. A human sets their own; an admin sets anyone's.
_Avoid_: Profile picture, photo, icon

**Project**:
A body of work with the Members, agents and humans, who do it: its own key, Workflow, Labels, Rank and Workspaces. Every Task belongs to exactly one Project and is taken by that Project's Members, with the exceptions listed under Takeable. It is the context the web app is always in.
_Avoid_: Team, workspace, board, space

**Skill**:
Something a Member is good at. A generic Skill (QA) is what a Member arrives with; a company Skill (QA at this company) builds on a generic one and adds the company's own knowledge. The Skill a Step carries decides who can take the Tasks at it.
_Avoid_: Speciality, capability, tag, role, playbook

**Reporting line**:
The relation between a Member and the Member who directs them. Either end can be a human or an agent, and it may cross Projects; a stuck Member escalates along it.
_Avoid_: Hierarchy, owner

### Work

**Tracker**:
The part of Darkory that holds the shared record of work. Members pull from it; it never starts an agent.
_Avoid_: Orchestrator, scheduler, runner

**Task**:
The unit of work in a Project: filed with a title, an Owner, a Rank, and any Labels. A Task with no Subtasks is at one Step of its Project's Workflow, where it is claimed, worked, and advanced by its holder. Everything said of a Task holds for a Subtask too.
_Avoid_: Issue, ticket, job, feature, epic, story, project

**Subtask**:
A Task filed under another Task, its Parent, which it belongs to. It inherits its Parent's Project and Owner, sorts by its Parent's Rank, and has no Subtasks of its own.
_Avoid_: Sub-issue, child, step, checklist item

**Parent**:
A Task that has Subtasks. It is at no Step, is never claimed or takeable, and neither blocks nor is blocked; it ends Done when its Owner completes it, which requires every Subtask to have ended, or Dropped. A Task becomes a Parent when its first Subtask is filed: anyone in its Project may file one under a Task nobody holds, and the holder may file one under the Task they hold, which ends their Claim.
_Avoid_: Epic, feature, container, group

**Workflow**:
A Project's Steps and the Connectors between them: one per Project, drawn on a canvas and shown as the columns of its board. A filed Task starts at the Step the filer names, by default the first Step whose Skill is the Project's own work rather than one Darkory files its Subtasks at.
_Avoid_: Pipeline, process, scheme, status list

**Step**:
A place in a Workflow, named by the Project, carrying at most one Skill: a Task at a Step is taken by a Member with that Skill. A Step without a Skill is a hold: no one is offered a Task there, and a human moves it on. Whether the Task at a Step is waiting or being worked follows from its Claim, not from the Step. A Task aimed at a Member by name waits with that Member instead of at a Step. The Steps carrying the breakdown, acceptance and retro Skills are where Darkory files the Subtasks it owns about a Parent as a whole.
_Avoid_: Status, state, column, stage, phase

**Connector**:
A named way out of a Step into another Step, or into Done: the outcome the holder names when they advance the Task. Advancing into Done completes the Task; Dropped needs no Connector.
_Avoid_: Transition, edge, arrow, rule

**Claim**:
A Member's exclusive hold on a Task; at most one Member holds a Task at a time. The Member may attach a heartbeat timeout when claiming. If so, the Claim is bound to the Session that made it and lapses when no Heartbeat arrives in time; otherwise it is bound to the Member. It also ends when the Member releases, advances, or completes the Task, when someone on the holder's Reporting line or the Task's Owner takes it back, when the Task is dropped or becomes a Parent, or when the token or Session it is bound to is revoked. A Task whose Claim ends without advancing stays at its Step.
_Avoid_: Assignment, lock, lease

**Session**:
One running copy of a Member, known by an id that copy chooses and presents with the Member's token. A Member can have many Sessions at once; a Claim with a heartbeat timeout belongs to one of them.
_Avoid_: Run, instance, connection

**Heartbeat**:
A signal from the Member holding a Claim that it is still working the Task. A missed Heartbeat ends a Claim that carries a timeout, and a late one does not restore it; the lapse is recorded.
_Avoid_: Ping, keepalive

**Takeable**:
A Task is takeable by a Member when it is open, has no Subtasks, is not blocked, not claimed, and one of these holds: it is aimed at that Member by name; it is at a Step whose Skill the Member has, in one of the Member's Projects; it is at a Step carrying the skill-review Skill, which the Member has, in any Project; or the Member owns it and no Member could take it by its Step's Skill: none in its Project has that Skill, or, for skill-review, none in the Organisation has it. A Member who has held a Task under one Skill can take it again only under that Skill: no one judges their own work.
_Avoid_: Available, ready, free

**Handover**:
The holder advancing a Task along a Connector: their Claim ends and the Task waits at the next Step, for whoever has that Step's Skill. A human may also move a Task to any Step by hand, which is recorded as such; moving a held Task ends the Claim as a take-back would.
_Avoid_: Transfer, reassignment, escalation, status change

**Blocking**:
A relation between two worked Tasks: a blocked Task is not takeable until every Task blocking it has ended. It may cross Parents; a Parent neither blocks nor is blocked.
_Avoid_: Dependency, waiting-on

**Escalation**:
A stuck Member filing a Task aimed at someone above them, on their Reporting line or the Task's Owner, and letting it block their own Task. The new Task joins the blocked Task's Parent as a Subtask, or stands alone in the Project beside a Task that has no Parent. Questions to any other Member work the same way.
_Avoid_: Ping, flag, help request

**Complete**:
How a Task ends Done: a worked Task by its holder advancing into Done, a Parent by its Owner once every Subtask has ended. In a git Workspace the Task's branch merges into the default branch, or the pull request that does opens.
_Avoid_: Ship, release, close, finish, resolve

**Dropped**:
How a Task ends when it will not be done, decided by its Owner; dropping a Parent drops its open Subtasks. A Task ends either done or dropped.
_Avoid_: Cancelled, won't-do, abandoned

**Owner**:
The one Member, human or agent, with authority over a Task and its Subtasks: completing or dropping a Parent, dropping its Subtasks, taking back their Claims, answering escalations about them, and taking any of them that no Member could take by its Step's Skill. The filer unless another is named; a Subtask's Owner is its Parent's. Ownership is not a Claim and can be passed on.
_Avoid_: Assignee, lead, PM

**Auto-complete**:
A Parent's standing instruction that it completes itself when its last Subtask ends Done — its Acceptance included, where the Workflow has one — with no Owner's click. Off unless the filer or the Project's default says so.
_Avoid_: Auto-merge, auto-close, ship when done

**Label**:
A named, coloured mark carried by any number of Tasks, defined by a Project for itself or by the Organisation for every Project. Filters and Views read it; Darkory's rules never do.
_Avoid_: Tag, category, component, type

**Evidence**:
A report, screenshot, or log attached to a Task, recording who attached it. Darkory keeps it; the Owner judges it.
_Avoid_: Artifact, attachment, proof

**File**:
Bytes an Organisation keeps, referenced by id and readable by any of its Members, such as an Avatar. Darkory takes its type from the bytes, never from the uploader.
_Avoid_: Attachment, upload, asset, blob

**Rank**:
The single order of the Tasks without a Parent within a Project, in which an ended Task keeps its place; a Subtask sorts by its Parent's Rank. It is the only notion of priority.
_Avoid_: Priority, urgency, severity

**Note**:
An entry in a Task's running log, written by whoever is working it, so context survives a Handover.
_Avoid_: Comment, thread, message

**Breakdown**:
The Subtask Darkory files under a Task filed with Break down on, at the Project's Step that carries the breakdown Skill. Whoever takes it files the Task's other Subtasks. A Project whose Workflow has no such Step offers no Break down.
_Avoid_: Planning, decomposition, grooming

**Acceptance**:
The Subtask Darkory files under a Parent when its last other Subtask ends Done, at the Project's Step that carries the acceptance Skill, so that a Member, agent or human, confirms the whole before it is called done. Completing it lets the Parent complete, itself with Auto-complete, else by its Owner; filing more Subtasks instead has it filed again when they end. A Parent's Owner may turn it off when filing; a Project whose Workflow has no such Step files none, and a Parent is then considered done when its Subtasks are.
_Avoid_: Sign-off, UAT, final review, gate, definition of done

**Observation**:
An entry on a Task, marked worked or didn't work, recording who wrote it and the Skill they worked under. It feeds the Retrospective of the Task's Parent, which marks it reviewed; unlike a Note, it is not for carrying context across a Handover.
_Avoid_: Lesson, learning, feedback

**Retrospective**:
The Subtask Darkory files under a Parent when it ends, at the Project's Step that carries the retro Skill. It reads the Parent's Observations, may propose a new Skill version, and files new Tasks for problems found. It is the only open Subtask an ended Parent can hold, apart from questions that block it. A Project whose Workflow has no such Step files none.
_Avoid_: Retro meeting, post-mortem, review

**Skill version**:
One published revision of a company Skill. A change is proposed by a Retrospective against the current version, and published only when a Member with the skill-review Skill, from any Project and other than its author, completes the review while that version is still current; when no Member of the Organisation has skill-review, the Task's Owner may complete it instead, unless they wrote it. Every Claim records the version it worked under.
_Avoid_: Revision, edit

**Model label**:
The name of the AI model an agent Member says it used while holding a Claim. It is optional, reported by the Member and never interpreted by Darkory; a human Member reports none.
_Avoid_: Engine, provider setting, model config

**Activity**:
The append-only trail of every change to the record: who did what and when. That includes claims, lapses, take-backs, Handovers, blocks, completions and drops. It is written with the change it describes, and is never the source of truth.
_Avoid_: Audit log, event, history

**View**:
A saved set of filters, sort and display for a list, kept by one Member for themselves. Nobody else sees it, and it is not part of the record.
_Avoid_: Saved filter, smart list

### Agents at work

**Runner**:
The part of a Local Install, beside the Tracker, that runs agent sessions: it pulls Tasks through `next` as an agent Member, prepares the Workspace, starts the agent's command, keeps its Heartbeats while the session shows progress, and ends the session when the Claim ends. It is a client of the record, never a second scheduler; the Tracker still starts nothing itself.
_Avoid_: Orchestrator, scheduler, supervisor

**Workspace**:
A place a session works in, named on the Install and given a kind — a git repository is the first. A Project has a default Workspace, and a Task names one or more. In a git Workspace the session works in a checkout on a branch named after the Task; a Parent's branch is where its Subtasks' branches merge.
_Avoid_: Repo (when the kind is not fixed), project folder

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
