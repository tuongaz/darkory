import { useParams } from "react-router";
import { useRouteProject } from "@/app/currentProject";
import { PlaceholderPage } from "@/app/Placeholder";

export { OrganisationGate, SettingsLayout } from "./SettingsLayout";

// M4a's second part fills these pages; the route table and the nav are final.

const owner = "M4a (Settings)";

export function AccountSettingsPage() {
  return <PlaceholderPage title="Profile" owner={owner} crumbs={[{ label: "Settings" }, { label: "Profile" }]} />;
}

function OrganisationPage({ title }: { title: string }) {
  const { member, skill } = useParams();
  const record = member ?? skill;
  return <PlaceholderPage title={title} owner={owner} crumbs={[{ label: "Settings" }, { label: title }, ...(record ? [{ label: record }] : [])]} />;
}

export function MembersSettingsPage() {
  return <OrganisationPage title="Members" />;
}

export function MemberSettingsPage() {
  return <OrganisationPage title="Members" />;
}

export function AgentsSettingsPage() {
  return <OrganisationPage title="Agents" />;
}

export function AgentSettingsPage() {
  return <OrganisationPage title="Agents" />;
}

export function SkillsSettingsPage() {
  return <OrganisationPage title="Skills" />;
}

export function SkillSettingsPage() {
  return <OrganisationPage title="Skills" />;
}

export function LabelsSettingsPage() {
  return <OrganisationPage title="Labels" />;
}

export function InstallSettingsPage() {
  return <OrganisationPage title="Install" />;
}

function ProjectPage({ title }: { title: string }) {
  const project = useRouteProject();
  return <PlaceholderPage title={title} owner={owner} crumbs={[{ label: "Settings" }, { label: project.name }, { label: title }]} />;
}

export function ProjectGeneralPage() {
  return <ProjectPage title="General" />;
}

export function ProjectMembersPage() {
  return <ProjectPage title="Members" />;
}

export function ProjectLabelsPage() {
  return <ProjectPage title="Labels" />;
}

export function ProjectWorkspacesPage() {
  return <ProjectPage title="Workspaces" />;
}
