import type { Skill } from "@/api/client";
import { newKey } from "@/api/client";
import { isNew, newIdPrefix, same, type RecordConnector, type RecordStep, type WorkflowRecord } from "../bind";
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
};

/** A Step carries `new-skill:<name>` until Save creates that Skill. */
export const newSkillPrefix = "new-skill:";
export const isNewSkill = (id: string | undefined) => !!id?.startsWith(newSkillPrefix);
export const skillName = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The builtin Skills whose Steps stand after a Parent, on the line's short branch, not on the main line. */
export const afterParentSkills = ["acceptance", "retro", "skill-review"] as const;

export type Group = "main" | "after";

/** Which group a Step is listed in: "After a Parent" when it carries acceptance, retro or skill-review. */
export function groupOf(step: Pick<RecordStep, "skill_id">, skills: Map<string, Pick<Skill, "name" | "builtin">>): Group {
  const skill = step.skill_id ? skills.get(step.skill_id) : undefined;
  return skill?.builtin && (afterParentSkills as readonly string[]).includes(skill.name) ? "after" : "main";
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
 * A new Step, unnamed and a hold, right after `after` in the Workflow's order (last with none).
 * `after`'s first outcome now leads into it, and it leads on with "pass" to where that outcome
 * led; when `after` has no outcome, the new Step leads on to the next Step of its group, or Done.
 */
export function insertStep(d: Draft, after: string | undefined, groups?: (s: RecordStep) => Group): { draft: Draft; id: string } {
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
  let connectors = wf.connectors;
  const first = prev && firstOutcome(wf, prev.id);
  let onTo: string | undefined;
  if (first) {
    onTo = first.to_step_id;
    connectors = connectors.map((c) => (c.id === first.id ? { ...c, to_step_id: id } : c));
  } else if (prev) {
    const group = groups?.(prev);
    onTo = order.slice(index).find((s) => !groups || groups(s) === group)?.id;
  }
  connectors = [...connectors, { id: fresh(), from_step_id: id, to_step_id: onTo, name: "pass", position: 1 }];
  return { draft: withWf(d, { ...wf, steps, connectors }), id };
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

/**
 * Deletes a Step. A Step whose first outcome led into it now leads where its first outcome led
 * (the reverse of inserting); any other outcome into it goes with it, as do all of them when it
 * had no outcome. Its open Tasks, and any moved
 * to it, go to `moveTo`.
 */
export function deleteStep(d: Draft, id: string, moveTo?: string): Draft {
  const wf = d.wf;
  const step = wf.steps.find((s) => s.id === id);
  if (!step) return d;
  const own = firstOutcome(wf, id);
  const onTo = own?.to_step_id;
  const firsts = new Set(wf.steps.map((s) => firstOutcome(wf, s.id)?.id));
  const connectors: RecordConnector[] = [];
  for (const c of wf.connectors) {
    if (c.from_step_id === id) continue;
    if (c.to_step_id !== id) connectors.push(c);
    else if (own && firsts.has(c.id) && onTo !== c.from_step_id) connectors.push({ ...c, to_step_id: onTo });
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

/** The Steps deleting `id` leaves with no way out, which had one before. */
export function deadEndsAfterDelete(d: Draft, id: string): RecordStep[] {
  const before = new Set(deadEnds(d.wf).map((s) => s.id));
  return deadEnds(deleteStep(d, id).wf).filter((s) => !before.has(s.id));
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

/**
 * How many changes the draft makes to the Workflow it began from, counted as they were made: each
 * Step added or deleted, renamed or given another Skill; each outcome added (a new Step's first
 * comes with it), removed, renamed or pointed elsewhere; and the Steps moved in the order, the
 * fewest that put it as it is.
 */
export function countChanges(server: WorkflowRecord, draft: WorkflowRecord): number {
  let n = 0;
  const kept = new Map(server.steps.map((s) => [s.id, s]));
  for (const s of draft.steps) {
    const was = kept.get(s.id);
    if (!was) n++;
    else {
      if (s.name.trim() !== was.name) n++;
      if (s.skill_id !== was.skill_id) n++;
    }
  }
  const ids = new Set(draft.steps.map((s) => s.id));
  n += server.steps.filter((s) => !ids.has(s.id)).length;
  const wasC = new Map(server.connectors.map((c) => [c.id, c]));
  for (const c of draft.connectors) {
    const was = wasC.get(c.id);
    if (!was) {
      const bornWithStep = !kept.has(c.from_step_id) && firstOutcome(draft, c.from_step_id)?.id === c.id;
      if (!bornWithStep) n++;
      continue;
    }
    if (c.name.trim() !== was.name) n++;
    if (c.to_step_id !== was.to_step_id) n++;
  }
  const cids = new Set(draft.connectors.map((c) => c.id));
  // A Connector that went with a deleted Step, out of it or into it, is counted with the Step.
  n += server.connectors.filter((c) => !cids.has(c.id) && ids.has(c.from_step_id) && (!c.to_step_id || ids.has(c.to_step_id))).length;
  n += reordered(server, draft);
  return n;
}

/** The fewest Steps moved that turn the old order of the Steps kept into the new: those off the longest run kept in order. */
function reordered(server: WorkflowRecord, draft: WorkflowRecord): number {
  const ids = new Set(draft.steps.map((s) => s.id));
  const old = new Map(
    inOrder(server.steps)
      .filter((s) => ids.has(s.id))
      .map((s, i) => [s.id, i]),
  );
  const seq = inOrder(draft.steps)
    .filter((s) => old.has(s.id))
    .map((s) => old.get(s.id)!);
  const tails: number[] = [];
  for (const x of seq) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return seq.length - tails.length;
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
