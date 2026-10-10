import { GitMergeIcon, GitPullRequestArrowIcon } from "lucide-react";
import type { PullRequest } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * "#7 open" or "#7 merged": a Task's pull request as the Runner read it on GitHub, a link to it
 * in a new tab. Merged is the done tone; open is a plain fact.
 */
export function PullRequestChip({ pr, className }: { pr: PullRequest; className?: string }) {
  const merged = pr.state === "merged";
  const Icon = merged ? GitMergeIcon : GitPullRequestArrowIcon;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer noopener"
      title={pr.url}
      className={cn(
        "inline-flex h-5 flex-none items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap tabular-nums hover:underline",
        merged ? "border-transparent bg-state-done-bg text-state-done" : "text-foreground",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />#{pr.number} {pr.state}
    </a>
  );
}
