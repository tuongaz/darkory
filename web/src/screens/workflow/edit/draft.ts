import type { Skill } from "@/api/client";
import { newKey } from "@/api/client";
import { branchSkills, branchSteps, type LineWorkflow } from "@/components/workflowLine/model";
import { isNew, newIdPrefix, same, type RecordConnector, type RecordStep, type WorkflowRecord } from "../bind";
import { countTasks } from "@/components/workflow/model";
import { problem as recordProblem } from "../edits";

/*
 * The Workflow as the list editor holds it until Save: the record with every change made on it,
 * where the open Tasks at a deleted Step go, and the generic Skills to create first. Every edit is
 * a function of the draft; Save creates the new Skills, then sends the whole Workflow in one
 * `PUT …/workflow` (bind.ts `toBody`). Nothing reaches `/v1` before Save.
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
};

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

/** The record as the Workflow line takes it: Skills by name, a Connector into Done with `to` null. */
export function asLine(wf: WorkflowRecord, skills: Map<string, Pick<Skill, "name">>): LineWorkflow {
  return {
    steps: wf.steps.map((s) => ({ id: s.id, name: s.name, position: s.position, ...(s.skill_id ? { skill: { name: skills.get(s.skill_id)?.name ?? "…" } } : {}) })),
    connectors: wf.connectors.map((c) => ({ id: c.id, from: c.from_step_id, to: c.to_step_id ?? null, name: c.name.trim(), position: c.position })),
  };
}

const fresh = () => `${newIdPrefix}${newKey()}`;
export const inOrder = (steps: RecordStep[]) => [...steps].sort((a, b) => a.position - b.position);
const renumber = (steps: RecordStep[]) => steps.map((s, i) => (s.position === i + 1 ? s : { ...s, position: i + 1 }));
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
 * A new Step, unnamed, a hold and with no outcome, right after `after` in the Workflow's order (last
 * with none): placed, not wired. No outcome is pointed into it and none leads out until the admin
 * says so, so a hold that is new reads as Backlog does, moved by hand. It is listed in `group`
 * (the group of the Step it follows) until its Skill places it.
 */
export function insertStep(d: Draft, after: string | undefined, group?: Group): { draft: Draft; id: string } {
  const wf = d.wf;
  const order = inOrder(wf.steps);
  const index = after ? order.findIndex((s) => s.id === after) + 1 : order.length;
  const prev = after ? order[index - 1] : undefined;
  const id = fresh();
  const step: RecordStep = {
    id,
    name: "",
    position: 0,
    x: prev ? prev.x : 0,
    y: prev ? prev.y : 0,
    tasks: 0,
    working: 0,
    takers: [],
  };
  const steps = renumber([...order.slice(0, index), step, ...order.slice(index)]);
  const placed = group ? { ...d.placed, [id]: group } : d.placed;
  return { draft: { ...d, wf: { ...wf, steps }, placed }, id };
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
  return { ...d, wf: { ...d.wf, steps }, skills };
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

/** The outcomes out of other Steps that lead into `id`, in the Workflow's order of their Steps, then their own. */
export function inbound(wf: WorkflowRecord, id: string): RecordConnector[] {
  const at = new Map(inOrder(wf.steps).map((s, i) => [s.id, i]));
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
    wf: { ...wf, steps: renumber(inOrder(wf.steps.filter((s) => s.id !== id))), connectors: numbered },
    moves,
    removed,
  };
}

/** The Steps carrying a Skill with no outcome: a Task there leaves only when moved by hand. */
export function deadEnds(wf: WorkflowRecord): RecordStep[] {
  return inOrder(wf.steps).filter((s) => s.skill_id && !wf.connectors.some((c) => c.from_step_id === s.id));
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

/** One place earlier (-1) or later (+1) among the Steps of its group, in the Workflow's order. */
export function reorderStep(d: Draft, id: string, by: -1 | 1, groups: (s: RecordStep) => Group): Draft {
  const order = inOrder(d.wf.steps);
  const i = order.findIndex((s) => s.id === id);
  if (i < 0) return d;
  const group = groups(order[i]);
  let j = i + by;
  while (j >= 0 && j < order.length && groups(order[j]) !== group) j += by;
  if (j < 0 || j >= order.length) return d;
  [order[i], order[j]] = [order[j], order[i]];
  return withWf(d, { ...d.wf, steps: renumber(order) });
}

/** A Step dragged onto another's place in the Workflow's order: the Steps between shift by one. */
export function moveStepTo(d: Draft, id: string, onto: string): Draft {
  const order = inOrder(d.wf.steps);
  const from = order.findIndex((s) => s.id === id);
  const to = order.findIndex((s) => s.id === onto);
  if (from < 0 || to < 0 || from === to) return d;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return withWf(d, { ...d.wf, steps: renumber(order) });
}

/** Where an outcome led when the editing began, when it leads elsewhere now: `{ to }`, undefined `to` being Done. */
export function wasTarget(server: WorkflowRecord, c: RecordConnector): { to: string | undefined } | undefined {
  const was = server.connectors.find((x) => x.id === c.id);
  if (!was || was.to_step_id === c.to_step_id) return undefined;
  return { to: was.to_step_id };
}

/** One change the draft makes, as the header's list says it: its kind, then what it changed. */
export type Change = { kind: "Added" | "Deleted" | "Renamed" | "Skill" | "Moved" | "Removed" | "Re-pointed" | "Main"; text: string };

/**
 * The changes the draft makes to the Workflow it began from, in the order of the Steps: each Step
 * added or deleted (with where its Tasks move), renamed, given another Skill or moved in the order
 * (the fewest moves that put it as it is); each outcome added, removed (the outcomes out of a
 * deleted Step go with it; one into it is a change of its own), renamed, pointed elsewhere, or made
 * the main way on.
 */
export function describeChanges(server: WorkflowRecord, draft: WorkflowRecord, moves: Record<string, string> = {}, skillName: (id: string | undefined) => string = (id) => id ?? "hold"): Change[] {
  const out: Change[] = [];
  const name = (id: string | undefined) =>
    id === undefined ? "Done" : (draft.steps.find((s) => s.id === id) ?? server.steps.find((s) => s.id === id))?.name.trim() || "New Step";
  const was = new Map(server.steps.map((s) => [s.id, s]));
  const ids = new Set(draft.steps.map((s) => s.id));
  const moved = reordered(server, draft);
  for (const s of inOrder(draft.steps)) {
    const w = was.get(s.id);
    if (!w) out.push({ kind: "Added", text: name(s.id) });
    else {
      if (s.name.trim() !== w.name) out.push({ kind: "Renamed", text: `${w.name} → ${s.name.trim() || "New Step"}` });
      if (s.skill_id !== w.skill_id) out.push({ kind: "Skill", text: `${name(s.id)} · ${skillName(w.skill_id)} → ${skillName(s.skill_id)}` });
      if (moved.has(s.id)) out.push({ kind: "Moved", text: name(s.id) });
    }
  }
  for (const s of inOrder(server.steps).filter((x) => !ids.has(x.id))) {
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

/** How many changes the draft makes to the Workflow it began from: `describeChanges`, counted. */
export function countChanges(server: WorkflowRecord, draft: WorkflowRecord): number {
  return describeChanges(server, draft).length;
}

/** The Steps moved that turn the old order of the Steps kept into the new: the fewest, those off the longest run kept in order. */
function reordered(server: WorkflowRecord, draft: WorkflowRecord): Set<string> {
  const ids = new Set(draft.steps.map((s) => s.id));
  const old = new Map(
    inOrder(server.steps)
      .filter((s) => ids.has(s.id))
      .map((s, i) => [s.id, i]),
  );
  const seq = inOrder(draft.steps).filter((s) => old.has(s.id));
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
