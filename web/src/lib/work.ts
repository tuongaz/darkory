/**
 * The derived state of a Task as its glyph draws it (model v2, ADR 0016): nothing here is stored.
 * Waiting, working and blocked follow from the Claim and Blocking; hold from the Task's step; a
 * Parent shows its Subtasks' progress instead of a state of its own.
 */

/** A Runner session's state, as `GET /v1/runner/sessions` reports it. */
export type SessionState = "running" | "waiting" | "stalled" | "ending";

/**
 * What a Member's mark says while it works: a Runner session's state for an agent, or `held` for
 * a human's live Claim (a human runs no session).
 */
export type Working = SessionState | "held";

export type MemberKind = "human" | "agent";

/** A Parent's Subtasks by how they stand: `working` counts the open ones with a live Claim. */
export type SubtaskCounts = { open: number; working: number; done: number; dropped: number };

export type WorkGlyph =
  | { glyph: "waiting" }
  | { glyph: "working"; holderKind: MemberKind; session?: SessionState }
  | { glyph: "blocked" }
  | { glyph: "hold" }
  | { glyph: "done" }
  | { glyph: "dropped" }
  | { glyph: "parent"; done: number; dropped: number; total: number };

export type GlyphInput = {
  state: "open" | "done" | "dropped";
  /** A live Claim holds the Task. */
  held?: boolean;
  holderKind?: MemberKind;
  /** The Runner's session on the Task, when one runs. */
  session?: SessionState;
  /** An open Task blocks it. */
  blocked?: boolean;
  /** The Task is at a step that carries no Skill. */
  atHold?: boolean;
  /** Present on a Parent: its Subtasks by how they stand. */
  counts?: SubtaskCounts;
};

/**
 * The glyph for a Task. The first that holds wins:
 *
 * 1. ended: done or dropped, a Parent too;
 * 2. a Parent: its progress, since it is at no step and is never claimed or blocked;
 * 3. held: working, in the holder's kind and its session's state, whatever else holds, since
 *    someone is on it (a holder who escalated still holds a Task their question blocks);
 * 4. blocked;
 * 5. at a hold step;
 * 6. waiting.
 */
export function glyphFor({ state, held, holderKind, session, blocked, atHold, counts }: GlyphInput): WorkGlyph {
  if (state !== "open") return { glyph: state };
  if (counts) {
    return { glyph: "parent", done: counts.done, dropped: counts.dropped, total: counts.open + counts.done + counts.dropped };
  }
  if (held) {
    const kind = holderKind ?? "human";
    return kind === "agent" && session ? { glyph: "working", holderKind: kind, session } : { glyph: "working", holderKind: kind };
  }
  if (blocked) return { glyph: "blocked" };
  if (atHold) return { glyph: "hold" };
  return { glyph: "waiting" };
}

/**
 * What a working mark draws: an agent's ring turns while its Claim is live and its session runs
 * (a live Claim with no Runner session counts as running), and stops in the session's colour
 * otherwise; a human's live Claim is a still ring.
 */
export function workingOf(holderKind: MemberKind, session?: SessionState): Working {
  return holderKind === "agent" ? (session ?? "running") : "held";
}

const sessionWords: Record<SessionState, string> = {
  running: "its session running",
  waiting: "its session waiting",
  stalled: "its session stalled",
  ending: "its session ending",
};

/** The glyph in words, for its `aria-label` and title. */
export function glyphLabel(g: WorkGlyph): string {
  switch (g.glyph) {
    case "waiting":
      return "Waiting";
    case "working":
      return g.holderKind === "agent" && g.session ? `Working, ${sessionWords[g.session]}` : "Working";
    case "blocked":
      return "Blocked";
    case "hold":
      return "At a hold";
    case "done":
      return "Done";
    case "dropped":
      return "Dropped";
    case "parent":
      return `${g.done} of ${g.total} Subtasks done${g.dropped ? `, ${g.dropped} dropped` : ""}`;
  }
}
