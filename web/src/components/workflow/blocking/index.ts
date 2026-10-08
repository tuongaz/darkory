import { createElement } from "react";

// The contract of the Blocking view (DEP-2): columns by what must end first, a band per Parent,
// the longest chain in black. A stub until its builder lands it; this file is replaced whole.

export type BlockingViewProps = {
  /** The Project's key. */
  project: string;
  /** A Parent's id: only its Subtasks and what blocks them. */
  scope?: string;
  /** "Show on the line": the page switches to the line with this Task selected. */
  onShowOnLine(taskId: string): void;
};

export function BlockingView(props: BlockingViewProps) {
  return createElement("p", { "data-stub": "blocking", className: "p-6 text-muted-foreground" }, props.scope ? "Blocking among these Subtasks" : "Blocking");
}
