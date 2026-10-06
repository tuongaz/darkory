import { glyphFor, type Glyph, type StatusKind } from "@/lib/status";
import { cn } from "@/lib/utils";
import { StatusGlyph } from "./StatusGlyph";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type StatusOption = { id: string; name: string; kind: StatusKind; position: number };

const openKinds: StatusKind[] = ["backlog", "todo", "in_progress"];

/**
 * The one Status picker, in File a Task and in a Task's properties: the Organisation's open-kind
 * Statuses in board order, each with its glyph, in a list under the control (Done and Dropped are
 * reached by Complete and Drop only). `field` is a form's bordered control, labelled by its
 * `<label htmlFor={id}>`; `property` is the properties column's quiet one, which reads as the value
 * until it is hovered and names itself "Status: Todo".
 */
export function StatusSelect({
  statuses,
  value,
  onValueChange,
  variant = "field",
  id,
}: {
  statuses: StatusOption[];
  value: string | undefined;
  onValueChange: (id: string) => void;
  variant?: "field" | "property";
  id?: string;
}) {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const glyphs = new Map<string, Glyph>();
  const seen = new Map<StatusKind, number>();
  for (const s of ordered) {
    const nth = seen.get(s.kind) ?? 0;
    seen.set(s.kind, nth + 1);
    glyphs.set(s.id, glyphFor(s.kind, nth));
  }
  const current = ordered.find((s) => s.id === value);
  const label = (s: StatusOption) => (
    <>
      <span aria-hidden className="inline-flex">
        <StatusGlyph glyph={glyphs.get(s.id) ?? "todo"} />
      </span>
      <span className="truncate">{s.name}</span>
    </>
  );
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        id={id}
        aria-label={variant === "property" && current ? `Status: ${current.name}` : undefined}
        className={cn(
          "gap-1.5",
          variant === "field"
            ? "w-full"
            : "-ml-1.5 h-[26px] max-w-full border-0 bg-transparent px-1.5 shadow-none hover:bg-accent data-[size=default]:h-[26px] dark:bg-transparent [&>svg]:hidden",
        )}
      >
        <SelectValue placeholder="Status">{current && <span className="inline-flex min-w-0 items-center gap-1.5">{label(current)}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="min-w-44">
        {ordered
          .filter((s) => openKinds.includes(s.kind))
          .map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {label(s)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
