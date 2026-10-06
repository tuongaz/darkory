import { ShieldIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import { useMembers, useSkills, useTeams, useWorkspaces } from "@/api/queries";
import { Content, TopBar, type Crumb } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";

const adminCrumb: Crumb = { label: "Admin", icon: <ShieldIcon className="size-3.5 text-muted-foreground" /> };

/** /admin/*: admins only. The shell hides Admin from others; an address typed in is refused here. */
export function AdminLayout() {
  const me = useCurrentMe();
  if (!me.member.admin) {
    return (
      <>
        <TopBar crumbs={[adminCrumb]} />
        <Content>
          <EmptyState icon={<ShieldIcon />} title="Admins only">
            An admin of {me.organisation.name} can open Admin.
          </EmptyState>
        </Content>
      </>
    );
  }
  return <Outlet />;
}

/**
 * Every Admin page: the top bar (Admin / the tab / the record), the tabs under it, then the page.
 * `crumbs` follow Admin.
 */
export function AdminFrame({
  crumbs,
  actions,
  primary,
  pad = true,
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  primary?: ReactNode;
  pad?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar crumbs={[adminCrumb, ...crumbs]} actions={actions} primary={primary} />
      <AdminTabs />
      <Content pad={pad}>{children}</Content>
    </>
  );
}

function AdminTabs() {
  const members = useMembers();
  const teams = useTeams();
  const skills = useSkills();
  const workspaces = useWorkspaces();
  const tabs = [
    { to: "/admin/members", label: "Members", n: members.data?.length },
    { to: "/admin/teams", label: "Teams", n: teams.data?.length },
    { to: "/admin/skills", label: "Skills", n: skills.data?.length },
    { to: "/admin/workflow", label: "Workflow" },
    { to: "/admin/workspaces", label: "Workspaces", n: workspaces.data?.length },
  ];
  return (
    // On a phone the five tabs fit the width: tighter padding and no counts, and they scroll
    // inside the bar if the names ever grow past it.
    <nav aria-label="Admin" className="flex flex-none gap-0.5 overflow-x-auto border-b px-2 sm:px-4">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            cn(
              "-mb-px inline-flex h-9 flex-none items-center gap-1.5 border-b-2 border-transparent px-2 font-medium whitespace-nowrap text-muted-foreground hover:text-foreground sm:px-2.5",
              isActive && "border-foreground text-foreground",
            )
          }
        >
          {t.label}
          {t.n !== undefined && <span className="hidden text-2xs text-muted-foreground tabular-nums sm:inline">{t.n}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
