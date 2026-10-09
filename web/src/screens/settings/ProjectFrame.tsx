import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { projectSettingsPath, type ProjectSettingsPage } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { cn } from "@/lib/utils";

const pages: { page: ProjectSettingsPage; label: string }[] = [
  { page: "general", label: "General" },
  { page: "members", label: "Members" },
  { page: "labels", label: "Labels" },
  { page: "workspaces", label: "Workspaces" },
];

/**
 * A Project's settings page (`/projects/:key/settings/<page>`): Project › Settings on the bar, its
 * pages as tabs on the second row, the page's acts at the right of it. The tabs are the view
 * switch's pill; its `p-0.5` keeps their focus rings inside the row's view, which clips. `pad` is
 * off for a page that is one table edge to edge.
 */
export function ProjectSettingsFrame({
  project,
  page,
  actions,
  primary,
  pad = true,
  children,
}: {
  project: Project;
  page: ProjectSettingsPage;
  actions?: ReactNode;
  primary?: ReactNode;
  pad?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Settings" }]}
        view={
          <nav aria-label="Project settings" className="inline-flex flex-none rounded-md bg-muted p-0.5">
            {pages.map((p) => (
              <Link
                key={p.page}
                to={projectSettingsPath(project, p.page)}
                aria-current={p.page === page ? "page" : undefined}
                className={cn(
                  "inline-flex h-[26px] items-center rounded-[6px] px-2 text-xs font-medium text-muted-foreground",
                  p.page === page && "bg-background text-foreground shadow-soft",
                )}
              >
                {p.label}
              </Link>
            ))}
          </nav>
        }
        actions={actions}
        primary={primary}
      />
      <Content pad={pad}>{children}</Content>
    </>
  );
}
