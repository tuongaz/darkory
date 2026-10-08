import { CheckIcon, XIcon } from "lucide-react";
import type { SVGProps } from "react";
import { glyphLabel, type WorkGlyph as Glyph } from "@/lib/work";
import { cn } from "@/lib/utils";

/**
 * A Task's derived state as a 14px glyph (`glyphFor` in `@/lib/work` says which): waiting ○,
 * working (an agent's AI-gradient ring, turning while its session runs and stopped in the
 * session's colour otherwise; a human's still ring), blocked ⊘, at a hold (dashed), done ✓,
 * dropped ✕, and a Parent's progress ring (done green, dropped grey, out of all its Subtasks).
 * `label` overrides the words it is named by.
 */
export function WorkGlyph({ glyph, label, className }: { glyph: Glyph; label?: string; className?: string }) {
  const name = label ?? glyphLabel(glyph);
  const common = { role: "img", "aria-label": name, title: name, "data-glyph": glyph.glyph } as const;
  const box = cn("inline-grid size-3.5 flex-none place-items-center", className);
  switch (glyph.glyph) {
    case "waiting":
      return <span {...common} className={cn(box, "rounded-full border-[1.5px] border-muted-foreground")} />;
    case "hold":
      return <span {...common} className={cn(box, "rounded-full border-[1.5px] border-dashed border-muted-foreground")} />;
    case "working":
      return (
        <span
          {...common}
          data-holder={glyph.holderKind}
          data-session={glyph.holderKind === "agent" ? (glyph.session ?? "running") : undefined}
          className={cn(box, "work-ring")}
        />
      );
    case "blocked":
      return (
        <svg {...common} viewBox="0 0 14 14" className={cn(box, "text-state-blocked")} fill="none" stroke="currentColor" strokeWidth={1.75}>
          <circle cx="7" cy="7" r="5.75" />
          <path d="M3 11 11 3" strokeLinecap="round" />
        </svg>
      );
    case "done":
      return (
        <span {...common} className={cn(box, "rounded-full bg-state-done")}>
          <CheckIcon className="size-[9px] text-on-solid" strokeWidth={3} />
        </span>
      );
    case "dropped":
      return (
        <span {...common} className={cn(box, "rounded-full bg-muted-foreground")}>
          <XIcon className="size-[9px] text-on-solid" strokeWidth={3} />
        </span>
      );
    case "parent":
      return <ProgressRing {...common} done={glyph.done} dropped={glyph.dropped} total={glyph.total} className={box} />;
  }
}

// The ring's circle: r 5.5 in a 14-unit box, its length the circumference.
const r = 5.5;
const length = 2 * Math.PI * r;

/** Arcs from twelve o'clock, clockwise: done, then dropped, over a track of the rest. */
function ProgressRing({
  done,
  dropped,
  total,
  className,
  ...aria
}: { done: number; dropped: number; total: number; className?: string } & Omit<SVGProps<SVGSVGElement>, "className">) {
  const part = (n: number) => (total > 0 ? (n / total) * length : 0);
  const arc = (from: number, n: number, stroke: string) =>
    n > 0 && (
      <circle
        cx="7"
        cy="7"
        r={r}
        className={stroke}
        strokeDasharray={`${part(n)} ${length}`}
        strokeDashoffset={-part(from)}
        transform="rotate(-90 7 7)"
      />
    );
  return (
    <svg {...aria} viewBox="0 0 14 14" fill="none" strokeWidth={2} className={className}>
      <circle cx="7" cy="7" r={r} className="stroke-muted-foreground/30" />
      {arc(0, done, "stroke-state-done")}
      {arc(done, dropped, "stroke-muted-foreground")}
    </svg>
  );
}
