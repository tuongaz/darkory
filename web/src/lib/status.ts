/** The six glyphs kit.css draws as `.st`: one per Status kind, and In review for a later In-progress Status. */
export type Glyph = "backlog" | "todo" | "inprogress" | "inreview" | "done" | "dropped";

/** The kinds a Status can have (CONTEXT.md, Status). */
export type StatusKind = "backlog" | "todo" | "in_progress" | "done" | "dropped";

/**
 * The glyph for a Status of `kind`: the first In-progress Status of the Organisation's list draws
 * half full, any later one (In review) three quarters full in the waiting blue.
 */
export function glyphFor(kind: StatusKind, nthOfKind = 0): Glyph {
  switch (kind) {
    case "in_progress":
      return nthOfKind === 0 ? "inprogress" : "inreview";
    default:
      return kind;
  }
}
