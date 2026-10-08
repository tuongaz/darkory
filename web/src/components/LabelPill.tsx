import type { Label } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * A Label's colour as a dot. The colour is the Label's own, data rather than a token, so it is set
 * through the style property (a CSSOM write, which the app's CSP allows).
 */
export function LabelDot({ label, className }: { label: Pick<Label, "color">; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 flex-none rounded-full", className)} style={{ backgroundColor: label.color }} />;
}

/** A Label as a Task carries it: its dot, then its name, in a round outline. */
export function LabelPill({ label, className }: { label: Pick<Label, "name" | "color">; className?: string }) {
  return (
    <span
      data-label={label.name}
      className={cn("inline-flex h-5 max-w-36 min-w-0 flex-none items-center gap-1.5 rounded-full border px-2 text-2xs whitespace-nowrap text-foreground", className)}
    >
      <LabelDot label={label} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** A Task's Labels by name, those of `ids` that still exist, on one line. */
export function LabelPills({ ids, labels, className }: { ids: readonly string[] | undefined; labels: ReadonlyMap<string, Label>; className?: string }) {
  const shown = (ids ?? []).flatMap((id) => labels.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
  if (shown.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)} aria-label={`Labels: ${shown.map((l) => l.name).join(", ")}`}>
      {shown.map((l) => (
        <LabelPill key={l.id} label={l} />
      ))}
    </span>
  );
}
