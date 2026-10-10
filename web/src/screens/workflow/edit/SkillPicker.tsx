import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { Skill } from "@/api/client";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isNewSkill, skillName, type NewSkill } from "./draft";

const NONE = "@none";

export type SkillChoice = { id: string } | { create: NewSkill } | undefined;

/**
 * A Step's Skill: the generic Skills (each with who holds it in the Project, where a Step shows
 * it), "None: a hold", and, when what is typed names no Skill, "+ New Skill" — which asks for its
 * text in a small dialog and is created on Save, before the Workflow.
 */
export function SkillPicker({
  value,
  label,
  skills,
  pending,
  holders,
  onChange,
  invalid,
  className,
}: {
  /** The Skill's id, a `new-skill:…` one, or undefined for a hold. */
  value: string | undefined;
  /** The accessible name: "Skill of Build". */
  label: string;
  skills: Skill[];
  /** The new Skills the draft carries, by their `new-skill:…` id. */
  pending: Record<string, NewSkill>;
  /** Who in the Project holds each Skill, by its id: the takers the Workflow lists. */
  holders: Map<string, string[]>;
  onChange: (choice: SkillChoice) => void;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [creating, setCreating] = useState<string | undefined>();
  const current = value
    ? isNewSkill(value)
      ? { name: pending[value]?.name ?? value.slice(10), fresh: true }
      : { name: skills.find((s) => s.id === value)?.name ?? "…", fresh: false }
    : undefined;
  // The generic Skills, and the Step's Skill when it is an own one.
  const offered = skills.filter((s) => s.kind === "generic" || s.id === value);
  const name = typed.trim().toLowerCase();
  const taken = skills.some((s) => s.name === name) || Object.values(pending).some((s) => s.name === name);
  const canCreate = !!name && skillName.test(name) && !taken;
  const pick = (choice: SkillChoice) => {
    onChange(choice);
    setOpen(false);
    setTyped("");
  };
  const who = (id: string) => {
    const names = holders.get(id) ?? [];
    return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
            aria-invalid={invalid || undefined}
            className={cn(
              "flex h-7 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2 text-left font-mono text-[11.5px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
              !current && "border-dashed font-sans text-xs text-muted-foreground",
              current?.fresh && "border-state-claimed bg-state-claimed-bg",
              className,
            )}
          >
            <span className="min-w-0 truncate">{current ? current.name : "Hold"}</span>
            {current?.fresh && <span className="flex-none font-sans text-[10.5px] text-state-claimed">new</span>}
            <ChevronDownIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Find or name a Skill" value={typed} onValueChange={setTyped} className="font-mono text-xs" />
            <CommandList className="max-h-72">
              <CommandEmpty>{name && !canCreate ? (taken ? "Named already." : "Lower-case letters, digits and dashes.") : "No Skill."}</CommandEmpty>
              {canCreate && (
                <CommandGroup>
                  <CommandItem value={`@create ${name}`} keywords={[name]} onSelect={() => setCreating(name)}>
                    <PlusIcon aria-hidden />
                    <span className="truncate">New Skill “{name}”</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">generic</span>
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup>
                {offered.map((s) => (
                  <CommandItem key={s.id} value={s.name} onSelect={() => pick({ id: s.id })} data-checked={s.id === value}>
                    <span className="truncate font-mono text-xs">{s.name}</span>
                    <span className="ml-auto truncate text-[11px] text-muted-foreground">{who(s.id)}</span>
                  </CommandItem>
                ))}
                {Object.entries(pending)
                  .filter(([id]) => id !== value)
                  .map(([id, s]) => (
                    <CommandItem key={id} value={s.name} onSelect={() => pick({ create: s })}>
                      <span className="truncate font-mono text-xs">{s.name}</span>
                      <span className="ml-auto text-[11px] text-state-claimed">new</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem value={NONE} keywords={["none", "hold"]} onSelect={() => pick(undefined)} data-checked={!value}>
                  <span>None: a hold</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {creating && (
        <NewSkillDialog
          name={creating}
          onClose={() => setCreating(undefined)}
          onDone={(s) => {
            setCreating(undefined);
            pick({ create: s });
          }}
        />
      )}
    </>
  );
}

/** The text of a new generic Skill, asked when it is picked: published as version 1 on Save. */
function NewSkillDialog({ name: initial, onClose, onDone }: { name: string; onClose: () => void; onDone: (s: NewSkill) => void }) {
  const [name, setName] = useState(initial);
  const [body, setBody] = useState("");
  const trimmed = name.trim();
  const problem = trimmed && !skillName.test(trimmed) ? "A Skill's name is lower-case letters, digits and dashes, starting with a letter or digit." : undefined;
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`New Skill “${trimmed || initial}”`}
      submitLabel="Use this Skill"
      submitDisabled={!trimmed || !!problem || !body.trim()}
      onSubmit={() => onDone({ name: trimmed, body })}
      size="md"
    >
      <FormRows>
        <FormRow label="Name" htmlFor="new-skill-name" info="Such as qa or security." help={problem ? <span className="text-destructive">{problem}</span> : undefined}>
          <Input id="new-skill-name" required maxLength={63} value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs md:text-xs" />
        </FormRow>
        <FormRow label="Text" htmlFor="new-skill-body" info="What a Member with it knows and does. Markdown.">
          <Textarea id="new-skill-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}
