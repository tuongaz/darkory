import type { Connector, Member, TaskDetail } from "@/api/client";
import { isOnReportingLine } from "@/me";
import { liveClaim } from "@/work";
import { canTakeBack, isParent } from "../board/derive";

/** What can be done to a Task from the web app. */
export type TaskAction =
  | "claim"
  | "advance"
  | "complete"
  | "release"
  | "move"
  | "rank"
  | "pass-ownership"
  | "add-blocker"
  | "attach-evidence"
  | "observe"
  | "file-subtask"
  | "ask-question"
  | "propose"
  | "take-back"
  | "merge"
  | "drop";

export type TaskActions = {
  /**
   * The screen's one primary: Claim; for the holder, Advance along the first Connector out of the
   * Task's Step (or Complete for a Task aimed at them, at no Step); for a Parent's Owner, Complete;
   * for the Owner of a Task whose pull request is open, with a Runner attached, Merge.
   */
  primary?: { kind: "claim" } | { kind: "advance"; connector: Connector } | { kind: "complete" } | { kind: "merge" };
  /** Beside the primary, in its caret: the other Connectors, then Release. */
  caret: ({ kind: "advance"; connector: Connector } | { kind: "release" })[];
  /** The ⋯ menu: the rest, Drop last. */
  menu: TaskAction[];
  /** Actions shown dimmed, with the pill saying why. */
  dimmed: Partial<Record<TaskAction, string>>;
  /** Where the Note composer goes: whoever may write sees it, anyone else who may. */
  notes: { composer: true } | { onlyHolder: string } | null;
  /** Whether the Labels are a menu or a fact. */
  labels: boolean;
  /** Filing a Subtask ends the signed-in Member's Claim: they hold the Task. */
  splits: boolean;
};

export type ActionInput = {
  me: string;
  detail: Pick<TaskDetail, "task" | "connectors">;
  members: Map<string, Member>;
  /** The ids of the Tasks the signed-in Member can take now (`GET /v1/tasks/takeable`). */
  takeable: Set<string>;
  /** The ids of the signed-in Member's Projects. */
  projects: Set<string>;
  now: number;
  /** Whether a Runner is attached to the server (`GET /v1/runner/sessions`): it merges a pull request. */
  runner?: boolean;
};

/** The actions a Member sees on a Task, by their part in it: holder, Owner, Reporting line, Project. */
export function taskActions({ me, detail, members, takeable, projects, now, runner }: ActionInput): TaskActions {
  const { task, connectors } = detail;
  const open = task.state === "open";
  const parent = isParent(task);
  const claim = liveClaim(task, now);
  const mine = claim?.holder_id === me;
  const owner = task.owner_id === me;
  const inProject = projects.has(task.project_id);
  const member = owner || inProject;
  const topLevel = !task.parent_id;
  const out: TaskActions = { caret: [], menu: [], dimmed: {}, notes: null, labels: member, splits: false };

  if (open && mine) {
    const [first, ...rest] = connectors;
    out.primary = first ? { kind: "advance", connector: first } : { kind: "complete" };
    out.caret.push(...rest.map((connector) => ({ kind: "advance" as const, connector })), { kind: "release" });
    out.menu.push("observe", "attach-evidence", "add-blocker", "ask-question");
    if (topLevel) {
      out.menu.push("file-subtask");
      out.splits = true;
    }
    if (task.kind === "retrospective") out.menu.push("propose");
    out.notes = { composer: true };
  } else if (open && claim) {
    out.notes = { onlyHolder: claim.holder_id };
    if (canTakeBack(members, me, claim.holder_id, task.owner_id)) out.menu.push("take-back", "move");
  } else if (open && parent) {
    if (owner) {
      out.primary = { kind: "complete" };
      if ((task.subtask_counts?.open ?? 0) > 0) out.dimmed.complete = "Subtasks open";
    }
    if (member) {
      out.menu.push("file-subtask", "attach-evidence");
      out.notes = { composer: true };
    }
  } else if (open) {
    if (takeable.has(task.id)) out.primary = { kind: "claim" };
    if (member) {
      out.menu.push("move", "add-blocker", "attach-evidence", "ask-question");
      if (topLevel) out.menu.push("file-subtask");
      out.notes = { composer: true };
    }
  } else if (member) {
    // Ended: the record still takes Evidence and Notes.
    out.menu.push("attach-evidence");
    out.notes = { composer: true };
  }
  if (open && topLevel) {
    if (member) out.menu.push("rank");
    // The Owner passes it on, or someone above the Owner on their Reporting line.
    if (owner || isOnReportingLine(members, me, task.owner_id)) out.menu.push("pass-ownership");
  }
  if (open) {
    out.menu.push("drop");
    if (!owner) out.dimmed.drop = "Owner only";
  }
  // The Owner lands the Task's pull request through the Runner, open or Done alike; a Dropped
  // Task's is the Owner's to close on GitHub. Holding the Task, the Owner's work comes first and
  // Merge waits in the menu; Claim gives way to it.
  if (owner && runner && task.state !== "dropped" && task.pull_request?.state === "open") {
    if (out.primary?.kind === "advance" || out.primary?.kind === "complete") out.menu.unshift("merge");
    else {
      if (out.primary?.kind === "claim") out.menu.unshift("claim");
      out.primary = { kind: "merge" };
    }
  }
  return out;
}
