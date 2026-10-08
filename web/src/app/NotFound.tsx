import { SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Content, TopBar, type Crumb } from "./TopBar";

/** An address that names nothing: what it was, and the way back to the Inbox. */
export function NotFound({ crumbs, title = "Not found", children }: { crumbs?: Crumb[]; title?: string; children?: ReactNode }) {
  return (
    <>
      <TopBar crumbs={crumbs ?? [{ label: title }]} />
      <Content>
        <EmptyState
          icon={<SearchXIcon />}
          title={title}
          action={
            <Button asChild variant="outline">
              <Link to="/inbox">Go to Inbox</Link>
            </Button>
          }
        >
          {children ?? "No page at this address."}
        </EmptyState>
      </Content>
    </>
  );
}
