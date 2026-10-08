import { useMutation } from "@tanstack/react-query";
import { BotIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { IssuedToken, Member, MemberKind, Project } from "@/api/client";
import { useProjects } from "@/api/queries";
import { addProjectMember, createMember } from "@/api/writes";
import { useCurrentProject } from "@/app/currentProject";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { ProjectMark } from "@/components/ProjectMark";
import { Refusal } from "@/components/Refusal";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { defaultModel, knownModels } from "./agent";
import { firstTokenName } from "./model";
import { Segmented } from "./parts";
import { memberPath } from "./paths";
import { OnceDialog, SignInLinkDialog, TokenShown } from "./secrets";
import { issueToken, setAgentSettings } from "@/api/writes";

type Created = { member: Member; token?: IssuedToken; problems: unknown[] };

/**
 * New Member: name, kind, email for a human, the Projects they join, admin. An agent gets its
 * first token in the same step, its secret shown once, and, unless Run with the Runner is off, its
 * settings for the Runner: the Install's default command on the model asked for. Off, it brings
 * its own session through that token. A human gets a Sign-in link next. `kind` fixed (Agents'
 * New agent) hides the choice.
 */
export function NewMemberDialog({
  kind: initialKind,
  fixedKind,
  project,
  onClose,
}: {
  kind: MemberKind;
  fixedKind?: boolean;
  /** The Project ticked to start with; else the one the app is in. */
  project?: Project;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects().data ?? [];
  const inApp = useCurrentProject();
  const current = project ?? inApp;
  const [name, setName] = useState("");
  const [kind, setKind] = useState(initialKind);
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [runner, setRunner] = useState(true);
  const [model, setModel] = useState(defaultModel);
  // The Project the app is in, until another choice is made (it may load after the dialog opens):
  // a Member in no Project takes no Task.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(current ? [current.key] : []);
  const create = useMutation({
    // /v1 has no create-with-everything: the Member is created, then an agent's first token is
    // issued and its settings set, then the Member joins each Project. What fails after the create
    // is said beside the token or the link, the Member being made.
    mutationFn: async (): Promise<Created> => {
      const member = await createMember({
        name: name.trim(),
        kind,
        email: kind === "human" && email.trim() ? email.trim() : undefined,
        admin,
      });
      const out: Created = { member, problems: [] };
      const attempt = async (write: () => Promise<unknown>) => {
        try {
          await write();
        } catch (e) {
          out.problems.push(e);
        }
      };
      if (member.kind === "agent") {
        await attempt(async () => (out.token = await issueToken(member.id, { name: firstTokenName })));
        if (runner) await attempt(async () => (out.member = await setAgentSettings(member.id, { model: model.trim() || defaultModel })));
      }
      for (const key of chosen) await attempt(() => addProjectMember(key, member.id));
      return out;
    },
  });
  const done = (m: Member) => {
    onClose();
    navigate(memberPath(m));
  };
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };

  const created = create.data;
  if (created?.member.kind === "agent") {
    return (
      <OnceDialog open onDone={() => done(created.member)} title={`Token for ${created.member.name}`}>
        {created.token && <TokenShown issued={created.token} />}
        {created.problems.map((p, i) => (
          <Refusal key={i} error={p} />
        ))}
      </OnceDialog>
    );
  }
  if (created) {
    return (
      <SignInLinkDialog member={created.member} onClose={() => done(created.member)}>
        {created.problems.map((p, i) => (
          <Refusal key={i} error={p} />
        ))}
      </SignInLinkDialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={fixedKind && kind === "agent" ? "New agent" : "New Member"}
      submitLabel={fixedKind && kind === "agent" ? "Create agent" : "Create Member"}
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!name.trim()}
      error={create.error}
      size="md"
    >
      <FormRows>
        <FormRow label="Name" htmlFor="member-name">
          <Input id="member-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        {!fixedKind && (
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
        )}
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
        {projects.length > 0 && (
          <FormRow label="Projects" help="It takes their Tasks at the Steps whose Skills it has.">
            <div role="group" aria-label="Projects" className="max-h-40 overflow-y-auto rounded-md border p-1">
              {projects.map((p) => (
                <label key={p.id} className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-1.5 hover:bg-accent">
                  <Checkbox checked={chosen.has(p.key)} onCheckedChange={(c) => toggle(p.key, c === true)} aria-label={p.name} />
                  <ProjectMark project={p} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
                </label>
              ))}
            </div>
          </FormRow>
        )}
        <FormRow label="Admin" htmlFor="member-admin">
          <Switch id="member-admin" checked={admin} onCheckedChange={setAdmin} className="self-start" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}
