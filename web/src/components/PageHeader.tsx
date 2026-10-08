import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The head of a record page (a Task, a Member, a Skill), under the top bar: an optional mark,
 * the title, a line of facts, and the page's actions on the right. The screen's one primary
 * action goes in the top bar, not here.
 */
export function PageHeader({
  title,
  mark,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  mark?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start gap-3.5 pb-5", className)}>
      {mark}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
        {meta && <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** A section heading inside a page or a Peek: the name, an optional count, and actions on the right. */
export function SectionHeader({ title, count, actions }: { title: ReactNode; count?: number; actions?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-2 font-semibold">
      <h2>{title}</h2>
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}
