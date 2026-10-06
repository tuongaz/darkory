import type { Member, TaskDetail } from "@/api/client";
import { isOnReportingLine } from "@/me";
import { liveClaim } from "@/work";

/** What can be done to a Task from the web app. */
export type TaskAction =
  | "claim"
  | "complete"
  | "hand-over"
  | "release"
  | "observe"
  | "attach-evidence"
  | "add-blocker"
  | "propose"
  | "take-back"
  | "drop";

export type TaskActions = {
  /** The screen's one primary: Claim, or Complete for the holder. */
  primary?: "claim" | "complete";
  /** Beside the primary, in its caret: the holder's other ways to end the Claim. */
  caret: TaskAction[];
  /** The ⋯ menu: the rare actions. */
  menu: TaskAction[];
  /** Menu items shown dimmed, with the pill saying why. */
  dimmed: Partial<Record<TaskAction, string>>;
  /** Whether the Status is a menu (the Feature's Team, its owner, the holder) or a fact. */
  status: "menu" | "fact";
  /** Where the Note composer goes: the holder writes, anyone else sees who may. */
  notes: { composer: true } | { onlyHolder: string } | null;
};

export type ActionInput = {
  me: string;
  detail: Pick<TaskDetail, "task" | "feature">;
  members: Map<string, Member>;
  /** The ids of the Tasks the signed-in Member can take now (`GET /v1/tasks/takeable`). */
  takeable: Set<string>;
  /** The ids of the signed-in Member's Teams. */
  teams: Set<string>;
  now: number;
};

/**
 * Who may take back a Claim: the Feature owner, or a Member above the holder on the holder's
 * Reporting line, at any distance. The holder releases instead.
 */
export function canTakeBack(members: Map<string, Member>, me: string, holder: string, owner: string): boolean {
  if (me === holder) return false;
  return me === owner || isOnReportingLine(members, me, holder);
}

/** The actions a Member sees on a Task, by their part in it: holder, owner, Reporting line, Team. */
export function taskActions({ me, detail, members, takeable, teams, now }: ActionInput): TaskActions {
  const { task, feature } = detail;
  const open = task.state === "open";
  const claim = liveClaim(task, now);
  const mine = claim?.holder_id === me;
  const owner = feature.owner_id === me;
  const inTeam = teams.has(feature.team_id);
  // The holder may be from another Team, as a reviewer or the Member a question is aimed at is.
  const movesStatus = open && (inTeam || owner || mine);
  const out: TaskActions = { caret: [], menu: [], dimmed: {}, status: movesStatus ? "menu" : "fact", notes: null };

  if (mine) {
    out.primary = "complete";
    out.caret.push("hand-over", "release");
    out.menu.push("observe", "attach-evidence", "add-blocker");
    if (task.kind === "retrospective") out.menu.push("propose");
    out.notes = { composer: true };
  } else if (claim) {
    out.notes = { onlyHolder: claim.holder_id };
    if (open && canTakeBack(members, me, claim.holder_id, feature.owner_id)) out.menu.push("take-back");
  } else {
    if (open && takeable.has(task.id)) out.primary = "claim";
    // Unheld, a Task's blockers and Evidence are its owner's and its Team's to add.
    if (owner || inTeam) {
      if (open) out.menu.push("add-blocker");
      out.menu.push("attach-evidence");
    }
  }
  if (open) {
    out.menu.push("drop");
    if (!owner) out.dimmed.drop = "Owner only";
  }
  return out;
}
