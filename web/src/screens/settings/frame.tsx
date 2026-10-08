import type { ReactNode } from "react";
import { Content, TopBar, type Crumb } from "@/app/TopBar";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Every Settings page: the top bar (Settings / the page / the record), then the page. `crumbs`
 * follow Settings; `pad` is off for a page that is one table edge to edge.
 */
export function SettingsFrame({
  crumbs,
  actions,
  primary,
  pad = true,
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  primary?: ReactNode;
  pad?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }, ...crumbs]} actions={actions} primary={primary} />
      <Content pad={pad}>{children}</Content>
    </>
  );
}

/** A record page's frame while the record loads. */
export function LoadingFrame({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <SettingsFrame crumbs={crumbs}>
      <Skeleton className="h-10 w-80" />
    </SettingsFrame>
  );
}

/** A table's header and rows (kit `.list`): the columns are the caller's grid classes. */
export const tableHead = "grid h-8 items-center gap-3 border-b px-6 text-xs font-medium text-muted-foreground";
export const tableRow = "relative grid min-h-10 items-center gap-3 border-b px-6";
