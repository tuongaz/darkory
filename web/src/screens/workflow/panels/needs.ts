import type { Activity, Member, RunnerSession, Skill, Task, TaskBrief, TaskDetail, Workflows } from "@/api/client";
import { isOnReportingLine } from "@/me";
import { atHold, liveClaim } from "@/work";

// What needs the signed-in Member, as Needs you (one Project) and the Inbox (every Project) list
// it, kept free of React so the tests hold it to the rules: which Tasks are decisions only a person
// can make, why each is with them, what acting on it unblocks, and the order to act in.

/** The one act a card offers. */
export type NeedAct =
  /** A question aimed at me: claim it, add the answer as a Note, complete it, in one submit. */
  | "answer"
  /** A Parent I own whose Subtasks have all ended. */
  | "complete"
  /** A Task at a hold, which only a human moves on: a Step picker, then `POST /step`. */
  | "move"
  /** A Task waiting at a Step whose only takers are paused agents: resume them (admin). */
  | "resume"
  /** A proposal on a Retrospective I own that waits on me: open it. */
  | "review"
  /** A Task I own at a Step no Member could take it at by its Skill: I take it. */
  | "take";

/** What the large age under a card names. */
export type AgeLabel = "asked" | "held" | "waiting" | "ready" | "lapsed";

export type NeedItem = {
  act: NeedAct;
  task: Task;
  /** When the age counts from. */
  since: string;
  ageLabel: AgeLabel;
  /** Why it is with me, in six words or fewer. */
  why: string;
  /** The open Tasks that wait on it: those whose open blockers name it. */
  unblocks: TaskBrief[];
  /** A Parent's Complete lands its done Subtasks. */
  lands?: number;
  /** The paused agents a resume starts again. */
  agents?: Member[];
  /** Nobody but me could act on it. */
  onlyMe: boolean;
  /** 1: it unblocks other work; 2: only I can move it; 3: the rest. */
  group: 1 | 2 | 3;
};

/** An agent session in trouble on a Task in scope: waiting on a decision, or stalled. */
export type AgentNeed = {
  agent: Member;
  task: Task;
  session: RunnerSession;
  /** The Owner or someone on the agent's Reporting line may take the Claim back. */
  canTakeBack: boolean;
  /** An admin may stop the session. */
  canStop: boolean;
  /** When the Runner last nudged the agent on it (`task.nudged`), in Unix ms. */
  nudgedAt?: number;
};

export type NeedsInput = {
  me: Member;
  now: number;
  /** Every open Task the caller can read: what is in scope, and what may wait on it. */
  open: Task[];
  /** Narrows the items to one Project (id); none is every Project. */
  projectId?: string;
  /** Each Project's Workflow by Project id: the Steps' Skills and takers. */
  workflows: Map<string, Workflows | undefined>;
  members: Map<string, Member>;
  /** Each Project's Members by Project id, while known. */
  projectMembers: Map<string, Member[]>;
  /** The records of the Parents and Retrospectives I own, by Task id. */
  details: Map<string, TaskDetail>;
  skills: Map<string, Pick<Skill, "name" | "current_version">>;
  sessions: RunnerSession[];
  /** Recent lapses, any order: the why of a Task I must take myself. */
  lapses: Activity[];
  /** Recent nudges by the Runner (`task.nudged`), any order. */
  nudges?: Activity[];
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * "unblocks MAIN-4", "unblocks 3 Tasks", "lands 2 Subtasks": what acting on it does beyond the Task
 * itself, or nothing when it does nothing more (a hold to move on, a paused agent to resume): the
 * why line already says that, and a line on every card would read as if each unblocked something.
 */
export function consequence(item: Pick<NeedItem, "unblocks" | "lands" | "act">): string | undefined {
  if (item.unblocks.length === 1) return `unblocks ${item.unblocks[0].key}`;
  if (item.unblocks.length > 1) return `unblocks ${item.unblocks.length} Tasks`;
  if (item.act === "complete") return `lands ${item.lands ?? 0} Subtask${item.lands === 1 ? "" : "s"}`;
  return undefined;
}

/** The button's words. */
export function actLabel(item: Pick<NeedItem, "act" | "agents" | "task">): string {
  switch (item.act) {
    case "answer":
      return "Answer";
    case "complete":
      return "Complete";
    case "move":
      return "Move on";
    case "resume":
      return item.agents?.length === 1 ? `Resume ${item.agents[0].name}` : "Resume agents";
    case "review":
      return "Review";
    case "take":
      return "Take";
  }
}

/** The open Tasks whose open blockers name `task`. */
export function unblockedBy(task: Task, open: Task[]): TaskBrief[] {
  return open.filter((t) => t.open_blockers?.some((b) => b.id === task.id)).map((t) => ({ id: t.id, key: t.key, title: t.title }));
}

const active = (m: Member | undefined): m is Member => !!m && !m.deactivated_at;

// Among items that unblock as much, a question leads, then a Parent's Complete.
const actRank: Record<NeedAct, number> = { answer: 0, complete: 1, review: 2, take: 3, resume: 4, move: 5 };

/** Needs you's order: what unblocks most first, then what only I can move, then the rest; oldest first within. */
export function byOrder(a: NeedItem, b: NeedItem): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.group === 1) {
    const wa = Math.max(a.unblocks.length, a.act === "complete" ? 1 : 0);
    const wb = Math.max(b.unblocks.length, b.act === "complete" ? 1 : 0);
    if (wa !== wb) return wb - wa;
    if (actRank[a.act] !== actRank[b.act]) return actRank[a.act] - actRank[b.act];
  }
  return Date.parse(a.since) - Date.parse(b.since) || a.task.key.localeCompare(b.task.key);
}

/**
 * What needs `me`, in Needs you's order. Each Task appears once, as the first of these that holds:
 * a question aimed at me (held by nobody, or by me after an answer that did not complete); a Parent
 * I own whose Subtasks have all ended; a proposal on a Retrospective I own gone stale, or pending at
 * a Step no one could review it at; a Task waiting at a Step whose only takers are paused agents,
 * for an admin; a Task I own waiting at a Step no Member could take it at (a lapse there included);
 * a Task at a hold in a Project I am in, for a human. Lapses others can take up, and Tasks blocked
 * by work under way, clear themselves and are left out.
 */
export function needsOf(input: NeedsInput): NeedItem[] {
  const { me, now, open, projectId, workflows, members, projectMembers, details, skills } = input;
  const inScope = open.filter((t) => t.state === "open" && (!projectId || t.project_id === projectId));
  const stepOf = (t: Task) => (t.step_id ? workflows.get(t.project_id)?.steps.find((s) => s.id === t.step_id) : undefined);
  const lapseOf = new Map<string, Activity>();
  for (const e of input.lapses) {
    if (e.kind !== "task.lapsed") continue;
    const seen = lapseOf.get(e.subject_id);
    if (!seen || e.seq > seen.seq) lapseOf.set(e.subject_id, e);
  }
  // Whether anyone but me in the Task's Project could do what `can` says; unknown members count as others.
  const othersCan = (t: Task, can: (m: Member) => boolean) => {
    const list = projectMembers.get(t.project_id);
    if (!list) return true;
    return list.some((m) => m.id !== me.id && active(members.get(m.id) ?? m) && can(members.get(m.id) ?? m));
  };
  const out: NeedItem[] = [];
  for (const t of inScope) {
    const holder = liveClaim(t, now)?.holder_id;
    const unblocks = unblockedBy(t, open);
    const base = { task: t, unblocks };
    let item: Omit<NeedItem, "group"> | undefined;
    if (t.aimed_at_id === me.id && !t.subtask_counts && (!holder || holder === me.id)) {
      const from = t.filed_by ? members.get(t.filed_by)?.name : undefined;
      item = { ...base, act: "answer", since: t.created_at, ageLabel: "asked", why: from ? `Question from ${from}` : "Question for you", onlyMe: true };
    } else if (t.owner_id === me.id && t.subtask_counts && t.subtask_counts.open === 0) {
      const subs = details.get(t.id)?.subtasks ?? [];
      const ended = subs.map((s) => s.ended_at).filter((x): x is string => !!x).sort();
      const acceptance = subs.filter((s) => s.kind === "acceptance").at(-1);
      const c = t.subtask_counts;
      const why =
        acceptance?.state === "done"
          ? "Acceptance passed"
          : acceptance?.state === "dropped"
            ? "Acceptance dropped"
            : `Subtasks ended${c.dropped ? ` · ${c.dropped} dropped` : ""}`;
      item = {
        ...base,
        // An Acceptance that did not pass is read first, not completed in one click.
        act: acceptance?.state === "dropped" ? "review" : "complete",
        since: ended.at(-1) ?? t.waiting_since,
        ageLabel: "ready",
        why,
        lands: c.done,
        onlyMe: true,
      };
    } else if (t.subtask_counts || holder) {
      continue;
    } else if (t.owner_id === me.id && t.kind === "retrospective" && details.get(t.id)) {
      const step = stepOf(t);
      const pending = details.get(t.id)!.proposals.filter((p) => p.state === "pending");
      const stale = pending.find((p) => {
        const s = skills.get(p.skill_id);
        return s && p.based_on_version < s.current_version;
      });
      const unreviewable = !!step?.skill_id && step.takers.length === 0;
      const p = stale ?? (unreviewable ? pending[0] : undefined);
      if (p) {
        const skill = skills.get(p.skill_id)?.name ?? "Skill";
        item = { ...base, act: "review", since: t.step_since ?? t.waiting_since, ageLabel: "waiting", why: `${skill} proposal ${stale ? "stale" : "unreviewed"}`, onlyMe: true };
      }
    }
    if (!item && !t.subtask_counts && !holder && !t.blocked && t.step_id) {
      const step = stepOf(t);
      const since = t.step_since ?? t.waiting_since;
      const takers = (step?.takers ?? []).map((k) => members.get(k.id)).filter(active);
      const paused = takers.length > 0 && takers.every((m) => m.kind === "agent" && m.agent?.paused);
      if (step?.skill_id && paused && me.admin) {
        const names = takers.map((m) => m.name);
        item = {
          ...base,
          act: "resume",
          since,
          ageLabel: "waiting",
          why: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} paused`,
          agents: takers,
          onlyMe: !othersCan(t, (m) => m.admin),
        };
      } else if (step?.skill_id && step.takers.length === 0 && t.owner_id === me.id && t.kind !== "retrospective") {
        const lapse = lapseOf.get(t.id);
        const lapsed = lapse && Date.parse(lapse.at) >= Date.parse(since) ? lapse : undefined;
        const was = lapsed && str(lapsed.payload, "holder_id");
        const skill = skills.get(step.skill_id)?.name ?? "its Skill";
        item = {
          ...base,
          act: "take",
          since: lapsed?.at ?? since,
          ageLabel: lapsed ? "lapsed" : "waiting",
          why: lapsed ? `Lapsed ${clock.format(new Date(lapsed.at))}${was && members.get(was) ? ` · held by ${members.get(was)!.name}` : ""}` : `No one else has ${skill}`,
          onlyMe: true,
        };
      } else if (atHold(t) && me.kind === "human" && (t.owner_id === me.id || projectMembers.get(t.project_id)?.some((m) => m.id === me.id))) {
        item = {
          ...base,
          act: "move",
          since,
          ageLabel: "held",
          why: `Held in ${step?.name ?? "a hold"}`,
          onlyMe: !othersCan(t, (m) => m.kind === "human"),
        };
      }
    }
    if (!item) continue;
    const weight = Math.max(item.unblocks.length, item.act === "complete" ? 1 : 0);
    out.push({ ...item, group: weight > 0 ? 1 : item.onlyMe ? 2 : 3 });
  }
  return out.sort(byOrder);
}

/**
 * The agent sessions waiting on a decision or stalled on Tasks in scope, the longest-running first,
 * with what the caller may do: take the Claim back (its Owner, or someone on the agent's Reporting
 * line) and stop the session (an admin).
 */
export function agentNeedsOf(input: Pick<NeedsInput, "me" | "open" | "projectId" | "members" | "sessions" | "nudges">): AgentNeed[] {
  const { me, open, projectId, members, sessions } = input;
  const out: AgentNeed[] = [];
  for (const s of sessions) {
    if (s.state !== "waiting" && s.state !== "stalled") continue;
    const task = open.find((t) => t.id === s.task_id);
    const agent = members.get(s.member_id);
    if (!task || !agent || (projectId && task.project_id !== projectId)) continue;
    out.push({
      agent,
      task,
      session: s,
      canTakeBack: task.owner_id === me.id || (agent.id !== me.id && isOnReportingLine(members, me.id, agent.id)),
      canStop: me.admin,
      nudgedAt: lastNudge(input.nudges ?? [], task.id, Date.parse(task.claim?.started_at ?? s.started_at)),
    });
  }
  // The longest in its state first: a session waiting since 10:39 before one stalled at 10:41.
  return out.sort((a, b) => Date.parse(a.session.state_since) - Date.parse(b.session.state_since));
}

/** The latest nudge on a Task since its Claim began. */
function lastNudge(nudges: Activity[], taskId: string, since: number): number | undefined {
  let at: number | undefined;
  for (const e of nudges) {
    const t = Date.parse(e.at);
    if (e.kind === "task.nudged" && e.subject_id === taskId && t >= since && (at === undefined || t > at)) at = t;
  }
  return at;
}
