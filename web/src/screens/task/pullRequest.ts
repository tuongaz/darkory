import type { TaskDetail, Workspace } from "@/api/client";
import { parentBranch } from "@/lib/branch";

/**
 * The branch a Task's pull request lands on, as the Runner checks it before merging: a Subtask's
 * lands on its Parent's branch, the Parent's key alone; any other Task's on the default branch of its Workspace in
 * `pull_request` mode, the one it names or else its Project's default; "main" when neither says.
 */
export function mergeBase(detail: Pick<TaskDetail, "workspaces" | "parent">, workspaces: readonly Workspace[], projectDefault?: string): string {
  if (detail.parent) return parentBranch(detail.parent.key);
  const named = detail.workspaces.find((w) => w.mode === "pull_request");
  const fallback = projectDefault ? workspaces.find((w) => w.id === projectDefault && w.mode === "pull_request") : undefined;
  return (named ?? fallback)?.default_branch || "main";
}

/** A pull request's address when the page may link it: https only (the server checks it; the page does not trust it). */
export function linkable(url: string): string | undefined {
  return url.startsWith("https://") ? url : undefined;
}
