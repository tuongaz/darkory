import { useMutation } from "@tanstack/react-query";
import { BotIcon, PlusIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { Member, MemberDetail, Team } from "@/api/client";
import { useAllFeatures, useDirectory, useTeams } from "@/api/queries";
import { EmptyState } from "@/components/EmptyState";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Loaded, Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AdminFrame } from "./AdminLayout";
import { count, groupByKind, humansFirst, suggestKey, teamKeyPattern } from "./model";
import { Avatars, GroupRow, MemberName, MoreMenu, Picker } from "./parts";
import { useMemberDetails, useTeamDetail, useTeamDetails } from "./queries";
import { addTeamMember, createTeam, removeTeamMember } from "./writes";

// Team · Key · Members · Features (F-D4a). A phone keeps Team and Members.
const teamCols = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[220px_80px_260px_minmax(0,1fr)]";
const wide = "hidden md:flex";

/** /admin/teams (F-D4a). ?new=1 opens New Team. */
export function TeamsPage() {
  const [params, setParams] = useSearchParams();
  const teams = useTeams();
  const details = useTeamDetails(teams.data ?? []);
  const features = useAllFeatures();
  const open = params.get("new") === "1";
  const setOpen = (o: boolean) =>
    setParams(
      (p) => {
        p.delete("new");
        if (o) p.set("new", "1");
        return p;
      },
      { replace: !o },
    );
  const featureCount = (team: Team) => (features.data ?? []).filter((f) => f.team_id === team.id).length;

  return (
    <AdminFrame
      crumbs={[{ label: "Teams" }]}
      pad={false}
      primary={
        <Button onClick={() => setOpen(true)}>
          <PlusIcon />
          New Team
        </Button>
      }
    >
      <Loaded query={teams} loading={<Skeleton className="m-6 h-8" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No Teams yet" action={<Button onClick={() => setOpen(true)}>New Team</Button>}>
              A Team shares a body of work.
            </EmptyState>
          ) : (
            <div role="table" aria-label="Teams" className="min-w-0">
              <div role="row" className={cn("grid h-8 items-center gap-3 border-b px-6 text-xs font-medium text-muted-foreground", teamCols)}>
                <span role="columnheader">Team</span>
                <span role="columnheader" className={wide}>
                  Key
                </span>
                <span role="columnheader">Members</span>
                <span role="columnheader" className={wide}>
                  Features
                </span>
              </div>
              {list.map((t) => {
                const members = details.get(t.id)?.members;
                return (
                  <div role="row" key={t.id} aria-label={t.name} className={cn("relative grid h-11 items-center gap-3 border-b px-6 hover:bg-accent/60", teamCols)}>
                    <span role="cell" className="min-w-0">
                      <Link to={`/admin/teams/${t.key}`} className="flex min-w-0 items-center gap-1.5 font-medium after:absolute after:inset-0">
                        <TeamMark team={t} />
                        <span className="truncate">{t.name}</span>
                      </Link>
                    </span>
                    <span role="cell" className={wide}>
                      <Key>{t.key}</Key>
                    </span>
                    <span role="cell" className="min-w-0">
                      {members ? <Avatars members={humansFirst(members.filter((m) => !m.deactivated_at))} /> : <Skeleton className="h-4 w-24" />}
                    </span>
                    <span role="cell" className={cn(wide, "text-muted-foreground")}>
                      {features.data && count(featureCount(t), "Feature")}
                    </span>
                  </div>
                );
              })}
            </div>
          )
        }
      </Loaded>
      {open && <NewTeamDialog onClose={() => setOpen(false)} />}
    </AdminFrame>
  );
}

/** New Team: a name and the key its Tasks are numbered with. Opens the Team once made. */
function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [typedKey, setTypedKey] = useState<string | null>(null);
  const key = typedKey ?? suggestKey(name);
  const create = useMutation({
    mutationFn: () => createTeam({ name: name.trim(), key }),
    onSuccess: (t) => {
      onClose();
      navigate(`/admin/teams/${t.key}`);
    },
  });
  const keyOK = teamKeyPattern.test(key);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Team"
      submitLabel="Create Team"
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!name.trim() || !keyOK}
      error={create.error}
    >
      <FormRows>
        <FormRow label="Name" htmlFor="team-name">
          <Input id="team-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow
          label="Key"
          htmlFor="team-key"
          help={
            key && !keyOK ? (
              <span className="text-state-blocked">2 to 10 capitals or digits, starting with a capital.</span>
            ) : (
              <>Starts each Task key, as in {key || "WEB"}-3.</>
            )
          }
        >
          <Input
            id="team-key"
            required
            maxLength={10}
            value={key}
            aria-invalid={!!key && !keyOK}
            onChange={(e) => setTypedKey(e.target.value.toUpperCase())}
            className="w-32 font-mono"
          />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

// Member · Skills · Reports to · ⋯ (F-D4b). A phone keeps Member and ⋯.
const memberCols = "grid-cols-[minmax(0,1fr)_26px] md:grid-cols-[220px_minmax(0,1fr)_180px_26px]";

/** /admin/teams/:team (F-D4b): the Team's Members with their Skills and Reporting line. */
export function TeamPage() {
  const { team: ref = "" } = useParams();
  const team = useTeamDetail(ref);
  return (
    <Loaded
      query={team}
      loading={
        <AdminFrame crumbs={[{ label: "Teams", to: "/admin/teams" }]}>
          <Skeleton className="h-8 w-60" />
        </AdminFrame>
      }
    >
      {(d) => <TeamMembers team={d.team} members={d.members} />}
    </Loaded>
  );
}

function TeamMembers({ team, members }: { team: Team; members: Member[] }) {
  const { details } = useMemberDetails();
  const directory = useDirectory();
  const add = useMutation({ mutationFn: (member: string) => addTeamMember(team.key, member) });
  const remove = useMutation({ mutationFn: (member: string) => removeTeamMember(team.key, member) });
  const inTeam = new Set(members.map((m) => m.id));
  const outside = directory.memberList.filter((m) => !inTeam.has(m.id) && !m.deactivated_at);
  const { humans, agents } = groupByKind(members);

  const row = (m: Member) => (
    <TeamMemberRow
      key={m.id}
      member={m}
      detail={details.get(m.id)}
      manager={m.manager_id ? directory.members.get(m.manager_id) : undefined}
      onRemove={() => remove.mutate(m.id)}
      team={team}
    />
  );

  return (
    <AdminFrame
      crumbs={[{ label: "Teams", to: "/admin/teams" }, { label: team.name }]}
      pad={false}
      primary={
        <Picker
          align="end"
          trigger={
            <Button>
              <PlusIcon />
              Add Member
            </Button>
          }
          placeholder={`Add to ${team.name}…`}
          heading={`Not in ${team.name}`}
          items={outside.map((m) => ({
            id: m.id,
            label: m.name,
            icon: <MemberAvatar member={m} />,
            hint: details
              .get(m.id)
              ?.teams.map((t) => t.name)
              .join(", "),
          }))}
          empty="Every Member is in it"
          onPick={(id) => add.mutate(id)}
        />
      }
    >
      <div className="flex items-center gap-2.5 px-6 pt-5 pb-4">
        <TeamMark team={team} size="lg" />
        <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em]">{team.name}</h1>
        <Key className="text-xs">{team.key}</Key>
      </div>
      <Refusal error={add.error ?? remove.error} className="px-6 pb-3" />
      {members.length === 0 ? (
        <EmptyState title="No Members yet">Add Member puts someone in {team.name}.</EmptyState>
      ) : (
        <div role="table" aria-label={`Members of ${team.name}`} className="min-w-0 border-t">
          <div role="row" className={cn("grid h-8 items-center gap-3 border-b pr-4 pl-6 text-xs font-medium text-muted-foreground", memberCols)}>
            <span role="columnheader">Member</span>
            <span role="columnheader" className={wide}>
              Skills
            </span>
            <span role="columnheader" className={wide}>
              Reports to
            </span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {humans.length > 0 && <GroupRow icon={<UserIcon />} label="Humans" count={humans.length} />}
          {humans.map(row)}
          {agents.length > 0 && <GroupRow icon={<BotIcon />} label="Agents" count={agents.length} />}
          {agents.map(row)}
        </div>
      )}
    </AdminFrame>
  );
}

function TeamMemberRow({
  member,
  detail,
  manager,
  team,
  onRemove,
}: {
  member: Member;
  detail?: MemberDetail;
  manager?: Member;
  team: Team;
  onRemove: () => void;
}) {
  const deactivated = !!member.deactivated_at;
  return (
    <div role="row" aria-label={member.name} className={cn("grid h-10 items-center gap-3 border-b pr-4 pl-6", memberCols)}>
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Link to={`/admin/members/${member.id}`} className={cn("min-w-0 hover:underline", deactivated && "opacity-60")}>
          <MemberName member={member} />
        </Link>
        {deactivated && <Pill tone="dropped">Deactivated</Pill>}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5 overflow-hidden")}>
        {detail?.skills.map((s) => (
          <Pill key={s.id} tone="outline">
            {s.name}
          </Pill>
        ))}
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        {manager ? <MemberName member={manager} /> : <span className="text-muted-foreground">No one</span>}
      </span>
      <span role="cell">
        <MoreMenu label={`More for ${member.name}`} size="icon-xs">
          <DropdownMenuItem onSelect={onRemove}>Remove from {team.name}</DropdownMenuItem>
        </MoreMenu>
      </span>
    </div>
  );
}
