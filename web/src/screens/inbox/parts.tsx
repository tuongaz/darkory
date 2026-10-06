import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, type To } from "react-router";
import { api, call, type Feature, type Task } from "@/api/client";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { StatusGlyph } from "@/components/StatusGlyph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startOfDay } from "./derive";
import { refusalToast } from "./toast";
import type { StatusView } from "./queries";

/** A section's band (kit `.group-h`): its name and how many rows it holds. */
export function GroupHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="flex h-[34px] items-center gap-2 border-b bg-muted pr-4 pl-6 font-medium">
      <h2>{title}</h2>
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** A line standing in for a section with nothing in it (kit `.none`). */
export function NoneLine({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="flex h-11 items-center gap-2 border-b pr-4 pl-6 text-muted-foreground [&_svg]:size-4">
      {icon}
      {children}
    </p>
  );
}

/** A Task's Status: its glyph and name. */
export function StatusCell({ status, className }: { status: StatusView | undefined; className?: string }) {
  if (!status) return <span className={className} />;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground", className)}>
      <StatusGlyph glyph={status.glyph} label={status.name} />
      <span className="truncate" aria-hidden>
        {status.name}
      </span>
    </span>
  );
}

/** The Feature a Task belongs to: its key and title, muted. */
export function FeatureCell({ feature, className }: { feature: Feature | undefined; className?: string }) {
  if (!feature) return <span className={className} />;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-muted-foreground", className)}>
      <Key>{feature.key}</Key>
      <span className="truncate">{feature.title}</span>
    </span>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "22:18" today, "6 Oct" before; the full time on hover. */
export function ShortTime({ at, className }: { at: string | undefined; className?: string }) {
  const now = useNow();
  if (!at) return <span className={className} />;
  const d = new Date(at);
  return (
    <time dateTime={at} title={full.format(d)} className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      {d.getTime() >= startOfDay(now) ? clock.format(d) : day.format(d)}
    </time>
  );
}

/**
 * The link that makes a whole row open its record: it covers the row, so the row's own buttons
 * and links sit above it (`relative z-10`).
 */
export function RowLink({ to, children, className }: { to: To; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn("truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline", className)}>
      {children}
    </Link>
  );
}

/** Claims the Task as the signed-in Member, with no expiry; a refusal is a toast. */
export function ClaimButton({ task, primary }: { task: Task; primary?: boolean }) {
  const claim = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: task.key } }, body: {} })),
    onError: refusalToast,
  });
  return (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      className="relative z-10"
      disabled={claim.isPending}
      aria-label={`Claim ${task.key}`}
      onClick={() => claim.mutate()}
    >
      Claim
    </Button>
  );
}

/** A Task's kind as a chip, for the Tasks Darkory files. */
export function KindPill({ task }: { task: Task }) {
  if (task.kind === "work") return null;
  return <Pill tone="secondary">{task.kind === "breakdown" ? "Break down" : "Retrospective"}</Pill>;
}
