import { useMutation } from "@tanstack/react-query";
import {
  ActivityIcon,
  BuildingIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CircleUserIcon,
  InboxIcon,
  ListIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useMatch, useNavigate } from "react-router";
import type { Project } from "@/api/client";
import { useStreamState, type StreamState } from "@/api/live";
import { useDirectory, useOpenTasks, useProjects } from "@/api/queries";
import { logout } from "@/api/writes";
import { useNow } from "@/clock";
import { MemberAvatar } from "@/components/MemberAvatar";
import { ProjectMark } from "@/components/ProjectMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveAgents } from "@/work";
import { projectPath, projectSettingsPath, useCurrentProject, useProjectArea, type ProjectArea } from "./currentProject";
import { sendIntent, useIntent } from "./intents";
import { searchKeys } from "./shortcuts";

/**
 * The app's sidebar: the Project switcher, Search, the places every Member has across Projects
 * (Inbox, My work), then the current Project's places (Tasks, Workflow, Agents, Activity) and its
 * Settings, and the signed-in Member's menu at the foot.
 */
export function AppSidebar() {
  const project = useCurrentProject();
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet: following a link closes it.
  const closeOnLink = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpenMobile(false);
  };

  return (
    <Sidebar aria-label="Sidebar">
      <SidebarHeader className="gap-1.5 p-2 pb-2" onClickCapture={closeOnLink}>
        <ProjectSwitcher current={project} />
        <button
          type="button"
          onClick={() => sendIntent({ kind: "search" })}
          className="flex h-[30px] cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <SearchIcon className="size-3.5" />
          Search
          <Kbd className="ml-auto border">{searchKeys}</Kbd>
        </button>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-2" onClickCapture={closeOnLink}>
        <nav aria-label="Main">
          <SidebarMenu className="gap-0.5">
            <NavItem to="/inbox" icon={<InboxIcon />} label="Inbox" />
            <NavItem to="/my-work" icon={<UserIcon />} label="My work" />
          </SidebarMenu>
        </nav>
        {project && <ProjectPlaces project={project} />}
      </SidebarContent>
      <SidebarFooter className="p-2" onClickCapture={closeOnLink}>
        <MemberMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * The switcher at the head of the sidebar: the current Project's mark and name. Its menu heads
 * with the Organisation (its settings, for an admin), lists every Project with the current one
 * ticked, offers "+ New Project" to admins, and "Switch Organisation" only when the sign-in reaches
 * more than one, which never happens on Local. G then P opens it.
 */
function ProjectSwitcher({ current }: { current: Project | undefined }) {
  const me = useCurrentMe();
  const projects = useProjects();
  const navigate = useNavigate();
  const area = useProjectArea();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  useIntent("switch-project", () => {
    if (isMobile) setOpenMobile(true);
    setOpen(true);
  });
  const admin = me.member.admin;
  const organisations = me.organisations ?? [];
  const go = (to: string) => {
    setOpenMobile(false);
    navigate(to);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          aria-label={current ? `Project: ${current.name}` : "Project: none yet"}
          className="h-9 gap-2 px-2 font-semibold data-[state=open]:bg-sidebar-accent"
        >
          {current ? <ProjectMark project={current} size="md" /> : <OrganisationMark name={me.organisation.name} />}
          <span className={cn("min-w-0 flex-1 truncate", !current && "font-normal text-muted-foreground")}>
            {current?.name ?? "No Project yet"}
          </span>
          <ChevronsUpDownIcon className="ml-auto size-3.5! text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-(--radix-dropdown-menu-trigger-width) min-w-60">
        {admin ? (
          <DropdownMenuItem asChild>
            <Link to="/settings/organisation" onClick={() => setOpenMobile(false)} className="font-semibold">
              <OrganisationMark name={me.organisation.name} />
              <span className="min-w-0 flex-1 truncate">{me.organisation.name}</span>
              <SettingsIcon className="text-muted-foreground" />
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuLabel className="flex items-center gap-2 font-semibold">
            <OrganisationMark name={me.organisation.name} />
            <span className="truncate">{me.organisation.name}</span>
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-label="Projects">
          {(projects.data ?? []).map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => go(projectPath(p, area ?? "tasks"))}
              aria-current={p.id === current?.id ? "true" : undefined}
            >
              <ProjectMark project={p} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="font-mono text-2xs text-muted-foreground">{p.key}</span>
              <CheckIcon className={cn(p.id !== current?.id && "invisible")} />
            </DropdownMenuItem>
          ))}
          {projects.data?.length === 0 && <DropdownMenuLabel className="font-normal text-muted-foreground">No Projects yet</DropdownMenuLabel>}
        </DropdownMenuGroup>
        {admin && (
          <DropdownMenuItem onSelect={() => sendIntent({ kind: "new-project" })}>
            <PlusIcon />
            New Project
          </DropdownMenuItem>
        )}
        {organisations.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <BuildingIcon />
                Switch Organisation
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-48">
                {organisations.map((o) => (
                  // /v1 has no operation that switches: the other Organisations are listed, not opened.
                  <DropdownMenuItem key={o.id} disabled={o.id !== me.organisation.id}>
                    <OrganisationMark name={o.name} />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    {o.id === me.organisation.id && <CheckIcon />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Organisation's lettered square, in the ink of the app's primary. */
function OrganisationMark({ name }: { name: string }) {
  return (
    <span aria-hidden className="grid size-5 flex-none place-items-center rounded-[5px] bg-primary text-[11px] font-semibold text-primary-foreground">
      {(name[0] ?? "?").toUpperCase()}
    </span>
  );
}

const places: { area: ProjectArea; label: string; icon: React.ReactNode }[] = [
  { area: "tasks", label: "Tasks", icon: <ListIcon /> },
  { area: "workflow", label: "Workflow", icon: <WorkflowIcon /> },
  { area: "agents", label: "Agents", icon: <ZapIcon /> },
  { area: "activity", label: "Activity", icon: <ActivityIcon /> },
];

/** The current Project's places, under its name, then its Settings. */
function ProjectPlaces({ project }: { project: Project }) {
  // A Task's page sits under its Project's Tasks: the current Project is the Task's.
  const onTask = useMatch("/tasks/:task") !== null;
  return (
    <SidebarGroup className="mt-3 p-0">
      <SidebarGroupLabel className="h-6 px-2 text-2xs text-muted-foreground">{project.name}</SidebarGroupLabel>
      <nav aria-label="Project">
        <SidebarMenu className="gap-0.5">
          {places.map((p) => (
            <NavItem
              key={p.area}
              to={projectPath(project, p.area)}
              icon={p.icon}
              label={p.label}
              active={p.area === "tasks" && onTask ? true : undefined}
              badge={p.area === "agents" ? <LiveCount project={project} /> : undefined}
            />
          ))}
          <NavItem to={projectSettingsPath(project)} icon={<SettingsIcon />} label="Settings" />
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}

function NavItem({ to, icon, label, badge, active }: { to: string; icon: React.ReactNode; label: string; badge?: React.ReactNode; active?: boolean }) {
  const path = to.split("?")[0];
  const here = useMatch({ path, end: false }) !== null;
  const isActive = active ?? here;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={to} aria-current={here ? "page" : undefined}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge}
    </SidebarMenuItem>
  );
}

/** How many agents hold a live Claim on the Project's Tasks now, beside Agents; nothing when none does. */
function LiveCount({ project }: { project: Project }) {
  const tasks = useOpenTasks();
  const { members } = useDirectory();
  const now = useNow();
  const n = liveAgents((tasks.data ?? []).filter((t) => t.project_id === project.id), members, now).size;
  if (n === 0) return null;
  return <SidebarMenuBadge className="text-2xs font-normal text-muted-foreground">{n} live</SidebarMenuBadge>;
}

/** The signed-in Member at the foot: their mark and name, opening Account, Organisation settings (admins) and Sign out. */
function MemberMenu() {
  const me = useCurrentMe();
  const { setOpenMobile } = useSidebar();
  const signOut = useMutation({ mutationFn: logout });
  const m = me.member;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton aria-label={`Account: ${m.name}`} className="h-10 gap-2 px-2 pr-24 data-[state=open]:bg-sidebar-accent">
              <MemberAvatar member={m} size="md" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="flex flex-col font-normal">
              <span className="truncate font-medium">{m.name}</span>
              {m.email && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings/account" onClick={() => setOpenMobile(false)}>
                <CircleUserIcon />
                Account
              </Link>
            </DropdownMenuItem>
            {m.admin && (
              <DropdownMenuItem asChild>
                <Link to="/settings/organisation" onClick={() => setOpenMobile(false)}>
                  <BuildingIcon />
                  Organisation settings
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut.mutate()} disabled={signOut.isPending}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <StreamStatus />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

const streamLabels: Record<StreamState, string> = {
  connecting: "Connecting",
  live: "Connected",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

/** Whether live updates are arriving: the Activity stream's state, at the right of the Member's row. */
function StreamStatus() {
  const state = useStreamState();
  return (
    <span
      role="status"
      className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 text-2xs text-muted-foreground"
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : "bg-state-claimed")} />
      {streamLabels[state]}
    </span>
  );
}
