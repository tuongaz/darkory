import { EllipsisIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ownsKeys } from "@/lib/keys";

/**
 * A record opened over the list it was picked from (kit `.sheet`): a 560px Sheet from the right,
 * a 44px header with the record's key, its ⋯ menu and ×, and a scrolling body. It is not modal:
 * no scrim, and the list beside it stays clickable and walkable with the keys (a click there opens
 * another record rather than closing this one). Esc and × close it; Esc in a terminal is the
 * terminal's.
 *
 * `label` names the sheet for screen readers ("WEB-3 Build the cart page"); `menu` is the ⋯
 * menu's items (DropdownMenuItem elements) and is absent when there are none.
 */
export function Peek({
  open,
  onOpenChange,
  label,
  heading,
  menu,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  heading: ReactNode;
  menu?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-peek=""
        className="w-full gap-0 outline-none sm:max-w-[560px]"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (ownsKeys(e.target)) e.preventDefault();
        }}
        // Whoever opened the record returns the focus (the shell, to the Task's row).
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The sheet itself takes focus, not its first button: Enter must not close it.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <div className="flex h-11 flex-none items-center gap-2 border-b pr-3 pl-4">
          <div className="flex min-w-0 items-center gap-2">{heading}</div>
          <div className="ml-auto flex items-center gap-1">
            {actions}
            {menu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="More">
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Close" onClick={() => onOpenChange(false)}>
              <XIcon />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
