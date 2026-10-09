import { FolderPlusIcon } from "lucide-react";
import { Navigate, Outlet, useLocation, useParams } from "react-router";
import { useProjects } from "@/api/queries";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { useCurrentMe } from "@/me";
import { findProject, projectPath, RouteProjectContext, useCurrentProject, type ProjectArea } from "./currentProject";
import { sendIntent } from "./intents";
import { NotFound } from "./NotFound";
import { Content, TopBar } from "./TopBar";

/**
 * The pages under `/projects/:key`, and Settings' old addresses of a Project's pages
 * (`/settings/projects/:key/…`) that lead there: finds the Project the key names
 * (an id or a key in another case is rewritten to the key), and gives it to them through
 * `useRouteProject()`. A key that names no Project is a page of its own.
 */
export function ProjectScope() {
  const { key = "" } = useParams();
  const { pathname, search, hash } = useLocation();
  const me = useCurrentMe();
  const projects = useProjects();
  const project = findProject(projects.data ?? [], key);
  // A Project made a moment ago may be in the Projects being read again.
  if (projects.isPending || (!project && projects.isFetching)) return <TopBar crumbs={[]} />;
  if (!project) {
    return (
      <NotFound title="No such Project">No Project of {me.organisation.name} has the key {key}.</NotFound>
    );
  }
  if (project.key !== key) {
    const at = pathname.indexOf(`/${key}`);
    const to = `${pathname.slice(0, at)}/${project.key}${pathname.slice(at + key.length + 1)}`;
    return <Navigate to={{ pathname: to, search, hash }} replace />;
  }
  return (
    <RouteProjectContext value={project}>
      <Outlet />
    </RouteProjectContext>
  );
}

/**
 * An address that means the current Project's place (`/agents`, `/projects`, an old Admin page):
 * there, or, with no Project yet, a page that says so and offers an admin "New Project".
 */
export function ToCurrentProject({ area = "tasks", path }: { area?: ProjectArea; path?: (key: string) => string }) {
  const me = useCurrentMe();
  const projects = useProjects();
  const project = useCurrentProject();
  const { search } = useLocation();
  if (projects.isPending) return <TopBar crumbs={[]} />;
  if (project) return <Navigate to={{ pathname: path ? path(project.key) : projectPath(project, area), search }} replace />;
  return (
    <>
      <TopBar crumbs={[{ label: "No Project yet" }]} />
      <Content>
        <EmptyState
          icon={<FolderPlusIcon />}
          title="No Project yet"
          action={
            me.member.admin && (
              <Button onClick={() => sendIntent({ kind: "new-project" })}>
                New Project
              </Button>
            )
          }
        >
          {me.member.admin ? "Every Task belongs to a Project." : "An admin creates Projects."}
        </EmptyState>
      </Content>
    </>
  );
}
