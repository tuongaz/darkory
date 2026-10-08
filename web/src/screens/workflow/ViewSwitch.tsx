import { ListIcon, WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { WorkflowView } from "./view";

/** Canvas | Text, the TopBar's view switcher: the Workflow drawn, or as a list. */
export function ViewSwitch({ view, onChange }: { view: WorkflowView; onChange: (v: WorkflowView) => void }) {
  const option = (v: WorkflowView, label: string, icon: ReactNode) => (
    <button
      type="button"
      aria-pressed={view === v}
      aria-label={label}
      onClick={() => onChange(v)}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
        view === v && "bg-background text-foreground shadow-soft",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
  return (
    <div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {option("canvas", "Canvas", <WorkflowIcon aria-hidden />)}
      {option("text", "Text", <ListIcon aria-hidden />)}
    </div>
  );
}
