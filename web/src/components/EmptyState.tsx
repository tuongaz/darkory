import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What an empty list or page says (kit `.empty`): an icon, a heading of at most three words, one
 * line saying the one next thing, and the action that does it.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center text-muted-foreground", className)}>
      {icon && <span className="[&_svg]:size-6">{icon}</span>}
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      {children && <p className="max-w-sm">{children}</p>}
      {action}
    </div>
  );
}
