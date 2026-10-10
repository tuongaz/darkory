import type { Activity, Member, PullRequest, RunnerSessionState, Skill, Task, TaskDetail, Workflows } from "@/api/client";
import { stepTitle } from "@/components/workflowLine/model";
import { stepsInOrder } from "@/screens/board/derive";
import { allShiftsBusy, liveClaim } from "@/work";

// The rules the four screens read, apart from rendering, so the tests can hold them to the plan.

const dayMs = 24 * 60 * 60 * 1000;

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" ? v : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" ? v : undefined;
}

// ---------------------------------------------------------------- Inbox

/** How many takeable Tasks the Inbox shows before "Show all". */
export const takeableCap = 5;

/**
 * The Inbox's Takeable by you: the takeable Tasks in `next` order, less those already listed as
 * aimed at you (a Task aimed at you is also takeable by you).
 */
export function takeableNow(takeable: Task[], aimedAtMe: Task[]): Task[] {
  const aimed = new Set(aimedAtMe.map((t) => t.id));
  return takeable.filter((t) => !aimed.has(t.id));
}

/** The open Tasks `task` blocks: the question's "blocks WEB-3". */
export function blocksOf(task: Task, openTasks: Task[]): Task[] {
  return openTasks.filter((t) => t.open_blockers?.some((b) => b.id === task.id));
}

/** Why a Task the signed-in Member owns waits on their decision. */
export type Decision =
  /** A Parent whose Subtasks have all ended: its Owner completes or drops it. */
  | { kind: "complete"; task: Task; acceptance?: "done" | "dropped" }
  /** A Retrospective carrying a proposal written against a Skill version no longer current. */
  | { kind: "stale"; task: Task; skill: string; basedOn: number; current: number }
  /** A Done Task whose pull request is open: its Owner merges it. */
  | { kind: "merge"; task: Task; pr: PullRequest };

/**
 * The Done Tasks `me` owns whose pull request the Runner read open on GitHub, oldest Done first:
 * the work is finished and lands once its Owner merges it.
 */
export function awaitingMerge(tasks: readonly Task[], me: string): Extract<Decision, { kind: "merge" }>[] {
  return tasks
    .filter((t) => t.state === "done" && t.owner_id === me && t.pull_request?.state === "open")
    .sort((a, b) => Date.parse(a.ended_at ?? "") - Date.parse(b.ended_at ?? ""))
    .map((task) => ({ kind: "merge" as const, task, pr: task.pull_request! }));
}

/**
 * The open Parents among `owned` whose every Subtask has ended and which wait for their Owner's
 * Complete (Auto-complete off, or an Acceptance that did not end done). `details` (by Task id) say
 * how the last Acceptance under each ended, where it had one.
 */
export function awaitingComplete(owned: Task[], details: Map<string, TaskDetail>): Decision[] {
  return owned
    .filter((t) => t.state === "open" && t.subtask_counts && t.subtask_counts.open === 0)
    .map((task) => {
      const subtasks = details.get(task.id)?.subtasks ?? [];
      const last = subtasks.filter((s) => s.kind === "acceptance").at(-1);
      const acceptance = last && last.state !== "open" ? last.state : undefined;
      return { kind: "complete" as const, task, acceptance };
    });
}

/**
 * The pending proposals on the open Retrospectives `details` hold (the signed-in Member owns
 * them) whose Skill has moved past the version they were written against: Skill review would
 * refuse them `proposal_stale`, so their Owner decides what becomes of them.
 */
export function staleProposals(details: TaskDetail[], skills: Map<string, Pick<Skill, "name" | "current_version">>): Decision[] {
  const out: Decision[] = [];
  for (const d of details) {
    if (d.task.state !== "open" || d.task.kind !== "retrospective") continue;
    for (const p of d.proposals) {
      const skill = skills.get(p.skill_id);
      if (p.state === "pending" && skill && p.based_on_version < skill.current_version) {
        out.push({ kind: "stale", task: d.task, skill: skill.name, basedOn: p.based_on_version, current: skill.current_version });
      }
    }
  }
  return out;
}

export type Lapse = { task: Task; at: string; holderId?: string };

/**
 * The Claims on `owned` Tasks that lapsed in the 24 hours before `now` and were not taken up
 * again: the Task is open and nobody holds it. One row per Task, its latest lapse.
 */
export function lapsesOn(owned: Task[], entries: Activity[], now: number): Lapse[] {
  const byId = new Map(owned.map((t) => [t.id, t]));
  const out = new Map<string, Lapse>();
  for (const e of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (e.kind !== "task.lapsed" || out.has(e.subject_id)) continue;
    const task = byId.get(e.subject_id);
    if (!task || task.state !== "open" || liveClaim(task, now)) continue;
    if (Date.parse(e.at) <= now - dayMs) continue;
    out.set(task.id, { task, at: e.at, holderId: str(e.payload, "holder_id") });
  }
  return [...out.values()];
}

/** A Parent's progress in words: "3 of 5 done", with the dropped ones when there are any. */
export function progressText(counts: NonNullable<Task["subtask_counts"]>): string {
  const total = counts.open + counts.done + counts.dropped;
  return `${counts.done} of ${total} done${counts.dropped ? ` · ${counts.dropped} dropped` : ""}`;
}

/** The open Parents among `owned`, by Project then Rank: My work's What you own. */
export function ownedParents(owned: Task[]): Task[] {
  return owned
    .filter((t) => t.state === "open" && t.subtask_counts && !t.parent_id)
    .sort((a, b) => a.project_id.localeCompare(b.project_id) || (a.rank ?? 0) - (b.rank ?? 0));
}

// ---------------------------------------------------------------- Agents

/** The Claim kinds an agent's history is made of; the first starts a Claim, the rest end one. */
export const claimKinds = [
  "task.claimed",
  "task.completed",
  "task.advanced",
  "task.released",
  "task.split",
  "task.lapsed",
  "task.taken_back",
  "task.claim_ended",
  "task.dropped",
] as const satisfies Activity["kind"][];

// The holder acts these ends; the others name the holder in the payload (no one, or someone else, acted).
const endedByHolder = new Set<string>(["task.completed", "task.advanced", "task.released"]);
const endedForHolder = new Set<string>(["task.lapsed", "task.taken_back", "task.claim_ended", "task.dropped", "task.split"]);

/** The Member whose Claim a Claim entry starts or ends, or undefined for any other entry. */
export function claimHolder(e: Activity): string | undefined {
  if (e.kind === "task.claimed") return e.actor_id;
  if (endedByHolder.has(e.kind)) return str(e.payload, "claim_id") ? e.actor_id : undefined;
  if (endedForHolder.has(e.kind)) return str(e.payload, "holder_id");
  return undefined;
}

/** The lapses of `memberId`'s Claims in the 24 hours before `now`, newest first. */
export function lapsesIn24h(entries: Activity[], memberId: string, now: number): Activity[] {
  return entries
    .filter((e) => e.kind === "task.lapsed" && str(e.payload, "holder_id") === memberId && Date.parse(e.at) > now - dayMs)
    .sort((a, b) => b.seq - a.seq);
}

/** The newest entry that started or ended one of `memberId`'s Claims. */
export function lastClaimEntry(entries: Activity[], memberId: string): Activity | undefined {
  let last: Activity | undefined;
  for (const e of entries) if (claimHolder(e) === memberId && (!last || e.seq > last.seq)) last = e;
  return last;
}

/** The newest entry `memberId` acted in, or whose Claim it ended: the agent's last activity. */
export function lastActivity(entries: Activity[], memberId: string): Activity | undefined {
  let last: Activity | undefined;
  for (const e of entries) if ((e.actor_id === memberId || claimHolder(e) === memberId) && (!last || e.seq > last.seq)) last = e;
  return last;
}

export type AgentRow = {
  agent: Member;
  /** The Tasks it holds a live Claim on, the one lapsing first first. */
  held: Task[];
  /** When its first Claim lapses without a Heartbeat (Unix ms); absent when it holds none that can. */
  deadline?: number;
};

// Where a runner session's state puts its agent: a Stalled one first, then a Waiting one.
const stateBands: Partial<Record<RunnerSessionState, number>> = { stalled: -2, waiting: -1 };

/**
 * The agents for the Agents table: those whose runner session is Stalled, then Waiting (`stateOf`
 * says, by Member id); then those holding a live Claim, the one whose Heartbeat is due first at
 * the top and Member-bound Claims after the timed ones; then the idle ones; deactivated agents
 * last. Names break ties.
 */
export function agentRows(
  agents: Member[],
  openTasks: Task[],
  now: number,
  stateOf: (memberId: string) => RunnerSessionState | undefined = () => undefined,
): AgentRow[] {
  const held = new Map<string, Task[]>();
  for (const t of openTasks) {
    const c = liveClaim(t, now);
    if (c) held.set(c.holder_id, [...(held.get(c.holder_id) ?? []), t]);
  }
  const expiry = (t: Task) => (t.claim?.expires_at ? Date.parse(t.claim.expires_at) : Infinity);
  const rows = agents
    .filter((m) => m.kind === "agent")
    .map((agent): AgentRow => {
      const tasks = (held.get(agent.id) ?? []).sort((a, b) => expiry(a) - expiry(b));
      const first = tasks[0] ? expiry(tasks[0]) : Infinity;
      return { agent, held: tasks, deadline: Number.isFinite(first) ? first : undefined };
    });
  const band = (r: AgentRow) => {
    if (r.agent.deactivated_at) return 3;
    const state = stateOf(r.agent.id);
    if (state && stateBands[state] !== undefined) return stateBands[state];
    return r.held.length === 0 ? 2 : r.deadline === undefined ? 1 : 0;
  };
  return rows.sort((a, b) => band(a) - band(b) || (a.deadline ?? 0) - (b.deadline ?? 0) || a.agent.name.localeCompare(b.agent.name));
}

export type ClaimRecord = {
  claimId: string;
  taskId: string;
  claimedAt: string;
  skillId?: string;
  modelLabel?: string;
  timeoutSeconds?: number;
  /** The entry that ended the Claim, while known. */
  end?: Activity;
};

/** The Claims `memberId` made at or after `since` (Unix ms), oldest first, each with the entry that ended it. */
export function claimsSince(entries: Activity[], memberId: string, since: number): ClaimRecord[] {
  const records = new Map<string, ClaimRecord>();
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    const claimId = str(e.payload, "claim_id");
    if (!claimId) continue;
    if (e.kind === "task.claimed") {
      if (e.actor_id !== memberId || Date.parse(e.at) < since) continue;
      records.set(claimId, {
        claimId,
        taskId: e.subject_id,
        claimedAt: e.at,
        skillId: str(e.payload, "skill_id"),
        modelLabel: str(e.payload, "model_label"),
        timeoutSeconds: num(e.payload, "heartbeat_timeout_seconds"),
      });
    } else if (claimHolder(e) === memberId) {
      const r = records.get(claimId);
      if (r && !r.end) r.end = e;
    }
  }
  return [...records.values()];
}

/** The start of the local day `now` falls in (Unix ms). */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------- Activity

/** The Activity page's filters, by id; `parentOf` names a Task's Parent, for the Task filter. */
export type ActivityFilter = { member?: string; kind?: string; task?: string; parentOf?: (taskId: string) => string | undefined };

/** Where the Activity page places an entry: a Task's Project, by the Task's id. */
export type Placement = { taskProject: (taskId: string) => string | undefined };

/**
 * Whether an entry belongs on a Project's Activity, by the rule /v1 applies to `project`: the
 * Project itself, its Workflow, its own Labels, or a Task of it.
 */
export function aboutProject(e: Activity, projectId: string, where: Placement): boolean {
  switch (e.subject_type) {
    case "project":
    case "workflow":
      return e.subject_id === projectId;
    case "label":
      return str(e.payload, "project_id") === projectId;
    case "task":
      return (where.taskProject(e.subject_id) ?? str(e.payload, "project_id")) === projectId;
    default:
      return false;
  }
}

/**
 * Whether an entry passes the Activity page's filters (ids), by the rules /v1 applies to `member`,
 * `kind` and `task`: the Member acted in it or held the Claim it ended; it is of the kind; it is
 * about the Task or, when the Task is a Parent, one of its Subtasks.
 */
export function matchesFilter(e: Activity, f: ActivityFilter): boolean {
  if (f.kind && e.kind !== f.kind) return false;
  if (f.member && e.actor_id !== f.member && !(endedForHolder.has(e.kind) && str(e.payload, "holder_id") === f.member)) return false;
  if (f.task && !(e.subject_type === "task" && (e.subject_id === f.task || f.parentOf?.(e.subject_id) === f.task))) return false;
  return true;
}

export type TimeGroup = { key: string; label: string; entries: Activity[] };

const shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Today", "Yesterday", or the day as "Mon 6 Oct". */
export function dayLabel(at: Date, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at.getTime());
  if (day === today) return "Today";
  if (day === startOfDay(today - 1)) return "Yesterday";
  return shortDay.format(at).replace(",", "");
}

/** Entries, newest first, in runs of one day each, labelled "Today", "Yesterday", "Mon 6 Oct". */
export function groupByDay(entries: Activity[], now: number): TimeGroup[] {
  const groups: TimeGroup[] = [];
  for (const e of entries) {
    const at = new Date(e.at);
    const key = String(startOfDay(at.getTime()));
    const last = groups.at(-1);
    if (last?.key === key) last.entries.push(e);
    else groups.push({ key, label: dayLabel(at, now), entries: [e] });
  }
  return groups;
}

/** "1 Task", "3 Tasks": a number with its noun. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The Steps a Member takes in a Project, in its order, as the Agents page names them: `Bugs ›
 * Investigate` when the Project has two or more Workflows, else the Step's name.
 */
/**
 * What waits for a busy agent in a Project: while it holds as many Tasks as it has Shifts (its
 * settings' `shifts`, 1 unless set), the open Tasks of the Project nobody holds and nothing blocks,
 * at a Step whose takers include it (its Skill there), not aimed at someone else and not Parents.
 * The longest waiting at its Step comes first.
 */
export function queueOf({
  agent,
  held,
  open,
  workflow,
  projectId,
  now,
}: {
  agent: Member;
  held: readonly Task[];
  open: readonly Task[];
  workflow: Pick<Workflows, "steps"> | undefined;
  projectId: string;
  now: number;
}): Task[] {
  if (!workflow || !allShiftsBusy(agent, held.length)) return [];
  const takes = new Set(workflow.steps.filter((s) => s.takers.some((t) => t.id === agent.id)).map((s) => s.id));
  const since = (t: Task) => Date.parse(t.step_since ?? t.waiting_since);
  return open
    .filter(
      (t) =>
        t.project_id === projectId &&
        t.state === "open" &&
        !t.subtask_counts &&
        !t.blocked &&
        !liveClaim(t, now) &&
        !!t.step_id &&
        takes.has(t.step_id) &&
        (!t.aimed_at_id || t.aimed_at_id === agent.id),
    )
    .sort((a, b) => since(a) - since(b));
}

export function takesOf(workflow: Pick<Workflows, "workflows" | "steps"> | undefined, memberId: string): string[] {
  if (!workflow) return [];
  return stepsInOrder(workflow)
    .filter((s) => s.takers.some((t) => t.id === memberId))
    .map((s) => stepTitle(s, workflow.workflows));
}
