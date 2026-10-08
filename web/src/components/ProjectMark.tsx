import type { Project } from "@/api/client";
import { markFill, projectHue } from "@/lib/projectHue";
import { cn } from "@/lib/utils";

const sizes = {
  sm: "size-3.5 rounded-[4px] text-[8px]",
  md: "size-5 rounded-[5px] text-[11px]",
  lg: "size-7 rounded-[7px] text-[13px]",
};

/**
 * A Project's square mark: the first letter of its name on its stored colour. `sm` 14px (rows, crumbs),
 * `md` 20px, `lg` 28px (a page head). The fill is written through the style property (a CSSOM
 * write, which the app's CSP allows).
 */
export function ProjectMark({
  project,
  size = "sm",
  className,
}: {
  project: Pick<Project, "key" | "name" | "color">;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const hue = projectHue(project.color);
  return (
    <span
      aria-hidden
      data-hue={hue}
      className={cn("inline-grid flex-none place-items-center leading-none font-semibold text-on-solid", sizes[size], className)}
      style={{ backgroundColor: markFill(project.color) }}
    >
      {(project.name[0] ?? project.key[0] ?? "?").toUpperCase()}
    </span>
  );
}
