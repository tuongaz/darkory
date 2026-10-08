import type { RunnerSession, Schemas, Skill, Task, Workflow as WorkflowRecord } from "@/api/client";
import type { Connector, Step, Taker, Workflow } from "@/components/workflow/model";
import { workingOf, type MemberKind, type Working } from "@/lib/work";
import { liveClaim } from "@/work";
import type { Change } from "./edits";

/*
 * The Project's Workflow as `/v1` serves it (`WorkflowRecord`, `GET …/workflow`) bound to the shapes the
 * canvas draws (`components/workflow/model.ts`), and back again as the one body `PUT …/workflow`
 * takes. Every edit the Settings canvas makes is a function of the record (edits.ts); the body is
 * built from the result, so what the canvas shows and what is sent never differ.
 */

export type { WorkflowRecord };
export type RecordStep = WorkflowRecord["steps"][number];
export type RecordConnector = WorkflowRecord["connectors"][number];
export type SetWorkflowBody = Schemas["SetWorkflowBody"];

/** A Step or Connector drawn before `/v1` has given it an id: sent without one. */
export const newIdPrefix = "new:";
export const isNew = (id: string) => id.startsWith(newIdPrefix);

/**
 * How each Member holding a Step's Skill is working there now: the live Claims on the open Tasks
 * at the Step, an agent's in its Runner session's state (`running` when no Runner runs it), a
 * human's as a still ring.
 */
export function workingAt(tasks: Task[], sessions: RunnerSession[], kindOf: (id: string) => MemberKind | undefined, now: number) {
  const byStep = new Map<string, Map<string, Working>>();
  for (const t of tasks) {
    const claim = t.step_id ? liveClaim(t, now) : undefined;
    if (!claim) continue;
    const kind = kindOf(claim.holder_id) ?? "human";
    const session = sessions.find((s) => s.task_id === t.id && s.member_id === claim.holder_id)?.state;
    const working = byStep.get(t.step_id!) ?? new Map<string, Working>();
    // A Member working two Tasks at one Step shows the livelier: a running ring over a stopped one.
    const was = working.get(claim.holder_id);
    const is = workingOf(kind, session);
    if (!was || rank[is] < rank[was]) working.set(claim.holder_id, is);
    byStep.set(t.step_id!, working);
  }
  return byStep;
}

const rank: Record<Working, number> = { running: 0, held: 1, waiting: 2, stalled: 3, ending: 4 };

/**
 * The record as the canvas draws it: each Step with its Skill's name, its takers (ringed by how
 * they work there, when `working` is given), its counts and median; each Connector with `to` null
 * into Done.
 */
export function toCanvas(record: WorkflowRecord, skills: Map<string, Pick<Skill, "id" | "name">>, working?: Map<string, Map<string, Working>>): Workflow {
  const steps: Step[] = record.steps.map((s) => {
    const skill = s.skill_id ? skills.get(s.skill_id) : undefined;
    const ringed = working?.get(s.id);
    const takers: Taker[] = s.takers.map((t) => ({ id: t.id, name: t.name, kind: t.kind, working: ringed?.get(t.id) }));
    return {
      id: s.id,
      name: s.name,
      skill: s.skill_id ? { id: s.skill_id, name: skill?.name ?? "…" } : undefined,
      position: s.position,
      x: s.x,
      y: s.y,
      takers,
      tasks: s.tasks,
      working: s.working,
      medianMs: s.median_ms,
    };
  });
  const connectors: Connector[] = record.connectors.map((c) => ({
    id: c.id,
    from: c.from_step_id,
    to: c.to_step_id ?? null,
    name: c.name,
    position: c.position,
  }));
  return { steps, connectors };
}

/**
 * The whole Workflow as `PUT …/workflow` takes it: Steps numbered 1, 2, 3… in their order, each
 * with its id unless it is new, its Skill (left out on a hold) and where it stands; Connectors
 * numbered among those out of their Step, naming a new Step by its name (the spec takes a Step of
 * the body by id or name, and names are unique in a Workflow), leaving `to` out into Done.
 */
export function toBody(record: WorkflowRecord, moves?: Record<string, string>): SetWorkflowBody {
  const steps = [...record.steps].sort((a, b) => a.position - b.position);
  const ref = new Map(steps.map((s) => [s.id, isNew(s.id) ? s.name : s.id]));
  const outPosition = new Map<string, number>();
  const connectors = [...record.connectors]
    .sort((a, b) => (positionOf(steps, a.from_step_id) - positionOf(steps, b.from_step_id)) || a.position - b.position)
    .map((c) => {
      const n = (outPosition.get(c.from_step_id) ?? 0) + 1;
      outPosition.set(c.from_step_id, n);
      return {
        ...(isNew(c.id) ? {} : { id: c.id }),
        from: ref.get(c.from_step_id) ?? c.from_step_id,
        ...(c.to_step_id ? { to: ref.get(c.to_step_id) ?? c.to_step_id } : {}),
        name: c.name,
        position: n,
      };
    });
  const body: SetWorkflowBody = {
    steps: steps.map((s, i) => ({
      ...(isNew(s.id) ? {} : { id: s.id }),
      name: s.name,
      ...(s.skill_id ? { skill: s.skill_id } : {}),
      position: i + 1,
      x: s.x,
      y: s.y,
    })),
    connectors,
  };
  if (moves && Object.keys(moves).length > 0) {
    body.moves = Object.fromEntries(Object.entries(moves).map(([from, to]) => [from, ref.get(to) ?? to]));
  }
  return body;
}

function positionOf(steps: RecordStep[], id: string): number {
  return steps.find((s) => s.id === id)?.position ?? 0;
}

/**
 * The ids `/v1` gave the Steps and Connectors `sent` drew without one: a Step by its name in the
 * reply, a Connector by its Step and name. Read from what was sent, so a Step renamed since keeps
 * its new id.
 */
export function newIds(sent: WorkflowRecord, reply: WorkflowRecord): Map<string, string> {
  const ids = new Map<string, string>();
  for (const s of sent.steps) {
    if (!isNew(s.id)) continue;
    const got = reply.steps.find((r) => same(r.name, s.name));
    if (got) ids.set(s.id, got.id);
  }
  const sid = (id: string) => ids.get(id) ?? id;
  for (const c of sent.connectors) {
    if (!isNew(c.id)) continue;
    const got = reply.connectors.find((r) => r.from_step_id === sid(c.from_step_id) && same(r.name, c.name));
    if (got) ids.set(c.id, got.id);
  }
  return ids;
}

/** `draft` with the new ids in place of its `new:…` ones, so later edits name them as the record does. */
export function adoptIds(draft: WorkflowRecord, ids: Map<string, string>): WorkflowRecord {
  const id = (x: string) => ids.get(x) ?? x;
  return {
    ...draft,
    steps: draft.steps.map((s) => (ids.has(s.id) ? { ...s, id: id(s.id) } : s)),
    connectors: draft.connectors.map((c) => ({
      ...c,
      id: id(c.id),
      from_step_id: id(c.from_step_id),
      to_step_id: c.to_step_id ? id(c.to_step_id) : undefined,
    })),
  };
}

/**
 * `make` applied to `wf` as a caller saw it before `/v1` named its new Steps (`renamed`, `new:…`
 * id to the record's): the change names them by their `new:…` ids, and comes back by `wf`'s.
 */
export function changeAcross(wf: WorkflowRecord, renamed: Map<string, string>, make: (wf: WorkflowRecord) => Change): Change {
  if (renamed.size === 0) return make(wf);
  const change = make(adoptIds(wf, new Map([...renamed].map(([was, now]) => [now, was]))));
  const id = (x: string) => renamed.get(x) ?? x;
  const moves = change.moves && Object.fromEntries(Object.entries(change.moves).map(([from, to]) => [id(from), id(to)]));
  return { ...change, next: adoptIds(change.next, renamed), moves };
}

/** Names compare as `/v1` compares them: ignoring case. */
export function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
