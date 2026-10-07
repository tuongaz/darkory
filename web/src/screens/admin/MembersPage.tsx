import { useMutation } from "@tanstack/react-query";
import { BotIcon, PlusIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { IssuedToken, Member, MemberDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { AdminFrame } from "./AdminLayout";
import { firstTokenName, groupByKind } from "./model";
import { GroupRow, MemberName, Segmented } from "./parts";
import { useMemberDetails } from "./queries";
import { OnceDialog, SignInLinkDialog, TokenShown } from "./secrets";
import { defaultModel, knownModels } from "./agent";
import { createMember, issueToken, setAgentSettings } from "./writes";

// Member · Model · Teams · Skills · Reports to · Admin (F-D1). A phone keeps Member and Admin; an
// agent's model comes at the width of a laptop.
const cols =
  "grid-cols-[minmax(0,1fr)_72px] md:grid-cols-[220px_180px_minmax(0,1fr)_160px_72px] lg:grid-cols-[220px_150px_180px_minmax(0,1fr)_160px_72px]";
const wide = "hidden md:flex";
const wider = "hidden lg:flex";

/** /admin/members (F-D1): every Member, grouped Humans / Agents. ?new=1 opens New Member. */
export function MembersPage() {
  const me = useCurrentMe();
  const [params, setParams] = useSearchParams();
  const { members, details, pending } = useMemberDetails();
  const directory = useDirectory();
  const open = params.get("new") === "1";
  const setOpen = (o: boolean) =>
    setParams(
      (p) => {
        p.delete("new");
        p.delete("kind");
        if (o) p.set("new", "1");
        return p;
      },
      { replace: !o },
    );
  const { humans, agents } = groupByKind(members.data ?? []);

  return (
    <AdminFrame
      crumbs={[{ label: "Members" }]}
      pad={false}
      primary={
        <Button onClick={() => setOpen(true)}>
          <PlusIcon />
          New Member
        </Button>
      }
    >
      {members.isError ? (
        <Refusal error={members.error} className="px-6 py-4" />
      ) : members.isPending ? (
        <Skeleton className="m-6 h-8" />
      ) : (
        <div role="table" aria-label="Members" className="min-w-0">
          <div role="row" className={cn("grid h-8 items-center gap-3 border-b px-6 text-xs font-medium text-muted-foreground", cols)}>
            <span role="columnheader">Member</span>
            <span role="columnheader" className={wider}>
              Model
            </span>
            <span role="columnheader" className={wide}>
              Teams
            </span>
            <span role="columnheader" className={wide}>
              Skills
            </span>
            <span role="columnheader" className={wide}>
              Reports to
            </span>
            <span role="columnheader">Admin</span>
          </div>
          {humans.length > 0 && <GroupRow icon={<UserIcon />} label="Humans" count={humans.length} />}
          {humans.map((m) => (
            <MemberRow key={m.id} member={m} detail={details.get(m.id)} loading={pending} you={m.id === me.member.id} directory={directory.members} />
          ))}
          {agents.length > 0 && <GroupRow icon={<BotIcon />} label="Agents" count={agents.length} />}
          {agents.map((m) => (
            <MemberRow key={m.id} member={m} detail={details.get(m.id)} loading={pending} you={false} directory={directory.members} />
          ))}
        </div>
      )}
      {open && <NewMemberDialog kind={params.get("kind") === "agent" ? "agent" : "human"} onClose={() => setOpen(false)} />}
    </AdminFrame>
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
    <div
      role="row"
      aria-label={member.name}
      className={cn("relative grid h-10 items-center gap-3 border-b px-6 hover:bg-accent/60", cols)}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Link
          to={`/admin/members/${member.id}`}
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
        {detail?.teams.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <TeamMark team={t} />
            {t.name}
          </span>
        ))}
        {!detail && loading && <Skeleton className="h-4 w-20" />}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5 overflow-hidden", deactivated && "opacity-60")}>
        {detail?.skills.map((s) => (
          <Pill key={s.id} tone="outline">
            {s.name}
          </Pill>
        ))}
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

type Created = { member: Member; token?: IssuedToken; tokenError?: unknown; agentError?: unknown };

/**
 * New Member (F-D2a): name, kind, email for a human, admin. An agent gets its first token in the
 * same step, its secret shown once (F-D2b), and, unless Run with the Runner is off, its settings
 * for the Runner: the Install's default command on the model asked for. Off, it brings its own
 * session through that token, as the test bots do. A human gets a Sign-in link button.
 */
function NewMemberDialog({ kind: initialKind, onClose }: { kind: "human" | "agent"; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState(initialKind);
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [runner, setRunner] = useState(true);
  const [model, setModel] = useState(defaultModel);
  const create = useMutation({
    // /v1 has no create-with-token: an agent is created, then its first token is issued, then its
    // settings are set when the Runner is to run it. What fails after the create is said beside the
    // token, the Member being made.
    mutationFn: async (): Promise<Created> => {
      const member = await createMember({
        name: name.trim(),
        kind,
        email: kind === "human" && email.trim() ? email.trim() : undefined,
        admin,
      });
      if (member.kind !== "agent") return { member };
      const out: Created = { member };
      try {
        out.token = await issueToken(member.id, firstTokenName);
      } catch (tokenError) {
        out.tokenError = tokenError;
      }
      if (!runner) return out;
      try {
        out.member = await setAgentSettings(member.id, { model: model.trim() || defaultModel });
      } catch (agentError) {
        out.agentError = agentError;
      }
      return out;
    },
  });
  const done = (m: Member) => {
    onClose();
    navigate(`/admin/members/${m.id}`);
  };

  const created = create.data;
  if (created?.member.kind === "agent") {
    return (
      <OnceDialog open onDone={() => done(created.member)} title={`Token for ${created.member.name}`}>
        {created.token ? <TokenShown issued={created.token} /> : <Refusal error={created.tokenError} />}
        <Refusal error={created.agentError} />
      </OnceDialog>
    );
  }
  if (created) return <SignInLinkDialog member={created.member} onClose={() => done(created.member)} />;

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Member"
      submitLabel="Create Member"
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!name.trim()}
      error={create.error}
    >
      <FormRows>
        <FormRow label="Name" htmlFor="member-name">
          <Input id="member-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow label="Kind">
          <Segmented
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "human", label: "Human", icon: <UserIcon /> },
              { value: "agent", label: "Agent", icon: <BotIcon /> },
            ]}
          />
        </FormRow>
        {kind === "human" && (
          <FormRow label="Email" htmlFor="member-email">
            <Input id="member-email" type="email" placeholder="Optional" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormRow>
        )}
        {kind === "agent" && (
          <FormRow
            label="Runner"
            help={runner ? "The Runner starts its sessions with the Install's default command." : "It brings its own session, through its token."}
          >
            <Switch checked={runner} onCheckedChange={setRunner} aria-label="Run with the Runner" className="self-start" />
          </FormRow>
        )}
        {kind === "agent" && runner && (
          <FormRow label="Model" htmlFor="member-model">
            <Input
              id="member-model"
              list="member-models"
              maxLength={200}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="font-mono text-xs md:text-xs"
            />
            <datalist id="member-models">
              {knownModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </FormRow>
        )}
        <FormRow label="Admin" htmlFor="member-admin">
          <Switch id="member-admin" checked={admin} onCheckedChange={setAdmin} className="self-start" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}
