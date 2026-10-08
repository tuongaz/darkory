import { useMutation } from "@tanstack/react-query";
import { CheckIcon, TagIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, call, type TaskDetail } from "@/api/client";
import { useLabels } from "@/api/queries";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { LabelPill } from "../board/bits";
import { useTaskWorkflow } from "./queries";

/**
 * The Labels a Task carries; for a Member of its Project or its Owner, a menu that sets them (the
 * Project's own and the Organisation's), each change one write of the whole set.
 */
export function LabelsEditor({ detail, editable }: { detail: TaskDetail; editable: boolean }) {
  const { project } = useTaskWorkflow(detail.task.project_id);
  const carried = useLabels(project?.key);
  const [open, setOpen] = useState(false);
  const ids = detail.labels.map((l) => l.id);
  const set = useMutation({
    mutationFn: (labels: string[]) => call(api.PUT("/v1/tasks/{task}/labels", { params: { path: { task: detail.task.id } }, body: { labels } })),
    onError: (err) => toast.error(`${detail.task.key}'s Labels not set`, { description: err.message }),
  });
  const pills = [...detail.labels].sort((a, b) => a.name.localeCompare(b.name)).map((l) => <LabelPill key={l.id} label={l} />);
  if (!editable) return pills.length ? <span className="flex flex-wrap items-center gap-1">{pills}</span> : null;
  const toggle = (id: string) => set.mutate(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={detail.labels.length ? `Labels: ${detail.labels.map((l) => l.name).join(", ")}` : "Add Labels"}
          className="inline-flex min-h-6 flex-wrap items-center gap-1 rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {pills.length ? (
            pills
          ) : (
            <span className="inline-flex items-center gap-1 text-xs">
              <TagIcon className="size-3.5" aria-hidden />
              Labels
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search Labels" />
          <CommandList className="max-h-64">
            <CommandEmpty>No Label</CommandEmpty>
            <CommandGroup>
              {(carried.data ?? []).map((l) => {
                const on = ids.includes(l.id);
                return (
                  <CommandItem key={l.id} value={l.id} keywords={[l.name]} onSelect={() => toggle(l.id)} data-checked={on}>
                    <CheckIcon className={cn(!on && "invisible")} aria-hidden />
                    <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: l.color }} />
                    <span className="truncate">{l.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{l.project_id ? project?.name : "Organisation"}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
