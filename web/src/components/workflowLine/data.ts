import type { Activity, Claim, Task } from "@/api/client";
import { workingOf, type MemberKind, type SessionState } from "@/lib/work";
import { taskPath } from "@/screens/task/path";
import { liveClaim } from "@/work";
import { DONE_STATION, drawnSteps, type LineBrief, type LineMember, type LineTask, type LineWorkflow } from "./model";

/*
 * The facts the line draws, from the records: each open Task as a token, the scope that narrows
 * them, a selected Task's Blocking chain, and one Task's path. Free of React, so the tests read
 * them as data.
 */

export type MemberOf = (id: string) => { name: string; kind: MemberKind } | undefined;

/** The Project's open Tasks as the line knows them: at a Step, or a question with a Member. */
export function lineTasks(tasks: readonly Task[], ctx: { member: MemberOf; session: (taskId: string, memberId: string) => SessionState | undefined; now: number }): LineTask[] {
  const keyOf = new Map(tasks.map((t) => [t.id, t]));
  const someone = (id: string): LineMember => {
    const m = ctx.member(id);
    return { id, name: m?.name ?? "a Member", kind: m?.kind ?? "human" };
  };
  return tasks
    .filter((t) => t.state === "open")
    .map((t) => {
      const claim = liveClaim(t, ctx.now);
      const holder = claim ? { ...someone(claim.holder_id), working: workingOf(ctx.member(claim.holder_id)?.kind ?? "human", ctx.session(t.id, claim.holder_id)) } : undefined;
      const blockers: LineBrief[] = (t.open_blockers ?? []).map((b) => ({ id: b.id, key: b.key, title: keyOf.get(b.id)?.title ?? b.title }));
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        stepId: t.step_id,
        parentId: t.parent_id,
        kind: t.kind,
        since: t.step_since ? Date.parse(t.step_since) : undefined,
        holder,
        heldSince: claim ? Date.parse(claim.started_at) : undefined,
        aimedAt: t.aimed_at_id && !t.step_id ? someone(t.aimed_at_id) : undefined,
        blockers,
        openSubtasks: t.subtask_counts?.open,
      };
    });
}

/* ------------------------------------------------------------------------------------------ */
/* Scope.                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** What the line shows: every open Task, those with no Parent, one Parent's Subtasks, or one Task. */
export type LineScope = { kind: "all" } | { kind: "none" } | { kind: "parent"; id: string } | { kind: "task"; id: string };

/** The scope `?scope=` names: `none`, or a Task's id (a Parent's narrows to its Subtasks). */
export function scopeOf(param: string | null, isParent: (id: string) => boolean | undefined): LineScope {
  if (!param) return { kind: "all" };
  if (param === "none") return { kind: "none" };
  return isParent(param) ? { kind: "parent", id: param } : { kind: "task", id: param };
}

export function scopeParam(scope: LineScope): string | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "none") return "none";
  return scope.id;
}

/** A Parent as its scope draws it. */
export type ScopeParent = {
  id: string;
  key: string;
  title: string;
  ended: boolean;
  acceptance: boolean;
  /** Its Subtasks, every state: open ones at their Steps, done ones at Done. */
  subtasks: readonly { id: string; key: string; title: string; kind: LineTask["kind"]; state: "open" | "done" | "dropped" }[];
};

/** A Parent the scope menu offers: its key and title ("…" until read), and how many of its Subtasks are open on the line. */
export type ScopeChoice = { id: string; key: string; title: string; open: number };

/**
 * The scope menu of a line that draws the Steps `drawn` (every Step when none): each Parent with
 * an open Subtask on the line, in the order of `all`, wherever the Parent itself is listed (an
 * ended one beside its open Retrospective; one with Subtasks on two Workflows' lines on both),
 * named by its record; and how many open Tasks at the line's Steps have no Parent. Another
 * Workflow's Tasks are on its own line.
 */
export function scopeMenu(
  all: readonly LineTask[],
  drawn: ReadonlySet<string> | undefined,
  recordOf: (id: string) => Pick<Task, "key" | "title"> | undefined,
): { parents: ScopeChoice[]; noParent: number } {
  const onLine = (t: LineTask) => !drawn || (!!t.stepId && drawn.has(t.stepId));
  const counts = new Map<string, number>();
  for (const t of all) if (t.parentId && onLine(t)) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
  const parents = [...counts].map(([id, open]) => {
    const r = recordOf(id);
    return { id, key: r?.key ?? "…", title: r?.title ?? "", open };
  });
  return { parents, noParent: all.filter((t) => t.stepId && onLine(t) && !t.parentId).length };
}

/** A token-shaped mark for a Subtask still to come: "when 4 open end Done". */
export type Ghost = { stepId: string; text: string; label: string };

export type ScopedLine = {
  /** The Tasks drawn as tokens at their Steps. */
  drawn: LineTask[];
  /** Per Step, the open Tasks there outside the scope: its faint "+N". */
  hidden: Map<string, number>;
  /** The open Tasks at the Steps drawn that the scope (or the Filter) leaves out: the header's "N hidden". */
  hiddenTotal: number;
  /** A Parent's Subtasks that ended Done: green tokens at Done. */
  done: { id: string; key: string; title: string }[];
  ghosts: Ghost[];
  /** The branch's heading: "After a Parent", "Next for MAIN-7", "After MAIN-1". */
  branchLabel: string;
  /** A Parent with nothing on the main line folds it to a strip of names. */
  fold: boolean;
};

/**
 * The line narrowed to a scope. Steps and Connectors stay drawn whatever the scope; only tokens
 * leave, each leaving a "+N" on its Step so the line never lies about load. Only the Tasks at the
 * Steps the line draws count (`LineWorkflow.drawn`): another Workflow's are on its own line. A Parent's scope adds
 * its Subtasks still to come as ghosts on the branch: its Acceptance (when it has one due and the
 * Workflow a Step for it) and its Retrospective (when the Workflow has a Step for it).
 */
export function scopedLine(all: readonly LineTask[], scope: LineScope, ctx: { workflow: LineWorkflow; parent?: ScopeParent; passes?: (id: string) => boolean }): ScopedLine {
  const onLine = drawnSteps(ctx.workflow);
  const atStep = all.filter((t) => t.stepId && (!onLine || onLine.has(t.stepId)));
  const steps = onLine ? ctx.workflow.steps.filter((s) => onLine.has(s.id)) : ctx.workflow.steps;
  const inScope: (t: LineTask) => boolean =
    scope.kind === "all" ? () => true : scope.kind === "none" ? (t) => !t.parentId : scope.kind === "parent" ? (t) => t.parentId === scope.id : (t) => t.id === scope.id;
  // The Filter narrows tokens as a scope does: what it leaves out counts into its Step's "+N".
  const keep = (t: LineTask) => inScope(t) && (scope.kind === "task" || !ctx.passes || ctx.passes(t.id));
  const drawn = atStep.filter(keep);
  const hidden = new Map<string, number>();
  for (const t of atStep) if (!keep(t)) hidden.set(t.stepId!, (hidden.get(t.stepId!) ?? 0) + 1);
  const out: ScopedLine = { drawn, hidden, hiddenTotal: atStep.length - drawn.length, done: [], ghosts: [], branchLabel: "After a Parent", fold: false };
  const p = scope.kind === "parent" ? ctx.parent : undefined;
  if (p && p.id === (scope as { id: string }).id) {
    out.done = p.subtasks.filter((s) => s.state === "done").map(({ id, key, title }) => ({ id, key, title }));
    out.branchLabel = p.ended ? `After ${p.key}` : `Next for ${p.key}`;
    const stepWith = (skill: string) => steps.find((s) => s.skill?.name === skill);
    const has = (kind: LineTask["kind"]) => p.subtasks.some((s) => s.kind === kind && s.state !== "dropped");
    const open = p.subtasks.filter((s) => s.state === "open").length;
    const acc = stepWith("acceptance");
    if (!p.ended && p.acceptance && acc && !has("acceptance")) out.ghosts.push({ stepId: acc.id, text: `when ${open} open end Done`, label: "Acceptance" });
    const retro = stepWith("retro");
    if (!p.ended && retro && !has("retrospective")) out.ghosts.push({ stepId: retro.id, text: `when ${p.key} ends`, label: "Retrospective" });
    const branch = new Set(steps.filter((s) => s.skill && ["acceptance", "retro", "skill-review"].includes(s.skill.name)).map((s) => s.id));
    out.fold = p.ended && !drawn.some((t) => !branch.has(t.stepId!));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Blocking chains.                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** How a Task in a chain stands, as its pill says. */
export type ChainStanding = "working" | "with" | "takeable" | "blocked" | "waiting";

export type Chain = {
  task: LineTask;
  /** Each way up to what must end first: root first, the selected Task's direct blocker last. */
  upstream: LineTask[][];
  /** What waits on it, nearest first: Tasks it blocks, then what those block. */
  downstream: LineTask[];
  /** Every Blocking in the chain, blocker → blocked, by id. */
  links: [string, string][];
  /** The first thing in the chain the viewer can do: answer a question, take a Task, or nothing. */
  first: { kind: "answer" | "take"; task: LineTask } | { kind: "none" };
};

/** A selected Task's Blocking chain, walked over the open Tasks. */
export function chainOf(id: string, all: readonly LineTask[], me: { id: string; takeable: ReadonlySet<string> }): Chain | undefined {
  const byId = new Map(all.map((t) => [t.id, t]));
  const task = byId.get(id);
  if (!task) return undefined;
  const links: [string, string][] = [];
  const up = (t: LineTask, seen: Set<string>): LineTask[][] => {
    const out: LineTask[][] = [];
    for (const b of t.blockers) {
      const blocker = byId.get(b.id);
      if (!blocker || seen.has(b.id)) continue;
      links.push([b.id, t.id]);
      const above = up(blocker, new Set([...seen, b.id]));
      if (above.length === 0) out.push([blocker]);
      else for (const path of above) out.push([...path, blocker]);
    }
    return out;
  };
  const upstream = up(task, new Set([id]));
  const downstream: LineTask[] = [];
  const queue = [task];
  const seen = new Set([id]);
  while (queue.length > 0) {
    const t = queue.shift()!;
    for (const w of all) {
      if (seen.has(w.id) || !w.blockers.some((b) => b.id === t.id)) continue;
      seen.add(w.id);
      links.push([t.id, w.id]);
      downstream.push(w);
      queue.push(w);
    }
  }
  let first: Chain["first"] = { kind: "none" };
  for (const path of upstream) {
    const root = path[0];
    if (root.aimedAt?.id === me.id && !root.holder) {
      first = { kind: "answer", task: root };
      break;
    }
    if (first.kind === "none" && me.takeable.has(root.id) && !root.holder && root.blockers.length === 0) first = { kind: "take", task: root };
  }
  return { task, upstream, downstream, links: dedupe(links), first };
}

function dedupe(links: [string, string][]): [string, string][] {
  const seen = new Set<string>();
  return links.filter(([a, b]) => !seen.has(`${a}>${b}`) && seen.add(`${a}>${b}`));
}

export function standing(t: LineTask, takeable: ReadonlySet<string>): ChainStanding {
  if (t.holder) return "working";
  if (t.aimedAt) return "with";
  if (t.blockers.length > 0) return "blocked";
  return takeable.has(t.id) ? "takeable" : "waiting";
}

/** "MAIN-4 and MAIN-12", "MAIN-10, then MAIN-11": when the selected Task unblocks. */
export function unblocksWhen(chain: Chain): string | undefined {
  const direct = chain.task.blockers.map((b) => b.key);
  if (direct.length === 0) return undefined;
  if (chain.upstream.length === 1 && chain.upstream[0].length > 1) return `Unblocks when ${chain.upstream[0].map((t) => t.key).join(", then ")} end`;
  const list = direct.length === 1 ? direct[0] : `${direct.slice(0, -1).join(", ")} and ${direct.at(-1)}`;
  return `Unblocks when ${list} ${direct.length === 1 ? "ends" : "end"}`;
}

/* ------------------------------------------------------------------------------------------ */
/* One Task's path.                                                                             */
/* ------------------------------------------------------------------------------------------ */

export type TraceStay = {
  stepId: string;
  since: number;
  until?: number;
  /** Time a live Claim held it there, and the rest. */
  worked: number;
  waited: number;
  /** Who last held it there. */
  holder?: LineMember;
};

/** A Task's way through the Workflow: its stays, the Connectors it took, and the outcomes open to it now. */
export type Trace = {
  stays: TraceStay[];
  traversed: string[];
  next: string[];
  current?: string;
  end?: "done" | "dropped" | "parent";
};

/**
 * One Task's path as the line traces it, from its Activity (`taskPath`) and its Claims: each stay
 * split into waited and worked; the Connectors it went along (an advance names its outcome; a
 * move by hand has none); and while it is at a Step, the Connectors out of it, its next moves.
 */
export function traceOf(
  task: Pick<Task, "id" | "state" | "step_id" | "step_since" | "ended_at" | "subtask_counts">,
  entries: readonly Activity[],
  claims: readonly Claim[],
  workflow: LineWorkflow,
  member: MemberOf,
  now: number,
): Trace {
  const { stays, end } = taskPath(task, entries);
  const out: TraceStay[] = stays.map((s) => {
    const until = s.until ?? now;
    let worked = 0;
    let holder: LineMember | undefined;
    for (const c of claims) {
      const from = Math.max(s.since, Date.parse(c.started_at));
      const to = Math.min(until, c.ended_at ? Date.parse(c.ended_at) : now);
      if (to > from) {
        worked += to - from;
        const m = member(c.holder_id);
        holder = { id: c.holder_id, name: m?.name ?? "a Member", kind: m?.kind ?? "human" };
      }
    }
    return { stepId: s.stepId, since: s.since, until: s.until, worked, waited: Math.max(0, until - s.since - worked), holder };
  });
  const traversed: string[] = [];
  stays.forEach((s, i) => {
    const left = s.left;
    if (!left || (left.by !== "advanced" && left.by !== "completed")) return;
    const to = left.by === "completed" ? null : (stays[i + 1]?.stepId ?? null);
    const c = workflow.connectors.find((x) => x.from === s.stepId && x.name === left.outcome && (left.by === "completed" ? x.to === null : x.to === to));
    if (c) traversed.push(c.id);
  });
  const current = task.state === "open" && task.step_id ? task.step_id : undefined;
  const next = current ? workflow.connectors.filter((c) => c.from === current).sort((a, b) => a.position - b.position).map((c) => c.id) : [];
  return { stays: out, traversed, next, current, end: end?.kind };
}

/** Where a Connector leads, as a station: a Step's id, or Done. */
export const stationOf = (to: string | null) => to ?? DONE_STATION;
