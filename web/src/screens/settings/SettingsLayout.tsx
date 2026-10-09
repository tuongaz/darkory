import { ArrowLeftIcon, CircleUserIcon, GraduationCapIcon, ServerIcon, ShieldIcon, TagIcon, UsersIcon, ZapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Outlet, useMatch } from "react-router";
import { appReturnPath } from "@/app/returnTo";
import { Frame } from "@/app/Shell";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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

/**
 * Settings' nav: Back to the app page you came from, then Account; the Organisation's pages for
 * admins. A Project's own settings are under the Project in the app. On a phone it is the sheet the
 * top bar's button opens, as the app's sidebar is.
 */
function SettingsNav() {
  const admin = useCurrentMe().member.admin;
  const { setOpenMobile } = useSidebar();
  const closeOnLink = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpenMobile(false);
  };

  return (
    <Sidebar aria-label="Settings" variant="inset">
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
