import type { Activity, ActivityKind, Label, Member, Project, Skill } from "@/api/client";
import { untilText } from "@/lib/time";
import { count } from "./derive";

// What an Activity entry says, in CONTEXT.md's words: the actor, the verb (or, for a lapse or a
// take-back, a mark), the record it is about, the Steps it went between, and the one detail worth
// a glance. Kept free of React so the tests read it as text.

/** Where an entry's ids become names. */
export type Lookup = {
  members: Map<string, Pick<Member, "name" | "kind">>;
  skills: Map<string, Pick<Skill, "name">>;
  tasks: Map<string, { key: string; title: string }>;
  /** A Step's name by id; a Step the Workflow no longer has has none. */
  stepName: (id: string) => string | undefined;
  projects: Map<string, Pick<Project, "key" | "name">>;
  labels?: Map<string, Pick<Label, "name">>;
  /** The `task.claimed` entries read so far, by claim id: how long a lapsed Claim waited. */
  claims: Map<string, Activity>;
};

export type Mark = "lapsed" | "taken_back";

export type Subject = { type: "task"; key: string; title: string } | { type: "workflow"; projectId: string } | { type: "text"; text: string };

/** A piece of the words after the subject: plain words, a Step (a link to the Tasks at it), or an outcome. */
export type Part = string | { step: string; name: string } | { outcome: string };

export type Sentence = {
  /** The Member who acted; absent when Darkory did, as on a lapse or its own filings. */
  actorId?: string;
  actorName: string;
  verb?: string;
  mark?: Mark;
  subject?: Subject;
  /** Words after the subject that belong to the sentence ("along pass to Review"). */
  after: Part[];
  /** The muted facts after a "·". */
  details: string[];
  outcome?: "worked" | "didnt_work";
  evidence?: { id: string; filename: string; size?: number };
};

type KindWords = { group: string; label: string; verb: string };

// Each kind: the menu group and label the Kind filter shows, and the verb the row says.
const kinds: Record<ActivityKind, KindWords> = {
  "task.filed": { group: "Task", label: "Filed", verb: "filed" },
  "task.claimed": { group: "Task", label: "Claimed", verb: "claimed" },
  "task.advanced": { group: "Task", label: "Advanced", verb: "advanced" },
  "task.moved": { group: "Task", label: "Moved", verb: "moved" },
  "task.completed": { group: "Task", label: "Completed", verb: "completed" },
  "task.dropped": { group: "Task", label: "Dropped", verb: "dropped" },
  "task.released": { group: "Task", label: "Released", verb: "released" },
  "task.lapsed": { group: "Task", label: "Lapsed", verb: "" },
  "task.nudged": { group: "Task", label: "Nudged", verb: "nudged the holder of" },
  "task.taken_back": { group: "Task", label: "Taken back", verb: "" },
  "task.claim_ended": { group: "Task", label: "Claim ended", verb: "ended a Claim on" },
  "task.split": { group: "Task", label: "Split", verb: "split" },
  "task.became_parent": { group: "Task", label: "Became a Parent", verb: "made" },
  "task.note_added": { group: "Task", label: "Note added", verb: "added a Note to" },
  "task.observed": { group: "Task", label: "Observation added", verb: "added an Observation to" },
  "task.blocker_added": { group: "Task", label: "Blocker added", verb: "added a blocker to" },
  "task.blocker_removed": { group: "Task", label: "Blocker removed", verb: "removed a blocker from" },
  "task.evidence_attached": { group: "Task", label: "Evidence attached", verb: "attached Evidence to" },
  "task.skill_proposed": { group: "Task", label: "Proposal", verb: "proposed" },
  "task.ranked": { group: "Task", label: "Ranked", verb: "ranked" },
  "task.owner_passed": { group: "Task", label: "Ownership passed", verb: "passed the ownership of" },
  "task.labels_set": { group: "Task", label: "Labels set", verb: "set the Labels of" },
  "workflow.changed": { group: "Workflow", label: "Changed", verb: "changed" },
  "label.created": { group: "Label", label: "Created", verb: "created the Label" },
  "label.changed": { group: "Label", label: "Changed", verb: "changed the Label" },
  "label.deleted": { group: "Label", label: "Deleted", verb: "deleted the Label" },
  "project.created": { group: "Project", label: "Created", verb: "created the Project" },
  "project.changed": { group: "Project", label: "Changed", verb: "changed the Project" },
  "project.member_added": { group: "Project", label: "Member added", verb: "added" },
  "project.member_removed": { group: "Project", label: "Member removed", verb: "removed" },
  "skill.created": { group: "Skill", label: "Created", verb: "created the Skill" },
  "skill.version_published": { group: "Skill", label: "Version published", verb: "published" },
  "member.created": { group: "Member", label: "Created", verb: "created the Member" },
  "member.updated": { group: "Member", label: "Updated", verb: "updated the Member" },
  "member.manager_set": { group: "Member", label: "Reporting line set", verb: "set the Reporting line of" },
  "member.manager_cleared": { group: "Member", label: "Reporting line removed", verb: "removed the Reporting line of" },
  "member.skill_granted": { group: "Member", label: "Skill granted", verb: "granted a Skill to" },
  "member.skill_revoked": { group: "Member", label: "Skill taken away", verb: "took a Skill away from" },
  "member.deactivated": { group: "Member", label: "Deactivated", verb: "deactivated the Member" },
  "member.reactivated": { group: "Member", label: "Reactivated", verb: "reactivated the Member" },
  "member.agent_changed": { group: "Member", label: "Agent settings changed", verb: "changed the agent settings of" },
  "workspace.added": { group: "Workspace", label: "Added", verb: "added the Workspace" },
  "workspace.changed": { group: "Workspace", label: "Changed", verb: "changed the Workspace" },
  "workspace.removed": { group: "Workspace", label: "Removed", verb: "removed the Workspace" },
  "token.issued": { group: "Token", label: "Issued", verb: "issued the token" },
  "token.revoked": { group: "Token", label: "Revoked", verb: "revoked a token" },
  "session.closed": { group: "Session", label: "Closed", verb: "closed a Session" },
  "login_link.issued": { group: "Login link", label: "Issued", verb: "issued a login link for" },
  "login_link.redeemed": { group: "Login link", label: "Redeemed", verb: "signed in with a login link" },
  "file.uploaded": { group: "File", label: "Uploaded", verb: "uploaded" },
  "file.deleted": { group: "File", label: "Deleted", verb: "deleted" },
};

/** The groups a Project's Activity holds: what `/v1/activity?project=` returns. */
const projectGroups = new Set(["Task", "Workflow", "Label", "Project"]);

/** The kinds a Project's Kind filter offers, in menu order, with their group and label. */
export const kindChoices = Object.entries(kinds)
  .filter(([, w]) => projectGroups.has(w.group))
  .map(([kind, w]) => ({ kind: kind as ActivityKind, group: w.group, label: w.label }));

/** A kind as the Kind chip names it: "Task lapsed", "Workflow changed". */
export function kindName(kind: string): string {
  const w = isKnown(kind) ? kinds[kind] : undefined;
  return w ? `${w.group} ${w.label.toLowerCase()}` : kind;
}

// /v1 adds kinds within the version and asks clients to skip those they do not know.
export function isKnown(kind: string): kind is ActivityKind {
  return Object.hasOwn(kinds, kind);
}

const claimEnds: Record<string, string> = {
  released: "released",
  advanced: "advanced",
  split: "split",
  completed: "completed",
  lapsed: "lapsed",
  taken_back: "taken back",
  dropped: "dropped",
  token_revoked: "token revoked",
  session_closed: "Session closed",
  member_deactivated: "Member deactivated",
};

const projectFields: Record<string, string> = {
  name: "name",
  default_workspace_id: "default Workspace",
  auto_complete: "Auto-complete",
  acceptance: "Acceptance",
};

function text(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function number(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" ? v : undefined;
}

function list(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** "2 s", "15 min": a Heartbeat timeout in seconds. */
export function timeoutText(seconds: number): string {
  return untilText(seconds * 1000);
}

/** The sentence an entry says, or null for a kind this app does not know. */
export function describe(e: Activity, l: Lookup): Sentence | null {
  if (!isKnown(e.kind)) return null;
  const p = e.payload;
  const member = (id: string | undefined) => (id ? (l.members.get(id)?.name ?? "a Member") : "a Member");
  const skill = (id: string | undefined) => (id ? (l.skills.get(id)?.name ?? "a Skill") : undefined);
  const step = (id: string | undefined): Part => (id ? { step: id, name: l.stepName(id) ?? "a Step" } : "a Step");
  const stepWord = (id: string | undefined) => (id ? (l.stepName(id) ?? "a Step") : undefined);
  const task = (id: string | undefined) => (id ? l.tasks.get(id)?.key : undefined);
  const s: Sentence = {
    actorId: e.actor_id,
    actorName: e.actor_id ? member(e.actor_id) : "Darkory",
    verb: kinds[e.kind].verb || undefined,
    after: [],
    details: [],
  };

  // The record the entry is about.
  switch (e.subject_type) {
    case "task": {
      const t = l.tasks.get(e.subject_id) ?? named(p);
      s.subject = t ? { type: "task", ...t } : { type: "text", text: "a Task" };
      break;
    }
    case "member":
      s.subject = { type: "text", text: member(e.subject_id) };
      break;
    case "project":
      s.subject = { type: "text", text: l.projects.get(e.subject_id)?.name ?? text(p, "name") ?? "a Project" };
      break;
    case "workflow":
      s.subject = { type: "workflow", projectId: e.subject_id };
      break;
    case "label":
      s.subject = { type: "text", text: text(p, "name") ?? l.labels?.get(e.subject_id)?.name ?? "a Label" };
      break;
    case "skill":
      s.subject = { type: "text", text: l.skills.get(e.subject_id)?.name ?? text(p, "name") ?? "a Skill" };
      break;
    case "file":
      s.subject = { type: "text", text: text(p, "name") ?? "a File" };
      break;
  }

  switch (e.kind) {
    case "task.filed": {
      // Darkory's own filings (a Breakdown, an Acceptance, a Retrospective) have no actor.
      if (text(p, "step_id")) s.after.push("at", step(text(p, "step_id")));
      if (p.aimed_at_id) s.after.push(`aimed at ${member(text(p, "aimed_at_id"))}`);
      if (text(p, "parent_id")) s.details.push(`under ${task(text(p, "parent_id")) ?? "a Parent"}`);
      if (text(p, "blocks")) s.details.push(`blocks ${task(text(p, "blocks")) ?? "a Task"}`);
      if (p.breakdown) s.details.push("with Break down");
      break;
    }
    case "task.claimed": {
      const sk = skill(text(p, "skill_id"));
      if (sk) s.details.push(sk);
      const timeout = number(p, "heartbeat_timeout_seconds");
      if (text(p, "model_label")) s.details.push(text(p, "model_label")!);
      else if (timeout) s.details.push(`Heartbeat every ${timeoutText(timeout)}`);
      break;
    }
    case "task.advanced":
      s.after.push("along", { outcome: text(p, "outcome") ?? "" }, "to", step(text(p, "to")));
      if (stepWord(text(p, "from"))) s.details.push(`from ${stepWord(text(p, "from"))}`);
      break;
    case "task.moved":
      s.after.push("to", step(text(p, "to")));
      if (stepWord(text(p, "from"))) s.details.push(`from ${stepWord(text(p, "from"))}`);
      if (p.workflow_changed) s.details.push("its Step was deleted");
      break;
    case "task.completed":
      if (text(p, "outcome")) s.after.push("along", { outcome: text(p, "outcome")! });
      if (stepWord(text(p, "from"))) s.details.push(`from ${stepWord(text(p, "from"))}`);
      break;
    case "task.dropped":
      if (text(p, "holder_id")) s.details.push(`held by ${member(text(p, "holder_id"))}`);
      break;
    case "task.lapsed": {
      s.mark = "lapsed";
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      const claimed = l.claims.get(text(p, "claim_id") ?? "");
      const timeout = claimed && number(claimed.payload, "heartbeat_timeout_seconds");
      if (timeout) s.details.push(`no Heartbeat in ${timeoutText(timeout)}`);
      break;
    }
    case "task.nudged":
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      if (number(p, "nudge")) s.details.push(`nudge ${number(p, "nudge")} of 2`);
      break;
    case "task.taken_back":
      s.mark = "taken_back";
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      if (text(p, "reason")) s.details.push(text(p, "reason")!);
      break;
    case "task.claim_ended":
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      if (text(p, "how_ended")) s.details.push(claimEnds[text(p, "how_ended")!] ?? text(p, "how_ended")!);
      break;
    case "member.updated":
      if (Object.hasOwn(p, "avatar_file_id")) s.details.push(p.avatar_file_id ? "new Avatar" : "Avatar removed");
      break;
    case "file.uploaded":
      if (text(p, "purpose") === "avatar") s.details.push("as an Avatar");
      break;
    case "file.deleted":
      if (p.released) s.details.push("an Avatar no one shows");
      break;
    case "task.split":
      s.after.push("into Subtasks");
      s.details.push("its Claim ended");
      break;
    case "task.became_parent":
      s.after.push("a Parent");
      if (stepWord(text(p, "from"))) s.details.push(`off ${stepWord(text(p, "from"))}`);
      break;
    case "task.observed":
      s.outcome = text(p, "outcome") === "worked" ? "worked" : "didnt_work";
      break;
    case "task.blocker_added":
    case "task.blocker_removed":
      if (text(p, "blocker_key")) s.details.push(`blocked by ${text(p, "blocker_key")}`);
      else if (task(text(p, "blocker_id"))) s.details.push(`blocked by ${task(text(p, "blocker_id"))}`);
      break;
    case "task.evidence_attached":
      if (text(p, "filename")) s.evidence = { id: text(p, "evidence_id") ?? "", filename: text(p, "filename")!, size: number(p, "size") };
      break;
    case "task.skill_proposed":
      s.verb = `proposed ${skill(text(p, "skill_id")) ?? "a Skill"} v${(number(p, "based_on_version") ?? 0) + 1} on`;
      break;
    case "task.ranked":
      s.details.push(`Rank #${text(p, "from")} → #${text(p, "to")}`);
      break;
    case "task.owner_passed":
      s.after.push(`to ${member(text(p, "to"))}`);
      break;
    case "task.labels_set": {
      const name = (id: string) => l.labels?.get(id)?.name ?? "a Label";
      const added = list(p, "added").map((id) => `+${name(id)}`);
      const removed = list(p, "removed").map((id) => `−${name(id)}`);
      if (added.length + removed.length > 0) s.details.push([...added, ...removed].join(" "));
      else if (list(p, "labels").length === 0) s.details.push("none");
      break;
    }
    case "workflow.changed": {
      const steps = Array.isArray(p.steps) ? p.steps.length : undefined;
      if (steps !== undefined) s.details.push(count(steps, "Step"));
      const moved = number(p, "tasks_moved");
      if (moved) s.details.push(`${count(moved, "Task")} moved`);
      break;
    }
    case "label.created":
      if (!text(p, "project_id")) s.details.push("for every Project");
      break;
    case "label.changed":
      if (text(p, "name")) s.details.push(`renamed ${text(p, "name")}`);
      if (text(p, "color") && !text(p, "name")) s.details.push("colour");
      break;
    case "label.deleted": {
      const n = number(p, "tasks");
      if (n) s.details.push(`taken off ${count(n, "Task")}`);
      break;
    }
    case "project.created":
      if (text(p, "key")) s.details.push(text(p, "key")!);
      break;
    case "project.changed": {
      const changed = Object.keys(p).map((k) => projectFields[k] ?? k);
      if (changed.length > 0) s.details.push(changed.join(", "));
      break;
    }
    case "project.member_added":
    case "project.member_removed": {
      const project = s.subject?.type === "text" ? s.subject.text : "a Project";
      s.subject = { type: "text", text: member(text(p, "member_id")) };
      s.after.push(`${e.kind === "project.member_added" ? "to" : "from"} ${project}`);
      break;
    }
    case "skill.version_published":
      s.subject = { type: "text", text: `${l.skills.get(e.subject_id)?.name ?? "a Skill"} v${text(p, "version")}` };
      break;
    case "member.manager_set":
      s.details.push(`to ${member(text(p, "manager_id"))}`);
      break;
    case "member.skill_granted":
    case "member.skill_revoked":
      s.details.push(skill(text(p, "skill_id")) ?? "a Skill");
      break;
    case "token.issued":
      s.subject = { type: "text", text: text(p, "name") ?? "" };
      s.after.push(`for ${member(text(p, "member_id"))}`);
      break;
    case "token.revoked":
      s.after.push(`for ${member(text(p, "member_id"))}`);
      break;
    case "session.closed": {
      const n = number(p, "claims_ended");
      if (n) s.details.push(`${count(n, "Claim")} ended`);
      break;
    }
    case "login_link.issued":
      s.subject = { type: "text", text: member(text(p, "member_id")) };
      break;
  }
  return s;
}

/** A Task's key and title from the entry that filed it. */
function named(p: Record<string, unknown>): { key: string; title: string } | undefined {
  const key = text(p, "key");
  return key ? { key, title: text(p, "title") ?? "" } : undefined;
}

export const markWords: Record<Mark, string> = { lapsed: "Lapsed", taken_back: "Taken back" };

function partText(part: Part): string {
  if (typeof part === "string") return part;
  if ("step" in part) return part.name;
  return part.outcome;
}

/**
 * The sentence as plain text, as a screen reader reads the row: "builder advanced WEB-4 Payment
 * form along pass to Review · from Build".
 */
export function sentenceText(s: Sentence, workflowName = "the Workflows"): string {
  const words: string[] = [s.actorName];
  if (s.mark) words.push(markWords[s.mark]);
  if (s.verb) words.push(s.verb);
  if (s.subject) words.push(s.subject.type === "text" ? s.subject.text : s.subject.type === "workflow" ? workflowName : `${s.subject.key} ${s.subject.title}`.trim());
  words.push(...s.after.map(partText));
  if (s.outcome) words.push(s.outcome === "worked" ? "Worked" : "Didn't work");
  if (s.evidence) words.push(s.evidence.filename);
  return [words.filter(Boolean).join(" "), ...s.details].join(" · ");
}
