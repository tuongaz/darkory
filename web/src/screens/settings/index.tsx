import { AccountPage } from "./AccountPage";
import { AgentsPage } from "./AgentsPage";
import { InstallPage } from "./InstallPage";
import { OrganisationLabelsPage, ProjectLabelsPage } from "./LabelsPage";
import { MemberPage } from "./MemberPage";
import { MembersPage } from "./MembersPage";
import { SkillPage, SkillsPage } from "./SkillsPage";
import { WorkspacesPage } from "./WorkspacesPage";

export { OrganisationGate, SettingsLayout } from "./SettingsLayout";
// A Project's settings, which app/routes.tsx mounts under /projects/:key/settings.
export { ProjectGeneralPage, ProjectMembersPage } from "./ProjectPages";
export { ProjectLabelsPage };
export const ProjectWorkspacesPage = WorkspacesPage;

// The pages app/routes.tsx mounts under /settings, by the names it imports.

export const AccountSettingsPage = AccountPage;
export const MembersSettingsPage = MembersPage;
export const AgentsSettingsPage = AgentsPage;
export const SkillsSettingsPage = SkillsPage;
export const SkillSettingsPage = SkillPage;
export const LabelsSettingsPage = OrganisationLabelsPage;
export const InstallSettingsPage = InstallPage;

export function MemberSettingsPage() {
  return <MemberPage area="members" />;
}

export function AgentSettingsPage() {
  return <MemberPage area="agents" />;
}
