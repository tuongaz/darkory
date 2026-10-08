import type { Project } from "@/api/client";
import { cn } from "@/lib/utils";

// The chart tokens a Project's mark is filled with, picked by its key so a Project keeps its colour.
const fills = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

function projectFill(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return fills[h % fills.length];
}

const sizes = {
  sm: "size-3.5 rounded-[4px] text-[8px]",
  md: "size-5 rounded-[5px] text-[11px]",
  lg: "size-7 rounded-[7px] text-[13px]",
};

/**
 * A Project's square mark: the first letter of its name on its colour. `sm` 14px (rows, crumbs),
 * `md` 20px, `lg` 28px (a page head).
 */
export function ProjectMark({
  project,
  size = "sm",
  className,
}: {
  project: Pick<Project, "key" | "name">;
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid flex-none place-items-center leading-none font-semibold text-on-solid",
        sizes[size],
        projectFill(project.key),
        className,
      )}
    >
      {(project.name[0] ?? project.key[0] ?? "?").toUpperCase()}
    </span>
  );
}
