import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import type { Workflow } from "@/api/client";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The Workflow in the breadcrumb, for a Project of two or more: the picked one's name and a
 * caret; its menu lists the Project's Workflows in order, a check on the picked one. Nothing for a
 * Project of one. The pick is `usePickedWorkflow`'s (pickedWorkflow.ts).
 */
export function WorkflowChip({ workflows, picked, onPick }: { workflows: readonly Workflow[]; picked: string | undefined; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (workflows.length < 2) return null;
  const ordered = [...workflows].sort((a, b) => a.position - b.position);
  const current = ordered.find((w) => w.id === picked) ?? ordered[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Workflow: ${current.name}`}
          className="inline-flex h-7 max-w-[220px] min-w-0 items-center gap-1 rounded-md border bg-background px-2 text-[13px] font-medium text-foreground"
        >
          <span className="truncate">{current.name}</span>
          <ChevronDownIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[220px] p-0"
        // The list takes the keys at once: ↑ ↓ walk the Workflows, Enter picks one.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[cmdk-root]")?.focus();
        }}
      >
        <Command defaultValue={current.id} label="Workflows">
          <CommandList className="max-h-[min(60vh,380px)]">
            <CommandGroup>
              {ordered.map((w) => (
                <CommandItem
                  key={w.id}
                  value={w.id}
                  keywords={[w.name]}
                  onSelect={() => {
                    setOpen(false);
                    if (w.id !== current.id) onPick(w.id);
                  }}
                >
                  <CheckIcon aria-hidden className={cn("size-3.5", w.id !== current.id && "invisible")} />
                  <span className="truncate">{w.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
