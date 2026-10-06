import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * An ⓘ that opens an explanation: where a rule or a term is explained, so the screen itself
 * stays label + number + pill. `label` names the button ("About Statuses").
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="inline-grid size-5 flex-none cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-[280px] px-3 py-2.5 text-[12.5px] leading-[1.45]">{children}</PopoverContent>
    </Popover>
  );
}
