import type { TaskDetail, Workspace } from "@/api/client";
import { taskBranch } from "@/lib/branch";

/**
 * The branch a Task's pull request lands on, as the Runner checks it before merging: a Subtask's
 * lands on its Parent's branch; any other Task's on the default branch of its Workspace in
 * `pull_request` mode, the one it names or else its Project's default; "main" when neither says.
 */
export function mergeBase(detail: Pick<TaskDetail, "workspaces" | "parent">, workspaces: readonly Workspace[], projectDefault?: string): string {
  if (detail.parent) return taskBranch(detail.parent.key, detail.parent.title);
  const named = detail.workspaces.find((w) => w.mode === "pull_request");
  const fallback = projectDefault ? workspaces.find((w) => w.id === projectDefault && w.mode === "pull_request") : undefined;
  return (named ?? fallback)?.default_branch || "main";
}
