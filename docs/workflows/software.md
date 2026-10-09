# The software Workflow

A Workflow for a Project that builds software, with Product, Architect, Security, Engineer, Code review, QA, DevOps, Acceptance and Retrospective as the roles. It is drawn from how strong teams move a change from an idea to production. Small changes go through quickly. Changes that are risky or hard to reverse get a design, a threat model and a security review. The preset that applies it to an Install is in [`examples/workflows/software/`](../../examples/workflows/software/).

## What the research says

These are the practices that change outcomes, with their sources. Only the rules that shape a Step or an outcome are kept here.

**Design before code, only when it is needed.** At Google a design doc covers context and scope, goals and non-goals, the design and its trade-offs, the alternatives considered, and cross-cutting concerns: security, privacy and observability. Peers review it before the work starts. Incremental work gets a mini design doc of one to three pages. When the solution is unambiguous, no doc is written ([Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/)). A decision that is architecturally significant is also recorded as an Architecture Decision Record: Context, Decision, Status, Consequences. It is never deleted, only superseded ([Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), [adr.github.io](https://adr.github.io/)).

**Security at both ends.**
- Microsoft's SDL puts threat modeling and a security design review at design time, and security testing and supply-chain checks at build time ([SDL practices](https://www.microsoft.com/en-us/securityengineering/sdl/practices)).
- Threat modeling asks four questions, early and in small scopes: what are we working on, what can go wrong, what are we going to do about it, and did we do a good enough job ([Threat Modeling Manifesto](https://www.threatmodelingmanifesto.org/)). STRIDE is the usual checklist for the second question ([STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)).
- OWASP SAMM makes threat assessment risk-based ([SAMM Threat Assessment](https://owaspsamm.org/model/design/threat-assessment/)). It turns security objectives into requirements that can be verified ([Security Requirements](https://owaspsamm.org/model/design/security-requirements/), [ASVS](https://owasp.org/www-project-application-security-verification-standard/)).
- SAMM runs automated security testing on every change and aims expert manual review by risk ([Security Testing](https://owaspsamm.org/model/verification/security-testing/)). Dependencies, pinning, secrets and provenance are checked as the supply chain ([OpenSSF Scorecard](https://scorecard.dev/), [SLSA](https://slsa.dev/spec/v1.0/levels)).

**Peer review is the approval gate, and it is kept light.**
- Every change is reviewed. Reviewers check design, functionality, complexity, tests, naming, comments and docs, and approve any change that improves the code's health ([What to look for](https://google.github.io/eng-practices/review/reviewer/looking-for.html)).
- Changes are small and self-contained, with their tests ([Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)), and reviews are answered quickly ([Speed](https://google.github.io/eng-practices/review/reviewer/speed.html)).
- DORA found no evidence that formal external approval, such as a change advisory board, lowers the change fail rate. It makes batches bigger and slower. Peer review in the repository plus automated tests is what works ([Streamlining change approval](https://dora.dev/capabilities/streamlining-change-approval/)).

**Small batches, integrated continuously, deployed by automation.** DORA's capabilities are trunk-based development with short-lived branches, continuous integration that tests every commit, deployment automation that keeps configuration out of the artefact, and small batches ([trunk-based](https://dora.dev/capabilities/trunk-based-development/), [CI](https://dora.dev/capabilities/continuous-integration/), [deployment automation](https://dora.dev/capabilities/deployment-automation/), [small batches](https://dora.dev/capabilities/working-in-small-batches/), [trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/short-lived-feature-branches/)). Speed and stability move together. DORA measures them as lead time, deployment frequency, change fail rate, recovery time and rework ([DORA metrics](https://dora.dev/guides/dora-metrics-four-keys/)).

**Release with a way back, and watch it.** Google's release engineering is self-service: builds are hermetic and reproducible, and a policy says who may release ([Release Engineering](https://sre.google/sre-book/release-engineering/)). Most incidents come from pushing a binary or a configuration, so releases are canaried and keep a fast rollback ([Canarying Releases](https://sre.google/workbook/canarying-releases/)). What to watch is the four golden signals: latency, traffic, errors and saturation ([Monitoring](https://sre.google/sre-book/monitoring-distributed-systems/)).

**Done means done.** A Definition of Done states the quality an increment must meet. Work that does not meet it is not released ([Scrum Guide](https://scrumguides.org/scrum-guide.html)). Most tests are fast unit tests, with fewer integration tests and very few end-to-end tests ([Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html), [Test sizes](https://testing.googleblog.com/2010/12/test-sizes.html)).

**Learn without blame.** A retrospective or postmortem is blameless. Its action items have owners and are tracked ([Postmortem Culture](https://sre.google/sre-book/postmortem-culture/), [workbook](https://sre.google/workbook/postmortem-culture/)). Shape Up adds two rules: shape the work before betting on it, and fix the time while letting the scope vary ([Shape Up](https://basecamp.com/shapeup/1.2-chapter-03)).

**Gate by risk.**
- Skip the design when the solution is obvious.
- Write an ADR only for a decision that is hard to reverse.
- Never skip code review, but keep it fast.
- Run automated checks on every change, and send a change for expert security review only when it touches the attack surface.
- Never add an external approval board.

## The Workflow

The preset's Workflow is named Software. A Project on it has this one Workflow, so its name shows nowhere until a second is added.

```
Backlog (hold)
Triage (triage) ── no design needed ──────────────────────────────────────────► Build
   └─ needs a design: Triage splits the Task, filing "Design: …" at Design
Plan (breakdown) ── done ──► Done          (files "Design: …" at Design, or the slices at Build)
Design (architecture) ── security impact ──► Threat model (security) ── accepted ──► Design review
                      └─ no security impact ─────────────────────────────────────► Design review (review)
Threat model ── redesign ──► Design          Design review ── approved ──► Done   ── redesign ──► Design
Build (engineer) ── ready for review ──► Code review (review)
Code review ── pass ──► QA   ── security review ──► Security review (security)   ── needs changes ──► Build
Security review ── pass ──► QA   ── needs changes ──► Build
QA (qa) ── pass ──► Release   ── fail ──► Build
Release (devops) ── released ──► Done   ── not ready ──► Build
Acceptance (acceptance) ── pass ──► Release   ── fixes filed ──► Done
Retro (retro) ── done ──► Done   ── propose ──► Skill review (skill-review) ── publish ──► Done / needs changes ──► Retro
```

A Task takes one of three paths.

1. **Fast path** (a standalone Task): Triage → Build → Code review → QA → Release → Done. It has no design, no threat model, and no security review unless its `security` Label or its diff calls for one.
2. **Design path** (a Parent, filed with Break down, or split by Triage): Plan decides the shape. A `Design: …` Subtask goes Design → (Threat model) → Design review → Done. Its branch carries the design document, the ADRs and the threat model into the Parent's branch. The architect files the slices while designing, each at Build and blocked from its first moment (`file --blocked-by`) by the Design Subtask and by any slice whose code it builds on. So no slice is built before its design is approved, and every slice branches from a Parent branch that holds the design.
3. **Slice path** (each slice): Build → Code review → (Security review) → QA → Release → Done, merging into the Parent's branch. When the last slice ends, Darkory files the Acceptance. Acceptance → Release → Done completes the Parent, which merges into the default branch, and then the Retrospective is filed.

### Why each Step and outcome exists

| Step | Skill (agent) | Why it exists | Outcomes |
|---|---|---|---|
| Backlog | hold | Ideas that nobody should take yet. A human moves them on. | (moved by hand) |
| Triage | `triage` (product) | Sets the definition of done and judges the risk before anyone builds. It is the one place a small change is let through quickly. | `no design needed` → Build; otherwise it splits the Task with a Design Subtask |
| Plan | `breakdown` (product) | A Parent filed with Break down gets its acceptance criteria and its shape: a design first, or slices straight away. | `done` |
| Design | `architecture` (architect) | Design doc and ADRs before code, written on a branch that every slice later starts from. The slices are filed here, at Build and already blocked by the Design Subtask. | `security impact` → Threat model; `no security impact` → Design review |
| Threat model | `security` (security) | The four questions and STRIDE, at design time when a fix is cheap. Their output is numbered security requirements, which bind slices as Notes and Labels. | `accepted` → Design review; `redesign` → Design |
| Design review | `review` (reviewer) | Peer review of the design: is it the simplest one, do the slices cover it, is the rollout written. Approving it merges the documents and starts the slices. | `approved` → Done; `redesign` → Design |
| Build | `engineer` (builder) | Test-first slice; attaches the test log. | `ready for review` → Code review |
| Code review | `review` (reviewer) | Spec and standards, kept apart; the merge gate the research keeps for every change. The reviewer also decides whether the diff needs a security review. | `pass` → QA; `security review` → Security review; `needs changes` → Build |
| Security review | `security` (security) | Expert review aimed by risk: authentication, input, secrets, dependencies, and the requirements from the threat model. | `pass` → QA; `needs changes` → Build |
| QA | `qa` (qa) | The change driven from its user's side, edges included. An unverified pass is not a pass. | `pass` → Release; `fail` → Build |
| Release | `devops` (devops) | CI steps green, the artefact builds and starts, configuration kept out of the code, rollout and rollback written. The last gate before the merge, which is the release. | `released` → Done; `not ready` → Build |
| Acceptance | `acceptance` (product) | The Parent as a whole, against the criteria Plan wrote: the Definition of Done. | `pass` → Release; `fixes filed` → Done (Darkory files a new Acceptance once the fixes end) |
| Retro | `retro` (retro) | Blameless and measured. A Skill change goes through a proposal; a problem in the product becomes a new Task. | `done`; `propose` → Skill review |
| Skill review | `skill-review` (reviewer) | No one publishes their own Skill change. | `publish`; `needs changes` → Retro |

### What is skipped, and who decides

| Gate | Skipped when | Decided by |
|---|---|---|
| Design, Threat model, Design review | The change is one Shift's work, its approach is obvious, it adds no component, endpoint, store, dependency or public interface, and nothing in it is hard to reverse | Triage (`no design needed`), or Plan filing the slices without a Design Subtask |
| Threat model | The design changes nothing on the attack surface | The architect (`no security impact`) |
| ADR | No decision in the design is hard to reverse | The architect |
| Security review | The Task has no `security` Label and its diff touches no authentication, authorisation, secret or untrusted input, and adds no dependency | The code reviewer (`pass` instead of `security review`) |
| Release's artefact build and release note | A slice that does not touch build, CI, container or deployment. Its CI steps still run. | DevOps, by the `infra` Label and the diff |

Never skipped: acceptance criteria, Code review, QA, and running the CI steps. No external approval board is added, because DORA's evidence goes against one.

### What each role leaves behind

| Role | In the repository (committed on the Task's branch) | In the record |
|---|---|---|
| Product | — | Acceptance criteria as a Note; Labels `security` and `infra` |
| Architect | `docs/design/<PARENT>.md`, `docs/adr/NNNN-*.md` | The slices filed and blocked; the design as Evidence |
| Security | `docs/security/<PARENT>-threat-model.md` | SR-n Notes on slices; `security-review-<KEY>.md` as Evidence |
| Builder | Code, tests, README | Test log as Evidence; a Note on what changed |
| Reviewer | — | A Note per axis |
| QA | — | `qa-<KEY>.log` as Evidence; one Note per defect |
| DevOps | `docs/releases/<KEY>.md` (Acceptance or standalone) | CI log as Evidence; readiness Note |
| Everyone | — | One Observation per Shift about the process |

## Where Darkory's model shapes it

The Workflow fits Darkory's rules as they are. Where the research asks for something the model does not have, this says how the Workflow works within the model, and what was decided.

- **One Skill per Step, one Step per Task at a time.** The reviewer decides whether the security review is needed.
- **Design review needs two eyes.** Peer review (`review`) and a threat model (`security`) are two Steps, because a Step carries one Skill.
- **Releasing a Parent.** A Parent is at no Step, so its release rides on its Acceptance Subtask (Acceptance → Release). The Release Step is pre-merge: merging into the default branch is the deploy trigger, and nothing in Darkory watches production after Done. Canary analysis and the post-release check of the golden signals are written into the release note, but no Step runs them.
- **Triage cannot turn a held Task into a Break down.** The design path from Triage is a split. The triager files a `Design: …` Subtask at Design, which makes the Task a Parent without a Breakdown Subtask.
- **Labels carry risk, but rules never read them.** `security` and `infra` steer the agents' choice of outcome, and Darkory's rules ignore them, by design.
- **Review Steps run one after another: a known limit.** Code review, Security review and QA cannot run in parallel on one Task; each waits for the one before it. Decided 2026-10-09: keep them sequential rather than give a Step several Skills.
- **A question has no branch.** A Task aimed at a Member gets no checkout and merges nothing: its answer lives in Notes. In the first proof run, an answer committed on a question's branch merged past every review; the Runner now prepares no Workspace for one.
- **Other flows are Workflows of their own.** Support, Bugs or Prototypes would each be a Workflow of its own in the same Project, with its own board and canvas, rather than more Steps in Software or another Project (ADR 0019). Triage routes by outcome: a Connector out of Triage such as `bug → Bugs › Investigate` leads into the other Workflow's Step, so the Task crosses in one advance and stays one Task with one history.
- **Self-review is by Skill.** Someone who built a Task under `devops` could release it under `devops` again. So infrastructure is built by the builder (`engineer`) and released by DevOps, never both by one agent.

## Applying it to an Install

The preset holds:
- `workflow.json`: Steps, Skills, Connectors and canvas positions, in the form `darkory workflow set` reads.
- `<skill>.md`: the generic Skills `architecture`, `security` and `devops`, and the Project's company Skill on each role (`software-*`), whose text the Runner puts first in a Shift's prompt and which a Retrospective may propose changes to. `darkory init` seeds `triage` and `qa`, and the preset keeps them, as it does `engineer` and `review`; its `triage.md` and `qa.md` carry init's text, for an Install without them.
- `agents.json`: the roster, with each agent's name, Skills, model and Reporting line. `@owner` is the admin running setup.
- `setup.sh`: applies all of it.

```sh
export DARKORY_URL=http://127.0.0.1:7357 DARKORY_TOKEN=dk_…   # an admin's token
export DATA=/path/to/the/Install/data                          # the Runner reads $DATA/agents/<agent>.token
PROJECT=WEB PROJECT_NAME="Web" REPO=/path/to/repo MODE=plain \
  examples/workflows/software/setup.sh
```

It creates the Skills, the Project with `acceptance` and `auto_complete` on, the Workspace (plain or `pull_request`), the Labels `security` and `infra`, and the agents. Each agent is a Member of the Project with its Skills and Reporting line, runs Claude Code on its model, unattended, and gets a token written to `$DATA/agents` that is never printed. Last, it sets the Workflow.

Running it again keeps everything that is already there, other Workflows included. The preset owns one Workflow, Software, and leaves every other Workflow of the Project as it is: its Steps, its Tasks and its Connectors, and a Connector out of a Software Step into one of them, such as `bug → Bugs › Investigate`. Software keeps the id of the Workflow it becomes: the Project's only one, renamed Software if it was named otherwise (a Project made before Workflows were named has one called Work); else the one named Software; else the one holding Backlog or Triage. So a re-run never deletes and remakes it, and Software is listed first. A Project on the default Workflows is refused before anything is written, because its Triage and Code review Steps share names with the preset's; a Project `setup.sh` creates starts from `--workflow empty`, so that works. Its Steps keep their ids by name, so Tasks in flight stay put. Open Tasks at a Step the preset no longer has move to Backlog. A Skill that already exists is not rewritten: change a Skill through a Retrospective's proposal, or `skill create` a new one.

Restart `darkory serve` (or start `darkory runner`) once the tokens exist, so the Runner starts the agents. File work with `darkory file --project WEB --title …`, which starts at Triage, or add `--breakdown` for a Parent, which starts at Plan.

Shifts run in each Task's directory, and Claude Code reads every `CLAUDE.md` from there up to the root. When the data directory is inside a git checkout or under a `CLAUDE.md`, the Runner puts Task directories under `~/.darkory/workspaces/` instead of `<data>/workspaces`, so agents never read another project's rules; `--workspaces` (or `DARKORY_WORKSPACES`) names the place yourself.

## The proof run (2026-10-08)

The preset ran on a scratch Install, with the Runner starting real Claude Code Shifts under the owner's own configuration, against a small Go service (`linkshort`). The run used two Tasks and nobody touched it while it ran.

- **Fast path.** LS-3 ("a short code that does not exist should say 'link not found'") went Triage → Build → Code review → QA → Release → Done in 3 minutes, with no design and no security Steps.
- **Design path.** LS-1 ("only callers with an API key can create short links, with rate limiting, a health check, and shipped as a container with CI") was filed with Break down.
  - Plan wrote the acceptance criteria.
  - A `Design: …` Subtask went Design → Threat model → Design review. It produced a design document, three ADRs, and a STRIDE threat model with 19 security requirements.
  - Four slices followed: health check, API keys, rate limit, and container + CI + deploy notes. The keys, rate-limit and container slices went through Security review. The health-check slice was taken the second it was filed, before it was blocked. Code review passed it before the threat model gave it its `security` Label, so it skipped Security review.
  - Two questions went to the architect.
  - The container slice went back to Build five times, four of them from Code review, each round finding one more flaw in the operator procedures.
  - Then Acceptance → Release, Auto-complete, the Retrospective, and a Skill review that sent one proposal back before publishing four new Skill versions.
- **Totals.** 52 Shifts and 84 minutes of work, from 12:19 to 13:37 UTC. No Claim lapsed and no Shift needed a nudge.
- **Landing on main.** The Parent's merge into main conflicted with LS-3. The Retrospective filed LS-13 to land it, and the agents carried it to Done.

The run found three Runner defects, each now fixed with a test: reviewed work was noted "without review" when a Step after the review completed it; a re-taken Task's branch was stale; a Shift could start before its sibling's merge. It also showed that a Parent's conflicting merge filed nothing to resolve it, which is fixed too. The Skill-text changes it led to are in the preset.

A second run on a fresh Install used the corrected Skill texts and Runner, and took a screenshot at every Step change.
- The architect filed five slices in the Backlog, blocked them, then moved them to Build. None was taken early.
- Design review sent the design back once before approving it.
- Release found that the Acceptance's branch no longer merged into main and answered `not ready`. The builder merged main in, so the Parent landed on main cleanly.
- The Retrospective measured 6 loops and about 87 minutes of work, with no time spent waiting in a queue. Skill review published 5 Skill changes after one round of fixes; those changes are now in the preset.
- No Claim lapsed and no Shift needed a nudge.
