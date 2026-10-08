import { useMutation } from "@tanstack/react-query";
import { CheckIcon, PlusIcon, TagIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Label } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { tableHead, tableRow } from "./frame";
import { colorPattern, count, labelColors, labelNameProblem as nameProblem, nextColor } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu } from "./parts";
import { useLabelUse } from "./queries";
import { createLabel, deleteLabel, updateLabel } from "./writes";

// Label · ⋯. The name takes the width; the colour sits beside it.
const cols = "grid-cols-[minmax(0,1fr)_26px]";

/**
 * A list of Labels with their colours, for the Organisation (`project` undefined) or a Project's
 * own: New Label adds a row to name and colour, a name is renamed in place, the dot recolours it,
 * Delete in ⋯ asks first and says how many Tasks stop carrying it. `editable` false shows the
 * list alone. `others` are the Labels the names must not repeat (a Project's and the
 * Organisation's share one namespace), said in words before sending.
 */
export function LabelsEditor({
  labels,
  project,
  editable,
  others = [],
  adding,
  onAddingChange,
  emptyHint,
}: {
  labels: Label[] | undefined;
  project?: string;
  editable: boolean;
  others?: Label[];
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  emptyHint: ReactNode;
}) {
  const [deleting, setDeleting] = useState<Label | null>(null);
  if (!labels) return <Skeleton className="m-6 h-8" />;
  const taken = [...labels, ...others];
  if (labels.length === 0 && !adding) {
    return (
      <EmptyState
        icon={<TagIcon />}
        title="No Labels yet"
        action={
          editable && (
            <Button onClick={() => onAddingChange(true)}>
              <PlusIcon />
              New Label
            </Button>
          )
        }
      >
        {emptyHint}
      </EmptyState>
    );
  }
  return (
    <div role="table" aria-label="Labels" className="min-w-0">
      <div role="row" className={cn(tableHead, cols)}>
        <span role="columnheader">Label</span>
        <span role="columnheader">
          <span className="sr-only">Actions</span>
        </span>
      </div>
      {adding && <NewLabelRow project={project} taken={taken} onDone={() => onAddingChange(false)} />}
      {labels.map((l) => (
        <LabelRow key={`${l.id}:${l.name}:${l.color}`} label={l} editable={editable} taken={taken} onDelete={() => setDeleting(l)} />
      ))}
      {deleting && <DeleteLabelDialog label={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function Swatch({ color, className }: { color: string; className?: string }) {
  // The colour is the record's own, so it is drawn from its value; everything else uses tokens.
  return <span aria-hidden className={cn("inline-block size-3 flex-none rounded-full", className)} style={{ backgroundColor: color }} />;
}

/** The colour button: the dot, opening the set and a field for any other `#rrggbb`. */
function ColorPicker({ color, onChange, label, disabled }: { color: string; onChange: (c: string) => void; label: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(color);
  const pick = (c: string) => {
    setOpen(false);
    if (c.toLowerCase() !== color.toLowerCase()) onChange(c);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setTyped(color);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="grid size-6 flex-none cursor-pointer place-items-center rounded-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
        >
          <Swatch color={color} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[212px] p-2">
        <div role="radiogroup" aria-label="Colours" className="grid grid-cols-9 gap-0.5">
          {labelColors.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c.toLowerCase() === color.toLowerCase()}
              aria-label={c}
              onClick={() => pick(c)}
              className="grid size-[21px] cursor-pointer place-items-center rounded-sm hover:bg-accent"
            >
              <Swatch color={c} />
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (colorPattern.test(typed.trim())) pick(typed.trim());
          }}
        >
          <Swatch color={colorPattern.test(typed.trim()) ? typed.trim() : color} />
          <Input
            aria-label="Colour as #rrggbb"
            value={typed}
            maxLength={7}
            onChange={(e) => setTyped(e.target.value)}
            aria-invalid={!colorPattern.test(typed.trim()) || undefined}
            className="h-7 font-mono text-xs md:text-xs"
          />
          <Button type="submit" size="icon-xs" variant="ghost" aria-label="Use this colour" disabled={!colorPattern.test(typed.trim())}>
            <CheckIcon />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** The row New Label opens at the top: a colour (the first of the set not used yet) and a name. */
function NewLabelRow({ project, taken, onDone }: { project?: string; taken: Label[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(() => nextColor(taken.map((l) => l.color)));
  const [tried, setTried] = useState(false);
  const create = useMutation({ mutationFn: () => createLabel({ name: name.trim(), color }, project), onSuccess: onDone });
  const problem = nameProblem(name, taken);
  return (
    <div role="row" aria-label="New Label" className={cn(tableRow, "bg-muted/40 py-1.5", cols)}>
      <form
        role="cell"
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!problem) create.mutate();
        }}
      >
        <ColorPicker color={color} onChange={setColor} label="Colour of the new Label" />
        <Input
          aria-label="Name of the new Label"
          autoFocus
          maxLength={100}
          value={name}
          placeholder="Label name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone()}
          aria-invalid={(tried && !!problem) || undefined}
          className="h-7 w-full min-w-0 sm:w-64"
        />
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={create.isPending}>
          Create Label
        </Button>
        {tried && problem && <p className="basis-full text-xs text-state-blocked">{problem}</p>}
        <Refusal error={create.error} className="basis-full" />
      </form>
      <span role="cell" />
    </div>
  );
}

/** A Label: its colour (a button when editable), its name (renamed in place), and Delete in ⋯. */
function LabelRow({ label: l, editable, taken, onDelete }: { label: Label; editable: boolean; taken: Label[]; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(l.name);
  const save = useMutation({ mutationFn: (body: { name?: string; color?: string }) => updateLabel(l.id, body) });
  const problem = editing ? nameProblem(name, taken, l) : undefined;
  const commit = () => {
    setEditing(false);
    const next = name.trim();
    if (next === l.name || nameProblem(next, taken, l)) return setName(l.name);
    save.mutate({ name: next });
  };
  const shown = save.isPending ? { ...l, ...save.variables } : l;
  return (
    <div role="row" aria-label={l.name} className={cn(tableRow, cols)}>
      <span role="cell" className="flex min-w-0 flex-wrap items-center gap-2">
        {editable ? (
          <ColorPicker color={shown.color} onChange={(color) => save.mutate({ color })} label={`Colour of ${l.name}`} disabled={save.isPending} />
        ) : (
          <span className="grid size-6 flex-none place-items-center">
            <Swatch color={l.color} />
          </span>
        )}
        {editing ? (
          <Input
            aria-label={`Name of ${l.name}`}
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(l.name);
                setEditing(false);
              }
            }}
            aria-invalid={!!problem || undefined}
            className="h-7 w-full min-w-0 sm:w-64"
          />
        ) : editable ? (
          <button
            type="button"
            aria-label={`Rename ${l.name}`}
            onClick={() => {
              setName(l.name);
              setEditing(true);
            }}
            className="min-w-0 cursor-text truncate rounded-sm px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {shown.name}
          </button>
        ) : (
          <span className="min-w-0 truncate px-1">{l.name}</span>
        )}
        {problem && <p className="basis-full text-xs text-state-blocked">{problem}</p>}
        <Refusal error={save.error} className="basis-full" />
      </span>
      <span role="cell">
        {editable && (
          <MoreMenu label={`More for ${l.name}`} size="icon-xs">
            <DropdownMenuItem
              onSelect={() => {
                setName(l.name);
                setEditing(true);
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              Delete
            </DropdownMenuItem>
          </MoreMenu>
        )}
      </span>
    </div>
  );
}

/** Delete, asking first: every Task carrying it, open or ended, stops carrying it. */
function DeleteLabelDialog({ label: l, onClose }: { label: Label; onClose: () => void }) {
  const use = useLabelUse(l.id);
  const remove = useMutation({ mutationFn: () => deleteLabel(l.id), onSuccess: onClose });
  const n = use.data?.length;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${l.name}?`}
      confirmLabel="Delete"
      onConfirm={() => remove.mutate()}
      pending={remove.isPending}
      disabled={use.isPending}
      error={remove.error ?? use.error}
    >
      {n === undefined ? (
        <Skeleton className="h-10" />
      ) : (
        <Facts>
          <Fact label="Removes">
            <span className="inline-flex items-center gap-1.5">
              <Swatch color={l.color} />
              {l.name}
            </span>
            <span className="font-normal text-muted-foreground">
              {n === 0 ? "No Task carries it." : `from ${count(n, "Task")}, open and ended`}
            </span>
          </Fact>
          <Fact label="Views">
            <span className="font-normal">A View filtering by it matches nothing for it.</span>
          </Fact>
        </Facts>
      )}
    </ConfirmDialog>
  );
}
