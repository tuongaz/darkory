// W5 Admin owns this folder: Admin (Members, Teams, Skills, Workflow) and Account. Placeholders
// until W5 lands; routes.tsx imports what this file exports.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldIcon } from "lucide-react";
import { NavLink, Outlet, useParams } from "react-router";
import { api, call } from "@/api/client";
import { PlaceholderPage } from "@/app/Placeholder";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";

const owner = "W5 Admin";

/** /admin/*: admins only. */
export function AdminLayout() {
  const me = useCurrentMe();
  if (!me.member.admin) {
    return (
      <>
        <TopBar crumbs={[{ label: "Admin", icon: <ShieldIcon className="size-3.5 text-muted-foreground" /> }]} />
        <Content>
          <EmptyState title="Admins only">An admin of {me.organisation.name} can open Admin.</EmptyState>
        </Content>
      </>
    );
  }
  return <Outlet />;
}

const tabs = [
  { to: "/admin/members", label: "Members" },
  { to: "/admin/teams", label: "Teams" },
  { to: "/admin/skills", label: "Skills" },
  { to: "/admin/workflow", label: "Workflow" },
];

function AdminTabs() {
  return (
    <nav aria-label="Admin" className="flex flex-none gap-0.5 overflow-x-auto border-b px-4">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            cn(
              "-mb-px inline-flex h-9 items-center border-b-2 border-transparent px-2.5 font-medium whitespace-nowrap text-muted-foreground",
              isActive && "border-foreground text-foreground",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

function AdminPlaceholder({ section, record }: { section: string; record?: string }) {
  const crumbs = [
    { label: "Admin", icon: <ShieldIcon className="size-3.5 text-muted-foreground" /> },
    { label: section, to: record ? `/admin/${section.toLowerCase()}` : undefined },
    ...(record ? [{ label: record }] : []),
  ];
  return (
    <>
      <TopBar crumbs={crumbs} />
      <AdminTabs />
      <Content>
        <EmptyState title={record ? `${section} › ${record}` : section}>Built by {owner}.</EmptyState>
      </Content>
    </>
  );
}

/** /admin/members (?new=1 opens New Member) */
export function MembersPage() {
  return <AdminPlaceholder section="Members" />;
}

/** /admin/members/:member */
export function MemberPage() {
  return <AdminPlaceholder section="Members" record={useParams().member} />;
}

/** /admin/teams (?new=1 opens New Team) */
export function TeamsPage() {
  return <AdminPlaceholder section="Teams" />;
}

/** /admin/teams/:team */
export function TeamPage() {
  return <AdminPlaceholder section="Teams" record={useParams().team} />;
}

/** /admin/skills */
export function SkillsPage() {
  return <AdminPlaceholder section="Skills" />;
}

/** /admin/skills/:skill */
export function SkillPage() {
  return <AdminPlaceholder section="Skills" record={useParams().skill} />;
}

/** /admin/workflow */
export function WorkflowPage() {
  return <AdminPlaceholder section="Workflow" />;
}

/** /account. Sign out works already, so a browser can leave before W5 lands. */
export function AccountPage() {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => call(api.POST("/v1/logout")),
    // Forget everything read as this Member; /v1/me then answers 401.
    onSuccess: () => qc.resetQueries(),
  });
  return (
    <PlaceholderPage title="Account" owner={owner}>
      <div className="mt-2 flex flex-col items-center gap-2">
        <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </Button>
        <Refusal error={logout.error} />
      </div>
    </PlaceholderPage>
  );
}
