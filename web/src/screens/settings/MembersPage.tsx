import { BotIcon, PlusIcon, UserIcon } from "lucide-react";
import { Link } from "react-router";
import { BarAction } from "@/app/TopBar";
import type { Member, MemberDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { SettingsFrame, tableHead, tableRow } from "./frame";
import { groupByKind } from "./model";
import { NewMemberDialog } from "./NewMember";
import { GroupRow, MemberName, ProjectsCell } from "./parts";
import { memberPath, useNewParam } from "./paths";
import { useMemberDetails } from "./queries";

// Member · Model · Projects · Skills · Reporting line · Admin. A phone keeps Member and Admin; an
// agent's model comes at the width of a laptop.
const cols =
  "grid-cols-[minmax(0,1fr)_72px] md:grid-cols-[220px_180px_minmax(0,1fr)_160px_72px] lg:grid-cols-[220px_150px_180px_minmax(0,1fr)_160px_72px]";
const wide = "hidden md:flex";
const wider = "hidden lg:flex";

/** Settings › Organisation › Members: every Member, grouped Humans / Agents. */
export function MembersPage() {
  const me = useCurrentMe();
  const { open, setOpen, kind } = useNewParam();
  const { members, details, pending } = useMemberDetails();
  const directory = useDirectory();
  const { humans, agents } = groupByKind(members.data ?? []);
  const row = (m: Member) => (
    <MemberRow key={m.id} member={m} detail={details.get(m.id)} loading={pending} you={m.id === me.member.id} directory={directory.members} />
  );

  return (
    <SettingsFrame
      crumbs={[{ label: "Members" }]}
      pad={false}
      primary={<BarAction icon={<PlusIcon />} label="New Member" onClick={() => setOpen(true)} />}
    >
      {members.isError ? (
        <Refusal error={members.error} className="px-6 py-4" />
      ) : members.isPending ? (
        <Skeleton className="m-6 h-8" />
      ) : (
        <div role="table" aria-label="Members" className="min-w-0">
          <div role="row" className={cn(tableHead, cols)}>
            <span role="columnheader">Member</span>
            <span role="columnheader" className={wider}>
              Model
            </span>
            <span role="columnheader" className={wide}>
              Projects
            </span>
            <span role="columnheader" className={wide}>
              Skills
            </span>
            <span role="columnheader" className={wide}>
              Reporting line
            </span>
            <span role="columnheader">Admin</span>
          </div>
          {humans.length > 0 && <GroupRow icon={<UserIcon />} label="Humans" count={humans.length} />}
          {humans.map(row)}
          {agents.length > 0 && <GroupRow icon={<BotIcon />} label="Agents" count={agents.length} />}
          {agents.map(row)}
        </div>
      )}
      {open && <NewMemberDialog kind={kind} onClose={() => setOpen(false)} />}
    </SettingsFrame>
  );
}

function MemberRow({
  member,
  detail,
  loading,
  you,
  directory,
}: {
  member: Member;
  detail?: MemberDetail;
  loading: boolean;
  you: boolean;
  directory: Map<string, Member>;
}) {
  const manager = member.manager_id ? directory.get(member.manager_id) : undefined;
  const deactivated = !!member.deactivated_at;
  return (
    <div role="row" aria-label={member.name} className={cn(tableRow, "hover:bg-accent/60", cols)}>
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Link
          to={memberPath(member)}
          className={cn("flex min-w-0 font-medium after:absolute after:inset-0 focus-visible:outline-none", deactivated && "opacity-60")}
        >
          <MemberName member={member} you={you} />
        </Link>
        {deactivated && <Pill tone="dropped">Deactivated</Pill>}
        {!deactivated && member.agent?.paused && <Pill tone="dropped">Paused</Pill>}
      </span>
      <span role="cell" className={cn(wider, "min-w-0", deactivated && "opacity-60")}>
        {member.agent && <span className="truncate font-mono text-xs text-muted-foreground">{member.agent.model}</span>}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-3 overflow-hidden", deactivated && "opacity-60")}>
        {detail && <ProjectsCell projects={detail.projects} />}
        {!detail && loading && <Skeleton className="h-4 w-20" />}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5 overflow-hidden", deactivated && "opacity-60")}>
        {detail?.skills.map((s) => (
          <Pill key={s.id} tone="outline">
            {s.name}
          </Pill>
        ))}
        {detail?.skills.length === 0 && <span className="text-muted-foreground">None</span>}
      </span>
      <span role="cell" className={cn(wide, "min-w-0", deactivated && "opacity-60")}>
        {manager ? <MemberName member={manager} /> : <span className="text-muted-foreground">No one</span>}
      </span>
      <span role="cell" className={cn(deactivated && "opacity-60")}>
        {member.admin && <Pill>Admin</Pill>}
      </span>
    </div>
  );
}
