import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleUserIcon,
  GraduationCapIcon,
  PlusIcon,
  ServerIcon,
  ShieldIcon,
  TagIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, Outlet, useMatch } from "react-router";
import type { Project } from "@/api/client";
import { useProjects } from "@/api/queries";
import { projectSettingsPath, useCurrentProject, type ProjectSettingsPage } from "@/app/currentProject";
import { sendIntent } from "@/app/intents";
import { appReturnPath } from "@/app/returnTo";
import { Frame } from "@/app/Shell";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { ProjectMark } from "@/components/ProjectMark";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useCurrentMe } from "@/me";

/** `/settings/*`: Settings' own nav in place of the app's sidebar, beside the page. */
export function SettingsLayout() {
  return (
    <Frame sidebar={<SettingsNav />}>
      <Outlet />
    </Frame>
  );
}

const organisationPages = [
  { path: "members", label: "Members", icon: <UsersIcon /> },
  { path: "agents", label: "Agents", icon: <ZapIcon /> },
  { path: "skills", label: "Skills", icon: <GraduationCapIcon /> },
  { path: "labels", label: "Labels", icon: <TagIcon /> },
  { path: "install", label: "Install", icon: <ServerIcon /> },
];

const projectPages: { page: ProjectSettingsPage; label: string }[] = [
  { page: "general", label: "General" },
  { page: "workflow", label: "Workflow" },
  { page: "members", label: "Members" },
  { page: "labels", label: "Labels" },
  { page: "workspaces", label: "Workspaces" },
];

/**
 * Settings' nav: Back to the app page you came from, then Account; the Organisation's pages for
 * admins; and the Projects, each opening onto its own pages, with "+ New Project" for admins. A
 * Member who is not an admin sees the Projects they are in. On a phone it is the sheet the top
 * bar's button opens, as the app's sidebar is.
 */
function SettingsNav() {
  const me = useCurrentMe();
  const admin = me.member.admin;
  const projects = useProjects();
  const current = useCurrentProject();
  const { setOpenMobile } = useSidebar();
  const shown = admin ? (projects.data ?? []) : me.projects;
  const inUrl = useMatch("/settings/projects/:key/*")?.params.key;
  const open = shown.find((p) => p.key === inUrl) ?? current;
  const closeOnLink = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpenMobile(false);
  };

  return (
    <Sidebar aria-label="Settings">
      <SidebarHeader className="gap-0 p-2 pb-1" onClickCapture={closeOnLink}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-muted-foreground">
              <Link to={appReturnPath()}>
                <ArrowLeftIcon />
                <span>Back</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <h1 className="px-2 pt-2 pb-1 text-[15px] font-semibold">Settings</h1>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-2 pb-3" onClickCapture={closeOnLink}>
        <nav aria-label="Settings pages">
          <NavGroup label="Account">
            <NavLink to="/settings/account" icon={<CircleUserIcon />} label="Account" />
          </NavGroup>
          {admin && (
            <NavGroup label="Organisation">
              {organisationPages.map((p) => (
                <NavLink key={p.path} to={`/settings/organisation/${p.path}`} icon={p.icon} label={p.label} />
              ))}
            </NavGroup>
          )}
          <NavGroup label="Projects">
            {shown.map((p) => (
              <ProjectItem key={`${p.id}:${p.id === open?.id}`} project={p} open={p.id === open?.id} />
            ))}
            {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton className="text-muted-foreground" onClick={() => sendIntent({ kind: "new-project" })}>
                  <PlusIcon />
                  <span>New Project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </NavGroup>
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SidebarGroup className="p-0 pt-3">
      <SidebarGroupLabel className="h-6 px-2 text-2xs text-muted-foreground">{label}</SidebarGroupLabel>
      <SidebarMenu aria-label={label} className="gap-0.5">
        {children}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function NavLink({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  const active = useMatch({ path: to, end: false }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={to} aria-current={active ? "page" : undefined}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** A Project in Settings' nav, unfolding onto its pages. */
function ProjectItem({ project, open: initiallyOpen }: { project: Project; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ProjectMark project={project} />
        <span>{project.name}</span>
        {open ? (
          <ChevronDownIcon className="ml-auto size-3.5! text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="ml-auto size-3.5! text-muted-foreground" />
        )}
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub aria-label={project.name} className="mx-0 translate-x-0 gap-0.5 border-l-0 px-0 py-0.5">
          {projectPages.map((p) => (
            <ProjectPageLink key={p.page} to={projectSettingsPath(project, p.page)} label={p.label} />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function ProjectPageLink({ to, label }: { to: string; label: string }) {
  const active = useMatch({ path: to, end: false }) !== null;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} className="h-[30px] pl-[30px]">
        <Link to={to} aria-current={active ? "page" : undefined}>
          <span>{label}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** `/settings/organisation/*`: admins only. Settings' nav hides it from others; an address typed in is refused here. */
export function OrganisationGate() {
  const me = useCurrentMe();
  if (me.member.admin) return <Outlet />;
  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }, { label: "Organisation" }]} />
      <Content>
        <EmptyState icon={<ShieldIcon />} title="Admins only">
          An admin of {me.organisation.name} changes its Members, Agents, Skills and Labels.
        </EmptyState>
      </Content>
    </>
  );
}
