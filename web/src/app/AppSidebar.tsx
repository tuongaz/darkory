import {
  ActivityIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InboxIcon,
  LayersIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useMatch } from "react-router";
import type { Team } from "@/api/client";
import { useStreamState, type StreamState } from "@/api/live";
import { useDirectory, useOpenTasks, useTeams } from "@/api/queries";
import { useNow } from "@/clock";
import { MemberAvatar } from "@/components/MemberAvatar";
import { TeamMark } from "@/components/TeamMark";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveAgents } from "@/work";
import { teamFeaturesPath, teamTasksPath, useCurrentTeam } from "./currentTeam";
import { searchKeys } from "./shortcuts";

/**
 * The shell's sidebar (F-B1): the Organisation, search, the four places every Member has, a group
 * per Team with its Tasks and Features, then Admin for admins and the signed-in Member.
 */
export function AppSidebar({ onSearch }: { onSearch: () => void }) {
  const me = useCurrentMe();
  const { setOpenMobile } = useSidebar();
  const location = useLocation();
  // On a phone the sidebar is a sheet: following a link closes it.
  const closeOnLink = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpenMobile(false);
  };

  return (
    <Sidebar aria-label="Sidebar">
      <SidebarHeader className="gap-0 p-2 pb-0">
        <div className="flex items-center gap-2 px-2 py-1.5 font-semibold">
          <span
            aria-hidden
            className="grid size-5 flex-none place-items-center rounded-[5px] bg-primary text-[11px] text-primary-foreground"
          >
            {(me.organisation.name[0] ?? "?").toUpperCase()}
          </span>
          <span className="truncate">{me.organisation.name}</span>
        </div>
        <button
          type="button"
          onClick={onSearch}
          className="mt-1.5 mb-2 flex h-[30px] cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
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
            <NavItem to="/agents" icon={<ZapIcon />} label="Agents" badge={<LiveCount />} />
            <NavItem to="/activity" icon={<ActivityIcon />} label="Activity" />
          </SidebarMenu>
        </nav>
        <Teams />
      </SidebarContent>
      <SidebarFooter className="gap-0.5 p-2" onClickCapture={closeOnLink}>
        {me.member.admin && (
          <SidebarMenu>
            <NavItem to="/admin" icon={<ShieldIcon />} label="Admin" />
          </SidebarMenu>
        )}
        <Link
          to="/account"
          aria-label={`Account, ${me.member.name}`}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
            location.pathname === "/account" && "bg-sidebar-accent",
          )}
        >
          <MemberAvatar member={me.member} size="md" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate">{me.member.name}</span>
            <small className="text-2xs text-muted-foreground">{me.member.admin ? "Admin" : "Member"}</small>
          </span>
          <StreamStatus />
        </Link>
      </SidebarFooter>
    </Sidebar>
  );
}

function NavItem({ to, icon, label, badge }: { to: string; icon: React.ReactNode; label: string; badge?: React.ReactNode }) {
  const active = useMatch({ path: to, end: false }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={to} aria-current={active ? "page" : undefined}>
          {icon}
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge}
    </SidebarMenuItem>
  );
}

/** How many agents hold a live Claim now, beside Agents; nothing when none does. */
function LiveCount() {
  const tasks = useOpenTasks();
  const { members } = useDirectory();
  const now = useNow();
  const n = liveAgents(tasks.data ?? [], members, now).size;
  if (n === 0) return null;
  return <SidebarMenuBadge className="text-2xs font-normal text-muted-foreground">{n} live</SidebarMenuBadge>;
}

function Teams() {
  const me = useCurrentMe();
  const teams = useTeams();
  const current = useCurrentTeam();
  if (!teams.data) return null;
  if (teams.data.length === 0 && !me.member.admin) return null;
  return (
    <SidebarGroup className="mt-2.5 p-0">
      <SidebarGroupLabel className="h-6 px-2 text-2xs text-muted-foreground">Teams</SidebarGroupLabel>
      <SidebarMenu className="gap-0.5">
        {teams.data.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-muted-foreground">
              <Link to="/admin/teams?new=1">
                <PlusIcon />
                <span>Create a Team</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          // Keyed by whether it is current, so becoming current (G B, a link) unfolds it.
          teams.data.map((t) => <TeamItem key={`${t.id}:${t.id === current?.id}`} team={t} current={t.id === current?.id} />)
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function TeamItem({ team, current }: { team: Team; current: boolean }) {
  const [open, setOpen] = useState(current);
  const tasks = teamTasksPath(team);
  const features = teamFeaturesPath(team);
  const onTasks = useMatch(`/teams/${team.key}/tasks`) !== null;
  const onFeatures = useMatch(`/teams/${team.key}/features`) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <TeamMark team={team} />
        <span>{team.name}</span>
        {open ? (
          <ChevronDownIcon className="ml-auto size-3.5! text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="ml-auto size-3.5! text-muted-foreground" />
        )}
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub className="mx-0 translate-x-0 gap-0.5 border-l-0 px-0 py-0.5">
          <SidebarMenuSubItem>
            <SidebarMenuSubButton asChild isActive={onTasks} className="h-[30px] pl-[30px]">
              <Link to={tasks} aria-current={onTasks ? "page" : undefined}>
                <ListIcon />
                <span>Tasks</span>
              </Link>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton asChild isActive={onFeatures} className="h-[30px] pl-[30px]">
              <Link to={features} aria-current={onFeatures ? "page" : undefined}>
                <LayersIcon />
                <span>Features</span>
              </Link>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

const streamLabels: Record<StreamState, string> = {
  connecting: "Connecting",
  live: "Connected",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

/** Whether live updates are arriving: the Activity stream's state. */
function StreamStatus() {
  const state = useStreamState();
  return (
    <span role="status" className="ml-auto flex flex-none items-center gap-1.5 text-2xs text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : "bg-state-claimed")} />
      {streamLabels[state]}
    </span>
  );
}
