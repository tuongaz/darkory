// The top bar's actions folded into one menu on a phone: beside the Workflow chip the bar has no
// room for Views, Filter and Display side by side. Each folded menu keeps its own button (shown
// from `sm` up) and opens under the fold's trigger while that button is hidden.
import { EllipsisIcon } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PopoverAnchor } from "@/components/ui/popover";

/** Whether a trigger is laid out (not hidden on a phone by its fold). */
const shown = (el: HTMLElement | null) => (el?.getBoundingClientRect().width ?? 0) > 0;

/** A menu's place in a fold: the fold's trigger, which it opens under on a phone. */
export type Fold = { anchor: HTMLButtonElement | null };

/**
 * The fold's trigger, a phone's alone: one item per folded menu, each opening that menu once this
 * one has closed (so the focus it returns does not dismiss the menu just opened).
 */
export function BarFold({
  anchor,
  items,
  badge,
}: {
  anchor: (el: HTMLButtonElement | null) => void;
  items: { label: string; icon: ReactNode; open: () => void; badge?: ReactNode }[];
  badge?: ReactNode;
}) {
  const next = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={anchor} variant="outline" aria-label="More" className="data-[state=open]:bg-accent sm:hidden">
          <EllipsisIcon />
          {badge}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44"
        onCloseAutoFocus={(e) => {
          const open = next.current;
          next.current = null;
          if (!open) return;
          e.preventDefault();
          open();
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={() => (next.current = item.open)}>
            {item.icon}
            {item.label}
            {item.badge}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Positions the menu under its own trigger while it shows, else under the fold's. */
export function FoldAnchor({ own, fold }: { own: HTMLElement | null; fold: HTMLElement | null }) {
  const at = useMemo(
    () => ({ current: { getBoundingClientRect: () => (shown(own) || !fold ? own : fold)?.getBoundingClientRect() ?? new DOMRect() } }),
    [own, fold],
  );
  return <PopoverAnchor virtualRef={at} />;
}
