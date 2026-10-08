import { useMutation } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import type { Member, MemberDetail } from "@/api/client";
import { useDirectory, useMember, useMemberSessions, useProjects, useSkills, useTokens } from "@/api/queries";
import { addProjectMember, removeProjectMember } from "@/api/writes";
import type { Crumb } from "@/app/TopBar";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { Loaded, Refusal } from "@/components/Refusal";
import { Time } from "@/components/Time";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { shortSessionId } from "@/lib/members";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { AgentCard } from "./AgentSettings";
import { AvatarControl } from "./AvatarControl";
import { SessionRows, TokenRows } from "./credentials";
import { LoadingFrame, SettingsFrame } from "./frame";
import { count, deactivateSummary, heldClaims, liveTokens } from "./model";
import { Chip, ConfirmDialog, Fact, Facts, MemberName, MoreMenu, Picker, SettingsForm, SettingsRow, w320 } from "./parts";
import { agentsPath, membersPath } from "./paths";
import { useHeldTasks } from "./queries";
import { IssueTokenDialog, SignInLinkDialog } from "./secrets";
import { clearManager, deactivateMember, grantSkill, reactivateMember, revokeSkill, setManager, updateMember } from "@/api/writes";

/**
 * Settings › Organisation › Members › a Member, and Agents › an agent: one Member's settings,
 * credentials and Sessions; an agent's also its Runner settings. `area` names the list it is
 * reached from.
 */
export function MemberPage({ area }: { area: "members" | "agents" }) {
  const { member: ref = "" } = useParams();
  const detail = useMember(ref);
  const list: Crumb = area === "agents" ? { label: "Agents", to: agentsPath, wide: true } : { label: "Members", to: membersPath, wide: true };
  return (
    <Loaded query={detail} loading={<LoadingFrame crumbs={[list]} />}>
      {(d) => <MemberSettings key={d.member.id} detail={d} list={list} />}
    </Loaded>
  );
}

type Dialog = "token" | "link" | "deactivate" | null;

function MemberSettings({ detail, list }: { detail: MemberDetail; list: Crumb }) {
  const me = useCurrentMe();
  const m = detail.member;
  const self = m.id === me.member.id;
  const active = !m.deactivated_at;
  const tokens = useTokens(m.id);
  const sessions = useMemberSessions(m.id);
  const held = useHeldTasks(m.id);
  const heldNow = heldClaims(held.data ?? []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const reactivate = useMutation({
    mutationFn: () => reactivateMember(m.id),
    onSuccess: () => toast(`${m.name} is active again`),
  });

  return (
    <SettingsFrame
      crumbs={[list, { label: m.name }]}
      actions={
        (active ? !self : true) && (
          <MoreMenu label={`More for ${m.name}`}>
            {active ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog("deactivate")}>
                Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => reactivate.mutate()}>Reactivate</DropdownMenuItem>
            )}
          </MoreMenu>
        )
      }
      primary={
        active && (
          <Button onClick={() => setDialog("token")}>
            <KeyRoundIcon />
            Issue token
          </Button>
        )
      }
    >
      <div className="max-w-[820px]">
        <PageHeader
          title={m.name}
          mark={<AvatarControl member={m} editable={me.member.admin || (self && m.kind === "human")} />}
          meta={
            <>
              {m.kind === "agent" ? <Pill tone="agent">Agent</Pill> : <Pill>Human</Pill>}
              {!active && <Pill tone="dropped">Deactivated</Pill>}
              {m.agent?.paused && <Pill tone="dropped">Paused</Pill>}
              <span>
                created <Time at={m.created_at} />
              </span>
            </>
          }
        />
        <Refusal error={reactivate.error} className="mb-3" />
        <SettingsForm label={`Settings of ${m.name}`}>
          {/* Keyed by the saved value, so an edit made elsewhere replaces the field's. */}
          <NameRow key={m.name} member={m} />
          {m.kind === "human" && <EmailRow key={m.email ?? ""} member={m} />}
          <AdminRow member={m} />
          <ManagerRow member={m} />
          <ProjectsRow detail={detail} />
          <SkillsRow detail={detail} />
          <SettingsRow label="Tokens" count={tokens.data ? liveTokens(tokens.data).length : undefined}>
            <Loaded query={tokens}>{(list) => <TokenRows tokens={liveTokens(list)} sessions={sessions.data ?? []} held={heldNow} />}</Loaded>
          </SettingsRow>
          <SettingsRow label="Sessions" count={sessions.data?.length}>
            <Loaded query={sessions}>
              {(list) => <SessionRows member={m} sessions={list} held={heldNow} current={self ? me.session.id : undefined} />}
            </Loaded>
          </SettingsRow>
          {m.kind === "human" && active && (
            <SettingsRow label="Sign-in link">
              <Button variant="outline" size="xs" onClick={() => setDialog("link")}>
                Issue link
              </Button>
            </SettingsRow>
          )}
        </SettingsForm>
        {m.kind === "agent" && <AgentCard member={m} />}
      </div>

      {dialog === "token" && <IssueTokenDialog member={m} onClose={() => setDialog(null)} />}
      {dialog === "link" && <SignInLinkDialog member={m} onClose={() => setDialog(null)} />}
      {dialog === "deactivate" && (
        <DeactivateDialog
          member={m}
          loaded={!!tokens.data && !!sessions.data && !!held.data}
          summary={deactivateSummary(tokens.data ?? [], sessions.data ?? [], heldNow)}
          onClose={() => setDialog(null)}
        />
      )}
    </SettingsFrame>
  );
}

/** Deactivate's confirm: what it stops, counted from the Member's live record. */
function DeactivateDialog({
  member,
  loaded,
  summary,
  onClose,
}: {
  member: Member;
  loaded: boolean;
  summary: ReturnType<typeof deactivateSummary>;
  onClose: () => void;
}) {
  const deactivate = useMutation({
    mutationFn: () => deactivateMember(member.id),
    onSuccess: () => {
      onClose();
      toast(`${member.name} is deactivated`);
    },
  });
  const { tokens, sessions, claims } = summary;
  const nothing = tokens.length + sessions.length + claims.length === 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deactivate ${member.name}?`}
      confirmLabel="Deactivate"
      onConfirm={() => deactivate.mutate()}
      pending={deactivate.isPending}
      disabled={!loaded}
      error={deactivate.error}
    >
      {!loaded ? (
        <Skeleton className="h-16" />
      ) : nothing ? (
        <p>Holds no token, Session or Claim.</p>
      ) : (
        <Facts>
          {tokens.length > 0 && (
            <Fact label="Revokes">
              {count(tokens.length, "token")}
              {tokens.map((t) => (
                <code key={t.id} className="font-mono text-[11.5px] font-normal text-muted-foreground">
                  {t.name}
                </code>
              ))}
            </Fact>
          )}
          {sessions.length > 0 && (
            <Fact label="Closes">
              {count(sessions.length, "Session")}
              {sessions.map((s) => (
                <code key={s.id} title={s.id} className="font-mono text-[11.5px] font-normal text-muted-foreground">
                  {shortSessionId(s.id)}
                </code>
              ))}
            </Fact>
          )}
          {claims.length > 0 && (
            <Fact label="Ends">
              {count(claims.length, "Claim")}
              {claims.map((h) => (
                <code key={h.task.id} className="font-mono text-[11.5px] font-normal text-muted-foreground">
                  {h.task.key}
                </code>
              ))}
            </Fact>
          )}
        </Facts>
      )}
    </ConfirmDialog>
  );
}

/** Name: saves when the field loses focus. */
function NameRow({ member }: { member: Member }) {
  const [name, setName] = useState(member.name);
  const save = useMutation({ mutationFn: (name: string) => updateMember(member.id, { name }) });
  const commit = () => {
    const next = name.trim();
    if (!next || next === member.name) return setName(member.name);
    save.mutate(next);
  };
  return (
    <SettingsRow label="Name" htmlFor="member-name">
      <Input
        id="member-name"
        className={w320}
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(member.name);
        }}
      />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

/** Email, for a human: saves when the field loses focus. /v1 sets an email but cannot clear one. */
function EmailRow({ member }: { member: Member }) {
  const [email, setEmail] = useState(member.email ?? "");
  const save = useMutation({ mutationFn: (email: string) => updateMember(member.id, { email }) });
  const commit = () => {
    const next = email.trim();
    if (!next || next === (member.email ?? "")) return setEmail(member.email ?? "");
    save.mutate(next);
  };
  return (
    <SettingsRow label="Email" htmlFor="member-email">
      <Input
        id="member-email"
        type="email"
        className={w320}
        placeholder="None set"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEmail(member.email ?? "");
        }}
      />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

function AdminRow({ member }: { member: Member }) {
  const save = useMutation({ mutationFn: (admin: boolean) => updateMember(member.id, { admin }) });
  return (
    <SettingsRow label="Admin" htmlFor="member-admin" help="Creates Members, Projects, Skills and the Organisation's Labels, and sets Workflows.">
      <Switch
        id="member-admin"
        checked={save.isPending ? save.variables : member.admin}
        onCheckedChange={(admin) => save.mutate(admin)}
        disabled={save.isPending}
      />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

const noOne = "none";

/** Reporting line: the Member who directs this one, or no one. Either may be a human or an agent. */
function ManagerRow({ member }: { member: Member }) {
  const { memberList, members } = useDirectory();
  const save = useMutation({
    mutationFn: (manager: string) => (manager === noOne ? clearManager(member.id) : setManager(member.id, manager)),
  });
  const value = save.isPending ? save.variables : (member.manager_id ?? noOne);
  // Anyone active may direct them; a deactivated manager stays listed while they are the one.
  const choices = memberList.filter((c) => c.id !== member.id && (!c.deactivated_at || c.id === member.manager_id));
  const current = member.manager_id ? members.get(member.manager_id) : undefined;
  return (
    <SettingsRow label="Reporting line" htmlFor="member-manager" help="Who directs them: where they escalate when stuck.">
      <Select value={value} onValueChange={(v) => save.mutate(v)} disabled={save.isPending}>
        <SelectTrigger id="member-manager" size="sm" className={cn(w320, "h-8")} aria-label="Reports to">
          <SelectValue>
            {value === noOne ? <span className="text-muted-foreground">Reports to no one</span> : current && <MemberName member={current} />}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={noOne}>No one</SelectItem>
          {choices.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <MemberName member={c} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

/** Projects as chips: × takes the Member out; Add to Project puts them in another. */
function ProjectsRow({ detail }: { detail: MemberDetail }) {
  const m = detail.member;
  const projects = useProjects();
  const add = useMutation({ mutationFn: (project: string) => addProjectMember(project, m.id) });
  const remove = useMutation({ mutationFn: (project: string) => removeProjectMember(project, m.id) });
  const inProjects = new Set(detail.projects.map((p) => p.id));
  const others = (projects.data ?? []).filter((p) => !inProjects.has(p.id));
  return (
    <SettingsRow label="Projects" count={detail.projects.length}>
      {detail.projects.map((p) => (
        <Chip key={p.id} removeLabel={`Remove from ${p.name}`} onRemove={() => remove.mutate(p.key)} disabled={remove.isPending}>
          <ProjectMark project={p} />
          {p.name}
        </Chip>
      ))}
      <Picker
        trigger={
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            <PlusIcon />
            Add to Project
          </Button>
        }
        placeholder={`Add ${m.name} to…`}
        heading="Projects"
        items={others.map((p) => ({ id: p.key, label: p.name, icon: <ProjectMark project={p} />, hint: p.key }))}
        empty="In every Project"
        onPick={(project) => add.mutate(project)}
      />
      <Refusal error={add.error ?? remove.error} />
    </SettingsRow>
  );
}

/** Skills as chips: × takes a Skill away; Grant Skill gives another. */
function SkillsRow({ detail }: { detail: MemberDetail }) {
  const m = detail.member;
  const skills = useSkills();
  const grant = useMutation({ mutationFn: (skill: string) => grantSkill(m.id, skill) });
  const revoke = useMutation({ mutationFn: (skill: string) => revokeSkill(m.id, skill) });
  const has = new Set(detail.skills.map((s) => s.id));
  const others = (skills.data ?? []).filter((s) => !has.has(s.id));
  return (
    <SettingsRow label="Skills" count={detail.skills.length}>
      {detail.skills.map((s) => (
        <Chip key={s.id} removeLabel={`Take away ${s.name}`} onRemove={() => revoke.mutate(s.name)} disabled={revoke.isPending}>
          {s.name}
        </Chip>
      ))}
      <Picker
        trigger={
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            <PlusIcon />
            Grant Skill
          </Button>
        }
        placeholder={`Grant ${m.name}…`}
        heading="Not held"
        items={others.map((s) => ({ id: s.name, label: s.name, hint: s.kind }))}
        empty="Holds every Skill"
        onPick={(skill) => grant.mutate(skill)}
      />
      <Refusal error={grant.error ?? revoke.error} />
    </SettingsRow>
  );
}
