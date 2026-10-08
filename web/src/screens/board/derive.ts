// What the Tasks screens compute from /v1 records: the Workflow's order, where each Task stands
// (a Step, with a Member, or ended), the order and grouping of the list, the board's columns, the
// marks a row or card carries, who may move a Task by hand and what a refused move says. Pure, so
// Vitest checks them without rendering.
import type { Connector, Label, Member, Project, Task, TaskBrief, WorkflowStep } from "@/api/client";
import type { ClaimTrail } from "@/components/filters/taskAxes";
import { isOnReportingLine } from "@/me";
import { kindLabel, liveClaim } from "@/work";

/** The builtin Skills Darkory files its own Subtasks at: never where a Task lands by default. */
export const ownSubtaskSkills = ["breakdown", "acceptance", "retro", "skill-review"] as const;

export function stepsInOrder<S extends Pick<WorkflowStep, "position">>(steps: readonly S[]): S[] {
  return [...steps].sort((a, b) => a.position - b.position);
}

/**
 * The Step a Task filed without one starts at, as `/v1` chooses it: the first Step carrying a
 * Skill other than those Darkory files its own Subtasks at (Build in the default Workflow); else
 * the first Step carrying any Skill; else the first Step. None in a Workflow with no Steps.
 */
export function defaultFileStep<S extends Pick<WorkflowStep, "position" | "skill_id">>(
  steps: readonly S[],
  skillName: (id: string) => string | undefined,
): S | undefined {
  const ordered = stepsInOrder(steps);
  const own: readonly string[] = ownSubtaskSkills;
  return (
    ordered.find((s) => s.skill_id && !own.includes(skillName(s.skill_id) ?? "")) ??
    ordered.find((s) => s.skill_id) ??
    ordered[0]
  );
}

/** The Step carrying the builtin Skill `name` (breakdown, acceptance, retro), if the Workflow has one. */
export function stepWithSkill<S extends Pick<WorkflowStep, "position" | "skill_id">>(
  steps: readonly S[],
  name: string,
  skillName: (id: string) => string | undefined,
): S | undefined {
  return stepsInOrder(steps).find((s) => s.skill_id && skillName(s.skill_id) === name);
}

/** Whether the Task has Subtasks: a Parent, at no Step, never claimed. */
export function isParent(task: Pick<Task, "subtask_counts">): boolean {
  return !!task.subtask_counts;
}

/** "3/5": a Parent's Subtasks done out of those not dropped. */
export function progressText(counts: NonNullable<Task["subtask_counts"]>): string {
  return `${counts.done}/${counts.open + counts.done}`;
}

/**
 * Where a Task stands, as the list's groups and the board's columns read it:
 *
 * - `step`: an open Task at a Step;
 * - `with`: an open Task aimed at a Member by name, waiting with them at no Step;
 * - `done` and `dropped`: ended;
 * - an open Parent stands where its least advanced open Subtask does, in the Workflow's order (a
 *   Subtask aimed at a Member counting after every Step); with none open, it waits with its
 *   Owner, whose Complete ends it.
 */
export type Place = { kind: "step"; stepId: string } | { kind: "with"; memberId: string } | { kind: "done" } | { kind: "dropped" };

export function placeOf(task: Task, ctx: { children: Map<string, Task[]>; position: Map<string, number> }): Place {
  if (task.state !== "open") return { kind: task.state };
  if (isParent(task)) {
    const open = (ctx.children.get(task.id) ?? []).filter((s) => s.state === "open");
    const atSteps = open.filter((s) => s.step_id && ctx.position.has(s.step_id));
    if (atSteps.length > 0) {
      const first = atSteps.reduce((a, b) => (ctx.position.get(b.step_id!)! < ctx.position.get(a.step_id!)! ? b : a));
      return { kind: "step", stepId: first.step_id! };
    }
    const aimed = open.find((s) => s.aimed_at_id);
    if (aimed) return { kind: "with", memberId: aimed.aimed_at_id! };
    return { kind: "with", memberId: task.owner_id };
  }
  if (task.step_id) return { kind: "step", stepId: task.step_id };
  if (task.aimed_at_id) return { kind: "with", memberId: task.aimed_at_id };
  // An open Task at no Step and aimed at no one does not arise; it waits with its Owner.
  return { kind: "with", memberId: task.owner_id };
}

export function placeKey(p: Place): string {
  return p.kind === "step" ? `step:${p.stepId}` : p.kind === "with" ? `with:${p.memberId}` : p.kind;
}

/** Each Parent's Subtasks, by the Parent's id, in the order given. */
export function childrenOf(tasks: readonly Task[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parent_id) continue;
    const list = out.get(t.parent_id);
    if (list) list.push(t);
    else out.set(t.parent_id, [t]);
  }
  return out;
}

export type Order = "rank" | "updated" | "filed";

const time = (at: string | undefined) => (at ? Date.parse(at) : 0);
const keyNumber = (key: string) => Number(key.slice(key.lastIndexOf("-") + 1)) || 0;

/** When the Task last changed as the list can tell: it ended, reached its Step, or was filed. */
export function updatedAt(task: Pick<Task, "ended_at" | "step_since" | "waiting_since" | "created_at">): string {
  const times = [task.ended_at, task.step_since, task.waiting_since, task.created_at].filter((t): t is string => !!t);
  return times.reduce((a, b) => (time(b) > time(a) ? b : a));
}

/**
 * Orders Tasks for a list or a column: by Rank (a Subtask by its Parent's, then after its Parent,
 * then by how long it has waited), by when it last changed (newest first), or by when it was filed
 * (newest first). Ties go to the older key.
 */
export function compareTasks(order: Order, rankOf: (task: Task) => number) {
  return (a: Task, b: Task): number => {
    let first: number;
    if (order === "rank") {
      first = rankOf(a) - rankOf(b) || Number(!!a.parent_id) - Number(!!b.parent_id) || time(a.waiting_since) - time(b.waiting_since);
    } else if (order === "updated") first = time(updatedAt(b)) - time(updatedAt(a));
    else first = time(b.created_at) - time(a.created_at);
    return first || keyNumber(a.key) - keyNumber(b.key);
  };
}

/** A Task's place in its Project's Rank: its own, or for a Subtask its Parent's. */
export function rankFinder(byId: Map<string, Task>): (task: Task) => number {
  return (t) => (t.parent_id ? byId.get(t.parent_id)?.rank : t.rank) ?? Number.MAX_SAFE_INTEGER;
}

export type GroupBy = "step" | "parent" | "owner" | "label" | "none";

export type Display = {
  group: GroupBy;
  order: Order;
  showDone: boolean;
  showDropped: boolean;
  /** The list: a Parent's row opens to its Subtasks. */
  showSubtasks: boolean;
  /** The board: Parents as cards, where their least advanced open Subtask stands. */
  showParents: boolean;
};

export const defaultDisplay: Display = { group: "step", order: "rank", showDone: true, showDropped: false, showSubtasks: true, showParents: false };

export type Group =
  | { by: "step"; id: string; step: WorkflowStep; tasks: Task[] }
  | { by: "with"; id: string; member: Member | undefined; memberId: string; tasks: Task[] }
  | { by: "ended"; id: "done" | "dropped"; state: "done" | "dropped"; tasks: Task[] }
  | { by: "parent"; id: string; parent: Task | undefined; tasks: Task[] }
  | { by: "owner"; id: string; owner: Member | undefined; tasks: Task[] }
  | { by: "label"; id: string; label: Label | undefined; tasks: Task[] }
  | { by: "none"; id: "all"; tasks: Task[] };

export type GroupContext = {
  steps: readonly WorkflowStep[];
  children: Map<string, Task[]>;
  members: Map<string, Member>;
  labels: Map<string, Label>;
  byId: Map<string, Task>;
};

function bucket<K>(tasks: readonly Task[], keyOf: (t: Task) => K): Map<K, Task[]> {
  const out = new Map<K, Task[]>();
  for (const t of tasks) {
    const k = keyOf(t);
    const list = out.get(k);
    if (list) list.push(t);
    else out.set(k, [t]);
  }
  return out;
}

const byName = (m: Map<string, { name: string }>, id: string) => m.get(id)?.name ?? "";

/**
 * Groups the rows of the list, already in order, keeping that order inside each group; empty
 * groups are left out.
 *
 * - `step` (the rows: Tasks with no Parent): the Steps in the Workflow's order, then "With
 *   <Member>" by name, then Done and Dropped, each Task where `placeOf` says it stands;
 * - `parent` (the rows: Subtasks and Tasks with no Parent and no Subtasks): a group per Parent in
 *   Rank order, its Subtasks under it, then the Tasks with none;
 * - `owner`: by the Owner's name; `label`: by the first Label a Task carries, by name, then those
 *   carrying none; `none`: one group.
 */
export function groupTasks(rows: readonly Task[], by: GroupBy, ctx: GroupContext): Group[] {
  if (by === "none") return rows.length ? [{ by, id: "all", tasks: [...rows] }] : [];
  if (by === "step") {
    const position = new Map(ctx.steps.map((s) => [s.id, s.position]));
    const places = bucket(rows, (t) => placeKey(placeOf(t, { children: ctx.children, position })));
    const groups: Group[] = [];
    for (const s of stepsInOrder(ctx.steps)) {
      const tasks = places.get(`step:${s.id}`);
      if (tasks) groups.push({ by: "step", id: s.id, step: s, tasks });
    }
    const withIds = [...places.keys()].filter((k) => k.startsWith("with:")).map((k) => k.slice(5));
    withIds.sort((a, b) => byName(ctx.members, a).localeCompare(byName(ctx.members, b)));
    for (const id of withIds) groups.push({ by: "with", id, memberId: id, member: ctx.members.get(id), tasks: places.get(`with:${id}`)! });
    for (const state of ["done", "dropped"] as const) {
      const tasks = places.get(state);
      if (tasks) groups.push({ by: "ended", id: state, state, tasks });
    }
    return groups;
  }
  if (by === "parent") {
    const parents = bucket(rows, (t) => t.parent_id ?? "");
    const ids = [...parents.keys()].filter((k) => k !== "");
    ids.sort((a, b) => (ctx.byId.get(a)?.rank ?? Infinity) - (ctx.byId.get(b)?.rank ?? Infinity));
    const groups: Group[] = ids.map((id) => ({ by: "parent", id, parent: ctx.byId.get(id), tasks: parents.get(id)! }));
    if (parents.has("")) groups.push({ by: "parent", id: "", parent: undefined, tasks: parents.get("")! });
    return groups;
  }
  if (by === "owner") {
    const owners = bucket(rows, (t) => t.owner_id);
    const ids = [...owners.keys()].sort((a, b) => byName(ctx.members, a).localeCompare(byName(ctx.members, b)));
    return ids.map((id) => ({ by: "owner", id, owner: ctx.members.get(id), tasks: owners.get(id)! }));
  }
  const firstLabel = (t: Task) =>
    (t.labels ?? []).filter((id) => ctx.labels.has(id)).sort((a, b) => byName(ctx.labels, a).localeCompare(byName(ctx.labels, b)))[0] ?? "";
  const labelled = bucket(rows, firstLabel);
  const ids = [...labelled.keys()].filter((k) => k !== "").sort((a, b) => byName(ctx.labels, a).localeCompare(byName(ctx.labels, b)));
  const groups: Group[] = ids.map((id) => ({ by: "label", id, label: ctx.labels.get(id), tasks: labelled.get(id)! }));
  if (labelled.has("")) groups.push({ by: "label", id: "", label: undefined, tasks: labelled.get("")! });
  return groups;
}

/**
 * The rows of the list for a grouping: by Parent, the Tasks that are worked (Subtasks, and Tasks
 * with neither Parent nor Subtasks), each under its Parent's group; otherwise the Tasks with no
 * Parent, a Parent's Subtasks opening under its row. Done and Dropped as the Display says.
 */
export function listRows(tasks: readonly Task[], display: Pick<Display, "group" | "showDone" | "showDropped">): Task[] {
  return tasks.filter((t) => {
    if (t.state === "done" && !display.showDone) return false;
    if (t.state === "dropped" && !display.showDropped) return false;
    return display.group === "parent" ? !isParent(t) : !t.parent_id;
  });
}

/** A column of the board: a Step (a drop target), a Member some Tasks are aimed at, Done or Dropped. */
export type Column =
  | { kind: "step"; id: string; step: WorkflowStep; tasks: Task[] }
  | { kind: "with"; id: string; memberId: string; member: Member | undefined; tasks: Task[] }
  | { kind: "done" | "dropped"; id: "done" | "dropped"; tasks: Task[]; collapsed: boolean };

/**
 * The board's columns: every Step in the Workflow's order (empty ones too, so a card can be
 * dragged there), then "With <Member>" for each Member an open card is aimed at, then Done, then
 * Dropped, each collapsed to its header unless the Display shows it. The cards are the Tasks with
 * no Subtasks; Parents, when the Display shows them, stand where `placeOf` says.
 */
export function boardColumns(
  tasks: readonly Task[],
  ctx: Pick<GroupContext, "steps" | "children" | "members"> & { display: Pick<Display, "showDone" | "showDropped" | "showParents"> },
): Column[] {
  const position = new Map(ctx.steps.map((s) => [s.id, s.position]));
  const cards = tasks.filter((t) => !isParent(t) || ctx.display.showParents);
  const places = bucket(cards, (t) => placeKey(placeOf(t, { children: ctx.children, position })));
  const columns: Column[] = stepsInOrder(ctx.steps).map((s) => ({ kind: "step", id: s.id, step: s, tasks: places.get(`step:${s.id}`) ?? [] }));
  const withIds = [...places.keys()].filter((k) => k.startsWith("with:")).map((k) => k.slice(5));
  withIds.sort((a, b) => byName(ctx.members, a).localeCompare(byName(ctx.members, b)));
  for (const id of withIds) columns.push({ kind: "with", id: `with:${id}`, memberId: id, member: ctx.members.get(id), tasks: places.get(`with:${id}`)! });
  columns.push({ kind: "done", id: "done", tasks: places.get("done") ?? [], collapsed: !ctx.display.showDone });
  columns.push({ kind: "dropped", id: "dropped", tasks: places.get("dropped") ?? [], collapsed: !ctx.display.showDropped });
  return columns;
}

/** The open Tasks each Task blocks, read off the `open_blockers` of the Tasks in view. */
export function blocking(tasks: readonly Task[]): Map<string, TaskBrief[]> {
  const out = new Map<string, TaskBrief[]>();
  for (const t of tasks) {
    if (t.state !== "open") continue;
    for (const b of t.open_blockers ?? []) {
      const list = out.get(b.id);
      const brief = { id: t.id, key: t.key, title: t.title };
      if (list) list.push(brief);
      else out.set(b.id, [brief]);
    }
  }
  return out;
}

export type Mark = { kind: "blocked"; by: string } | { kind: "lapsed"; at: string } | { kind: "task-kind"; label: string };

/** The marks a Task carries, most pressing first: a card shows the first, a row all of them. */
export function marksOf(task: Task, trail: ClaimTrail | undefined, now: number): Mark[] {
  const marks: Mark[] = [];
  if (task.state === "open" && task.blocked) marks.push({ kind: "blocked", by: task.open_blockers?.[0]?.key ?? "" });
  if (task.state === "open" && !liveClaim(task, now) && trail?.lapsedAt) marks.push({ kind: "lapsed", at: trail.lapsedAt });
  const label = kindLabel(task);
  if (label) marks.push({ kind: "task-kind", label });
  return marks;
}

/**
 * Who may take back a Claim: the Task's Owner, or a Member above the holder on the holder's
 * Reporting line, at any distance. The holder releases instead.
 */
export function canTakeBack(members: Map<string, Member>, me: string, holder: string, owner: string): boolean {
  if (me === holder) return false;
  return me === owner || isOnReportingLine(members, me, holder);
}

export type MoveContext = {
  me: string;
  /** The Projects the signed-in Member is in. */
  projects: readonly Pick<Project, "id">[];
  members: Map<string, Member>;
  now: number;
};

/**
 * Why `me` may not move the Task to a Step by hand, in words, before anything is sent; undefined
 * when `/v1` would take the move. A Member of the Project or the Owner moves an open Task that is
 * not a Parent; a held one only whoever may take it back, which ends the Claim.
 */
export function moveProblem(task: Task, ctx: MoveContext & { projectName: string }): string | undefined {
  if (task.state !== "open") return `${task.key} has ended and stays where it is.`;
  if (isParent(task)) return `${task.key} is a Parent: it stands at no Step, its Subtasks do.`;
  const inProject = ctx.projects.some((p) => p.id === task.project_id);
  if (!inProject && task.owner_id !== ctx.me) return `Only Members of ${ctx.projectName} or the Owner move ${task.key}.`;
  const claim = liveClaim(task, ctx.now);
  if (claim && !canTakeBack(ctx.members, ctx.me, claim.holder_id, task.owner_id)) {
    const holder = ctx.members.get(claim.holder_id)?.name ?? "its holder";
    const owner = ctx.members.get(task.owner_id)?.name;
    return `${holder} holds ${task.key}: only the Owner${owner ? `, ${owner},` : ""} or someone above ${holder} moves it.`;
  }
  return undefined;
}

/** Whether moving the Task ends someone's Claim: it is held, and the mover may take it back. */
export function moveEndsClaim(task: Task, now: number): string | undefined {
  return liveClaim(task, now)?.holder_id;
}

/** What a board says when a card is dropped where `/v1` will not put it, before anything is sent. */
export function dropProblem(task: Pick<Task, "key">, column: Column, holds: boolean): string | undefined {
  if (column.kind === "done") {
    return holds
      ? `Advance ${task.key} into Done from its page, or complete it.`
      : `Done is reached by its holder advancing ${task.key}, or by its Owner completing a Parent.`;
  }
  if (column.kind === "dropped") return `Only the Owner drops ${task.key}, from its page.`;
  if (column.kind === "with") return `${task.key} is aimed at a Member when it is filed as a question, not by a drag.`;
  return undefined;
}

/** Words for a move `/v1` refused, by its stable code. */
export function refusalText(code: string, ctx: { task: Pick<Task, "key">; to: string; projectName: string; message: string }): string {
  const key = ctx.task.key;
  switch (code) {
    case "held":
      return `Someone else holds ${key} now: only the Owner or someone above its holder moves it.`;
    case "conflict":
      return `${key} became a Parent: its Subtasks stand at Steps, it does not.`;
    case "ended":
      return `${key} has ended and stays where it is.`;
    case "forbidden":
      return `Only Members of ${ctx.projectName} or the Owner move ${key}.`;
    case "not_found":
      return `${ctx.to} is no longer a Step of this Workflow.`;
    default:
      return ctx.message;
  }
}

/** The Connectors out of a Step, in their order. */
export function connectorsFrom(connectors: readonly Connector[], stepId: string | undefined): Connector[] {
  return connectors.filter((c) => c.from_step_id === stepId).sort((a, b) => a.position - b.position);
}

/** A group's id among the list's folded groups: Done and Dropped are the same group under any Step grouping. */
export function groupKey(g: Group): string {
  return g.by === "ended" ? g.id : `${g.by}:${g.id}`;
}

/** A board column's name: its Step's, "With <Member>", Done or Dropped. */
export function columnName(c: Column, model: { members: Map<string, Member> }): string {
  switch (c.kind) {
    case "step":
      return c.step.name;
    case "with":
      return `With ${c.member?.name ?? model.members.get(c.memberId)?.name ?? "a Member"}`;
    case "done":
      return "Done";
    case "dropped":
      return "Dropped";
  }
}
