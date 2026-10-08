import {
  ActivityIcon,
  CheckIcon,
  ChevronDownIcon,
  InboxIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  UserIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useMatch } from "react-router";
import type { Project } from "@/api/client";
import { useStreamState, type StreamState } from "@/api/live";
import { useDirectory, useOpenTasks, useProjects } from "@/api/queries";
import { useNow } from "@/clock";
import { ProjectMark } from "@/components/ProjectMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveAgents } from "@/work";
import { projectPath, projectSettingsPath, useCurrentProject, type ProjectArea } from "./currentProject";
import { sendIntent, useIntent } from "./intents";
import { logOutKeys, searchKeys, settingsHome } from "./shortcuts";

/**
 * The app's sidebar, after Linear's: a top row with the Organisation menu (and whether live
 * updates arrive), Search and File a Task; the places every Member has across Projects (Inbox, My
 * work); then the Projects the Member is in, each unfolding onto its places and its Settings, the
 * current one unfolded. Nothing at the foot: the Member's Account and Log out are in the
 * Organisation menu.
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
      <SidebarHeader className="flex-row items-center gap-1 p-2 pb-1">
        <OrganisationMenu />
        <StreamDot />
        <div className="ml-auto flex flex-none items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search"
                aria-keyshortcuts="Meta+K Control+K"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setOpenMobile(false);
                  sendIntent({ kind: "search" });
                }}
              >
                <SearchIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Search <Kbd className="ml-1">{searchKeys}</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="File a Task"
                aria-keyshortcuts="C"
                className="rounded-full"
                onClick={() => {
                  setOpenMobile(false);
                  sendIntent({ kind: "file-task", project: project?.key });
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              File a Task <Kbd className="ml-1">C</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-2 pb-3" onClickCapture={closeOnLink}>
        <nav aria-label="Main">
          <SidebarMenu className="gap-0.5">
            <NavItem to="/inbox" icon={<InboxIcon />} label="Inbox" />
            <NavItem to="/my-work" icon={<UserIcon />} label="My work" />
          </SidebarMenu>
        </nav>
        <ProjectsGroup current={project} />
      </SidebarContent>
    </Sidebar>
  );
}

/** A shortcut as Linear writes it in a menu: muted, "G then S". */
function MenuKeys({ keys }: { keys: string[] }) {
  return <DropdownMenuShortcut className="pl-6 tracking-normal">{keys.join(" then ")}</DropdownMenuShortcut>;
}

/**
 * The Organisation's mark and name, opening its menu: Settings, Invite and manage Members (admins),
 * Switch Organisation (the Organisations the sign-in reaches, and the Member's Account settings),
 * Log out.
 * O then W opens it on Switch Organisation.
 */
function OrganisationMenu() {
  const me = useCurrentMe();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  useIntent("switch-organisation", () => {
    if (isMobile) setOpenMobile(true);
    setOpen(true);
    setSwitchOpen(true);
  });
  const organisation = me.organisation;
  // Local holds exactly one Organisation, and /v1/me says so by leaving the list out.
  const organisations = me.organisations ?? [organisation];
  // The menu is portalled out of the sheet: a link followed in it closes the sheet itself.
  const link = (to: string, label: string, keys?: string[]) => (
    <DropdownMenuItem asChild>
      <Link to={to} onClick={() => setOpenMobile(false)}>
        {label}
        {keys && <MenuKeys keys={keys} />}
      </Link>
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSwitchOpen(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm font-semibold outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent"
        >
          <OrganisationMark name={organisation.name} />
          <span className="min-w-0 truncate">{organisation.name}</span>
          <ChevronDownIcon aria-hidden className="size-3.5 flex-none text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-72 max-w-[calc(100vw-2rem)]">
        {link(settingsHome(me.member.admin), "Settings", ["G", "S"])}
        {me.member.admin && link("/settings/organisation/members", "Invite and manage Members")}
        <DropdownMenuSeparator />
        <DropdownMenuSub open={switchOpen} onOpenChange={setSwitchOpen}>
          <DropdownMenuSubTrigger>
            Switch Organisation
            <MenuKeys keys={["O", "W"]} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-64 max-w-[calc(100vw-2rem)]"
            collisionPadding={8}
            // A phone has room beside the menu for neither side: it overlaps the menu, under its row.
            sideOffset={isMobile ? -168 : 4}
            alignOffset={isMobile ? 28 : -4}
          >
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{me.member.email ?? me.member.name}</DropdownMenuLabel>
            {organisations.map((o) => {
              const current = o.id === organisation.id;
              return (
                // /v1 has no operation that switches: the others are listed, not opened.
                <DropdownMenuItem key={o.id} disabled={!current} aria-current={current ? "true" : undefined}>
                  <OrganisationMark name={o.name} />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {current && <CheckIcon className="text-foreground" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            {link("/settings/account", "Account settings")}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => sendIntent({ kind: "log-out" })}>
          Log out
          <DropdownMenuShortcut className="pl-6 tracking-normal">{logOutKeys}</DropdownMenuShortcut>
        </DropdownMenuItem>
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

const streamLabels: Record<StreamState, string> = {
  connecting: "Connecting…",
  live: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Offline",
};

/** Whether live updates are arriving: the Activity stream's state, a dot beside the Organisation, its words on hover. */
function StreamDot() {
  const state = useStreamState();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="status" className="grid size-4 flex-none place-items-center">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : state === "closed" ? "bg-muted-foreground" : "bg-state-claimed")}
          />
          <span className="sr-only">{streamLabels[state]}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{streamLabels[state]}</TooltipContent>
    </Tooltip>
  );
}

const places: { area: ProjectArea; label: string; icon: React.ReactNode }[] = [
  { area: "tasks", label: "Tasks", icon: <ListIcon /> },
  { area: "workflow", label: "Workflow", icon: <WorkflowIcon /> },
  { area: "agents", label: "Agents", icon: <ZapIcon /> },
  { area: "activity", label: "Activity", icon: <ActivityIcon /> },
];

// Which Projects this browser unfolded or folded, by key, beyond the current one being unfolded.
const foldsKey = "darkory.sidebar.projects";
let foldsVersion = 0;
const foldListeners = new Set<() => void>();

function readFolds(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(foldsKey) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeFold(key: string, open: boolean | undefined) {
  const folds = readFolds();
  if (folds[key] === open) return;
  if (open === undefined) delete folds[key];
  else folds[key] = open;
  try {
    localStorage.setItem(foldsKey, JSON.stringify(folds));
  } catch {
    // Storage refused (a private window): the rows unfold for this page only.
  }
  foldsVersion++;
  for (const l of foldListeners) l();
}

function useFolds(): Record<string, boolean> {
  useSyncExternalStore(
    (l) => {
      foldListeners.add(l);
      return () => foldListeners.delete(l);
    },
    () => foldsVersion,
  );
  return readFolds();
}

/**
 * The Projects the Member is in, as Linear lists "Your teams", and the current Project if the
 * Member is not in it (an admin may open any). Each row unfolds onto the Project's places; the
 * current one is unfolded whenever it becomes current, the others as this browser left them.
 * "+ New Project" ends the group for admins. G then P focuses the current Project's row.
 */
function ProjectsGroup({ current }: { current: Project | undefined }) {
  const me = useCurrentMe();
  const projects = useProjects();
  const { isMobile, setOpenMobile } = useSidebar();
  const folds = useFolds();
  const mine = new Set(me.projects.map((p) => p.id));
  const shown = (projects.data ?? me.projects).filter((p) => mine.has(p.id) || p.id === current?.id);

  // Becoming current unfolds a Project, even one folded before.
  useEffect(() => {
    if (current) writeFold(current.key, undefined);
  }, [current]);

  useIntent("focus-projects", () => {
    if (isMobile) setOpenMobile(true);
    // The sheet mounts its content as it opens.
    setTimeout(() => {
      const rows = document.querySelectorAll<HTMLElement>("[data-sidebar=sidebar] [data-project-row]");
      const row = [...rows].find((r) => r.dataset.projectRow === current?.key) ?? rows[0];
      row?.focus();
    });
  });

  return (
    <SidebarGroup className="mt-3 p-0">
      <SidebarGroupLabel className="h-6 px-2 text-2xs text-muted-foreground">Projects</SidebarGroupLabel>
      <nav aria-label="Projects">
        <SidebarMenu className="gap-0.5">
          {shown.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              current={p.id === current?.id}
              open={folds[p.key] ?? p.id === current?.id}
              onOpenChange={(open) => writeFold(p.key, open === (p.id === current?.id) ? undefined : open)}
            />
          ))}
          {shown.length === 0 && !me.member.admin && <li className="px-2 py-1 text-xs text-muted-foreground">No Projects yet</li>}
          {me.member.admin && (
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-muted-foreground"
                onClick={() => {
                  setOpenMobile(false);
                  sendIntent({ kind: "new-project" });
                }}
              >
                <PlusIcon />
                <span>New Project</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}

/** A Project in the sidebar: its mark and name, unfolding onto Tasks, Workflow, Agents (with its live count), Activity, Settings. */
function ProjectRow({ project, current, open, onOpenChange }: { project: Project; current: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  // A Task's page sits under its Project's Tasks: the current Project is the Task's.
  const onTask = useMatch("/tasks/:task") !== null && current;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton aria-expanded={open} data-project-row={project.key} onClick={() => onOpenChange(!open)}>
        <ProjectMark project={project} />
        <span className="min-w-0 truncate">{project.name}</span>
        <ChevronDownIcon aria-hidden className={cn("size-3! flex-none text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub aria-label={project.name} className="mx-0 translate-x-0 gap-0.5 border-l-0 px-0 py-0.5">
          {places.map((p) => (
            <PlaceLink
              key={p.area}
              to={projectPath(project, p.area)}
              icon={p.icon}
              label={p.label}
              active={p.area === "tasks" && onTask ? true : undefined}
              badge={p.area === "agents" ? <LiveCount project={project} /> : undefined}
            />
          ))}
          <PlaceLink to={projectSettingsPath(project)} icon={<SettingsIcon />} label="Settings" />
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function PlaceLink({ to, icon, label, badge, active }: { to: string; icon: React.ReactNode; label: string; badge?: React.ReactNode; active?: boolean }) {
  const path = to.split("?")[0];
  const here = useMatch({ path, end: false }) !== null;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active ?? here} className="h-[30px] pl-[26px] [&>svg]:text-muted-foreground">
        <Link to={to} aria-current={here ? "page" : undefined}>
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {badge}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  const here = useMatch({ path: to, end: false }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={here}>
        <Link to={to} aria-current={here ? "page" : undefined}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
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
  return <span className="ml-auto flex-none text-2xs text-muted-foreground">{n} live</span>;
}
