import { InfoIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** How an InfoTip came open: a pointer resting on it, the keyboard reaching it, or a click or tap that pins it. */
type Opened = "hover" | "focus" | "pinned";

const openDelay = 200;
const closeDelay = 120;

/**
 * An ⓘ beside a label that explains it, so the screen itself stays label and control. It opens on
 * hover and on keyboard focus, and closes when the pointer or the focus leaves; a click or a tap
 * pins it open until Esc or a click elsewhere, which is how it opens on a touch screen. Its name
 * is "About <label>". The explanation floats over the page, so opening it moves nothing, and the
 * ⓘ is a fixed 16px square that sits inside a label's line.
 *
 * By default it opens under the ⓘ. `anchor`, `side` and `align` place it beside something else,
 * such as the column it explains, so it covers nothing it is about; `className` sizes it.
 */
export function InfoTip({
  label,
  children,
  anchor,
  side,
  align = "start",
  className,
}: {
  /** What it explains, as on screen: "Labels" names the button "About Labels". */
  label: string;
  children: ReactNode;
  anchor?: RefObject<HTMLElement | null>;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [opened, setOpened] = useState<Opened>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clear = () => clearTimeout(timer.current);
  const later = (next: Opened | undefined, ms: number) => {
    clear();
    timer.current = setTimeout(() => setOpened(next), ms);
  };
  useEffect(() => clear, []);

  // A pointer resting on the ⓘ or on what it opened keeps it open; leaving both closes it, unless pinned.
  const enter = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (opened) return clear();
    later("hover", openDelay);
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    if (opened === "pinned") return;
    if (opened) later(undefined, closeDelay);
    else clear();
  };

  return (
    <Popover
      open={!!opened}
      onOpenChange={(open) => {
        // Esc, or a click elsewhere: the trigger's own click is handled below.
        clear();
        if (!open) setOpened(undefined);
      }}
    >
      {anchor && <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />}
      <PopoverTrigger
        type="button"
        aria-label={`About ${label}`}
        data-info-tip=""
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={(e) => {
          // A click or a tap pins what hover or focus opened, and closes what it pinned.
          e.preventDefault();
          clear();
          setOpened((o) => (o === "pinned" ? undefined : "pinned"));
        }}
        onFocus={(e) => {
          if (!opened && e.currentTarget.matches(":focus-visible")) setOpened("focus");
        }}
        onBlur={() => {
          if (opened === "focus") setOpened(undefined);
        }}
        className="relative inline-grid size-4 flex-none cursor-pointer place-items-center rounded-full align-middle text-muted-foreground after:absolute after:-inset-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:text-foreground"
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={16}
        // It explains; nothing in it takes the focus, which stays on whatever had it.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={enter}
        onPointerLeave={leave}
        className={cn("w-[280px] max-w-[calc(100vw-2rem)] px-3 py-2.5 text-[12.5px] leading-[1.45] font-normal", className)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
