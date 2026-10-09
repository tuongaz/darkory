import type { Skill } from "@/api/client";
import { newKey } from "@/api/client";
import { lineTopology } from "@/components/workflowLine/layout";
import { branchSkills, branchSteps, inProjectOrder, workflowsInOrder, type LineWorkflow } from "@/components/workflowLine/model";
import { isNew, newIdPrefix, same, toBody, type RecordConnector, type RecordStep, type SetWorkflowBody, type WorkflowRecord } from "../bind";
import type { Holder, Roster } from "./holders";
import { countTasks } from "@/components/workflow/model";
import { problem as recordProblem } from "../edits";

/*
 * The Workflow as the list editor holds it until Save: the record with every change made on it,
 * where the open Tasks at a deleted Step go, the generic Skills to create, and who is to take the
 * Steps (Members given or denied a Skill, Members joining the Project). Every edit is a function
 * of the draft; Save sends all of it in one `PUT …/workflow` (`saveBody`), which makes it in one
 * write. Nothing reaches `/v1` before Save.
 */

/** A generic Skill picked by name before it exists: created on Save, before the Workflow. */
export type NewSkill = { name: string; body: string };

export type Draft = {
  wf: WorkflowRecord;
  /** Where the open Tasks at a deleted Step go: its id to a Step's id. */
  moves: Record<string, string>;
  /** The Skills to create on Save, by the id the draft's Steps carry until then. */
  skills: Record<string, NewSkill>;
  /** The open Tasks each deleted Step held, by its id: what `moves` carries. */
  removed?: Record<string, number>;
  /** The group a new Step is listed in until its Skill places it: the group of the Step it was added after. */
  placed?: Record<string, Group>;
  /** Who takes the Steps, changed: made on Save with the Workflow. */
  people?: People;
};

/** A Member and a Skill: an existing Skill's id, or a new one's `new-skill:<name>`. */
export type Grant = { member: string; skill: string };

/**
 * The changes to who takes the Steps: the Skills given and taken away, and the Members joining the
 * Project to take a Skill's Steps here. Each pair is in at most one list, and nothing undone stays.
 */
export type People = { grants: Grant[]; revokes: Grant[]; joins: string[] };

const noPeople: People = { grants: [], revokes: [], joins: [] };
const sameGrant = (a: Grant, b: Grant) => a.member === b.member && a.skill === b.skill;
const withPeople = (d: Draft, p: People): Draft => ({ ...d, people: p.grants.length || p.revokes.length || p.joins.length ? p : undefined });

/** A Step carries `new-skill:<name>` until Save creates that Skill. */
export const newSkillPrefix = "new-skill:";
export const isNewSkill = (id: string | undefined) => !!id?.startsWith(newSkillPrefix);
export const skillName = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The Skills whose Steps may stand after a Parent, on the line's short branch: the Workflow line's `branchSkills`. */
export const afterParentSkills: readonly string[] = branchSkills;

export type Group = "main" | "after";

/**
 * Which group each Step is listed in: the Workflow line's own rule (`branchSteps`), so the list
 * and the line never disagree. "After a Parent" when it carries acceptance, retro or skill-review
 * and no Step on the main line leads into it; one a main Step leads into stays on the main line.
 */
export function groupsOf(wf: WorkflowRecord, skills: Map<string, Pick<Skill, "name">>, placed: Record<string, Group> = {}): (s: Pick<RecordStep, "id">) => Group {
  const side = branchSteps(asLine(wf, skills));
  const held = new Set(wf.steps.filter((s) => !s.skill_id).map((s) => s.id));
  return (s) => (held.has(s.id) && placed[s.id] ? placed[s.id] : side.has(s.id) ? "after" : "main");
}

/**
 * The record as the Workflow line takes it: Skills by name, a Connector into Done with `to` null;
 * `drawn` names the Workflow the line draws, of a Project of several (every Step when unsaid).
 */
export function asLine(wf: WorkflowRecord, skills: Map<string, Pick<Skill, "name">>, drawn?: string): LineWorkflow {
  return {
    ...(drawn !== undefined ? { drawn } : {}),
    workflows: wf.workflows,
    steps: wf.steps.map((s) => ({ id: s.id, workflow_id: s.workflow_id, name: s.name, position: s.position, ...(s.skill_id ? { skill: { name: skills.get(s.skill_id)?.name ?? "…" } } : {}) })),
    connectors: wf.connectors.map((c) => ({ id: c.id, from: c.from_step_id, to: c.to_step_id ?? null, name: c.name.trim(), position: c.position })),
  };
}

const fresh = () => `${newIdPrefix}${newKey()}`;

/** A named Workflow of the record. */
export type RecordWorkflow = WorkflowRecord["workflows"][number];

/** The Project's Steps in its order: by their Workflow's position, then their own. */
export const inOrder = (wf: Pick<WorkflowRecord, "workflows" | "steps">): RecordStep[] => [...wf.steps].sort(inProjectOrder(wf.workflows));

/** One Workflow's Steps in its order. */
export const stepsIn = (wf: Pick<WorkflowRecord, "workflows" | "steps">, workflowId: string | undefined): RecordStep[] =>
  inOrder(wf).filter((s) => s.workflow_id === workflowId);

/** The Project's Workflows in their order. */
export const workflowsOf = (wf: Pick<WorkflowRecord, "workflows">): RecordWorkflow[] => workflowsInOrder(wf.workflows);

/** Numbers the Steps 1, 2, 3… within each Workflow, in the order given. */
const renumber = (steps: RecordStep[]): RecordStep[] => {
  const n = new Map<string, number>();
  return steps.map((s) => {
    const at = (n.get(s.workflow_id) ?? 0) + 1;
    n.set(s.workflow_id, at);
    return s.position === at ? s : { ...s, position: at };
  });
};

/** The record with one Workflow's Steps put in the order given, numbered 1, 2, 3…; the others as they are. */
function withSteps(wf: WorkflowRecord, workflowId: string, list: RecordStep[]): WorkflowRecord {
  const others = wf.steps.filter((s) => s.workflow_id !== workflowId && !list.some((x) => x.id === s.id));
  const own = list.map((s, i) => ({ ...s, workflow_id: workflowId, position: i + 1 }));
  return { ...wf, steps: renumber(inOrder({ workflows: wf.workflows, steps: [...others, ...own] })) };
}

/** Numbers the Workflows 1, 2, 3… in the order given. */
const renumberWorkflows = (list: RecordWorkflow[]): RecordWorkflow[] => list.map((w, i) => (w.position === i + 1 ? w : { ...w, position: i + 1 }));
const outOf = (wf: WorkflowRecord, id: string) => wf.connectors.filter((c) => c.from_step_id === id).sort((a, b) => a.position - b.position);

/** The first outcome out of a Step: the one its row shows, the one the main line follows. */
export const firstOutcome = (wf: WorkflowRecord, id: string): RecordConnector | undefined => outOf(wf, id)[0];

/** The outcomes out of a Step in the order they are offered. */
export const outcomes = outOf;

export function fromRecord(wf: WorkflowRecord): Draft {
  return { wf, moves: {}, skills: {} };
}

const withWf = (d: Draft, wf: WorkflowRecord): Draft => ({ ...d, wf });

/**
 * A new Step, unnamed, a hold and with no outcome, right after `after` in its Workflow's order (at
 * the end of `workflowId`, else of the Project's first Workflow, with none): placed, not wired. No
 * outcome is pointed into it and none leads out until the admin says so, so a hold that is new
 * reads as Backlog does, moved by hand. It is listed in `group` (the group of the Step it follows)
 * until its Skill places it.
 */
export function insertStep(d: Draft, after: string | undefined, group?: Group, workflowId?: string): { draft: Draft; id: string } {
  const wf = d.wf;
  const prev = after ? wf.steps.find((s) => s.id === after) : undefined;
  // Into the Workflow of the Step it follows; with none, the one named, else the Project's first.
  // A draft of no Workflow has nowhere to put a Step: it is left as it is.
  const into = prev?.workflow_id ?? (workflowId && wf.workflows.some((w) => w.id === workflowId) ? workflowId : workflowsOf(wf)[0]?.id);
  if (!into) return { draft: d, id: "" };
  const order = stepsIn(wf, into);
  const index = prev ? order.findIndex((s) => s.id === prev.id) + 1 : order.length;
  const id = fresh();
  const step: RecordStep = {
    id,
    workflow_id: into,
    name: "",
    position: 0,
    x: prev ? prev.x : 0,
    y: prev ? prev.y : 0,
    tasks: 0,
    working: 0,
    takers: [],
  };
  const placed = group ? { ...d.placed, [id]: group } : d.placed;
  return { draft: { ...d, wf: withSteps(wf, into, [...order.slice(0, index), step, ...order.slice(index)]), placed }, id };
}

/** Makes an outcome the first out of its Step: the main way on, the one the line follows. The others keep their order after it. */
export function makeMain(d: Draft, id: string): Draft {
  const c = d.wf.connectors.find((x) => x.id === id);
  if (!c || firstOutcome(d.wf, c.from_step_id)?.id === id) return d;
  const order = [c, ...outOf(d.wf, c.from_step_id).filter((x) => x.id !== id)];
  const at = new Map(order.map((x, i) => [x.id, i + 1]));
  return withWf(d, { ...d.wf, connectors: d.wf.connectors.map((x) => (at.has(x.id) ? { ...x, position: at.get(x.id)! } : x)) });
}

export function renameStep(d: Draft, id: string, name: string): Draft {
  return withWf(d, { ...d.wf, steps: d.wf.steps.map((s) => (s.id === id ? { ...s, name } : s)) });
}

/**
 * Gives a Step a Skill (an existing one's id, or a new one created on Save), or none: a hold.
 * A new Skill no Step carries any more is not created.
 */
export function setSkill(d: Draft, id: string, skill: { id: string } | { create: NewSkill } | undefined): Draft {
  let skills = d.skills;
  let skillId: string | undefined;
  if (skill && "create" in skill) {
    skillId = `${newSkillPrefix}${skill.create.name}`;
    skills = { ...skills, [skillId]: skill.create };
  } else skillId = skill?.id;
  const steps = d.wf.steps.map((s) => (s.id === id ? { ...s, skill_id: skillId, takers: skillId === s.skill_id ? s.takers : [] } : s));
  const carried = new Set(steps.map((s) => s.skill_id));
  skills = Object.fromEntries(Object.entries(skills).filter(([k]) => carried.has(k)));
  const next = { ...d, wf: { ...d.wf, steps }, skills };
  // Members given a new Skill no Step carries any more are given nothing.
  const dropped = Object.keys(d.skills).filter((k) => !(k in skills));
  return dropped.reduce((x, k) => (x.people?.grants.filter((g) => g.skill === k) ?? []).reduce((y, g) => removeTaker(y, g.member, k), x), next);
}

/**
 * `member` takes the Steps carrying `skill` here: a Skill taken away in the draft is kept; else
 * they are given it, and join the Project first when `join` (they are not in it).
 */
export function addTaker(d: Draft, member: string, skill: string, join: boolean): Draft {
  const p = d.people ?? noPeople;
  const g = { member, skill };
  if (p.revokes.some((x) => sameGrant(x, g))) return withPeople(d, { ...p, revokes: p.revokes.filter((x) => !sameGrant(x, g)) });
  if (p.grants.some((x) => sameGrant(x, g))) return d;
  return withPeople(d, { ...p, grants: [...p.grants, g], joins: join && !p.joins.includes(member) ? [...p.joins, member] : p.joins });
}

/**
 * `member` no longer takes the Steps carrying `skill`: a Skill given in the draft is not given,
 * and a Member who joined only for it does not join; else the Skill is taken from them.
 */
export function removeTaker(d: Draft, member: string, skill: string): Draft {
  const p = d.people ?? noPeople;
  const g = { member, skill };
  if (p.grants.some((x) => sameGrant(x, g))) {
    const grants = p.grants.filter((x) => !sameGrant(x, g));
    const joins = grants.some((x) => x.member === member) ? p.joins : p.joins.filter((m) => m !== member);
    return withPeople(d, { ...p, grants, joins });
  }
  if (p.revokes.some((x) => sameGrant(x, g))) return d;
  return withPeople(d, { ...p, revokes: [...p.revokes, g] });
}

/** Whether `member` is to have `skill` at Save, given whether they have it now. */
export function willHave(d: Draft, member: string, skill: string, has: boolean): boolean {
  const p = d.people ?? noPeople;
  const g = { member, skill };
  return has ? !p.revokes.some((x) => sameGrant(x, g)) : p.grants.some((x) => sameGrant(x, g));
}

/** Whether `member` is to be in the Project at Save, given whether they are now. */
export const willBeIn = (d: Draft, member: string, now: boolean) => now || !!d.people?.joins.includes(member);

/** The draft as `PUT …/workflow` takes it: the Workflow, its new Skills by name, and who takes its Steps. */
export function saveBody(d: Draft): SetWorkflowBody {
  const ref = (skill: string) => (isNewSkill(skill) ? (d.skills[skill]?.name ?? skill.slice(newSkillPrefix.length)) : skill);
  const body = toBody(d.wf, d.moves);
  body.steps = body.steps.map((s) => (s.skill ? { ...s, skill: ref(s.skill) } : s));
  const skills = Object.values(d.skills).map((s) => ({ name: s.name, body: s.body }));
  const p = d.people ?? noPeople;
  const pairs = (gs: Grant[]) => gs.map((g) => ({ member: g.member, skill: ref(g.skill) }));
  return {
    ...body,
    ...(skills.length ? { skills } : {}),
    ...(p.joins.length ? { joins: p.joins } : {}),
    ...(p.grants.length ? { grants: pairs(p.grants) } : {}),
    ...(p.revokes.length ? { revokes: pairs(p.revokes) } : {}),
  };
}

/**
 * Who takes each Skill's Steps at Save: the Project's Members holding it (the Organisation's, for
 * skill-review), after the draft's grants, revokes and joins; humans first, then by name.
 */
export function holdersAt(d: Draft | undefined, roster: Roster | undefined, orgWideSkills: ReadonlySet<string>): Map<string, Holder[]> | undefined {
  if (!roster) return undefined;
  const p = d?.people ?? noPeople;
  const holders = new Map<string, Holder[]>();
  for (const m of roster.members) {
    const skills = new Set(m.skills);
    for (const g of p.revokes) if (g.member === m.id) skills.delete(g.skill);
    for (const g of p.grants) if (g.member === m.id) skills.add(g.skill);
    const inProject = roster.inProject.has(m.id) || p.joins.includes(m.id);
    for (const s of skills) {
      if (!orgWideSkills.has(s) && !inProject) continue;
      holders.set(s, [...(holders.get(s) ?? []), { id: m.id, name: m.name, kind: m.kind }]);
    }
  }
  for (const list of holders.values()) list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "human" ? -1 : 1));
  return holders;
}

/** The changes the draft makes to who takes the Steps, as the header's list says them. */
export function describePeople(d: Draft, memberName: (id: string) => string, skillName: (id: string) => string, project: string): Change[] {
  const p = d.people ?? noPeople;
  return [
    ...p.grants.map((g): Change => ({ kind: "Added", text: `${memberName(g.member)} to ${skillName(g.skill)}${p.joins.includes(g.member) ? `, joins ${project}` : ""}` })),
    ...p.revokes.map((g): Change => ({ kind: "Removed", text: `${memberName(g.member)} from ${skillName(g.skill)}` })),
  ];
}

/** A new outcome out of a Step, unnamed, into Done until a Step is picked. */
export function addOutcome(d: Draft, from: string): { draft: Draft; id: string } {
  const out = outOf(d.wf, from);
  const id = fresh();
  const c: RecordConnector = { id, from_step_id: from, name: "", position: Math.max(0, ...out.map((x) => x.position)) + 1 };
  return { draft: withWf(d, { ...d.wf, connectors: [...d.wf.connectors, c] }), id };
}

export function renameOutcome(d: Draft, id: string, name: string): Draft {
  return withWf(d, { ...d.wf, connectors: d.wf.connectors.map((c) => (c.id === id ? { ...c, name } : c)) });
}

/** Where an outcome leads: a Step's id, or undefined for Done. */
export function setTarget(d: Draft, id: string, to: string | undefined): Draft {
  return withWf(d, { ...d.wf, connectors: d.wf.connectors.map((c) => (c.id === id ? { ...c, to_step_id: to } : c)) });
}

export function removeOutcome(d: Draft, id: string): Draft {
  const gone = d.wf.connectors.find((c) => c.id === id);
  if (!gone) return d;
  const rest = d.wf.connectors.filter((c) => c.id !== id);
  // The outcomes left keep their order, numbered from 1, so the next one becomes the row's first.
  let n = 0;
  const connectors = rest.sort((a, b) => a.position - b.position).map((c) => (c.from_step_id === gone.from_step_id ? { ...c, position: ++n } : c));
  return withWf(d, { ...d.wf, connectors });
}

/** The open Tasks a Step holds at Save: its own, and those moved to it from Steps deleted before it. */
export function tasksAt(d: Draft, id: string): number {
  const own = d.wf.steps.find((s) => s.id === id)?.tasks ?? 0;
  return own + movedInto(d, id);
}

function movedInto(d: Draft, id: string): number {
  return Object.entries(d.moves)
    .filter(([, to]) => to === id)
    .reduce((n, [from]) => n + (d.removed?.[from] ?? 0), 0);
}

/** The outcomes out of other Steps that lead into `id`, in the Project's order of their Steps, then their own. */
export function inbound(wf: WorkflowRecord, id: string): RecordConnector[] {
  const at = new Map(inOrder(wf).map((s, i) => [s.id, i]));
  return wf.connectors
    .filter((c) => c.to_step_id === id && c.from_step_id !== id)
    .sort((a, b) => (at.get(a.from_step_id) ?? 0) - (at.get(b.from_step_id) ?? 0) || a.position - b.position);
}

/** Where each outcome into a deleted Step leads instead, by its id: a Step's id, or undefined for Done. One not named is removed. */
export type Repoint = Record<string, { to: string | undefined }>;

/**
 * Deletes a Step and the outcomes out of it. Each outcome into it from another Step is removed,
 * unless `repoint` leads it elsewhere: nothing is dropped or re-pointed without being asked. Its
 * open Tasks, and any moved to it, go to `moveTo`.
 */
export function deleteStep(d: Draft, id: string, moveTo?: string, repoint: Repoint = {}): Draft {
  const wf = d.wf;
  const step = wf.steps.find((s) => s.id === id);
  if (!step) return d;
  const connectors: RecordConnector[] = [];
  for (const c of wf.connectors) {
    if (c.from_step_id === id) continue;
    if (c.to_step_id !== id) connectors.push(c);
    else if (repoint[c.id] && repoint[c.id].to !== id && repoint[c.id].to !== c.from_step_id) connectors.push({ ...c, to_step_id: repoint[c.id].to });
  }
  let n = 0;
  let last = "";
  const numbered = connectors
    .sort((a, b) => a.from_step_id.localeCompare(b.from_step_id) || a.position - b.position)
    .map((c) => {
      n = c.from_step_id === last ? n + 1 : 1;
      last = c.from_step_id;
      return c.position === n ? c : { ...c, position: n };
    });
  let moves = Object.fromEntries(Object.entries(d.moves).map(([from, to]) => [from, to === id && moveTo ? moveTo : to]));
  if (!isNew(id) && step.tasks > 0 && moveTo) moves = { ...moves, [id]: moveTo };
  const removed = step.tasks > 0 ? { ...d.removed, [id]: step.tasks } : d.removed;
  return {
    ...d,
    wf: { ...wf, steps: renumber(inOrder({ workflows: wf.workflows, steps: wf.steps.filter((s) => s.id !== id) })), connectors: numbered },
    moves,
    removed,
  };
}

/** The Steps carrying a Skill with no outcome: a Task there leaves only when moved by hand. */
export function deadEnds(wf: WorkflowRecord): RecordStep[] {
  return inOrder(wf).filter((s) => s.skill_id && !wf.connectors.some((c) => c.from_step_id === s.id));
}

/** Whether deleting a Step asks first: it holds Tasks, other Steps lead into it, or it leaves one with no way out. */
export function asksBeforeDelete(d: Draft, id: string): boolean {
  return tasksAt(d, id) > 0 || inbound(d.wf, id).length > 0 || deadEndsAfterDelete(d, id).length > 0;
}

/** The Steps deleting `id` leaves with no way out, which had one before. */
export function deadEndsAfterDelete(d: Draft, id: string, repoint: Repoint = {}): RecordStep[] {
  const before = new Set(deadEnds(d.wf).map((s) => s.id));
  return deadEnds(deleteStep(d, id, undefined, repoint).wf).filter((s) => !before.has(s.id));
}

/** One place earlier (-1) or later (+1) among the Steps of its group, in its Workflow's order. */
export function reorderStep(d: Draft, id: string, by: -1 | 1, groups: (s: RecordStep) => Group): Draft {
  const own = d.wf.steps.find((s) => s.id === id);
  if (!own) return d;
  const order = stepsIn(d.wf, own.workflow_id);
  const i = order.findIndex((s) => s.id === id);
  const group = groups(order[i]);
  let j = i + by;
  while (j >= 0 && j < order.length && groups(order[j]) !== group) j += by;
  if (j < 0 || j >= order.length) return d;
  [order[i], order[j]] = [order[j], order[i]];
  return withWf(d, withSteps(d.wf, own.workflow_id, order));
}

/** A Step dragged onto another's place in their Workflow's order: the Steps between shift by one. Not across Workflows. */
export function moveStepTo(d: Draft, id: string, onto: string): Draft {
  const own = d.wf.steps.find((s) => s.id === id);
  if (!own) return d;
  const order = stepsIn(d.wf, own.workflow_id);
  const from = order.findIndex((s) => s.id === id);
  const to = order.findIndex((s) => s.id === onto);
  if (from < 0 || to < 0 || from === to) return d;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return withWf(d, withSteps(d.wf, own.workflow_id, order));
}

/** A Step moved into another Workflow, last there; both Workflows' Steps are numbered again. Its outcomes go with it. */
export function moveStepToWorkflow(d: Draft, id: string, workflowId: string): Draft {
  const own = d.wf.steps.find((s) => s.id === id);
  if (!own || own.workflow_id === workflowId || !d.wf.workflows.some((w) => w.id === workflowId)) return d;
  const from = own.workflow_id;
  const left = withSteps(d.wf, from, stepsIn(d.wf, from).filter((s) => s.id !== id));
  return withWf(d, withSteps(left, workflowId, [...stepsIn(left, workflowId), { ...own, workflow_id: workflowId }]));
}

/** The name a new Workflow is given: the first of "Workflow 2", "Workflow 3"… the Project does not use, ignoring case. */
export function newWorkflowName(wf: Pick<WorkflowRecord, "workflows">): string {
  for (let n = 2; ; n++) {
    const name = `Workflow ${n}`;
    if (!wf.workflows.some((w) => same(w.name, name))) return name;
  }
}

/** A new Workflow, last, with no Step: `newWorkflowName`'s name, until renamed. */
export function addWorkflow(d: Draft): { draft: Draft; id: string } {
  const id = fresh();
  const list = [...workflowsOf(d.wf), { id, name: newWorkflowName(d.wf), position: 0 }];
  return { draft: withWf(d, { ...d.wf, workflows: renumberWorkflows(list) }), id };
}

export function renameWorkflow(d: Draft, id: string, name: string): Draft {
  return withWf(d, { ...d.wf, workflows: d.wf.workflows.map((w) => (w.id === id ? { ...w, name } : w)) });
}

/** One place earlier (-1) or later (+1) among the Workflows. */
export function reorderWorkflow(d: Draft, id: string, by: -1 | 1): Draft {
  const list = workflowsOf(d.wf);
  const i = list.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return d;
  [list[i], list[j]] = [list[j], list[i]];
  return withWf(d, { ...d.wf, workflows: renumberWorkflows(list) });
}

/** A Workflow dragged onto another's place: the Workflows between shift by one. */
export function moveWorkflowTo(d: Draft, id: string, onto: string): Draft {
  const list = workflowsOf(d.wf);
  const from = list.findIndex((w) => w.id === id);
  const to = list.findIndex((w) => w.id === onto);
  if (from < 0 || to < 0 || from === to) return d;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return withWf(d, { ...d.wf, workflows: renumberWorkflows(list) });
}

/**
 * Deletes a Workflow with its Steps, as deleting each of them would (`deleteStep`): the open Tasks
 * at each go to the Step `moves` names for it, and each outcome into them from another Workflow is
 * removed unless `repoint` leads it elsewhere. The last Workflow stays.
 */
export function deleteWorkflow(d: Draft, id: string, moves: Record<string, string> = {}, repoint: Repoint = {}): Draft {
  if (d.wf.workflows.length < 2 || !d.wf.workflows.some((w) => w.id === id)) return d;
  const gone = stepsIn(d.wf, id);
  const out = gone.reduce((x, s) => deleteStep(x, s.id, moves[s.id], repoint), d);
  const placed = out.placed && Object.fromEntries(Object.entries(out.placed).filter(([k]) => !gone.some((s) => s.id === k)));
  return { ...out, placed, wf: { ...out.wf, workflows: renumberWorkflows(workflowsOf(out.wf).filter((w) => w.id !== id)) } };
}

/** The outcomes from other Workflows' Steps that lead into a Workflow's Steps, in the Project's order of their Steps. */
export function inboundWorkflow(wf: WorkflowRecord, id: string): RecordConnector[] {
  const at = new Map(inOrder(wf).map((s, i) => [s.id, i]));
  const own = new Set(stepsIn(wf, id).map((s) => s.id));
  return wf.connectors
    .filter((c) => c.to_step_id && own.has(c.to_step_id) && !own.has(c.from_step_id))
    .sort((a, b) => (at.get(a.from_step_id) ?? 0) - (at.get(b.from_step_id) ?? 0) || a.position - b.position);
}

/** Where an outcome led when the editing began, when it leads elsewhere now: `{ to }`, undefined `to` being Done. */
export function wasTarget(server: WorkflowRecord, c: RecordConnector): { to: string | undefined } | undefined {
  const was = server.connectors.find((x) => x.id === c.id);
  if (!was || was.to_step_id === c.to_step_id) return undefined;
  return { to: was.to_step_id };
}

/** One change the draft makes, as the header's list says it: its kind, then what it changed. */
export type Change = {
  kind: "Added" | "Deleted" | "Renamed" | "Skill" | "Moved" | "Removed" | "Re-pointed" | "Main" | "Workflow added" | "Workflow renamed" | "Workflow deleted" | "Workflows reordered";
  text: string;
};

/**
 * The changes the draft makes to the Workflows it began from: each Workflow added, renamed or
 * deleted, and their order changed (one change); then, in the Project's order of the Steps, each
 * Step added or deleted (with where its Tasks move), renamed, given another Skill, moved into
 * another Workflow, or moved in its Workflow's order (the fewest moves that put it as it is); each
 * outcome added, removed (the outcomes out of a deleted Step go with it; one into it is a change of
 * its own), renamed, pointed elsewhere, or made the main way on.
 */
export function describeChanges(server: WorkflowRecord, draft: WorkflowRecord, moves: Record<string, string> = {}, skillName: (id: string | undefined) => string = (id) => id ?? "hold"): Change[] {
  const out: Change[] = [];
  const name = (id: string | undefined) =>
    id === undefined ? "Done" : (draft.steps.find((s) => s.id === id) ?? server.steps.find((s) => s.id === id))?.name.trim() || "New Step";
  const workflowName = (id: string) => (draft.workflows.find((w) => w.id === id) ?? server.workflows.find((w) => w.id === id))?.name.trim() || "New Workflow";
  // A Workflow deleted and one added under its name, ignoring case, are one Workflow kept: /v1
  // gives the one sent without an id the id of the Workflow named alike. Its Steps are replaced.
  const asServer = sameWorkflows(server, draft);
  const wasW = new Map(server.workflows.map((w) => [w.id, w]));
  const wids = new Set(draft.workflows.map((w) => asServer(w.id)));
  for (const w of workflowsOf(draft)) {
    const before = wasW.get(asServer(w.id));
    if (!before) out.push({ kind: "Workflow added", text: workflowName(w.id) });
    else if (w.name.trim() !== before.name) out.push({ kind: "Workflow renamed", text: `${before.name} → ${workflowName(w.id)}` });
  }
  for (const w of workflowsOf(server).filter((x) => !wids.has(x.id))) out.push({ kind: "Workflow deleted", text: w.name });
  const kept = (list: string[], ids: Set<string>) => list.filter((id) => ids.has(id));
  const keptNow = kept(
    workflowsOf(draft).map((w) => asServer(w.id)),
    new Set(wasW.keys()),
  );
  if (keptNow.join() !== kept(workflowsOf(server).map((w) => w.id), wids).join()) out.push({ kind: "Workflows reordered", text: workflowsOf(draft).map((w) => workflowName(w.id)).join(", ") });

  const was = new Map(server.steps.map((s) => [s.id, s]));
  const ids = new Set(draft.steps.map((s) => s.id));
  const moved = reordered(server, draft);
  for (const s of inOrder(draft)) {
    const w = was.get(s.id);
    if (!w) out.push({ kind: "Added", text: name(s.id) });
    else {
      if (s.name.trim() !== w.name) out.push({ kind: "Renamed", text: `${w.name} → ${s.name.trim() || "New Step"}` });
      if (s.skill_id !== w.skill_id) out.push({ kind: "Skill", text: `${name(s.id)} · ${skillName(w.skill_id)} → ${skillName(s.skill_id)}` });
      if (asServer(s.workflow_id) !== w.workflow_id) out.push({ kind: "Moved", text: `${name(s.id)} to ${workflowName(s.workflow_id)}` });
      else if (moved.has(s.id)) out.push({ kind: "Moved", text: name(s.id) });
    }
  }
  for (const s of inOrder(server).filter((x) => !ids.has(x.id))) {
    const to = moves[s.id];
    out.push({ kind: "Deleted", text: s.tasks > 0 && to ? `${s.name} · its ${countTasks(s.tasks)} move to ${name(to)}` : s.name });
  }
  const wasC = new Map(server.connectors.map((c) => [c.id, c]));
  const way = (c: RecordConnector, to = c.to_step_id) => `${name(c.from_step_id)} · ${c.name.trim() || "outcome"} → ${name(to)}`;
  for (const c of draft.connectors) {
    const w = wasC.get(c.id);
    if (!w) {
      out.push({ kind: "Added", text: way(c) });
      continue;
    }
    if (c.name.trim() !== w.name) out.push({ kind: "Renamed", text: `${name(c.from_step_id)} · ${w.name} → ${c.name.trim() || "outcome"}` });
    if (c.to_step_id !== w.to_step_id) out.push({ kind: "Re-pointed", text: `${way(c)} (was ${name(w.to_step_id)})` });
  }
  const cids = new Set(draft.connectors.map((c) => c.id));
  // An outcome out of a deleted Step goes with it; one into it, out of a Step kept, is a change of its own.
  for (const c of server.connectors) if (!cids.has(c.id) && ids.has(c.from_step_id)) out.push({ kind: "Removed", text: way(c) });
  for (const s of draft.steps) {
    const first = firstOutcome(draft, s.id);
    const before = firstOutcome(server, s.id);
    if (first && before && first.id !== before.id && cids.has(before.id) && wasC.has(first.id)) out.push({ kind: "Main", text: way(first) });
  }
  return out;
}

/**
 * The id /v1 will give each of the draft's Workflows, as far as it is known now: a Workflow sent
 * without an id takes that of the Workflow named alike, ignoring case, that the draft no longer
 * carries; any other keeps its own.
 */
function sameWorkflows(server: WorkflowRecord, draft: WorkflowRecord): (id: string) => string {
  const carried = new Set(draft.workflows.map((w) => w.id));
  const free = server.workflows.filter((w) => !carried.has(w.id));
  const out = new Map<string, string>();
  for (const w of draft.workflows) {
    if (server.workflows.some((x) => x.id === w.id)) continue;
    const alike = free.find((x) => same(x.name, w.name) && ![...out.values()].includes(x.id));
    if (alike) out.set(w.id, alike.id);
  }
  return (id) => out.get(id) ?? id;
}

/**
 * Where New Tasks will start once the draft is saved, when that is not where they start now: "New
 * Tasks start at Investigate", or that no Step is left for them; undefined when it stays.
 */
export function startMoves(server: WorkflowRecord, draft: WorkflowRecord, skills: Map<string, Pick<Skill, "name">>): string | undefined {
  const was = lineTopology(asLine(server, skills)).start;
  const is = lineTopology(asLine(draft, skills)).start;
  if (was === is) return undefined;
  const step = is && draft.steps.find((s) => s.id === is);
  return step ? `New Tasks start at ${step.name.trim() || "New Step"}` : "No Step is left where New Tasks start";
}

/** How many changes the draft makes to the Workflow it began from: `describeChanges`, counted. */
export function countChanges(server: WorkflowRecord, draft: WorkflowRecord): number {
  return describeChanges(server, draft).length;
}

/**
 * The Steps moved within their Workflow that turn its old order of the Steps it kept into the new:
 * the fewest, those off the longest run kept in order. A Step moved into another Workflow is not
 * one of them; that move is a change of its own.
 */
function reordered(server: WorkflowRecord, draft: WorkflowRecord): Set<string> {
  const out = new Set<string>();
  for (const w of draft.workflows) for (const id of reorderedIn(server, draft, w.id)) out.add(id);
  return out;
}

function reorderedIn(server: WorkflowRecord, draft: WorkflowRecord, workflowId: string): Set<string> {
  const ids = new Set(stepsIn(draft, workflowId).map((s) => s.id));
  const old = new Map(
    stepsIn(server, workflowId)
      .filter((s) => ids.has(s.id))
      .map((s, i) => [s.id, i]),
  );
  const seq = stepsIn(draft, workflowId).filter((s) => old.has(s.id));
  // The longest run in order (patience sorting), kept with links back to rebuild it.
  const tails: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < seq.length; i++) {
    const x = old.get(seq[i].id)!;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (old.get(seq[tails[mid]].id)! < x) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const kept = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) kept.add(seq[i].id);
  return new Set(seq.filter((s) => !kept.has(s.id)).map((s) => s.id));
}

/**
 * What Save would be refused, in words, before anything is sent; undefined when nothing. The
 * shipped editor's checks (edits.ts `problem`) against the Workflow the editing began from, then
 * the new Skills' names.
 */
export function problem(d: Draft, server: WorkflowRecord, skills: Pick<Skill, "name">[]): string | undefined {
  const p = recordProblem(d.wf, server, d.moves);
  if (p) return p;
  for (const s of Object.values(d.skills)) {
    if (!skillName.test(s.name)) return `A Skill's name is lower-case letters, digits and dashes: ${s.name} is not.`;
    if (skills.some((x) => same(x.name, s.name))) return `There is a Skill called ${s.name} already: pick it instead.`;
  }
  return undefined;
}
