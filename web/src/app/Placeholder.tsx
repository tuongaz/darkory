import { HammerIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/EmptyState";
import { Content, TopBar, type Crumb } from "./TopBar";

/** A screen not built yet: its name and the agent that builds it. Each screens/ folder replaces its own. */
export function PlaceholderPage({
  title,
  owner,
  crumbs,
  view,
  children,
}: {
  title: string;
  owner: string;
  crumbs?: Crumb[];
  view?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <TopBar crumbs={crumbs ?? [{ label: title }]} view={view} />
      <Content>
        <EmptyState icon={<HammerIcon />} title={title} action={children}>
          Built by {owner}.
        </EmptyState>
      </Content>
    </>
  );
}
