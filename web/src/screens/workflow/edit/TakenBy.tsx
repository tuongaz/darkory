import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BotIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Project, Skill } from "@/api/client";
import { invalidateAll, useTasks } from "@/api/queries";
import { addProjectMember, grantSkill, removeProjectMember, revokeSkill } from "@/api/writes";
import { FormDialog } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { countTasks } from "@/components/workflow/model";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { memberSettingsPath } from "@/lib/members";
import { orgWide, type Holder } from "./holders";
import { CreateAgentDialog } from "./people";
import { andList, grantElsewhere, joinAlso, leaveReach, othersAt, staysIn, takeAwayReach, type OrgFacts, type Place } from "./reach";

/*
 * Who takes a Step's Tasks, in its panel: the Members of the Project who have its Skill (the
 * Organisation's, for skill-review), each with the two acts that take them off it, named for what
 * they change and how far they reach (take the Skill away: every Project they are in; remove from
 * the Project: every Step there); then Add a Member and Create an agent. All four act at once: they
 * change Members, not the Workflow, so Save neither sends nor undoes them.
 */

const kindWord = (h: Pick<Holder, "kind">) => (h.kind === "agent" ? "Agent" : "Human");
const placeWord = (p: Place, many: boolean) => (many ? `${p.project.name} · ${p.step.name}` : p.step.name);
const tasksWord = (places: Place[]) => countTasks(places.reduce((n, p) => n + p.tasks, 0));

export function TakenBy({
  project,
  stepName,
  skill,
  holders,
  skills,
  facts,
  readOnly,
}: {
  project: Project;
  stepName: string;
  skill: Skill;
  /** Who takes it now; undefined while unknown. */
  holders: Holder[] | undefined;
  skills: Skill[];
  facts: OrgFacts | undefined;
  readOnly: boolean;
}) {
  const wide = orgWide(skill);
  const [act, setAct] = useState<{ kind: "take" | "leave"; member: Holder } | undefined>();
  const [agent, setAgent] = useState(false);
  const [adding, setAdding] = useState(false);
  const scope = wide ? "the Organisation" : project.name;

  const summary = (m: Holder, kind: "take" | "leave") => {
    if (!facts) return "…";
    if (kind === "take") {
      const elsewhere = takeAwayReach(facts, m.id, skill).filter((p) => !(p.project.key === project.key && p.step.name === stepName));
      if (elsewhere.length === 0) return "Only here";
      if (elsewhere.length === 1) return `Also stops ${elsewhere[0].step.name} in ${elsewhere[0].project.name} · ${countTasks(elsewhere[0].tasks)}`;
      return `Also stops ${elsewhere.length} other Steps · ${tasksWord(elsewhere)}`;
    }
    const steps = leaveReach(facts, m.id, project.key, skills).map((p) => p.step.name);
    const stays = staysIn(facts, m.id, project.key).map((p) => p.name);
    return `Leaves ${andList(steps)}${stays.length ? ` · stays in ${andList(stays)}` : ""}`;
  };

  return (
    <section aria-label="Taken by" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[13px] font-semibold">Taken by</h3>
        {holders && holders.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {holders.length} in {scope} with {skill.name}
            {!readOnly && " · changes here happen at once, not on Save"}
          </span>
        )}
      </div>
      {!holders ? (
        <span className="text-xs text-muted-foreground">…</span>
      ) : holders.length === 0 ? (
        <p className="text-xs font-medium text-state-claimed">
          Nobody in {scope} has {skill.name}: each Task's Owner takes it.
        </p>
      ) : (
        <ul aria-label={`Members with ${skill.name}`} className="flex flex-col gap-1.5">
          {holders.map((m) => (
            <li key={m.id} className="flex h-9 items-center gap-2 rounded-md border pr-1.5 pl-2">
              <MemberAvatar member={m} />
              <span className="truncate text-[13.5px]">{m.name}</span>
              <span className="text-xs text-muted-foreground">{kindWord(m)}</span>
              {!readOnly && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Take ${m.name} off ${stepName}`}
                      className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
                    >
                      <MoreHorizontalIcon aria-hidden className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-80">
                    <DropdownMenuItem onSelect={() => setAct({ kind: "take", member: m })} className="flex-col items-start gap-0">
                      <span>
                        Take {skill.name} from {m.name}…
                      </span>
                      <span className="text-xs text-muted-foreground">{summary(m, "take")}</span>
                    </DropdownMenuItem>
                    {!wide && (
                      <DropdownMenuItem onSelect={() => setAct({ kind: "leave", member: m })} className="flex-col items-start gap-0">
                        <span>
                          Remove {m.name} from {project.name}…
                        </span>
                        <span className="text-xs text-muted-foreground">{summary(m, "leave")}</span>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to={memberSettingsPath(m)}>Open profile</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Popover open={adding} onOpenChange={setAdding}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <PlusIcon aria-hidden /> Add a Member
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[440px] max-w-[calc(100vw-32px)] p-0">
              <AddMember project={project} skill={skill} holders={holders ?? []} skills={skills} facts={facts} onDone={() => setAdding(false)} />
            </PopoverContent>
          </Popover>
          <Button type="button" variant="outline" size="sm" onClick={() => setAgent(true)}>
            <BotIcon aria-hidden /> Create an agent
          </Button>
        </div>
      )}
      {act && facts && <RemoveDialog act={act.kind} member={act.member} project={project} skill={skill} skills={skills} facts={facts} onClose={() => setAct(undefined)} />}
      {agent && <CreateAgentDialog project={project} skill={skill} onClose={() => setAgent(false)} />}
    </section>
  );
}

/**
 * Add a Member: the Project's Members without the Skill first, then the rest of the Organisation
 * (for skill-review, everyone without it: it is taken in every Project). Each row says exactly what
 * picking it does and where else that reaches; picking acts at once.
 */
function AddMember({
  project,
  skill,
  holders,
  skills,
  facts,
  onDone,
}: {
  project: Project;
  skill: Skill;
  holders: Holder[];
  skills: Skill[];
  facts: OrgFacts | undefined;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const wide = orgWide(skill);
  const here = facts?.projects.find((p) => p.key === project.key);
  const has = (id: string) => !!facts?.skillsOf.get(id)?.has(skill.id);
  const taking = new Set(holders.map((h) => h.id));
  const candidates = (facts?.members ?? []).filter((m) => !taking.has(m.id));
  const inside = candidates.filter((m) => wide || here?.members.has(m.id)).filter((m) => !has(m.id));
  const outside = wide ? [] : candidates.filter((m) => !here?.members.has(m.id));
  const add = useMutation({
    mutationFn: async (id: string) => {
      if (!wide && !here?.members.has(id)) await addProjectMember(project.key, id);
      if (!has(id)) await grantSkill(id, skill.id);
    },
    onSuccess: () => {
      invalidateAll(qc);
      onDone();
    },
  });
  const what = (id: string) => {
    const joins = !wide && !here?.members.has(id);
    const elsewhere = facts && !has(id) ? grantElsewhere(facts, id, skill, project.key).map((p) => p.name) : [];
    const gets = has(id) ? `has ${skill.name}` : `gets ${skill.name}${elsewhere.length ? `, here and in ${andList(elsewhere)}` : ""}`;
    return joins ? `Joins ${project.name}${has(id) ? " · " : ", "}${gets}` : gets.charAt(0).toUpperCase() + gets.slice(1);
  };
  const also = (id: string) => {
    if (!facts || wide || here?.members.has(id)) return undefined;
    const steps = joinAlso(facts, id, skill, project.key, skills).map((p) => p.step.name);
    return steps.length ? `Also takes ${andList(steps)} here` : undefined;
  };
  const item = (m: OrgFacts["members"][number]) => {
    const extra = also(m.id);
    return (
      <CommandItem key={m.id} value={m.name} aria-label={`${m.name}: ${what(m.id)}`} disabled={add.isPending} onSelect={() => add.mutate(m.id)} className="items-start">
        <MemberAvatar member={m} card={false} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate">{m.name}</span>
            <span className="text-xs text-muted-foreground">· {m.kind === "agent" ? "Agent" : "Human"}</span>
            <span className="ml-auto pl-3 text-right text-xs text-muted-foreground">{what(m.id)}</span>
          </span>
          {extra && <span className="text-xs text-muted-foreground">{extra}</span>}
        </span>
      </CommandItem>
    );
  };
  return (
    <Command>
      <CommandInput placeholder="Find a Member" aria-label="Find a Member" />
      <CommandList className="max-h-80">
        <CommandEmpty>{facts ? `Every Member has ${skill.name}.` : "…"}</CommandEmpty>
        {inside.length > 0 && <CommandGroup heading={wide ? `Without ${skill.name}` : `In ${project.name} · without ${skill.name}`}>{inside.map(item)}</CommandGroup>}
        {outside.length > 0 && <CommandGroup heading={`Not in ${project.name}`}>{outside.map(item)}</CommandGroup>}
      </CommandList>
      {add.error ? (
        <div className="border-t px-3 py-2">
          <Refusal error={add.error} />
        </div>
      ) : null}
    </Command>
  );
}

/**
 * The two acts that take a Member off a Step, asked first: every Step they reach with its open
 * Tasks, who takes those Tasks then, and the Claims the Member keeps (neither act ends one).
 */
function RemoveDialog({
  act,
  member,
  project,
  skill,
  skills,
  facts,
  onClose,
}: {
  act: "take" | "leave";
  member: Holder;
  project: Project;
  skill: Skill;
  skills: Skill[];
  facts: OrgFacts;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const places = act === "take" ? takeAwayReach(facts, member.id, skill) : leaveReach(facts, member.id, project.key, skills);
  const many = new Set(places.map((p) => p.project.key)).size > 1 || (places[0] && places[0].project.key !== project.key);
  const held = useTasks({ state: "open", holder: member.id });
  const kept = (held.data ?? []).filter((t) => places.some((p) => p.step.id === t.step_id)).map((t) => t.key);
  const skillAt = (p: Place) => skills.find((s) => s.id === facts.workflows.get(p.project.key)?.steps.find((x) => x.id === p.step.id)?.skill_id);
  // Who takes each reached Step's Tasks then: the others with its Skill, or each Task's Owner.
  const nobody = places.filter((p) => {
    const sk = skillAt(p);
    return sk && othersAt(facts, p, sk, member.id).length === 0;
  });
  const still = places
    .map((p) => ({ p, names: skillAt(p) ? othersAt(facts, p, skillAt(p)!, member.id) : [] }))
    .filter((x) => x.names.length > 0);
  const stays = staysIn(facts, member.id, project.key);
  const run = useMutation({
    mutationFn: () => (act === "take" ? revokeSkill(member.id, skill.id) : removeProjectMember(project.key, member.id)),
    onSuccess: () => {
      invalidateAll(qc);
      onClose();
    },
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={act === "take" ? `Take ${skill.name} from ${member.name}?` : `Remove ${member.name} from ${project.name}?`}
      description={
        places.length === 0
          ? `${member.name} takes no Step's Tasks ${act === "take" ? `by ${skill.name}` : `in ${project.name}`}.`
          : act === "take"
            ? `${member.name} stops taking the Tasks at every Step that carries ${skill.name}:`
            : `${member.name} stops taking ${project.name}'s Tasks at:`
      }
      submitLabel={act === "take" ? `Take ${skill.name} away` : `Remove from ${project.name}`}
      destructive
      pending={run.isPending}
      error={run.error}
      onSubmit={() => run.mutate()}
    >
      {places.length > 0 && (
        <ul aria-label="Steps it reaches" className="flex flex-col gap-1">
          {places.map((p) => (
            <li key={`${p.project.key}-${p.step.id}`} className="flex justify-between gap-4">
              <span>{placeWord(p, !!many)}</span>
              <span className="text-muted-foreground tabular-nums">{countTasks(p.tasks)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold">Then</span>
        <ul className="list-disc pl-5 text-[13px]">
          {act === "leave" && stays.length > 0 && (
            <li>
              {member.name} stays in {andList(stays.map((p) => p.name))}.
            </li>
          )}
          {nobody.length > 0 && (
            <li>
              Nobody else {nobody.every((p) => p.project.key === project.key) ? `in ${project.name}` : `in ${andList([...new Set(nobody.map((p) => p.project.name))], "or")}`} takes{" "}
              {andList([...new Set(nobody.map((p) => p.step.name))])}: each Task's Owner takes those Tasks.
            </li>
          )}
          {still.map(({ p, names }) => (
            <li key={`${p.project.key}-${p.step.id}`}>
              {andList(names)} still {names.length === 1 ? "takes" : "take"} {placeWord(p, !!many)}.
            </li>
          ))}
          {kept.length > 0 && (
            <li>
              {member.name} keeps {andList(kept)}, which {member.name} holds now.
            </li>
          )}
        </ul>
      </div>
    </FormDialog>
  );
}
