import type { Claim, Label, Member, MemberDetail, Project, Session, Skill, SkillProposal, Task, TaskDetail, Token, Workspace, WorkspaceMode } from "@/api/client";

export type { Session };

/** The name of the first token an agent created in the web app gets. */
export const firstTokenName = "default";

/** Members split by kind, each group in the order given (the API lists by name). */
export function groupByKind<M extends Pick<Member, "kind">>(members: M[]): { humans: M[]; agents: M[] } {
  return { humans: members.filter((m) => m.kind === "human"), agents: members.filter((m) => m.kind === "agent") };
}

/** Humans first, then agents: how avatars stack. */
export function humansFirst<M extends Pick<Member, "kind">>(members: M[]): M[] {
  const { humans, agents } = groupByKind(members);
  return [...humans, ...agents];
}

export function liveTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => !t.revoked_at);
}

/** A held Task with the Claim that holds it. */
export type Held = { task: Task; claim: Claim };

export function heldClaims(tasks: Task[]): Held[] {
  return tasks.flatMap((task) => (task.claim && !task.claim.ended_at ? [{ task, claim: task.claim }] : []));
}

/**
 * The Claims bound to a Session: those made through it with a Heartbeat timeout. A Claim made
 * without one is bound to the Member, and closing the Session leaves it.
 */
export function boundToSession(held: Held[], session: string): Held[] {
  return held.filter((h) => h.claim.session_id === session && !!h.claim.heartbeat_timeout_seconds);
}

/** Everything a Member holds through a Session, bound to it or not: what its row says it is doing. */
export function madeThrough(held: Held[], session: string): Held[] {
  return held.filter((h) => h.claim.session_id === session);
}

/** What revoking a token stops: its open Sessions, and the Claims bound to them. */
export function revokeSummary(token: Token, sessions: Session[], held: Held[]) {
  const closed = sessions.filter((s) => s.token_id === token.id);
  return { sessions: closed, claims: closed.flatMap((s) => boundToSession(held, s.id)) };
}

/**
 * What deactivating a Member stops, from their live record: every live token revoked, every open
 * Session closed, and every Claim they hold ended, bound to a Session or to the Member.
 */
export function deactivateSummary(tokens: Token[], sessions: Session[], held: Held[]) {
  return { tokens: liveTokens(tokens), sessions, claims: held };
}

/** "1 token", "3 Sessions". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A pending proposal written against a Skill, with the Retrospective that carries it. */
export type Pending = { proposal: SkillProposal; retro: TaskDetail };

/**
 * The pending proposals written against a Skill, oldest first. A Retrospective carries at most
 * one per Skill, and several Retrospectives may propose to the same Skill at once.
 */
export function pendingProposals(skill: Pick<Skill, "id">, retros: TaskDetail[]): Pending[] {
  return retros
    .flatMap((retro) => retro.proposals.filter((p) => p.state === "pending" && p.skill_id === skill.id).map((proposal) => ({ proposal, retro })))
    .sort((a, b) => a.proposal.created_at.localeCompare(b.proposal.created_at));
}

/** The Members holding each Skill, by Skill id. */
export function holdersBySkill(details: Map<string, MemberDetail>): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  for (const d of details.values()) {
    for (const s of d.skills) out.set(s.id, [...(out.get(s.id) ?? []), d.member]);
  }
  return out;
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** A line diff of `before` against `after`, by the longest common run of lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // lcs[i][j]: the common lines of a[i:] and b[j:].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++] });
  while (j < b.length) out.push({ op: "add", text: b[j++] });
  return out;
}

function splitLines(s: string): string[] {
  const lines = s.split("\n");
  // A closing newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A Skill name as /v1 takes it. */
export const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A Workspace name as /v1 takes it. */
export const workspaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** How work lands in a Workspace, as the Mode select names it: merged on this machine, or through pull requests. */
export const modeNames: Record<WorkspaceMode, string> = { plain: "Local", pull_request: "Pull request" };

/** The Projects whose Tasks work in a Workspace when they name none. */
export function defaultOf(w: Pick<Workspace, "id">, projects: Project[]): Project[] {
  return projects.filter((p) => p.default_workspace_id === w.id);
}

/** The Tasks that name a Workspace. */
export function naming(w: Pick<Workspace, "id">, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.workspace_ids?.includes(w.id));
}

/** A Label's colour as /v1 takes it. */
export const colorPattern = /^#[0-9a-fA-F]{6}$/;

/**
 * The colours a new Label is offered, Linear's set: grey, blue, violet, pink, red, orange, amber,
 * green, teal. Any other `#rrggbb` may be typed.
 */
export const labelColors = ["#95a2b3", "#4ea7fc", "#8b5cf6", "#d946a8", "#eb5757", "#f2994a", "#f2c94c", "#4cb782", "#26b5ce"];

/** The colour to offer a new Label: the first of the set no Label has yet, else the first. */
export function nextColor(taken: string[]): string {
  const used = new Set(taken.map((c) => c.toLowerCase()));
  return labelColors.find((c) => !used.has(c)) ?? labelColors[0];
}

/** Why a name cannot be used, or nothing: empty, too long, or another Label's (ignoring case). */
export function labelNameProblem(name: string, taken: Label[], self?: Label): string | undefined {
  const n = name.trim();
  if (!n) return "A Label needs a name.";
  if (n.length > 100) return "At most 100 characters.";
  const clash = taken.find((l) => l.id !== self?.id && l.name.toLowerCase() === n.toLowerCase());
  if (clash) return clash.project_id ? `This Project has a Label ${clash.name}.` : `The Organisation has a Label ${clash.name}.`;
  return undefined;
}
