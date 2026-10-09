// The header's Views control, ported from enably-v2's SavedViewsControl: the Member's Views of this
// list, apply one, save the current Filter and Display as a new one, overwrite or delete one. The
// row under the header names the applied View (FilterChipRow's `leading`, AppliedView here).
import { BookmarkIcon, CheckIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { Fold } from "@/components/BarFold";
import { useFolded } from "@/components/useFolded";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ViewsMenuProps = {
  /** The Member's Views of this list, oldest first; undefined while they load. */
  views: readonly { id: string; name: string }[] | undefined;
  /** The View the list was last set from, if it is still one of `views`. */
  appliedId: string | undefined;
  /** Whether the pills have changed since that View was applied. */
  edited: boolean;
  onApply: (id: string) => void;
  /** Saves the list as it is under a new name; true once saved, so the form closes. */
  onSaveNew: (name: string) => Promise<boolean>;
  /** Replaces one View with the list as it is, keeping its name. */
  onOverwrite: (id: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  /** A refused save (a name already taken), shown beside the field. */
  error: string | null;
  onClearError: () => void;
  saving: boolean;
  /** Its open state, when the page opens it too (from the bar's fold). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Folded on a phone into the bar's menu (the board beside the Workflow chip). */
  fold?: Fold;
};

/**
 * Views beside Filter. A View is apply · save · overwrite · delete; a rename is a delete and a new
 * save, as in enably. Deleting asks nothing: a View is a preference that takes seconds to remake.
 */
export function ViewsMenu(props: ViewsMenuProps) {
  const { views, appliedId, edited } = props;
  const [openState, setOpenState] = useState(false);
  const open = props.open ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    props.onOpenChange?.(next);
  };
  const { own: foldOwn, hide: foldHide, anchor: foldAnchor, onCloseAutoFocus: foldClose } = useFolded(props.fold);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const close = () => {
    setOpen(false);
    setNaming(false);
    setName("");
    props.onClearError();
  };
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Only a saved View closes the form; a refused name stays in the field beside the reason.
    if (await props.onSaveNew(trimmed)) close();
  };
  // Nothing new to save while the list is the applied View as it was.
  const canSave = !(appliedId && !edited);
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      {foldAnchor}
      <PopoverTrigger asChild>
        <Button ref={foldOwn} variant="outline" aria-label="Views" className={cn("data-[state=open]:bg-accent", foldHide)}>
          <BookmarkIcon />
          <span className="hidden sm:inline">Views</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Views" className="w-72 p-0" onCloseAutoFocus={foldClose}>
        {naming ? (
          <form
            className="flex flex-col gap-2 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              autoFocus
              aria-label="View name"
              placeholder="Name this View"
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                props.onClearError();
              }}
              className="h-7"
            />
            {props.error && (
              <p role="alert" className="text-xs text-destructive">
                {props.error}
              </p>
            )}
            <Button type="submit" size="sm" disabled={props.saving || !name.trim()}>
              Save View
            </Button>
          </form>
        ) : (
          <Command>
            <CommandList className="max-h-[min(60vh,360px)]">
              {views && views.length === 0 ? (
                <div className="px-3 py-4 text-muted-foreground">
                  <p>No Views yet.</p>
                  <p className="mt-1 text-xs">Set the Filter and Display as you want them, then save them as a View to come back to.</p>
                </div>
              ) : (
                <CommandGroup>
                  {(views ?? []).map((view) => {
                    const applied = view.id === appliedId;
                    return (
                      <CommandItem
                        key={view.id}
                        value={view.id}
                        className="group h-[30px]"
                        onSelect={() => {
                          props.onApply(view.id);
                          close();
                        }}
                      >
                        <CheckIcon className={cn(applied ? "opacity-100" : "opacity-0")} />
                        <span className="flex-1 truncate">{view.name}</span>
                        {applied && edited && <span className="text-xs text-muted-foreground">edited</span>}
                        {!(applied && !edited) && (
                          <button
                            type="button"
                            aria-label={`Overwrite ${view.name}`}
                            title="Save the list as it is into this View"
                            disabled={props.saving}
                            // Inside the row: without stopPropagation, overwriting would also apply.
                            onClick={(e) => {
                              e.stopPropagation();
                              void props.onOverwrite(view.id);
                            }}
                            className="grid size-5 place-items-center rounded-sm opacity-0 group-hover:opacity-60 group-data-[selected=true]:opacity-60 hover:!opacity-100 focus-visible:opacity-100"
                          >
                            <SaveIcon className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Delete ${view.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onDelete(view.id);
                          }}
                          className="grid size-5 place-items-center rounded-sm opacity-0 group-hover:opacity-60 group-data-[selected=true]:opacity-60 hover:!opacity-100 focus-visible:opacity-100"
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
            {props.error && (
              <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
                {props.error}
              </p>
            )}
            {canSave && (
              <div className="border-t p-1">
                <Button variant="ghost" size="sm" className="w-full justify-start font-normal text-muted-foreground" onClick={() => setNaming(true)}>
                  <PlusIcon />
                  Save as view…
                </Button>
              </div>
            )}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The applied View's name at the head of the chips row, and "edited" once the pills differ. */
export function AppliedView({ name, edited }: { name: string; edited: boolean }) {
  return (
    <span
      aria-label={edited ? `View ${name}, edited` : `View ${name}`}
      className="inline-flex h-7 max-w-full flex-none items-center gap-1.5 rounded-md bg-muted px-2 font-medium"
    >
      <BookmarkIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="truncate">{name}</span>
      {edited && <span className="font-normal text-muted-foreground">edited</span>}
    </span>
  );
}
