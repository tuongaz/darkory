import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { useAnyTask, useWorkflow } from "@/api/queries";
import { Loaded } from "@/components/Refusal";
import { toShort } from "@/lib/shortid";
import { BoardDialogs, TasksPage } from "@/screens/board";
import { ActivityPage, AgentsPage, InboxPage, MyWorkPage } from "@/screens/inbox";
import {
  AccountSettingsPage,
  AgentSettingsPage,
  AgentsSettingsPage,
  InstallSettingsPage,
  LabelsSettingsPage,
  MemberSettingsPage,
  MembersSettingsPage,
  OrganisationGate,
  ProjectGeneralPage,
  ProjectLabelsPage,
  ProjectMembersPage,
  ProjectWorkspacesPage,
  SettingsLayout,
  SkillSettingsPage,
  SkillsSettingsPage,
} from "@/screens/settings";
import { TaskPage, TaskPeek } from "@/screens/task";
import { WorkflowPage, WorkflowSettingsPage } from "@/screens/workflow";
import { NotFound } from "./NotFound";
import { ProjectScope, ToCurrentProject } from "./ProjectScope";
import { SetupChecklist } from "./SetupChecklist";
import { AppFrame, Shell } from "./Shell";
import { TopBar } from "./TopBar";

/**
 * Every screen's address. This is the only file that imports the screens/ folders; each folder's
 * index.tsx exports the pages named here, so the agents building them never edit the same file.
 *
 * Search parameters every page honours: ?task=<key> opens that Task's Peek over the page (the
 * shell mounts it). A Project's Tasks take ?view=list|board; its Agents ?agent=<name>;
 * /settings/organisation/members ?new=1 opens New Member.
 *
 * The addresses of the model before Projects (/teams, /features, /admin, /account, /agents,
 * /activity) lead to their places now.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        // One peek for every Task it shows: J and K move it along the list without opening a new sheet.
        element={<Shell dialogs={<BoardDialogs />} peek={(taskKey, close) => <TaskPeek taskKey={taskKey} onClose={close} />} />}
      >
        <Route element={<AppFrame />}>
          <Route index element={<Navigate to="/inbox" replace />} />
          <Route path="inbox" element={<InboxRoute />} />
          <Route path="my-work" element={<MyWorkPage />} />
          <Route path="projects" element={<ToCurrentProject />} />
          <Route path="projects/:key" element={<ProjectScope />}>
            <Route index element={<Navigate to="tasks" replace />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="workflows" element={<WorkflowPage />} />
            <Route path="workflows/:workflow" element={<WorkflowPage />} />
            <Route path="workflow" element={<FromWorkflow />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="tasks/:task" element={<TaskPage />} />

          <Route path="agents" element={<ToCurrentProject area="agents" />} />
          <Route path="activity" element={<ToCurrentProject area="activity" />} />
          <Route path="teams/:key/*" element={<FromTeam />} />
          <Route path="features/:key" element={<FromFeature />} />
          <Route path="account" element={<Navigate to="/settings/account" replace />} />
          <Route path="admin/*" element={<FromAdmin />} />
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="account" element={<AccountSettingsPage />} />
          <Route path="organisation" element={<OrganisationGate />}>
            <Route index element={<Navigate to="members" replace />} />
            <Route path="members" element={<MembersSettingsPage />} />
            <Route path="members/:member" element={<MemberSettingsPage />} />
            <Route path="agents" element={<AgentsSettingsPage />} />
            <Route path="agents/:member" element={<AgentSettingsPage />} />
            <Route path="skills" element={<SkillsSettingsPage />} />
            <Route path="skills/:skill" element={<SkillSettingsPage />} />
            <Route path="labels" element={<LabelsSettingsPage />} />
            <Route path="install" element={<InstallSettingsPage />} />
          </Route>
          <Route path="projects" element={<ToCurrentProject path={(key) => `/settings/projects/${key}/general`} />} />
          <Route path="projects/:key" element={<ProjectScope />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<ProjectGeneralPage />} />
            <Route path="workflows" element={<WorkflowSettingsPage />} />
            <Route path="workflows/:workflow" element={<WorkflowSettingsPage />} />
            <Route path="workflow" element={<FromWorkflow settings />} />
            <Route path="members" element={<ProjectMembersPage />} />
            <Route path="labels" element={<ProjectLabelsPage />} />
            <Route path="workspaces" element={<ProjectWorkspacesPage />} />
          </Route>
          <Route path="*" element={<NotFound crumbs={[{ label: "Settings" }, { label: "Not found" }]} />} />
        </Route>
      </Route>
    </Routes>
  );
}

// Only `npm run dev` has it: the build replaces import.meta.env.DEV with false and leaves the
// page, and what only it imports, out of the bundle.
const DesignLab = import.meta.env.DEV ? lazy(() => import("@/screens/dev/DesignLab")) : undefined;

/**
 * Pages for building the app, above the sign-in: /dev/design (the marks and the canvases on
 * sample records) needs no server. Anywhere else, the app.
 */
export function DevScreens({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  if (DesignLab && pathname === "/dev/design") {
    return (
      <Suspense fallback={null}>
        <DesignLab />
      </Suspense>
    );
  }
  return children;
}

/** /inbox: the Install checklist until anything is filed, then the Inbox. */
function InboxRoute() {
  const any = useAnyTask();
  return (
    <Loaded query={any} loading={<TopBar crumbs={[{ label: "Inbox" }]} />}>
      {(filed) => (filed ? <InboxPage /> : <SetupChecklist />)}
    </Loaded>
  );
}

/** /teams/:key/tasks and /teams/:key/features: a Team is a Project now, and its Features are Tasks. */
function FromTeam() {
  const { key = "" } = useParams();
  const { search } = useLocation();
  return <Navigate to={{ pathname: `/projects/${encodeURIComponent(key)}/tasks`, search }} replace />;
}

/**
 * /projects/:key/workflow and /settings/projects/:key/workflow, the addresses of one Workflow per
 * Project: the Workflows' now. A `?workflow=` becomes the `:workflow` segment; with none, a
 * `?step=` names the Workflow of its Step (Edit from a Step on the live page, as it was linked);
 * everything else the address says (`?step=`, `?scope=`, `?view=`…) is kept.
 */
export function FromWorkflow({ settings = false }: { settings?: boolean }) {
  const { key = "" } = useParams();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const named = params.get("workflow");
  const step = params.get("step");
  const byStep = !named && !!step;
  const graph = useWorkflow(byStep ? key : undefined);
  if (byStep && graph.isPending) return null;
  const workflow = named ? toShort(named) : step ? graph.data?.steps.find((s) => s.id === toShort(step))?.workflow_id : undefined;
  params.delete("workflow");
  const rest = params.toString();
  const pathname = `${settings ? "/settings" : ""}/projects/${encodeURIComponent(key)}/workflows${workflow ? `/${encodeURIComponent(workflow)}` : ""}`;
  return <Navigate to={{ pathname, search: rest ? `?${rest}` : "" }} replace />;
}

/** /features/:key: a Feature is a Task with Subtasks now, under the same key. */
function FromFeature() {
  const { key = "" } = useParams();
  return <Navigate to={`/tasks/${encodeURIComponent(key)}`} replace />;
}

/**
 * /admin/*: Admin is Settings now. Members and Skills are the Organisation's; a Team is a
 * Project; the Workflow and the Workspaces are the current Project's.
 */
function FromAdmin() {
  const { "*": rest = "" } = useParams();
  const { search } = useLocation();
  const [page, record] = rest.split("/");
  const projectPage = (p: string) => <ToCurrentProject path={(key) => `/settings/projects/${key}/${p}`} />;
  const to = (pathname: string) => <Navigate to={{ pathname, search }} replace />;
  switch (page) {
    case "":
    case "members":
      return to(`/settings/organisation/members${record ? `/${record}` : ""}`);
    case "skills":
      return to(`/settings/organisation/skills${record ? `/${record}` : ""}`);
    case "teams":
      return to(record ? `/settings/projects/${record}/general` : "/settings/projects");
    case "workflow":
      return projectPage("workflows");
    case "workspaces":
      return projectPage("workspaces");
    default:
      return to("/settings");
  }
}
