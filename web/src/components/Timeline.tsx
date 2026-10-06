import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A record over time, oldest or newest first as the caller orders it (kit `.tl`): the Activity
 * page, a Task's record in the peek and on its page. Children are TimelineDay and TimelineRow.
 */
export function Timeline({ className, ...props }: ComponentProps<"ol">) {
  return <ol className={cn("flex flex-col", className)} {...props} />;
}

/** The day a run of rows happened on: "Today", "Mon 6 Oct". */
export function TimelineDay({ children }: { children: ReactNode }) {
  return <li className="pt-3.5 pb-1.5 text-2xs font-medium text-muted-foreground">{children}</li>;
}

/**
 * One entry: who (a MemberAvatar, or a dashed circle when Darkory acted, as on a lapse), what
 * happened in words, and when. A Note's text goes in `children` under the line.
 */
export function TimelineRow({ who, when, children, className }: { who: ReactNode; when: ReactNode; children: ReactNode; className?: string }) {
  return (
    <li className={cn("grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 py-1.5", className)}>
      <span className="grid h-5 place-items-center">{who}</span>
      <div className="min-w-0 [&_b]:font-medium">{children}</div>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{when}</span>
    </li>
  );
}

/** The mark for an entry no Member made (a lapse Darkory recorded): a dashed circle. */
export function SystemMark({ children }: { children?: ReactNode }) {
  return (
    <span
      role="img"
      aria-label="Darkory"
      className="grid size-5 place-items-center rounded-full border border-dashed border-ring bg-background text-muted-foreground [&_svg]:size-3"
    >
      {children}
    </span>
  );
}
