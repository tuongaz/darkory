import { SearchXIcon } from "lucide-react";
import { Link, Navigate, Route, Routes } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Loaded } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import {
  AccountPage,
  AdminLayout,
  MemberPage,
  MembersPage,
  SkillPage,
  SkillsPage,
  TeamPage,
  TeamsPage,
  WorkflowPage,
  WorkspacesPage,
} from "@/screens/admin";
import { BoardDialogs, TeamFeaturesPage, TeamTasksPage } from "@/screens/board";
import { ActivityPage, AgentsPage, InboxPage, MyWorkPage } from "@/screens/inbox";
import { FeaturePage, TaskPage, TaskPeek } from "@/screens/task";
import { SetupChecklist } from "./SetupChecklist";
import { useAnyFeature } from "./setup";
import { Shell } from "./Shell";
import { Content, TopBar } from "./TopBar";

/**
 * Every screen's address. This is the only file that imports the screens/ folders; each folder's
 * index.tsx exports the pages named here, so the phases building them never edit the same file.
 *
 * Search parameters every list honours: ?task=<key> opens that Task's Peek over the page (the
 * shell mounts it); ?view=list|board on a Team's Tasks; ?new=1 on /admin/members and /admin/teams
 * opens the create dialog.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        // One peek for every Task it shows: J and K move it along the list without opening a new sheet.
        element={<Shell dialogs={<BoardDialogs />} peek={(taskKey, close) => <TaskPeek taskKey={taskKey} onClose={close} />} />}
      >
        <Route index element={<Navigate to="/inbox" replace />} />
        <Route path="inbox" element={<InboxRoute />} />
        <Route path="my-work" element={<MyWorkPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="teams/:team/tasks" element={<TeamTasksPage />} />
        <Route path="teams/:team/features" element={<TeamFeaturesPage />} />
        <Route path="features/:feature" element={<FeaturePage />} />
        <Route path="tasks/:task" element={<TaskPage />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/members" replace />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/:member" element={<MemberPage />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="teams/:team" element={<TeamPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="skills/:skill" element={<SkillPage />} />
          <Route path="workflow" element={<WorkflowPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
        </Route>
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** /inbox: the Install checklist until anything is filed, then the Inbox. */
function InboxRoute() {
  const any = useAnyFeature();
  return (
    <Loaded query={any} loading={<TopBar crumbs={[{ label: "Inbox" }]} />}>
      {(filed) => (filed ? <InboxPage /> : <SetupChecklist />)}
    </Loaded>
  );
}

function NotFound() {
  return (
    <>
      <TopBar crumbs={[{ label: "Not found" }]} />
      <Content>
        <EmptyState
          icon={<SearchXIcon />}
          title="Not found"
          action={
            <Button asChild variant="outline">
              <Link to="/inbox">Go to Inbox</Link>
            </Button>
          }
        >
          No page at this address.
        </EmptyState>
      </Content>
    </>
  );
}
