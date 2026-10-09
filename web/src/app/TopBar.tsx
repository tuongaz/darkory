import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
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
 * The 44px bar over every screen (kit `.topbar`): where you are, then the view switcher, then the
 * screen's actions and its one primary on the right. Every page renders one as its first child;
 * on a phone it carries the button that opens the sidebar.
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
  const icon = (i: number, c: Crumb) =>
    mark(i, c) ? <span className="flex flex-none max-sm:[&>*]:size-5 max-sm:[&>*]:rounded-[5px] max-sm:[&>*]:text-[11px]">{c.icon}</span> : c.icon;
  return (
    <header className="flex h-11 flex-none items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1.5 text-muted-foreground md:hidden" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <span aria-hidden className={cn("text-border", (c.wide || (i === 1 && whole)) && "hidden sm:inline")}>
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
                  className="flex min-w-0 items-center gap-1.5 hover:underline"
                >
                  {icon(i, c)}
                  <span className={cn("truncate", mark(i, c) && "hidden sm:inline")}>{c.label}</span>
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
      {view && <div className="flex-none sm:ml-3">{view}</div>}
      {(actions || primary) && (
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {actions}
          {primary}
        </div>
      )}
    </header>
  );
}

/** The scrolling area under the TopBar. `pad` gives it the kit's 20px × 24px page padding. */
export function Content({ children, pad, className }: { children: ReactNode; pad?: boolean; className?: string }) {
  return <div className={cn("relative min-h-0 flex-1 overflow-auto", pad && "px-6 py-5", className)}>{children}</div>;
}
