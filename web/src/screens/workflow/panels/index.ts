import { createElement } from "react";

// The contract of the Workflow page's two panels under the line: Needs you (decision cards, left)
// and What's happening (one story per Task, right). Stubs until their builder lands them; this
// file is replaced whole.

export type NeedsYouPanelProps = {
  /** The Project's key. */
  project: string;
  /** A card hovered (its Task's token is ringed on the line), or null when it leaves. */
  onHover(taskId: string | null): void;
};

export type StoriesPanelProps = {
  project: string;
  onHover(taskId: string | null): void;
  /** A story opened: the Task's peek. */
  onOpen(taskId: string): void;
};

export function NeedsYouPanel(props: NeedsYouPanelProps) {
  return createElement("section", { "aria-label": "Needs you", "data-stub": "needs-you", "data-project": props.project, className: "p-5 text-muted-foreground" }, "Needs you");
}

export function StoriesPanel(props: StoriesPanelProps) {
  return createElement("section", { "aria-label": "What's happening", "data-stub": "stories", "data-project": props.project, className: "p-5 text-muted-foreground" }, "What's happening");
}
