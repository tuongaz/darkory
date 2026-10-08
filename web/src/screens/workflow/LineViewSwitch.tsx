import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LineView } from "./lineView";

const names: Record<LineView, string> = { line: "Line", blocking: "Blocking", text: "Text" };

/**
 * Line | Blocking (N) | Text, the live page's view switcher. Blocking shows how many Blockings
 * stand among the Project's open Tasks (no count while it is read), and is left out when there are
 * none. On a phone it folds to one compact menu, so the breadcrumb keeps its room.
 */
export function LineViewSwitch({ view, onChange, blocking }: { view: LineView; onChange: (v: LineView) => void; blocking: number | undefined }) {
  const views: LineView[] = ["line", ...(blocking !== 0 || view === "blocking" ? (["blocking"] as const) : []), "text"];
  const count = (v: LineView) => (v === "blocking" && blocking !== undefined ? blocking : undefined);
  return (
    <>
      <div role="group" aria-label="View" className="hidden items-center gap-0.5 rounded-md bg-muted p-0.5 sm:flex">
        {views.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onChange(v)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              view === v && "bg-background text-foreground shadow-soft",
            )}
          >
            {names[v]}
            {count(v) !== undefined && <span className="tabular-nums text-muted-foreground">{count(v)}</span>}
          </button>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`View: ${names[view]}`} className="flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium sm:hidden">
            {names[view]}
            <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {views.map((v) => (
            <DropdownMenuItem key={v} onSelect={() => onChange(v)}>
              <CheckIcon aria-hidden className={cn("size-3.5", view !== v && "invisible")} />
              {names[v]}
              {count(v) !== undefined && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count(v)}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
