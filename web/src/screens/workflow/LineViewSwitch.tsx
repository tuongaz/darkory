import type { LineView } from "./lineView";
import { cn } from "@/lib/utils";

/**
 * Line | Blocking (N) | Text, the live page's view switcher. Blocking shows how many Blockings
 * stand among the Project's open Tasks, and is left out when there are none.
 */
export function LineViewSwitch({ view, onChange, blocking }: { view: LineView; onChange: (v: LineView) => void; blocking: number }) {
  const option = (v: LineView, label: string, count?: number) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => onChange(v)}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        view === v && "bg-background text-foreground shadow-soft",
      )}
    >
      {label}
      {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );
  return (
    <div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {option("line", "Line")}
      {(blocking > 0 || view === "blocking") && option("blocking", "Blocking", blocking)}
      {option("text", "Text")}
    </div>
  );
}
