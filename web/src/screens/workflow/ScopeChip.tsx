import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { LineData } from "@/components/workflowLine";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The scope in the breadcrumb: "All Tasks ▾", "No Parent ▾", or a Parent or Task by key and title
 * with × to widen again. Its menu finds any open Task, and lists All Tasks, the Parents with open
 * Subtasks and No Parent with their counts; hovering a Parent rings its tokens on the line.
 */
export function ScopeChip({
  data,
  onScope,
  onPreview,
}: {
  data: LineData;
  onScope: (scope: string | null) => void;
  onPreview?: (parentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pick = (s: string | null) => {
    setOpen(false);
    setQuery("");
    onPreview?.(null);
    onScope(s);
  };
  const atSteps = data.all.filter((t) => t.stepId).length;
  const named = data.scope.kind === "parent" || data.scope.kind === "task" ? data.scope.id : undefined;
  const task = named ? (data.all.find((t) => t.id === named) ?? data.parents.find((p) => p.id === named)) : undefined;
  const label = data.scope.kind === "all" ? "All Tasks" : data.scope.kind === "none" ? "No Parent" : task ? `${task.key} ${task.title}` : "One Task";
  const narrowed = data.scope.kind !== "all";
  return (
    <span className={cn("inline-flex h-7 max-w-[260px] min-w-0 items-center rounded-md border bg-background text-foreground", narrowed && "border-foreground")}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) onPreview?.(null);
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Scope: ${label}`} className="flex h-full min-w-0 items-center gap-1 px-2 text-[13px] font-medium">
            {named && task ? (
              <>
                <span className="flex-none font-mono text-[11.5px] text-muted-foreground">{task.key}</span>
                <span className="min-w-0 truncate">{task.title}</span>
              </>
            ) : (
              <span className="truncate">{label}</span>
            )}
            <ChevronDownIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[250px] p-0">
          <Command filter={(_v, search, words) => ((words ?? []).join(" ").toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
            <CommandInput placeholder="Find a Task…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[min(60vh,380px)]">
              <CommandEmpty>No open Task matches.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="all" keywords={["All Tasks"]} onSelect={() => pick(null)}>
                  <CheckIcon aria-hidden className={cn("size-3.5", data.scope.kind !== "all" && "invisible")} />
                  All Tasks
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{atSteps}</span>
                </CommandItem>
              </CommandGroup>
              {data.parents.length > 0 && (
                <CommandGroup heading="Parents">
                  {data.parents.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`parent ${p.id}`}
                      keywords={[p.key, p.title]}
                      onSelect={() => pick(p.id)}
                      onMouseEnter={() => onPreview?.(p.id)}
                      onMouseLeave={() => onPreview?.(null)}
                    >
                      <CheckIcon aria-hidden className={cn("size-3.5", named !== p.id && "invisible")} />
                      <span className="flex-none font-mono text-[11px] text-muted-foreground">{p.key}</span>
                      <span className="min-w-0 truncate">{p.title}</span>
                      <span className="ml-auto flex-none text-xs text-muted-foreground">{p.open} open</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Other">
                <CommandItem value="none" keywords={["No Parent"]} onSelect={() => pick("none")}>
                  <CheckIcon aria-hidden className={cn("size-3.5", data.scope.kind !== "none" && "invisible")} />
                  No Parent
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{data.noParent}</span>
                </CommandItem>
              </CommandGroup>
              {/* Found only by typing: any open Task at a Step, its path traced on the line. */}
              {query.trim() && (
                <CommandGroup heading="Tasks">
                  {data.all
                    .filter((t) => t.stepId)
                    .map((t) => (
                      <CommandItem key={t.id} value={`task ${t.id}`} keywords={[t.key, t.title]} onSelect={() => pick(t.id)}>
                        <CheckIcon aria-hidden className={cn("size-3.5", named !== t.id && "invisible")} />
                        <span className="flex-none font-mono text-[11px] text-muted-foreground">{t.key}</span>
                        <span className="min-w-0 truncate">{t.title}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {narrowed && (
        <button type="button" aria-label="All Tasks" onClick={() => pick(null)} className="flex h-full flex-none items-center border-l px-1.5 text-muted-foreground hover:text-foreground">
          <XIcon aria-hidden className="size-3" />
        </button>
      )}
    </span>
  );
}
