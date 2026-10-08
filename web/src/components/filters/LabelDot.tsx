import type { Label } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * A Label's colour as a dot. The colour is the Label's own, data rather than a token, so it is set
 * through the style property (a CSSOM write, which the app's CSP allows).
 */
export function LabelDot({ label, className }: { label: Pick<Label, "color">; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 flex-none rounded-full", className)} style={{ backgroundColor: label.color }} />;
}
