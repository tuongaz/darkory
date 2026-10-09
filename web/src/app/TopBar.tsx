import { Slot } from "radix-ui";
import { Fragment, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * A step of the breadcrumb. `wide` leaves it out on a phone, where the bar has room for the area
 * alone. `whole` keeps it at its own width (a control, such as the Workflow chip, that must read
 * in full on a phone): the other crumbs truncate first, and on a phone the area's crumb gives it
 * its room, its name and the "/" stepping aside while its icon stays as the link; only when the
 * bar has no more does the whole crumb shrink, its control truncating inside it.
 */
export type Crumb = { label: ReactNode; to?: string; icon?: ReactNode; wide?: boolean; whole?: boolean };

/**
 * The bar over every screen: where you are on the first row (the button that collapses the sidebar and
 * brings it back, which on a phone opens it as a sheet, then the crumbs), then, when the page has any, a second row named "Page" of what the page does: the view
 * switch and the scope at the left, the actions and the one primary at the right. Every page
 * renders one as its first child. Each row has its own hairline: one under the crumbs when a second
 * row follows, and one under the last row.
 *
 * The first crumb is the area (a Project, Settings, Inbox) and reads strong; the rest are muted.
 */
export function TopBar({
  crumbs,
  view,
  actions,
  primary,
}: {
  crumbs: Crumb[];
  view?: ReactNode;
  actions?: ReactNode;
  primary?: ReactNode;
}) {
  const whole = crumbs.some((c) => c.whole);
  // The area's crumb beside a whole one shows on a phone as its mark alone, about 20px, still the
  // link it was (named for the area, its name hidden).
  const mark = (i: number, c: Crumb) => i === 0 && whole && !c.whole && !!c.icon;
  // On a phone the mark stands beside the first crumb shown after it, with no "/" between.
  const next = crumbs.findIndex((c, i) => i > 0 && !c.wide);
  const icon = (i: number, c: Crumb) =>
    mark(i, c) ? <span className="flex flex-none max-sm:[&>*]:size-5 max-sm:[&>*]:rounded-[5px] max-sm:[&>*]:text-[11px]">{c.icon}</span> : c.icon;
  const second = !!(view || actions || primary);
  const [viewRef, overflowing] = useOverflow<HTMLDivElement>();
  return (
    <header className="flex flex-none flex-col border-b">
      <div className={cn("flex h-11 items-center gap-2 px-4", second && "border-b")}>
        <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <span aria-hidden className={cn("text-border", (c.wide || (i === next && whole)) && "hidden sm:inline")}>
                  /
                </span>
              )}
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  c.whole ? "min-w-0 sm:flex-none" : "min-w-0",
                  i === 0 && "font-medium text-foreground",
                  mark(i, c) && "flex-none sm:flex-initial",
                  (c.wide || (i === 0 && whole && !c.whole && !c.icon)) && "hidden sm:flex",
                )}
              >
                {c.to ? (
                  <Link
                    to={c.to}
                    aria-label={mark(i, c) && typeof c.label === "string" ? c.label : undefined}
                    className="group flex min-w-0 items-center gap-1.5"
                  >
                    {icon(i, c)}
                    <span className={cn("truncate group-hover:underline", mark(i, c) && "hidden sm:inline")}>{c.label}</span>
                  </Link>
                ) : (
                  <>
                    {icon(i, c)}
                    <span className={cn(c.whole ? "flex min-w-0" : "truncate", mark(i, c) && "hidden sm:inline")}>{c.label}</span>
                  </>
                )}
              </span>
            </Fragment>
          ))}
        </nav>
      </div>
      {second && (
        <div role="group" aria-label="Page" className="@container/page flex h-10 items-center gap-2 px-4">
          {view && (
            <div ref={viewRef} data-overflow={overflowing || undefined} className="bar-view flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
              {view}
            </div>
          )}
          {(actions || primary) && (
            <div className="ml-auto flex flex-none items-center gap-1.5">
              {actions}
              {primary}
            </div>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * An act on the bar's second row, the kit's sm size (28px, 12px text, 14px icon): the height of
 * the row's pills and chips. Its icon, then its label once the row has 42rem; on a narrower row the
 * label steps aside and the act is a 28px square, still named by its label. What it is given as
 * children follows the label (Filter's count, File Task's key), or, with `asChild`, is the element
 * it becomes (a Link).
 */
export function BarAction({ icon, label, className, children, size = "sm", ...props }: { icon: ReactNode; label: string } & ComponentProps<typeof Button>) {
  return (
    <Button
      aria-label={label}
      size={size}
      className={cn("text-xs [&_svg:not([class*='size-'])]:size-3.5 @max-2xl/page:min-w-7 @max-2xl/page:px-1.5", className)}
      {...props}
    >
      {icon}
      <span className="hidden @2xl/page:inline">{label}</span>
      <Slot.Slottable>{children}</Slot.Slottable>
    </Button>
  );
}

/**
 * Whether an element's content runs past its right edge, kept as its box, its content and its
 * scroll change: true while there is more to scroll to, so the fade clears once scrolled to the end.
 */
function useOverflow<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null);
  const [on, setOn] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    // One pixel of slack: scrollLeft is fractional on a zoomed or high-density screen.
    const measure = () => setOn(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    el.addEventListener("scroll", measure, { passive: true });
    // The element's box and each child's: a chip whose label grows widens the content without
    // resizing the element. Children come and go (the scope chip once the line loads), so a
    // MutationObserver re-observes them as they change.
    const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    const observe = () => {
      if (!sizes) return;
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
    };
    const children = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => {
      observe();
      measure();
    });
    children?.observe(el, { childList: true });
    observe();
    measure();
    return () => {
      el.removeEventListener("scroll", measure);
      sizes?.disconnect();
      children?.disconnect();
    };
  }, [el]);
  return [ref, on] as const;
}

/** The scrolling area under the TopBar. `pad` gives it the kit's 20px × 24px page padding. */
export function Content({ children, pad, className }: { children: ReactNode; pad?: boolean; className?: string }) {
  return <div className={cn("relative min-h-0 flex-1 overflow-auto", pad && "px-6 py-5", className)}>{children}</div>;
}
