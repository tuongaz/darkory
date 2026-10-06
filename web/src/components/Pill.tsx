import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The kit's `.badge` tones. The state tones are ink on a tint: waiting (open, takeable), claimed
 * (held), blocked, done (done or shipped), dropped (also lapsed, deactivated: a dimmed row's
 * reason), agent. outline carries a Skill name; secondary a Task kind or a fact.
 */
export type PillTone =
  | "waiting"
  | "claimed"
  | "blocked"
  | "done"
  | "dropped"
  | "agent"
  | "outline"
  | "secondary"
  | "destructive";

const tones: Record<PillTone, string> = {
  waiting: "bg-state-waiting-bg text-state-waiting",
  claimed: "bg-state-claimed-bg text-state-claimed",
  blocked: "bg-state-blocked-bg text-state-blocked",
  done: "bg-state-done-bg text-state-done",
  dropped: "bg-state-dropped-bg text-state-dropped",
  agent: "bg-agent-bg text-agent",
  outline: "border-border text-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive text-white",
};

/** A short status or label: at most two words, e.g. "Blocked by WEB-8", "Shipped", "web-engineer". */
export function Pill({ tone = "secondary", className, children }: { tone?: PillTone; className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" data-tone={tone} className={cn(tones[tone], tone !== "outline" && "border-transparent", className)}>
      {children}
    </Badge>
  );
}
