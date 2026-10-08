import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** A short word on hover or focus, for the detail a control or chip leaves out. */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="max-w-[280px]">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
