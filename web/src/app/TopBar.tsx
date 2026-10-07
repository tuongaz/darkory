import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** A step of the breadcrumb. `wide` leaves it out on a phone, where the bar has room for the area alone. */
export type Crumb = { label: ReactNode; to?: string; icon?: ReactNode; wide?: boolean };

/**
 * The 44px bar over every screen (kit `.topbar`): where you are, then the view switcher, then the
 * screen's actions and its one primary on the right. Every page renders one as its first child;
 * on a phone it carries the button that opens the sidebar.
 *
 * The first crumb is the area (a Team, Admin, Inbox) and reads strong; the rest are muted.
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
  return (
    <header className="flex h-11 flex-none items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1.5 text-muted-foreground md:hidden" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <span aria-hidden className={cn("text-border", c.wide && "hidden sm:inline")}>
                /
              </span>
            )}
            <span className={cn("flex min-w-0 items-center gap-1.5", i === 0 && "font-medium text-foreground", c.wide && "hidden sm:flex")}>
              {c.icon}
              {c.to ? (
                <Link to={c.to} className="truncate hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </span>
          </Fragment>
        ))}
      </nav>
      {view && <div className="ml-3 flex-none">{view}</div>}
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
