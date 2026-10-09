import type { Activity, ActivityKind } from "@/api/client";
import { DONE, DROPPED, type Tone, type Travel, type Who } from "@/components/workflow/live";
import type { Workflow } from "@/components/workflow/model";

// What the live Workflow makes of an Activity entry about one of its Tasks, kept free of React so
// the tests read it as data: the callout above a Step ("builder picked up MAIN-7"), the chip that
// pulses, the token that travels a Connector, and the trail's line beside the canvas ("qa sent
// MAIN-7 back along fail to Build").

/** The entries that trace a Task through the Workflow: what the trail lists and the canvas shows. */
export const flowKinds = [
  "task.filed",
  "task.claimed",
  "task.released",
  "task.lapsed",
  "task.taken_back",
  "task.advanced",
  "task.moved",
  "task.completed",
  "task.dropped",
  "task.split",
  "task.became_parent",
] as const satisfies readonly ActivityKind[];

const isFlowKind = (kind: string): kind is (typeof flowKinds)[number] => (flowKinds as readonly string[]).includes(kind);

export type { Tone, Travel, Who };

export type FlowEffect = {
  seq: number;
  taskId: string;
  key: string;
  /** A bubble above the Step: the Member's mark (none when Darkory acted) and the words. */
  callout?: { stepId: string; tone: Tone; who?: Who; text: string };
  /** The Task's chip pulses, and its Step's node is outlined, in the moment's colour. */
  pulse?: { stepId: string; tone: Tone };
  /** A token carries the key from Step to Step (or into Done or Dropped). */
  travel?: Travel;
  /** The chip fades in at its Step with a short highlight: a Task filed there. */
  arrive?: string;
};

/** What the Workflow knows to name an entry's ids. */
export type FlowContext = {
  projectId: string;
  /** The Steps and Connectors the entries name: the canvas's Workflow or the line's; each Step with its Workflow. */
  workflow: {
    steps: readonly (Pick<Workflow["steps"][number], "id" | "name" | "position"> & { workflow_id?: string })[];
    connectors: readonly Pick<Workflow["connectors"][number], "id" | "from" | "to" | "name">[];
  };
  /**
   * The Steps the line draws, of a Project of several Workflows: what happens at another
   * Workflow's Steps plays on its own line, and a Task crossing between the two leaves or arrives
   * by the Connector's chip. Every Step when unsaid.
   */
  drawn?: ReadonlySet<string>;
  task: (id: string) => { key: string; step_id?: string; project_id?: string } | undefined;
  member: (id: string) => Who | undefined;
};

function text(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

/** The Step ids an entry names in its payload. */
function stepsNamed(e: Activity): string[] {
  return ["step_id", "from", "to"].map((k) => text(e.payload, k)).filter((x): x is string => !!x);
}

/**
 * Whether an entry is about a Task of this Project: by the Task's record, by the Project a filing
 * names, or by a Step of this Workflow it names (a Task filed and claimed before its record is read).
 */
export function aboutThisFlow(e: Activity, ctx: FlowContext): boolean {
  if (e.subject_type !== "task" || !isFlowKind(e.kind)) return false;
  const project = ctx.task(e.subject_id)?.project_id ?? text(e.payload, "project_id");
  if (project) return project === ctx.projectId;
  const ids = new Set(ctx.workflow.steps.map((s) => s.id));
  return stepsNamed(e).some((id) => ids.has(id));
}

/**
 * Whether an entry is about the line drawn: it names one of its Steps (or the Task's record is at
 * one), or names no Step at all. Every entry when the line draws every Step.
 */
export function onDrawnLine(e: Activity, ctx: FlowContext): boolean {
  if (!ctx.drawn) return true;
  const ids = [...stepsNamed(e), ...[ctx.task(e.subject_id)?.step_id].filter((x): x is string => !!x)];
  return ids.length === 0 || ids.some((id) => ctx.drawn!.has(id));
}

const someone = (id: string | undefined, ctx: FlowContext): Who | undefined =>
  id ? (ctx.member(id) ?? { id, name: "a Member", kind: "human" }) : undefined;

function keyOf(e: Activity, ctx: FlowContext): string {
  return ctx.task(e.subject_id)?.key ?? text(e.payload, "key") ?? "a Task";
}

/** A Step the line draws, or nothing. */
const here = (id: string | undefined, ctx: FlowContext) => (id && (!ctx.drawn || ctx.drawn.has(id)) ? id : undefined);

/** The Step a Task is at when the entry does not say: its record's. */
function stepOf(e: Activity, ctx: FlowContext): string | undefined {
  const at = text(e.payload, "step_id") ?? ctx.task(e.subject_id)?.step_id;
  return at && ctx.workflow.steps.some((s) => s.id === at) ? at : undefined;
}

/** The Connector a Task went along: out of `from`, named by the outcome, into `to` (null is Done). */
function connectorOf(ctx: FlowContext, from: string | undefined, outcome: string | undefined, to: string | null): string | undefined {
  if (!from || !outcome) return undefined;
  return ctx.workflow.connectors.find((c) => c.from === from && c.name === outcome && c.to === to)?.id;
}

/**
 * Whether a Connector leads back: into an earlier Step of its own Workflow. A Connector into
 * another Workflow's Step is an advance whichever Workflow comes first in the Project.
 */
function leadsBack(ctx: FlowContext, from: string | undefined, to: string | undefined): boolean {
  const [a, b] = [ctx.workflow.steps.find((s) => s.id === from), ctx.workflow.steps.find((s) => s.id === to)];
  if (!a || !b || (a.workflow_id ?? "") !== (b.workflow_id ?? "")) return false;
  return b.position < a.position;
}

const toneOf = (who: Who | undefined): Tone => (who?.kind === "agent" ? "agent" : "human");

/** What the canvas shows for an entry, or null when it shows nothing (not a flow entry, not this Project's). */
export function effectOf(e: Activity, ctx: FlowContext): FlowEffect | null {
  if (!aboutThisFlow(e, ctx)) return null;
  const p = e.payload;
  const key = keyOf(e, ctx);
  const base = { seq: e.seq, taskId: e.subject_id, key };
  const actor = someone(e.actor_id, ctx);
  // What happens at a Step the line does not draw plays on its own Workflow's line.
  const at = here(stepOf(e, ctx), ctx);
  const known = (id: string | undefined) => (id && ctx.workflow.steps.some((s) => s.id === id) ? id : undefined);
  const drawn = (id: string | undefined) => here(known(id), ctx);
  switch (e.kind) {
    case "task.filed": {
      const step = drawn(text(p, "step_id"));
      if (!step) return null;
      const said = actor ? `${actor.name} filed ${key}` : `${key} filed`;
      return { ...base, arrive: step, callout: { stepId: step, tone: "filed", who: actor, text: said } };
    }
    case "task.claimed":
      if (!at) return null;
      return {
        ...base,
        pulse: { stepId: at, tone: toneOf(actor) },
        callout: { stepId: at, tone: toneOf(actor), who: actor, text: `${actor?.name ?? "a Member"} picked up ${key}` },
      };
    case "task.released":
      if (!at) return null;
      return {
        ...base,
        pulse: { stepId: at, tone: "neutral" },
        callout: { stepId: at, tone: "neutral", who: actor, text: `${actor?.name ?? "a Member"} let go of ${key}` },
      };
    case "task.lapsed": {
      if (!at) return null;
      const holder = someone(text(p, "holder_id"), ctx);
      return { ...base, pulse: { stepId: at, tone: "lapsed" }, callout: { stepId: at, tone: "lapsed", who: holder, text: `${key}'s Claim lapsed` } };
    }
    case "task.taken_back":
      if (!at) return null;
      return {
        ...base,
        pulse: { stepId: at, tone: "back" },
        callout: { stepId: at, tone: "back", who: actor, text: `${actor?.name ?? "a Member"} took ${key} back` },
      };
    case "task.advanced":
    case "task.moved": {
      // Along a Connector into another Workflow, a Task leaves by its exit chip; from another, it
      // arrives by its entry. Moved by hand into another Workflow it leaves the same way; moved
      // in from one, or from no Step, it appears at its Step.
      const [from, to] = [known(text(p, "from")), known(text(p, "to"))];
      if (!to) return null;
      const connectorId = from && connectorOf(ctx, from, text(p, "outcome"), to);
      const [out, into] = [!!drawn(from), !!drawn(to)];
      if (!out && !into) return null;
      if (!from || (!out && !connectorId)) return { ...base, arrive: to };
      return { ...base, travel: { from, to, connectorId } };
    }
    case "task.completed": {
      // A Parent completing is at no Step: nothing travels.
      const from = drawn(text(p, "from"));
      if (!from) return null;
      return { ...base, travel: { from, to: DONE, connectorId: connectorOf(ctx, from, text(p, "outcome"), null) } };
    }
    case "task.dropped": {
      const from = drawn(text(p, "from"));
      if (!from) return null;
      return { ...base, travel: { from, to: DROPPED } };
    }
    case "task.became_parent": {
      const from = drawn(text(p, "from"));
      if (!from) return null;
      return { ...base, callout: { stepId: from, tone: "neutral", who: actor, text: `${key} became a Parent` } };
    }
    default:
      return null;
  }
}

/** A piece of a trail line: words, the Task's key (opens its peek), a Step, or an outcome. */
export type TrailPart = string | { key: string } | { step: string; name: string } | { outcome: string };

export type TrailLine = {
  seq: number;
  at: string;
  taskId: string;
  key: string;
  /** Whose mark leads the line; none when Darkory acted. */
  who?: Who;
  parts: TrailPart[];
  /** The muted fact after a "·". */
  detail?: string;
  /** The Steps the line names, which hovering it lights on the canvas. */
  steps: string[];
};

/**
 * The trail's line for an entry, in the glossary's voice: "builder picked up MAIN-7 at Build",
 * "builder advanced MAIN-7 along pass to QA", "qa sent MAIN-7 back along fail to Build", "MAIN-3
 * completed". Null for an entry the trail does not list.
 */
export function trailLine(e: Activity, ctx: FlowContext): TrailLine | null {
  if (!aboutThisFlow(e, ctx)) return null;
  const p = e.payload;
  const key = keyOf(e, ctx);
  const k = { key };
  const actor = someone(e.actor_id, ctx);
  const name = (id: string) => ctx.workflow.steps.find((s) => s.id === id)?.name;
  const step = (id: string | undefined): TrailPart[] => (id && name(id) ? [{ step: id, name: name(id)! }] : []);
  const atStep = (id: string | undefined): TrailPart[] => (id && name(id) ? ["at", ...step(id)] : []);
  const by = actor?.name ?? "Darkory";
  const line = (parts: TrailPart[], steps: (string | undefined)[], who = actor, detail?: string): TrailLine => ({
    seq: e.seq,
    at: e.at,
    taskId: e.subject_id,
    key,
    who,
    parts,
    detail,
    steps: steps.filter((s): s is string => !!s && !!name(s)),
  });
  const [from, to] = [text(p, "from"), text(p, "to")];
  switch (e.kind) {
    case "task.filed":
      return line([by, "filed", k, ...atStep(text(p, "step_id"))], [text(p, "step_id")]);
    case "task.claimed":
      return line([by, "picked up", k, ...atStep(stepOf(e, ctx))], [stepOf(e, ctx)]);
    case "task.released":
      return line([by, "let go of", k, ...atStep(stepOf(e, ctx))], [stepOf(e, ctx)]);
    case "task.lapsed": {
      const holder = someone(text(p, "holder_id"), ctx);
      return line([k, "'s Claim lapsed", ...atStep(stepOf(e, ctx))], [stepOf(e, ctx)], undefined, holder && `held by ${holder.name}`);
    }
    case "task.taken_back": {
      const holder = someone(text(p, "holder_id"), ctx);
      return line([by, "took", k, "back", ...(holder ? [`from ${holder.name}`] : []), ...atStep(stepOf(e, ctx))], [stepOf(e, ctx)]);
    }
    case "task.advanced": {
      const outcome = { outcome: text(p, "outcome") ?? "" };
      if (leadsBack(ctx, from, to)) return line([by, "sent", k, "back along", outcome, "to", ...step(to)], [from, to]);
      return line([by, "advanced", k, "along", outcome, "to", ...step(to)], [from, to]);
    }
    case "task.moved":
      return line([by, "moved", k, ...(from && name(from) ? ["from", ...step(from)] : []), "to", ...step(to)], [from, to]);
    case "task.completed":
      if (from && text(p, "outcome")) return line([by, "completed", k, "along", { outcome: text(p, "outcome")! }], [from], actor, name(from) && `from ${name(from)}`);
      return line([k, "completed"], [from]);
    case "task.dropped":
      return line([by, "dropped", k], [from], actor, from && name(from) ? `from ${name(from)}` : undefined);
    case "task.split":
      return line([by, "split", k, "into Subtasks"], [stepOf(e, ctx)]);
    case "task.became_parent":
      return line([k, "became a Parent"], [from], actor, from && name(from) ? `off ${name(from)}` : undefined);
    default:
      return null;
  }
}

/** A trail line as plain text, as a screen reader reads it. */
export function lineText(l: TrailLine): string {
  let out = "";
  for (const part of l.parts) {
    const word = typeof part === "string" ? part : "key" in part ? part.key : "step" in part ? part.name : part.outcome;
    // "MAIN-7" + "'s Claim lapsed" join without a space.
    out += out === "" || word.startsWith("'") ? word : ` ${word}`;
  }
  return l.detail ? `${out} · ${l.detail}` : out;
}

/**
 * A story row's latest change in the trail's words, without the Task's own key (the row names it)
 * or the Step it reached (the row's path shows it): "builder picked up", "qa advanced along pass",
 * "qa sent back along fail", "qa's Claim lapsed", "tuongaz filed". `sub` is a Subtask whose filing
 * or end folds into its Parent's row, and is named: "tuongaz filed MAIN-18", "builder completed
 * MAIN-21". Null for an entry the trail does not list.
 */
export function storyVerb(e: Activity, ctx: FlowContext, sub?: string): string | null {
  if (!isFlowKind(e.kind)) return null;
  const p = e.payload;
  const by = someone(e.actor_id, ctx)?.name ?? "Darkory";
  const outcome = text(p, "outcome");
  switch (e.kind) {
    case "task.filed":
      return sub ? `${by} filed ${sub}` : `${by} filed it`;
    case "task.claimed":
      return `${by} picked up`;
    case "task.released":
      return `${by} let go of it`;
    case "task.lapsed": {
      const holder = someone(text(p, "holder_id"), ctx);
      return holder ? `${holder.name}'s Claim lapsed` : "Claim lapsed";
    }
    case "task.taken_back": {
      const holder = someone(text(p, "holder_id"), ctx);
      return `${by} took it back${holder ? ` from ${holder.name}` : ""}`;
    }
    case "task.advanced":
      return leadsBack(ctx, text(p, "from"), text(p, "to")) ? `${by} sent back along ${outcome ?? ""}`.trim() : `${by} advanced along ${outcome ?? ""}`.trim();
    case "task.moved":
      return `${by} moved it`;
    case "task.completed":
      if (sub) return `${e.actor_id ? by : "Darkory"} completed ${sub}`;
      return e.actor_id ? `${by} completed it` : "completed";
    case "task.dropped":
      return sub ? `${by} dropped ${sub}` : `${by} dropped it`;
    case "task.split":
      return `${by} split it into Subtasks`;
    case "task.became_parent":
      return "became a Parent";
    default:
      return null;
  }
}
