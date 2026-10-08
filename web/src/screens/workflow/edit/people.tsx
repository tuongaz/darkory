import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { IssuedToken, Member, Project, Skill } from "@/api/client";
import { invalidateAll, useMembers, useProject } from "@/api/queries";
import { addProjectMember, createMember, grantSkill, issueToken, setAgentSettings } from "@/api/writes";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { defaultModel, knownModels } from "@/screens/settings/agent";
import { firstTokenName } from "@/screens/settings/model";
import { OnceDialog, TokenShown } from "@/screens/settings/secrets";
import { orgWide, type Holder } from "./holders";

/*
 * Who takes a Step's Tasks, from its row in the list: the Members holding its Skill as marks, a
 * warning when nobody does, and Add Member… and Create an agent…, which act at once — they change
 * Members, not the Workflow, so they are not part of what Save sends.
 */


/** A Step's takers as small marks (an agent's ringed), or the warning when its Skill has none. */
export function Takers({ skillName, holders }: { skillName: string; holders: Holder[] }) {
  if (holders.length === 0) {
    return (
      <span className="flex items-center gap-1 text-xs font-medium whitespace-nowrap text-state-claimed">
        <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
        No Member has it
      </span>
    );
  }
  const shown = holders.slice(0, 3);
  return (
    <span role="img" aria-label={`Members with ${skillName}: ${holders.map((h) => h.name).join(", ")}`} className="flex items-center gap-[3px]">
      {shown.map((h) => (
        <MemberAvatar key={h.id} member={h} />
      ))}
      {holders.length > shown.length && <span className="text-[11px] text-muted-foreground">+{holders.length - shown.length}</span>}
    </span>
  );
}

const now = "This happens now: it changes Members, not the Workflow, and Save does not undo it.";

/**
 * Add Member…: any active Member of the Organisation who does not hold the Skill yet. Each says
 * what picking them does: added to the Project when not in it (never for skill-review, taken from
 * any Project), and given the Skill.
 */
export function AddMemberDialog({ project, skill, holders, onClose }: { project: Project; skill: Skill; holders: Holder[]; onClose: () => void }) {
  const qc = useQueryClient();
  const members = useMembers();
  const detail = useProject(project.key);
  const inProject = new Set((detail.data?.members ?? []).map((m) => m.id));
  const holding = new Set(holders.map((t) => t.id));
  const candidates = (members.data ?? []).filter((m) => !m.deactivated_at && !holding.has(m.id));
  const joins = (m: Member) => !orgWide(skill) && !inProject.has(m.id);
  const add = useMutation({
    mutationFn: async (m: Member) => {
      if (joins(m)) await addProjectMember(project.key, m.id);
      await grantSkill(m.id, skill.id);
      return m;
    },
    onSuccess: () => {
      invalidateAll(qc);
      onClose();
    },
  });
  const what = (m: Member) => (joins(m) ? `Joins ${project.name}, gets ${skill.name}` : `Gets ${skill.name}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="top-20 translate-y-0 gap-0 p-0 sm:max-w-[440px]">
        <div className="flex flex-col gap-1 px-5 pt-4 pb-3">
          <DialogTitle className="text-[15px] font-semibold">Add a Member with {skill.name}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{now}</DialogDescription>
        </div>
        <Command className="border-t">
          <CommandInput placeholder="Member…" aria-label="Find a Member" />
          <CommandList className="max-h-72">
            <CommandEmpty>Every Member holds it already.</CommandEmpty>
            <CommandGroup>
              {candidates.map((m) => (
                <CommandItem key={m.id} value={m.name} aria-label={`${m.name}: ${what(m)}`} disabled={add.isPending} onSelect={() => add.mutate(m)}>
                  <MemberAvatar member={m} card={false} />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{what(m)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {add.error ? (
          <div className="px-5 py-3">
            <Refusal error={add.error} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Made = { member?: Member; token?: IssuedToken; done: string[]; failed?: { what: string; error: unknown }; runner?: string };

/**
 * Create an agent…: a name, the Step's Skill, and whether the Runner starts its sessions and on
 * which model. /v1 makes it in steps — the Member, its place in the Project, its Skill, its first
 * token, its Runner settings — and what refuses says which, beside what was made. The token's
 * secret shows once, with how the agent runs.
 */
export function CreateAgentDialog({ project, skill, onClose }: { project: Project; skill: Skill; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [runner, setRunner] = useState(true);
  const [model, setModel] = useState(defaultModel);
  const make = useMutation({
    mutationFn: async (): Promise<Made> => {
      const made: Made = { done: [] };
      const step = async (what: string, run: () => Promise<unknown>) => {
        if (made.failed) return;
        try {
          await run();
          made.done.push(what);
        } catch (error) {
          made.failed = { what, error };
        }
      };
      made.member = await createMember({ name: name.trim(), kind: "agent" });
      const id = made.member.id;
      if (!orgWide(skill)) await step(`added to ${project.name}`, () => addProjectMember(project.key, id));
      await step(`given ${skill.name}`, () => grantSkill(id, skill.id));
      if (!made.failed) {
        try {
          made.token = await issueToken(id, { name: firstTokenName });
        } catch (error) {
          made.failed = { what: "issued its token", error };
        }
      }
      if (runner) {
        const m = model.trim() || defaultModel;
        await step("set up for the Runner", () => setAgentSettings(id, { model: m }));
        if (!made.failed) made.runner = `The Runner starts its sessions on this Install, on ${m}.`;
      } else made.runner = "The Runner does not start it: it brings its own session, through this token.";
      return made;
    },
    onSettled: () => invalidateAll(qc),
  });

  const made = make.data;
  if (made?.member) {
    return (
      <OnceDialog open onDone={onClose} title={`${made.member.name} is ready`}>
        <p className="text-muted-foreground">
          Created{made.done.length > 0 && `, ${made.done.join(", ")}`}.
        </p>
        {made.failed && (
          <div className="flex flex-col gap-1">
            <p>Not {made.failed.what}:</p>
            <Refusal error={made.failed.error} />
          </div>
        )}
        {made.token && <TokenShown issued={made.token} label={`Secret of ${made.member.name}'s token`} />}
        {made.runner && <p className="text-muted-foreground">{made.runner}</p>}
      </OnceDialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create an agent"
      description={`An agent Member of ${project.name} that takes the Tasks needing ${skill.name}. ${now}`}
      submitLabel="Create agent"
      onSubmit={() => make.mutate()}
      pending={make.isPending}
      submitDisabled={!name.trim()}
      error={make.error}
    >
      <FormRows>
        <FormRow label="Name" htmlFor="agent-name">
          <Input id="agent-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow label="Skill">
          <span className="font-mono text-xs">{skill.name}</span>
        </FormRow>
        <FormRow label="Runner" help={runner ? "The Runner starts its sessions with the Install's default command." : "It brings its own session, through its token."}>
          <Switch checked={runner} onCheckedChange={setRunner} aria-label="Run with the Runner" className="self-start" />
        </FormRow>
        {runner && (
          <FormRow label="Model" htmlFor="agent-model">
            <Input
              id="agent-model"
              list="agent-models"
              maxLength={200}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="font-mono text-xs md:text-xs"
            />
            <datalist id="agent-models">
              {knownModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </FormRow>
        )}
      </FormRows>
    </FormDialog>
  );
}
