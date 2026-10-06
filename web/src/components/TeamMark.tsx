import type { Team } from "@/api/client";
import { cn } from "@/lib/utils";

// The chart tokens a Team's mark is filled with, picked by its key so a Team keeps its colour.
const fills = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

function teamFill(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return fills[h % fills.length];
}

/** A Team's square mark: the first letter of its name on its colour. */
export function TeamMark({ team, size = "sm", className }: { team: Pick<Team, "key" | "name">; size?: "sm" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid flex-none place-items-center font-semibold leading-none text-on-solid",
        size === "sm" ? "size-3.5 rounded-[4px] text-[8px]" : "size-7 rounded-[7px] text-[13px]",
        teamFill(team.key),
        className,
      )}
    >
      {(team.name[0] ?? team.key[0] ?? "?").toUpperCase()}
    </span>
  );
}
