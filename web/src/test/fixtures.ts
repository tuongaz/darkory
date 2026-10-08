import type {
  Connector,
  Health,
  Label,
  Me,
  Member,
  MemberDetail,
  Project,
  ProjectDetail,
  Skill,
  SkillVersion,
  Task,
  TaskDetail,
  Workflow,
  WorkflowStep,
} from "../api/client";
import { refuse, type Handler } from "./api";

const at = "2026-10-01T09:00:00Z";

export const ada: Member = { id: "m-ada", name: "ada", kind: "human", admin: true, email: "ada@example.com", created_at: at };
export const bob: Member = { id: "m-bob", name: "bob", kind: "human", admin: false, manager_id: "m-ada", created_at: at };
export const builder: Member = { id: "m-builder", name: "builder", kind: "agent", admin: false, manager_id: "m-ada", created_at: at };

const project = (id: string, key: string, name: string, color: number): Project => ({ id, key, name, color, auto_complete: false, acceptance: false, created_at: at });
// The colours the server gives the first two Projects of an Organisation.
export const web: Project = project("p-web", "WEB", "Web", 0);
export const ops: Project = project("p-ops", "OPS", "Ops", 6);

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  id: `s-${name}`,
  name,
  kind: "generic",
  builtin: false,
  current_version: 1,
  created_at: at,
  ...extra,
});
/** The generic Skills `init` seeds for the default Workflow. */
export const engineer = skill("engineer");
export const review = skill("review");
/** The builtin Skills Darkory files its own Subtasks at, and skill-review. */
export const breakdown = skill("breakdown", { builtin: true });
export const acceptance = skill("acceptance", { builtin: true });
export const retro = skill("retro", { builtin: true });
export const skillReview = skill("skill-review", { builtin: true });
export const skills: Skill[] = [acceptance, breakdown, engineer, retro, review, skillReview];

/** A Skill's version 1, published by ada when it was created. */
export function skillVersion(s: Skill, version = 1, body = `How ${s.name} is done here.`): SkillVersion {
  return { skill_id: s.id, version, body, published_by: ada.id, published_at: at };
}

/**
 * A Step id of a Project's default Workflow: `step.build` is WEB's Build. Another Project's Steps
 * are prefixed with its key in lower case (`ops-st-build`).
 */
export const step = {
  backlog: "st-backlog",
  plan: "st-plan",
  build: "st-build",
  review: "st-review",
  retro: "st-retro",
  skillReview: "st-skill-review",
} as const;

/**
 * `init`'s default Workflow for `p` (decisions.md, Model v2 and W0), with its compact layout:
 * Backlog (hold) · Plan (breakdown) · Build (engineer) · Review (review) · Retro (retro) · Skill
 * review (skill-review), and the eight Connectors. No Task stands anywhere; builder takes Build and
 * ada Review and Skill review, so Plan and Retro have no takers.
 */
export function workflow(p: Project = web, extra: Partial<Record<keyof typeof step, Partial<WorkflowStep>>> = {}): Workflow {
  const id = (s: keyof typeof step) => (p.id === web.id ? step[s] : `${p.key.toLowerCase()}-${step[s]}`);
  const s = (key: keyof typeof step, name: string, position: number, x: number, y: number, sk?: Skill, takers: Member[] = []): WorkflowStep => ({
    id: id(key),
    name,
    skill_id: sk?.id,
    position,
    x,
    y,
    tasks: 0,
    working: 0,
    takers: takers.map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
    ...extra[key],
  });
  const c = (n: number, from: keyof typeof step, to: keyof typeof step | null, name: string, position: number): Connector => ({
    id: `${id(from)}-c${n}`,
    from_step_id: id(from),
    to_step_id: to ? id(to) : undefined,
    name,
    position,
  });
  return {
    project_id: p.id,
    steps: [
      s("backlog", "Backlog", 1, 0, 0),
      s("plan", "Plan", 2, 0, 128, breakdown),
      s("build", "Build", 3, 0, 256, engineer, [builder]),
      s("review", "Review", 4, 448, 256, review, [ada]),
      s("retro", "Retro", 5, 0, 384, retro),
      s("skillReview", "Skill review", 6, 448, 384, skillReview, [ada]),
    ],
    connectors: [
      c(1, "plan", null, "done", 1),
      c(2, "build", "review", "pass", 1),
      c(3, "review", null, "pass", 1),
      c(4, "review", "build", "needs changes", 2),
      c(5, "retro", null, "done", 1),
      c(6, "retro", "skillReview", "propose", 2),
      c(7, "skillReview", null, "publish", 1),
      c(8, "skillReview", "retro", "needs changes", 2),
    ],
  };
}

/** A Label: the Organisation's unless `project_id` is given. */
export function label(name: string, color: string, extra: Partial<Label> = {}): Label {
  return { id: `l-${name}`, name, color, created_at: at, ...extra };
}
export const bug = label("bug", "#d1453b");
export const clientX = label("client-x", "#3b82d1", { project_id: web.id });

export function me(member: Member = ada, extra: Partial<Me> = {}): Me {
  return {
    organisation: { id: "o-1", name: "Acme", created_at: at },
    member,
    projects: [web],
    skills: [engineer],
    session: { id: "browser-1", member_id: member.id, kind: "browser", started_at: at, last_seen_at: at },
    ...extra,
  };
}

/**
 * A Task of WEB waiting at Build, owned and filed by ada, ranked `n`. A Subtask takes `parent_id`
 * and drops `rank`; a Parent drops `step_id` and takes `subtask_counts` (see `parentTask`).
 */
export function task(n: number, extra: Partial<Task> = {}): Task {
  return {
    id: `k-${n}`,
    key: `WEB-${n}`,
    project_id: web.id,
    kind: "work",
    title: `Task ${n}`,
    description: "",
    state: "open",
    owner_id: ada.id,
    rank: n,
    step_id: step.build,
    step_since: at,
    skill_id: engineer.id,
    breakdown: false,
    auto_complete: false,
    acceptance: false,
    blocked: false,
    filed_by: ada.id,
    waiting_since: at,
    created_at: at,
    ...extra,
  };
}

/** A Parent: at no Step, its Subtasks counted. */
export function parentTask(n: number, counts: Task["subtask_counts"], extra: Partial<Task> = {}): Task {
  return task(n, { step_id: undefined, step_since: undefined, skill_id: undefined, subtask_counts: counts, ...extra });
}

/** A Subtask of `parent`: its Project and Owner, no Rank of its own. */
export function subtask(n: number, parent: Task, extra: Partial<Task> = {}): Task {
  return task(n, { parent_id: parent.id, project_id: parent.project_id, owner_id: parent.owner_id, rank: undefined, ...extra });
}

/** A Task's record with nothing on it yet; its Step and the Connectors out of it from WEB's default Workflow. */
export function detail(t: Task, extra: Partial<TaskDetail> = {}): TaskDetail {
  const wf = workflow();
  const at = wf.steps.find((s) => s.id === t.step_id);
  return {
    task: t,
    step: at && { id: at.id, name: at.name, skill_id: at.skill_id, position: at.position, x: at.x, y: at.y },
    subtasks: [],
    connectors: wf.connectors.filter((c) => c.from_step_id === t.step_id),
    labels: [],
    workspaces: [],
    claims: [],
    notes: [],
    evidence: [],
    blockers: [],
    blocking: [],
    observations: [],
    proposals: [],
    ...extra,
  };
}

/** A Member's record: in WEB, holding engineer, directing no one, unless `extra` says otherwise. */
export function memberDetail(member: Member, extra: Partial<MemberDetail> = {}): MemberDetail {
  return { member, projects: [web], skills: [engineer], reports: [], ...extra };
}

export function health(extra: Partial<Health> = {}): Health {
  return { status: "ok", version: "v1.2.0", sign_in_modes: ["printed_link"], ...extra };
}

const projects = [ops, web];

/**
 * What every signed-in page reads: health, the caller, the Members, Projects and Skills for names,
 * each Project with ada as its one Member, its default Workflow and no Labels of its own, the
 * Organisation's Labels (none), every Task (none: the Install checklist shows), the Install's
 * Workspaces (none), the Member's Views (none), and the Runner's sessions (no Runner); each
 * Member's record (`memberDetail`) with no tokens or Sessions, and each Skill at its version 1.
 */
export function signedIn(member: Member = ada): Record<string, Handler> {
  const find = (ref: string) => projects.find((p) => p.id === ref || p.key === ref.toUpperCase());
  return {
    "GET /v1/health": health(),
    "GET /v1/me": me(member),
    "GET /v1/members": { items: [ada, bob, builder] },
    "GET /v1/members/:member": ({ params }) => {
      const m = [ada, bob, builder].find((x) => x.id === params.member || x.name === params.member);
      return m ? memberDetail(m) : refuse(404, "not_found", `No Member ${params.member}`);
    },
    "GET /v1/members/:member/tokens": { items: [] },
    "GET /v1/members/:member/sessions": { items: [], open: 0, ended: 0 },
    "GET /v1/projects": { items: projects },
    "GET /v1/projects/:project": ({ params }) => {
      const p = find(params.project);
      return p ? ({ project: p, members: [ada] } satisfies ProjectDetail) : refuse(404, "not_found", `No Project ${params.project}`);
    },
    "GET /v1/projects/:project/workflow": ({ params }) => workflow(find(params.project) ?? web),
    "GET /v1/projects/:project/labels": { items: [] },
    "GET /v1/labels": { items: [] },
    "GET /v1/skills": { items: skills },
    "GET /v1/skills/:skill": ({ params }) => {
      const sk = skills.find((x) => x.id === params.skill || x.name === params.skill);
      return sk ? { skill: sk, current: skillVersion(sk) } : refuse(404, "not_found", `No Skill ${params.skill}`);
    },
    "GET /v1/skills/:skill/versions": ({ params }) => {
      const sk = skills.find((x) => x.id === params.skill || x.name === params.skill);
      return sk ? { items: [skillVersion(sk)] } : refuse(404, "not_found", `No Skill ${params.skill}`);
    },
    "GET /v1/tasks": { items: [] },
    "GET /v1/runner/sessions": { items: [], runner: false },
    "GET /v1/workspaces": { items: [] },
    "GET /v1/views": { items: [] },
  };
}
