import { useMutation } from "@tanstack/react-query";
import { AlertTriangleIcon, BotIcon, CheckIcon, CopyIcon, UserPlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { IssuedToken, Member, Project, Skill } from "@/api/client";
import { useMembers, useProject, useSkills } from "@/api/queries";
import { addProjectMember, createMember } from "@/api/writes";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createSkill, grantSkill, issueToken, setAgentSettings } from "./writes";

/*
 * Who takes a Step's Tasks, changed from its panel: a Member of the Organisation given the Step's
 * Skill (and added to the Project when not in it), a new agent created for it, a new Skill.
 */

export const defaultModel = "claude-sonnet-5-5";
const knownModels = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];
const defaultCommand = "claude";
/** The token a new agent is issued: its first. */
export const firstTokenName = "default";
const skillName = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The skill-review Skill, whose takers are the Organisation's, not the Project's. */
const orgWide = (skill: Pick<Skill, "name" | "builtin">) => skill.builtin && skill.name === "skill-review";

/**
 * Add Member: any active Member of the Organisation who does not take the Step's Tasks yet. Each
 * says what picking them does: added to the Project when not in it (never for skill-review,
 * taken from any Project), and given the Skill.
 */
export function AddMember({ project, skill, takers }: { project: Project; skill: Skill; takers: { id: string }[] }) {
  const [open, setOpen] = useState(false);
  const members = useMembers();
  const detail = useProject(project.key);
  const inProject = new Set((detail.data?.members ?? []).map((m) => m.id));
  const taking = new Set(takers.map((t) => t.id));
  const candidates = (members.data ?? []).filter((m) => !m.deactivated_at && !taking.has(m.id));
  const joins = (m: Member) => !orgWide(skill) && !inProject.has(m.id);
  const add = useMutation({
    mutationFn: async (m: Member) => {
      if (joins(m)) await addProjectMember(project.key, m.id);
      await grantSkill(m.id, skill.id);
      return m;
    },
    onSuccess: (m) => toast(`${m.name} now takes the Tasks that need ${skill.name}`),
    onError: (err, m) => toast.error(`${m.name} was not added: ${err instanceof Error ? err.message : String(err)}`),
  });
  const what = (m: Member) => (joins(m) ? `Joins ${project.name}, gets ${skill.name}` : `Gets ${skill.name}`);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" disabled={add.isPending}>
          <UserPlusIcon />
          Add Member
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Member…" aria-label="Find a Member" />
          <CommandList>
            <CommandEmpty>Every Member takes these already.</CommandEmpty>
            <CommandGroup>
              {candidates.map((m) => (
                <CommandItem
                  key={m.id}
                  value={m.name}
                  aria-label={`${m.name}: ${what(m)}`}
                  onSelect={() => {
                    setOpen(false);
                    add.mutate(m);
                  }}
                >
                  <MemberAvatar member={m} />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{what(m)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type Made = { member?: Member; token?: IssuedToken; done: string[]; failed?: { what: string; error: unknown } };

/**
 * Create an agent for a Step: a name, the Skill it works (the Step's), and how the Runner starts
 * its sessions. /v1 makes it in steps — the Member, its place in the Project, its Skill, its
 * Runner settings, its first token — and what refuses says which, beside what was made. The
 * token's secret shows once.
 */
export function CreateAgent({ project, skill }: { project: Project; skill?: Skill }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        <BotIcon />
        Create an agent
      </Button>
      {open && <CreateAgentDialog project={project} skill={skill} onClose={() => setOpen(false)} />}
    </>
  );
}

function CreateAgentDialog({ project, skill, onClose }: { project: Project; skill?: Skill; onClose: () => void }) {
  const skills = useSkills();
  const [name, setName] = useState("");
  const [skillId, setSkillId] = useState(skill?.id ?? "");
  const [runner, setRunner] = useState(true);
  const [model, setModel] = useState(defaultModel);
  const [command, setCommand] = useState(defaultCommand);
  const chosen = skills.data?.find((s) => s.id === skillId);
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
      await step(`added to ${project.name}`, () => addProjectMember(project.key, id));
      if (chosen) await step(`given ${chosen.name}`, () => grantSkill(id, chosen.id));
      if (runner) {
        const body = { model: model.trim() || defaultModel, ...(command.trim() && command.trim() !== defaultCommand ? { command: command.trim() } : {}) };
        await step("set up for the Runner", () => setAgentSettings(id, body));
      }
      if (!made.failed) {
        try {
          made.token = await issueToken(id, { name: firstTokenName });
        } catch (error) {
          made.failed = { what: "issued its token", error };
        }
      }
      return made;
    },
  });

  const made = make.data;
  if (made?.member) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent showCloseButton={false} className="top-20 translate-y-0 gap-0 p-0 sm:max-w-[480px]" aria-describedby={undefined}>
          <div className="px-5 pt-4">
            <DialogTitle className="text-[15px] font-semibold">{made.member.name} is ready</DialogTitle>
          </div>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <p className="text-muted-foreground">
              Created{made.done.length > 0 && `, ${made.done.join(", ")}`}.
            </p>
            {made.failed && (
              <div className="flex flex-col gap-1">
                <p>Not {made.failed.what}:</p>
                <Refusal error={made.failed.error} />
              </div>
            )}
            {made.token && (
              <FormRows>
                <FormRow label="Token">
                  <span>{made.token.token.name}</span>
                </FormRow>
                <FormRow label="Secret">
                  <ShownOnce value={made.token.secret} label={`Secret of ${made.member.name}'s token`} />
                </FormRow>
              </FormRows>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-5 pt-1 pb-4">
            <Button onClick={onClose}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create an agent"
      description={`An agent Member of ${project.name}${chosen ? ` that takes the Tasks needing ${chosen.name}` : ""}.`}
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
          <Select value={skillId} onValueChange={setSkillId}>
            <SelectTrigger aria-label="Skill of the new agent" className="w-full">
              <SelectValue placeholder="Pick a Skill" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {(skills.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow label="Runner" help={runner ? "The Runner starts its sessions on this Install." : "It brings its own session, through its token."}>
          <Switch checked={runner} onCheckedChange={setRunner} aria-label="Run with the Runner" className="self-start" />
        </FormRow>
        {runner && (
          <>
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
            <FormRow label="Command" htmlFor="agent-command" help="The program the Runner starts; Settings › Agents holds its arguments.">
              <Input
                id="agent-command"
                maxLength={1000}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="font-mono text-xs md:text-xs"
              />
            </FormRow>
          </>
        )}
      </FormRows>
    </FormDialog>
  );
}

/** A secret /v1 returns once, in a field that selects itself, with Copy. */
function ShownOnce({ value, label }: { value: string; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      input.current?.focus();
      input.current?.select();
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-input bg-muted pr-1 pl-2.5">
        <input
          ref={input}
          readOnly
          aria-label={label}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs tracking-[0.02em] outline-none"
        />
        <Button type="button" variant="outline" size="xs" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="flex items-center gap-1.5 font-medium text-state-claimed">
        <AlertTriangleIcon className="size-3" aria-hidden />
        It will not be shown again.
      </p>
    </div>
  );
}

/**
 * Create a Skill for a Step: a generic Skill, named in lower case with dashes as `/v1` requires,
 * with its text published as version 1. `onCreated` puts it on the Step.
 */
export function CreateSkillDialog({ onCreated, onClose }: { onCreated: (skill: Skill) => void; onClose: () => void }) {
  const skills = useSkills();
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const trimmed = name.trim();
  const problem = !trimmed
    ? undefined
    : !skillName.test(trimmed)
      ? "A Skill's name is lower-case letters, digits and dashes, starting with a letter or digit."
      : skills.data?.some((s) => s.name === trimmed)
        ? `There is a Skill called ${trimmed} already: pick it instead.`
        : undefined;
  const make = useMutation({
    mutationFn: () => createSkill({ name: trimmed, kind: "generic", body }),
    onSuccess: (detail) => onCreated(detail.skill),
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create a Skill"
      description="A generic Skill: what a Member arrives able to do. Its text is version 1."
      submitLabel="Create Skill"
      onSubmit={() => make.mutate()}
      pending={make.isPending}
      submitDisabled={!trimmed || !!problem}
      error={make.error}
      size="md"
    >
      <FormRows>
        <FormRow label="Name" htmlFor="skill-name" help={problem ? <span className="text-destructive">{problem}</span> : "Such as qa or tax-return."}>
          <Input id="skill-name" required maxLength={63} value={name} onChange={(e) => setName(e.target.value)} autoFocus className="font-mono text-xs md:text-xs" />
        </FormRow>
        <FormRow label="Text" htmlFor="skill-body" help="What a Member with it knows and does. Markdown.">
          <Textarea id="skill-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}
