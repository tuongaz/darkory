import { newKey } from "@/api/client";
import { RANK_GAP, STEP_H, STEP_W, ROW_GAP } from "@/components/workflow/layout";
import { countTasks, type Point } from "@/components/workflow/model";
import { isNew, newIdPrefix, same, type RecordConnector, type RecordStep, type WorkflowRecord } from "./bind";

/*
 * Every edit the Settings canvas makes, as a function of the Workflow record: it returns the
 * Workflow as it should be, which the page draws at once and sends whole as one `PUT …/workflow`
 * (bind.ts). A new Step or Connector carries an id of the form `new:…` until `/v1` gives it one.
 * `problem` says in words what `/v1` would refuse before anything is sent.
 */

/** One change, as the page applies and sends it, and as its toast and Undo name it. */
export type Change = {
  next: WorkflowRecord;
  /** What was done, in words: the toast's line. */
  label: string;
  /** Where the open Tasks at a deleted Step go: its id to a Step's id. */
  moves?: Record<string, string>;
  /** The Step to select once it is drawn (a new one). */
  select?: string;
  /** What Undo cannot put back, said in its toast. */
  undoNote?: string;
};

export const nameMax = 50;

const fresh = () => `${newIdPrefix}${newKey()}`;
const stepById = (wf: WorkflowRecord, id: string) => wf.steps.find((s) => s.id === id);
const nameOf = (wf: WorkflowRecord, id: string | undefined) => (id ? (stepById(wf, id)?.name ?? "a Step that is gone") : "Done");
const inOrder = (steps: RecordStep[]) => [...steps].sort((a, b) => a.position - b.position);
const renumber = (steps: RecordStep[]) => steps.map((s, i) => (s.position === i + 1 ? s : { ...s, position: i + 1 }));

/** The first of `base`, `base 2`, `base 3`… no name in `taken` has, ignoring case. */
export function unusedName(base: string, taken: string[]): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.some((t) => same(t, name))) return name;
  }
}

export function renameStep(wf: WorkflowRecord, id: string, name: string): Change {
  const was = nameOf(wf, id);
  return {
    next: { ...wf, steps: wf.steps.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)) },
    label: `Renamed ${was} to ${name.trim()}`,
  };
}

/** Gives a Step a Skill, or none (a hold). Its Tasks stay where they are, Claims included. */
export function setStepSkill(wf: WorkflowRecord, id: string, skill: { id: string; name: string } | undefined): Change {
  const step = stepById(wf, id)!;
  return {
    next: { ...wf, steps: wf.steps.map((s) => (s.id === id ? { ...s, skill_id: skill?.id, takers: skill ? s.takers : [] } : s)) },
    label: skill ? `${step.name} now carries ${skill.name}` : `${step.name} is now a hold`,
  };
}

/** Where a new Step after `from` stands: one rank right of it, clear of every Step there. */
function placeAfter(wf: WorkflowRecord, from: RecordStep | undefined): Point {
  const x = from ? from.x + STEP_W + RANK_GAP : wf.steps.length === 0 ? 0 : Math.max(...wf.steps.map((s) => s.x)) + STEP_W + RANK_GAP;
  let y = from ? from.y : 0;
  const clash = (y_: number) => wf.steps.some((s) => Math.abs(s.x - x) < STEP_W && Math.abs(s.y - y_) < STEP_H + ROW_GAP);
  while (clash(y)) y += STEP_H + ROW_GAP;
  return { x, y };
}

/**
 * A new Step, a hold named "New Step", after `from` in the Workflow's order and on the canvas
 * (at `at` when a connection was let go there), with a Connector into it from `from`; with no
 * `from`, last.
 */
export function addStep(wf: WorkflowRecord, from?: string, at?: Point): Change {
  const after = from ? stepById(wf, from) : undefined;
  const id = fresh();
  const name = unusedName("New Step", wf.steps.map((s) => s.name));
  const place = at ?? placeAfter(wf, after);
  const order = inOrder(wf.steps);
  const index = after ? order.findIndex((s) => s.id === after.id) + 1 : order.length;
  const step: RecordStep = { id, name, position: 0, x: place.x, y: place.y, tasks: 0, working: 0, takers: [] };
  const steps = renumber([...order.slice(0, index), step, ...order.slice(index)]);
  let connectors = wf.connectors;
  if (after) connectors = [...connectors, newConnector(wf, after.id, id)];
  return { next: { ...wf, steps, connectors }, label: after ? `Added ${name} after ${after.name}` : `Added ${name}`, select: id };
}

function newConnector(wf: WorkflowRecord, from: string, to: string | undefined, name?: string): RecordConnector {
  const out = wf.connectors.filter((c) => c.from_step_id === from);
  return {
    id: fresh(),
    from_step_id: from,
    to_step_id: to,
    name: name?.trim() || unusedName(out.length === 0 ? "pass" : "next", out.map((c) => c.name)),
    position: Math.max(0, ...out.map((c) => c.position)) + 1,
  };
}

/**
 * Deletes a Step and the Connectors out of it and into it. Its open Tasks go to `moveTo`, which
 * `problem` requires when it has any.
 */
export function deleteStep(wf: WorkflowRecord, id: string, moveTo?: string): Change {
  const step = stepById(wf, id)!;
  const moving = step.tasks > 0 && moveTo;
  return {
    next: {
      ...wf,
      steps: renumber(inOrder(wf.steps.filter((s) => s.id !== id))),
      connectors: wf.connectors.filter((c) => c.from_step_id !== id && c.to_step_id !== id),
    },
    moves: moving ? { [id]: moveTo } : undefined,
    label: moving ? `Deleted ${step.name}; its ${countTasks(step.tasks)} moved to ${nameOf(wf, moveTo)}` : `Deleted ${step.name}`,
    undoNote: moving ? `Undo brings ${step.name} back; its Tasks stay at ${nameOf(wf, moveTo)}.` : undefined,
  };
}

/** The Steps carrying a Skill with no Connector out: a Task there leaves only when moved by hand. */
export function deadEnds(wf: WorkflowRecord): RecordStep[] {
  return inOrder(wf.steps).filter((s) => s.skill_id && !wf.connectors.some((c) => c.from_step_id === s.id));
}

/** The Steps deleting `id` leaves with no way out, which had one before: its Connectors in go with it. */
export function deadEndsAfterDelete(wf: WorkflowRecord, id: string): RecordStep[] {
  const before = new Set(deadEnds(wf).map((s) => s.id));
  return deadEnds(deleteStep(wf, id).next).filter((s) => !before.has(s.id));
}

/** One place earlier (-1) or later (+1) in the Workflow's order: the board's order of Steps. */
export function reorderStep(wf: WorkflowRecord, id: string, by: -1 | 1): Change {
  const order = inOrder(wf.steps);
  const i = order.findIndex((s) => s.id === id);
  const j = Math.min(order.length - 1, Math.max(0, i + by));
  [order[i], order[j]] = [order[j], order[i]];
  return { next: { ...wf, steps: renumber(order) }, label: `Moved ${order[j].name} ${by < 0 ? "earlier" : "later"} in the order` };
}

export function placeStep(wf: WorkflowRecord, id: string, x: number, y: number): Change {
  return { next: { ...wf, steps: wf.steps.map((s) => (s.id === id ? { ...s, x, y } : s)) }, label: `Moved ${nameOf(wf, id)} on the canvas` };
}

/** Tidy up: every Step at its new place. */
export function layoutSteps(wf: WorkflowRecord, positions: Record<string, Point>): Change {
  return {
    next: { ...wf, steps: wf.steps.map((s) => (positions[s.id] ? { ...s, ...positions[s.id] } : s)) },
    label: "Tidied up the Workflow",
  };
}

/** A Connector from a Step into another Step or Done (`to` undefined), named `name` or a free default. */
export function addConnector(wf: WorkflowRecord, from: string, to: string | undefined, name?: string): Change {
  const c = newConnector(wf, from, to, name);
  return { next: { ...wf, connectors: [...wf.connectors, c] }, label: `Connected ${nameOf(wf, from)} to ${nameOf(wf, to)}: ${c.name}` };
}

export function renameConnector(wf: WorkflowRecord, id: string, name: string): Change {
  const c = wf.connectors.find((x) => x.id === id)!;
  return {
    next: { ...wf, connectors: wf.connectors.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) },
    label: `Renamed ${c.name} out of ${nameOf(wf, c.from_step_id)} to ${name.trim()}`,
  };
}

/** A Connector's ends moved: out of another Step it comes last among that Step's. */
export function reconnect(wf: WorkflowRecord, id: string, ends: { from: string; to: string | undefined }): Change {
  const c = wf.connectors.find((x) => x.id === id)!;
  const moved = ends.from !== c.from_step_id;
  const position = moved ? Math.max(0, ...wf.connectors.filter((x) => x.from_step_id === ends.from).map((x) => x.position)) + 1 : c.position;
  return {
    next: { ...wf, connectors: wf.connectors.map((x) => (x.id === id ? { ...x, from_step_id: ends.from, to_step_id: ends.to, position } : x)) },
    label: `${c.name} now leads from ${nameOf(wf, ends.from)} to ${nameOf(wf, ends.to)}`,
  };
}

/** One place earlier (-1) or later (+1) among the Connectors out of its Step: the order its outcomes are offered in. */
export function reorderConnector(wf: WorkflowRecord, id: string, by: -1 | 1): Change {
  const c = wf.connectors.find((x) => x.id === id)!;
  const out = wf.connectors.filter((x) => x.from_step_id === c.from_step_id).sort((a, b) => a.position - b.position);
  const i = out.findIndex((x) => x.id === id);
  const j = Math.min(out.length - 1, Math.max(0, i + by));
  [out[i], out[j]] = [out[j], out[i]];
  const position = new Map(out.map((x, n) => [x.id, n + 1]));
  return {
    next: { ...wf, connectors: wf.connectors.map((x) => (position.has(x.id) ? { ...x, position: position.get(x.id)! } : x)) },
    label: `Moved ${c.name} ${by < 0 ? "earlier" : "later"} among the outcomes out of ${nameOf(wf, c.from_step_id)}`,
  };
}

export function removeConnector(wf: WorkflowRecord, id: string): Change {
  const c = wf.connectors.find((x) => x.id === id)!;
  return {
    next: { ...wf, connectors: wf.connectors.filter((x) => x.id !== id) },
    label: `Removed ${c.name} from ${nameOf(wf, c.from_step_id)} to ${nameOf(wf, c.to_step_id)}`,
  };
}

/**
 * Undo: the Workflow as it was before a change, sent over the Workflow as it is now. A Step or
 * Connector the change deleted comes back as a new one (its id is gone); the live facts are the
 * current ones.
 */
export function restore(current: WorkflowRecord, before: WorkflowRecord, label: string): Change {
  const stepIds = new Set(current.steps.map((s) => s.id));
  const connectorIds = new Set(current.connectors.map((c) => c.id));
  const reborn = new Map<string, string>();
  for (const s of before.steps) if (!stepIds.has(s.id) && !isNew(s.id)) reborn.set(s.id, fresh());
  const sid = (id: string) => reborn.get(id) ?? id;
  const steps = before.steps.map((s) => {
    const now = current.steps.find((c) => c.id === s.id);
    const facts = now ? { tasks: now.tasks, working: now.working, takers: now.takers, median_ms: now.median_ms } : { tasks: 0, working: 0, takers: [] };
    return { ...s, ...facts, id: sid(s.id) };
  });
  const connectors = before.connectors.map((c) => ({
    ...c,
    id: connectorIds.has(c.id) ? c.id : fresh(),
    from_step_id: sid(c.from_step_id),
    to_step_id: c.to_step_id ? sid(c.to_step_id) : undefined,
  }));
  return { next: { ...current, steps, connectors }, label: `Undid: ${label}` };
}

/**
 * What `/v1` would refuse in `next`, in words, before anything is sent; undefined when nothing.
 * `current` is the Workflow it replaces: a Step it had that `next` does not is deleted, and its
 * open Tasks need a Step in `moves`.
 */
export function problem(next: WorkflowRecord, current: WorkflowRecord, moves: Record<string, string> = {}): string | undefined {
  const steps = inOrder(next.steps);
  for (const s of steps) {
    if (!s.name.trim()) return "A Step needs a name.";
    if (s.name.trim().length > nameMax) return `A Step's name is at most ${nameMax} characters.`;
  }
  for (let i = 0; i < steps.length; i++) {
    const twin = steps.slice(i + 1).find((t) => same(t.name, steps[i].name));
    if (twin) return `Two Steps are called ${steps[i].name.trim()}: a name is used once in a Workflow, whatever its case.`;
  }
  const kept = new Set(next.steps.map((s) => s.id));
  for (const c of next.connectors) {
    const from = stepById(next, c.from_step_id);
    if (!from) return "A Connector leads out of a Step that is gone.";
    if (c.to_step_id === c.from_step_id) return `A Connector leads out of ${from.name} into another Step or Done.`;
    if (c.to_step_id && !kept.has(c.to_step_id)) return `A Connector out of ${from.name} leads into a Step that is gone.`;
    if (!c.name.trim()) return `An outcome out of ${from.name} needs a name.`;
    if (c.name.trim().length > nameMax) return `An outcome's name is at most ${nameMax} characters.`;
    const twin = next.connectors.find((o) => o !== c && o.from_step_id === c.from_step_id && same(o.name, c.name));
    if (twin) return `Two outcomes out of ${from.name} are called ${c.name.trim()}: whoever advances a Task names one, so each is used once.`;
  }
  for (const gone of current.steps.filter((s) => !kept.has(s.id))) {
    const to = moves[gone.id];
    if (gone.tasks > 0 && !to) {
      return `${countTasks(gone.tasks)} ${gone.tasks === 1 ? "is" : "are"} at ${gone.name}: say which Step they move to.`;
    }
    if (to && !kept.has(to)) return `${gone.name}'s Tasks must move to a Step the Workflow keeps.`;
  }
  return undefined;
}
