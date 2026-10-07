import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Pill } from "./Pill";

const gap = 4;

/**
 * Outline pills on one line (Skill names): as many whole pills as the cell has room for, then a
 * "+N" chip naming the rest on hover. The pills that do not fit stay in place unseen, so their
 * widths can be measured again when the cell grows.
 */
export function PillsFit({ names, className }: { names: string[]; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(names.length);
  const key = names.join("\n");

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const widths = [...el.querySelectorAll<HTMLElement>("[data-pill]")].map((p) => p.offsetWidth);
      const room = el.clientWidth;
      // Not laid out (a test's DOM, a hidden column): show them all.
      if (room === 0) return setFit(widths.length);
      const more = chip.current?.offsetWidth || 26;
      let used = 0;
      let n = 0;
      for (; n < widths.length; n++) {
        const next = used + (n > 0 ? gap : 0) + widths[n];
        const rest = n + 1 < widths.length ? gap + more : 0;
        if (next + rest > room) break;
        used = next;
      }
      setFit(n);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [key]);

  const rest = names.slice(fit);
  return (
    <span ref={box} className={cn("flex min-w-0 gap-1 overflow-hidden", className)}>
      {names.map((name, i) => (
        <span key={name} data-pill className={cn("flex flex-none", i >= fit && "invisible order-2")}>
          <Pill tone="outline">{name}</Pill>
        </span>
      ))}
      {rest.length > 0 && (
        <span ref={chip} title={rest.join(", ")} aria-label={`and ${rest.join(", ")}`} className="order-1 flex flex-none">
          <Pill tone="secondary">+{rest.length}</Pill>
        </span>
      )}
    </span>
  );
}
