import { useMutation } from "@tanstack/react-query";
import { BotIcon, PlusIcon, UserIcon, UsersIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Member, MemberDetail, Project } from "@/api/client";
import { useDirectory, useProject, useWorkflow, useWorkspaces } from "@/api/queries";
import { addProjectMember, removeProjectMember, updateProject } from "@/api/writes";
import { projectSettingsPath, useRouteProject } from "@/app/currentProject";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { Loaded, Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { SettingsFrame, tableHead, tableRow } from "./frame";
import { groupByKind } from "./model";
import { NewMemberDialog } from "./NewMember";
import { GroupRow, MemberName, MoreMenu, Picker, SettingsForm, SettingsRow, w320 } from "./parts";
import { memberPath } from "./paths";
import { useMemberDetails } from "./queries";

/** The crumbs of a Project's settings page: the Project (left out on a phone), then the page. */
function crumbs(project: Project, page: string) {
  return [{ label: project.name, wide: true }, { label: page }];
}

/**
 * Settings › a Project › General: its name, its key (which never changes), and what a Task filed
 * in it takes when its filer does not say: the Workspace, Auto-complete and Acceptance. Admins
 * change them; anyone else reads.
 */
export function ProjectGeneralPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  return (
    <SettingsFrame crumbs={crumbs(project, "General")}>
      <div className="max-w-[820px]">
        <div className="flex items-center gap-2.5 pb-5">
          <ProjectMark project={project} size="lg" />
          <h1 className="min-w-0 truncate text-xl leading-tight font-semibold tracking-[-0.01em]">{project.name}</h1>
        </div>
        <SettingsForm label={`General settings of ${project.name}`}>
          {/* Keyed by the saved value, so an edit made elsewhere replaces the field's. */}
          <ProjectNameRow key={project.name} project={project} admin={admin} />
          <SettingsRow label="Key" help={`Starts each Task key, as in ${project.key}-1, and never changes.`}>
            <Key>{project.key}</Key>
          </SettingsRow>
          <DefaultWorkspaceRow project={project} admin={admin} />
          <DefaultSwitchRow
            project={project}
            admin={admin}
            field="auto_complete"
            label="Auto-complete"
            help="A Parent filed here completes itself when its last Subtask ends Done, unless its filer says otherwise."
          />
          <AcceptanceRow project={project} admin={admin} />
        </SettingsForm>
      </div>
    </SettingsFrame>
  );
}

function ProjectNameRow({ project, admin }: { project: Project; admin: boolean }) {
  const [name, setName] = useState(project.name);
  const save = useMutation({ mutationFn: (name: string) => updateProject(project.key, { name }) });
  if (!admin) return <SettingsRow label="Name">{project.name}</SettingsRow>;
  const commit = () => {
    const next = name.trim();
    if (!next || next === project.name) return setName(project.name);
    save.mutate(next);
  };
  return (
    <SettingsRow label="Name" htmlFor="project-name">
      <Input
        id="project-name"
        className={w320}
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(project.name);
        }}
      />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

const none = "none";

/** Default Workspace: where a Task filed in the Project works when it names none. */
function DefaultWorkspaceRow({ project, admin }: { project: Project; admin: boolean }) {
  const workspaces = useWorkspaces();
  const save = useMutation({ mutationFn: (ws: string) => updateProject(project.key, { default_workspace: ws === none ? "" : ws }) });
  const value = save.isPending ? save.variables : (project.default_workspace_id ?? none);
  const list = workspaces.data ?? [];
  const chosen = list.find((w) => w.id === value);
  const help = "Where the sessions of its Tasks work when a Task names none; a Subtask works where its Parent does.";
  if (!admin) {
    return (
      <SettingsRow label="Default Workspace" help={help}>
        {chosen ? chosen.name : <span className="text-muted-foreground">None</span>}
      </SettingsRow>
    );
  }
  return (
    <SettingsRow label="Default Workspace" htmlFor="project-workspace" help={help}>
      {workspaces.data && list.length === 0 ? (
        <span className="text-muted-foreground">
          No Workspace yet;{" "}
          <Link to={projectSettingsPath(project, "workspaces")} className="text-foreground underline-offset-2 hover:underline">
            add one in Workspaces
          </Link>
        </span>
      ) : (
        <Select value={value} onValueChange={(v) => v !== value && save.mutate(v)} disabled={save.isPending || !workspaces.data}>
          <SelectTrigger id="project-workspace" size="sm" className={cn(w320, "h-8")} aria-label="Default Workspace">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={none}>
              <span className="text-muted-foreground">None</span>
            </SelectItem>
            {list.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
                <span className="truncate font-mono text-xs text-muted-foreground">{w.path}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

/** One of the defaults a Task filed in the Project takes: a switch for an admin, Yes or No for anyone else. */
function DefaultSwitchRow({
  project,
  admin,
  field,
  label,
  help,
  disabled,
}: {
  project: Project;
  admin: boolean;
  field: "auto_complete" | "acceptance";
  label: string;
  help: ReactNode;
  disabled?: boolean;
}) {
  const save = useMutation({ mutationFn: (on: boolean) => updateProject(project.key, { [field]: on }) });
  const on = save.isPending ? save.variables : project[field];
  const id = `project-${field}`;
  return (
    <SettingsRow label={label} htmlFor={admin ? id : undefined} help={help}>
      {admin ? (
        <Switch id={id} checked={on} onCheckedChange={(v) => save.mutate(v)} disabled={save.isPending || disabled} />
      ) : (
        <span>{on ? "On" : "Off"}</span>
      )}
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

/**
 * Acceptance: a Parent filed here has its Acceptance Subtask filed when its last other Subtask ends
 * Done. A Workflow with no Step carrying the acceptance Skill files none, which the row says.
 */
function AcceptanceRow({ project, admin }: { project: Project; admin: boolean }) {
  const workflow = useWorkflow(project.key);
  const { skillList } = useDirectory();
  const acceptance = skillList.find((s) => s.builtin && s.name === "acceptance");
  const hasStep = !!acceptance && !!workflow.data?.steps.some((s) => s.skill_id === acceptance.id);
  const help =
    workflow.data && acceptance && !hasStep ? (
      <>
        The{" "}
        <Link to={projectSettingsPath(project, "workflow")} className="text-foreground underline-offset-2 hover:underline">
          Workflow
        </Link>{" "}
        has no Step carrying acceptance, so no Acceptance is filed.
      </>
    ) : (
      "A Member confirms a Parent filed here as a whole before it is called done, unless its filer says otherwise."
    );
  return <DefaultSwitchRow project={project} admin={admin} field="acceptance" label="Acceptance" help={help} />;
}

// Member · Skills · Reporting line · ⋯. A phone keeps Member and ⋯.
const memberCols = "grid-cols-[minmax(0,1fr)_26px] md:grid-cols-[220px_minmax(0,1fr)_180px_26px]";
const wide = "hidden md:flex";

/**
 * Settings › a Project › Members: who takes its Tasks, humans then agents, with their Skills and
 * Reporting line. An admin adds a Member, makes a new agent in it, or takes one out.
 */
export function ProjectMembersPage() {
  const project = useRouteProject();
  const detail = useProject(project.key);
  return (
    <Loaded
      query={detail}
      loading={
        <SettingsFrame crumbs={crumbs(project, "Members")}>
          <Skeleton className="h-8 w-60" />
        </SettingsFrame>
      }
    >
      {(d) => <ProjectMembers project={d.project} members={d.members} />}
    </Loaded>
  );
}

function ProjectMembers({ project, members }: { project: Project; members: Member[] }) {
  const admin = useCurrentMe().member.admin;
  const { details } = useMemberDetails();
  const directory = useDirectory();
  const [newAgent, setNewAgent] = useState(false);
  const add = useMutation({ mutationFn: (member: string) => addProjectMember(project.key, member) });
  const remove = useMutation({ mutationFn: (member: string) => removeProjectMember(project.key, member) });
  const inProject = new Set(members.map((m) => m.id));
  const outside = directory.memberList.filter((m) => !inProject.has(m.id) && !m.deactivated_at);
  const { humans, agents } = groupByKind(members);

  const row = (m: Member) => (
    <ProjectMemberRow
      key={m.id}
      member={m}
      detail={details.get(m.id)}
      manager={m.manager_id ? directory.members.get(m.manager_id) : undefined}
      project={project}
      admin={admin}
      onRemove={() => remove.mutate(m.id)}
    />
  );

  return (
    <SettingsFrame
      crumbs={crumbs(project, "Members")}
      pad={false}
      actions={
        admin && (
          <Button variant="outline" onClick={() => setNewAgent(true)}>
            <BotIcon />
            <span className="hidden sm:inline">New agent</span>
          </Button>
        )
      }
      primary={
        admin && (
          <Picker
            align="end"
            trigger={
              <Button>
                <PlusIcon />
                Add Member
              </Button>
            }
            placeholder={`Add to ${project.name}…`}
            heading={`Not in ${project.name}`}
            items={outside.map((m) => ({
              id: m.id,
              label: m.name,
              icon: <MemberAvatar member={m} />,
              hint: m.kind === "agent" ? "Agent" : "Human",
            }))}
            empty="Every Member is in it"
            onPick={(id) => add.mutate(id)}
          />
        )
      }
    >
      <Refusal error={add.error ?? remove.error} className="px-6 pt-3" />
      {members.length === 0 ? (
        <EmptyState icon={<UsersIcon />} title="No Members yet">
          {admin ? `Add Member puts someone in ${project.name}.` : `No one takes the Tasks of ${project.name} yet.`}
        </EmptyState>
      ) : (
        <div role="table" aria-label={`Members of ${project.name}`} className="min-w-0">
          <div role="row" className={cn(tableHead, "pr-4", memberCols)}>
            <span role="columnheader">Member</span>
            <span role="columnheader" className={wide}>
              Skills
            </span>
            <span role="columnheader" className={wide}>
              Reporting line
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
      {newAgent && <NewMemberDialog kind="agent" fixedKind project={project} onClose={() => setNewAgent(false)} />}
    </SettingsFrame>
  );
}

function ProjectMemberRow({
  member,
  detail,
  manager,
  project,
  admin,
  onRemove,
}: {
  member: Member;
  detail?: MemberDetail;
  manager?: Member;
  project: Project;
  admin: boolean;
  onRemove: () => void;
}) {
  const deactivated = !!member.deactivated_at;
  const name = <MemberName member={member} />;
  return (
    <div role="row" aria-label={member.name} className={cn(tableRow, "pr-4", memberCols)}>
      <span role="cell" className="flex min-w-0 items-center gap-2">
        {admin ? (
          <Link to={memberPath(member)} className={cn("min-w-0 hover:underline", deactivated && "opacity-60")}>
            {name}
          </Link>
        ) : (
          <span className={cn("min-w-0", deactivated && "opacity-60")}>{name}</span>
        )}
        {member.kind === "agent" && <Pill tone="agent">Agent</Pill>}
        {deactivated && <Pill tone="dropped">Deactivated</Pill>}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5 overflow-hidden")}>
        {detail?.skills.map((s) => (
          <Pill key={s.id} tone="outline">
            {s.name}
          </Pill>
        ))}
        {detail?.skills.length === 0 && <span className="text-muted-foreground">None</span>}
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        {manager ? <MemberName member={manager} /> : <span className="text-muted-foreground">No one</span>}
      </span>
      <span role="cell">
        {admin && (
          <MoreMenu label={`More for ${member.name}`} size="icon-xs">
            <DropdownMenuItem onSelect={onRemove}>Remove from {project.name}</DropdownMenuItem>
          </MoreMenu>
        )}
      </span>
    </div>
  );
}
