import type { Activity, Task } from "@/api/client";

/** The Activity kinds that trace a Task's path through its Workflow. */
export const pathKinds = ["task.filed", "task.advanced", "task.moved", "task.became_parent", "task.completed", "task.dropped"] as const;

/** A stretch of a Task's life at one Step: when it got there, and when and how it left. */
export type Stay = {
  stepId: string;
  /** Unix ms. */
  since: number;
  /** Unix ms; absent while the Task is still there. */
  until?: number;
  /** How it left: along a Connector (its outcome), moved by hand, or ended there (into Done along one). */
  left?: { by: "advanced"; outcome: string } | { by: "moved" } | { by: "parent" } | { by: "completed"; outcome?: string } | { by: "dropped" };
};

/** Where the path ends, once it has: Done, Dropped, or a Parent's Subtasks. */
export type PathEnd = { kind: "done" | "dropped" | "parent"; at: number };

export type TaskPath = { stays: Stay[]; end?: PathEnd };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/**
 * A Task's path through its Workflow's Steps, read from its Activity (`task.filed`'s `step_id`;
 * `task.advanced`'s and `task.moved`'s `from`, `to` and `since`; `from` and `since` on the entries
 * that leave a Step) and its record (`step_id` and `step_since`, which make the current stay
 * exact). Entries may come in any order and may repeat; history the read did not reach starts the
 * path where the earliest entry found does.
 */
export function taskPath(task: Pick<Task, "id" | "state" | "step_id" | "step_since" | "ended_at" | "subtask_counts">, entries: readonly Activity[]): TaskPath {
  const seen = new Set<number>();
  const mine = entries
    .filter((e) => e.subject_id === task.id && !seen.has(e.seq) && seen.add(e.seq))
    .sort((a, b) => a.seq - b.seq);
  const stays: Stay[] = [];
  let end: PathEnd | undefined;
  const open = () => stays.at(-1)?.until === undefined ? stays.at(-1) : undefined;

  // Leaves `from` at `at`, closing its stay, or recording one the read began after.
  const leave = (from: string | undefined, since: number | undefined, at: number, left: Stay["left"]) => {
    if (!from) return;
    const current = open();
    if (current && current.stepId === from) {
      current.until = at;
      current.left = left;
      return;
    }
    if (current) current.until = at;
    stays.push({ stepId: from, since: since ?? at, until: at, left });
  };
  const arrive = (to: string | undefined, at: number) => {
    if (to) stays.push({ stepId: to, since: at });
  };

  for (const e of mine) {
    const at = Date.parse(e.at);
    const p = e.payload;
    switch (e.kind) {
      case "task.filed":
        arrive(str(p.step_id), at);
        break;
      case "task.advanced":
        leave(str(p.from), num(p.since), at, { by: "advanced", outcome: str(p.outcome) ?? "" });
        arrive(str(p.to), at);
        break;
      case "task.moved":
        leave(str(p.from), num(p.since), at, { by: "moved" });
        arrive(str(p.to), at);
        break;
      case "task.became_parent":
        leave(str(p.from), num(p.since), at, { by: "parent" });
        end = { kind: "parent", at };
        break;
      case "task.completed":
      case "task.dropped": {
        const kind = e.kind === "task.completed" ? "done" : "dropped";
        const outcome = str(p.outcome);
        leave(str(p.from), num(p.since), at, kind === "dropped" ? { by: "dropped" } : outcome ? { by: "completed", outcome } : { by: "completed" });
        end = { kind, at };
        break;
      }
    }
  }

  // The record is the truth about where the Task is now and since when.
  if (task.state === "open" && task.step_id && task.step_since) {
    const since = Date.parse(task.step_since);
    const current = open();
    if (current && current.stepId === task.step_id) current.since = since;
    else {
      if (current) current.until = since;
      stays.push({ stepId: task.step_id, since });
    }
  }
  if (task.state !== "open" && !end) end = { kind: task.state, at: task.ended_at ? Date.parse(task.ended_at) : Date.now() };
  if (task.state === "open" && task.subtask_counts && !end) end = { kind: "parent", at: stays.at(-1)?.until ?? Date.now() };
  return { stays, end };
}

/** "40 s", "12 min", "3 h", "2 d": how long a stay lasted. */
export function stayText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
