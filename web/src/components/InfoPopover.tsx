import { InfoIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * An ⓘ that opens an explanation: where a rule or a term is explained, so the screen itself
 * stays label + number + pill. `label` names the button ("About Statuses").
 *
 * By default it opens under the ⓘ. `anchor`, `side` and `align` place it beside something else,
 * such as the column it explains, so it covers nothing it is about; `className` sizes it.
 */
export function InfoPopover({
  label,
  children,
  anchor,
  side,
  align,
  className,
}: {
  label: string;
  children: ReactNode;
  anchor?: RefObject<HTMLElement | null>;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <Popover>
      {anchor && <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />}
      <PopoverTrigger
        aria-label={label}
        className="inline-grid size-5 flex-none cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={16}
        className={cn("w-[280px] max-w-[calc(100vw-2rem)] px-3 py-2.5 text-[12.5px] leading-[1.45]", className)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
