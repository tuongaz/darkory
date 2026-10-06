import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A label/value grid, as the Task peek and the page's right rail show a record's facts (kit
 * `.props`). `compact` narrows the label column for the 300px rail.
 */
export function PropertiesRail({ children, compact, className, ...props }: ComponentProps<"dl"> & { compact?: boolean }) {
  return (
    <dl
      className={cn(
        "grid items-center gap-x-2 gap-y-2.5",
        compact ? "grid-cols-[84px_minmax(0,1fr)]" : "grid-cols-[100px_minmax(0,1fr)]",
        className,
      )}
      {...props}
    >
      {children}
    </dl>
  );
}

/** One row of a PropertiesRail. `stack` lays several values one under another (Blocks: WEB-6, WEB-7). */
export function Property({ label, children, stack }: { label: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className={cn("flex min-w-0 gap-1.5", stack ? "flex-col items-start gap-1" : "items-center")}>{children}</dd>
    </>
  );
}

/** A value that opens a menu or a picker in place (kit `.prop-btn`): a Status, a Feature. */
export function PropertyButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "-ml-1.5 inline-flex h-[26px] max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
