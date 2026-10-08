import { ChevronsUpDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ComboOption = { value: string; label: string; icon?: ReactNode; detail?: ReactNode; keywords?: string[] };

/**
 * A field that picks one of many (kit `.select` with a search): a button showing the choice, which
 * opens a searchable list. `id` ties it to its label.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  empty,
  icon,
  invalid,
  className,
}: {
  id?: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: ComboOption[];
  placeholder: string;
  searchPlaceholder: string;
  empty: string;
  icon?: ReactNode;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          className={cn(
            "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 [&_svg]:size-3.5 [&_svg]:flex-none",
            className,
          )}
        >
          {chosen?.icon ?? <span className="text-muted-foreground">{icon}</span>}
          <span className={cn("min-w-0 flex-1 truncate", !chosen && "text-muted-foreground")}>{chosen?.label ?? placeholder}</span>
          {chosen?.detail}
          <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-64">
            <CommandEmpty>{empty}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  onSelect={() => {
                    onChange(o.value === value ? undefined : o.value);
                    setOpen(false);
                  }}
                  data-checked={o.value === value}
                >
                  {o.icon}
                  <span className="truncate">{o.label}</span>
                  {o.detail && <span className="ml-auto">{o.detail}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
