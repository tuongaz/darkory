import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ComboOption } from "./Combobox";

/**
 * A field that picks several of many, in order (kit `.select` with chips): the choices as chips,
 * each with × to take it out, then a button that opens a searchable list where an item is added
 * or taken out. `id` ties the button to its label.
 */
export function MultiCombobox({
  id,
  values,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  empty,
  icon,
  invalid,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: ComboOption[];
  placeholder: string;
  searchPlaceholder: string;
  empty: string;
  icon?: ReactNode;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const byValue = new Map(options.map((o) => [o.value, o]));
  const chosen = values.flatMap((v) => byValue.get(v) ?? []);
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The list opens under the whole field, not under its button. */}
      <PopoverAnchor asChild>
        <div
          aria-invalid={invalid || undefined}
          className="flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background py-[5px] pr-1.5 pl-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
        >
          {chosen.map((o) => (
            <span key={o.value} className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border bg-background pr-1 pl-2 text-xs whitespace-nowrap [&_svg]:size-3 [&_svg]:text-muted-foreground">
              {o.icon}
              <span className="truncate">{o.label}</span>
              <button
                type="button"
                aria-label={`Take out ${o.label}`}
                onClick={() => onChange(values.filter((v) => v !== o.value))}
                className="grid size-4 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon />
              </button>
            </span>
          ))}
          <PopoverTrigger asChild>
            <button
              id={id}
              type="button"
              role="combobox"
              aria-expanded={open}
              className="flex h-6 min-w-24 flex-1 items-center gap-2 rounded-sm px-1 text-left text-muted-foreground outline-none [&_svg]:size-3.5 [&_svg]:flex-none"
            >
              {chosen.length === 0 && icon}
              <span className="min-w-0 flex-1 truncate">{chosen.length === 0 ? placeholder : ""}</span>
              <ChevronsUpDownIcon aria-hidden />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-64">
            <CommandEmpty>{empty}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = values.includes(o.value);
                return (
                  <CommandItem key={o.value} value={o.value} keywords={[o.label, ...(o.keywords ?? [])]} onSelect={() => toggle(o.value)} data-checked={on}>
                    <CheckIcon className={cn(!on && "invisible")} aria-hidden />
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                    {o.detail && <span className="ml-auto min-w-0 truncate">{o.detail}</span>}
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
