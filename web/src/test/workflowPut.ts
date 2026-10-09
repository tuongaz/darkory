import type { Schemas, Workflows } from "@/api/client";
import { refuse } from "./api";

export type Body = Schemas["SetWorkflowBody"];

/**
 * The items of a body list numbered as /v1 numbers them: by the position given, one left out or 0
 * reading as its place in the list, then 1, 2, 3… in that order.
 */
function numbered<T extends { position?: number }>(items: readonly T[]): (T & { position: number })[] {
  return items
    .map((x, i) => ({ x, at: x.position || i + 1, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ x }, i) => ({ ...x, position: i + 1 }));
}

/** `numbered` within each bucket `keyOf` names, keeping the list's order across buckets. */
function numberedPer<T extends { position?: number }>(items: readonly T[], keyOf: (x: T) => string): (T & { position: number })[] {
  const keys = [...new Set(items.map(keyOf))];
  return keys.flatMap((k) => numbered(items.filter((x) => keyOf(x) === k)));
}

/**
 * The record a PUT body makes of `wf`, as /v1 answers: a Workflow without an id keeps that of the
 * one named alike, ignoring case, unless another Workflow of the body already carries that id;
 * else it is new. New Steps and Connectors get ids; the facts stay. Workflows are numbered 1..n,
 * Steps 1..n within their Workflow, Connectors 1..n among those out of their Step.
 */
export function answer(wf: Workflows, body: Body): Workflows | Response {
  let n = 0;
  const carried = new Set(body.workflows.flatMap((w) => (w.id ? [w.id] : [])));
  const workflows = numbered(body.workflows).map((w) => ({
    id: w.id ?? wf.workflows.find((x) => x.name.toLowerCase() === w.name.toLowerCase() && !carried.has(x.id))?.id ?? `wf-made-${++n}`,
    name: w.name,
    position: w.position,
  }));
  const workflowOf = (ref: string) => (workflows.find((w) => w.id === ref) ?? workflows.find((w) => w.name.toLowerCase() === ref.toLowerCase()))?.id;
  // As /v1: a Step naming no Workflow of the body is refused, nothing made.
  const stray = body.steps.find((s) => !workflowOf(s.workflow));
  if (stray) return refuse(400, "invalid", `a Step names "${stray.workflow}", which is not a Workflow of the body`);
  const steps = numberedPer(body.steps, (s) => workflowOf(s.workflow)!).map((s) => {
    const was = wf.steps.find((x) => x.id === s.id);
    return {
      id: s.id ?? `st-made-${++n}`,
      workflow_id: workflowOf(s.workflow)!,
      name: s.name,
      skill_id: s.skill,
      position: s.position,
      x: s.x ?? was?.x ?? 0,
      y: s.y ?? was?.y ?? 0,
      tasks: was?.tasks ?? 0,
      working: was?.working ?? 0,
      takers: s.skill === was?.skill_id ? (was?.takers ?? []) : [],
    };
  });
  const ref = (r?: string) => (r === undefined ? undefined : (steps.find((s) => s.id === r || s.name.toLowerCase() === r.toLowerCase())?.id ?? r));
  return {
    project_id: wf.project_id,
    workflows,
    steps,
    connectors: numberedPer(body.connectors, (c) => ref(c.from)!).map((c) => ({
      id: c.id ?? `c-made-${++n}`,
      from_step_id: ref(c.from)!,
      to_step_id: ref(c.to),
      name: c.name,
      position: c.position,
    })),
  };
}

