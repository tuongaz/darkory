import { BotIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Project, Skill } from "@/api/client";
import { FormDialog } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { memberSettingsPath } from "@/lib/members";
import { cn } from "@/lib/utils";
import { inOrder, isNewSkill, willBeIn, type Draft } from "./draft";
import { orgWide, type Holder, type Roster } from "./holders";
import { CreateAgentDialog } from "./people";
import { andList, takeAwayReach, type OrgFacts } from "./reach";
import { Tip } from "@/components/Tip";

/*
 * Who takes a Step's Tasks, in its panel: the Members of the Project who have its Skill (the
 * Organisation's, for skill-review), as the draft has them. Each row's name opens the Member; its
 * × removes them, which takes the Skill from them on Save and asks first only when that reaches
 * past this Step. Add gives a Member the Skill (joining the Project first when they are not in it).
 * Add and Remove edit the draft like the rest of the editor; New agent makes a Member at once.
 */

/** The Skill a Step carries: one that exists, or a new one (`new-skill:<name>`) made on Save. */
export type StepSkill = Pick<Skill, "id" | "name" | "builtin">;

const kindWord = (h: Pick<Holder, "kind">) => (h.kind === "agent" ? "Agent" : "Human");

export function TakenBy({
  project,
  stepId,
  skill,
  draft,
  holders,
  roster,
  facts,
  readOnly,
  onAdd,
  onRemove,
}: {
  project: Project;
  stepId: string;
  skill: StepSkill;
  draft: Draft;
  /** Who takes it at Save; undefined while unknown. */
  holders: Holder[] | undefined;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  readOnly: boolean;
  onAdd: (member: string, join: boolean) => void;
  onRemove: (member: string) => void;
}) {
  const [asking, setAsking] = useState<{ member: Holder; also: string } | undefined>();
  const [agent, setAgent] = useState(false);
  const [adding, setAdding] = useState(false);
  const fresh = isNewSkill(skill.id);
  const given = (id: string) => !!draft.people?.grants.some((g) => g.member === id && g.skill === skill.id);

  // Where else the Member takes the Skill: other Steps here carrying it, and other Projects' Steps.
  const elsewhere = (m: Holder): string | undefined => {
    const here = inOrder(draft.wf.steps)
      .filter((s) => s.id !== stepId && s.skill_id === skill.id)
      .map((s) => s.name.trim() || "New Step");
    const projects = [...new Set((facts ? takeAwayReach(facts, m.id, skill) : []).filter((p) => p.project.key !== project.key).map((p) => p.project.name))];
    const parts = [here.length ? `at ${andList(here)}` : "", projects.length ? `in ${andList(projects)}` : ""].filter(Boolean);
    return parts.length ? `${m.name} also takes ${skill.name} ${parts.join(", and ")}.` : undefined;
  };
  const remove = (m: Holder) => {
    const also = fresh || given(m.id) ? undefined : elsewhere(m);
    if (also) setAsking({ member: m, also });
    else onRemove(m.id);
  };

  return (
    <section aria-label="Taken by" className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">Taken by</h3>
      {!holders ? (
        <span className="text-xs text-muted-foreground">…</span>
      ) : holders.length === 0 ? (
        <Tip label="Each Task's Owner takes it">
          <p tabIndex={0} className="self-start rounded-sm text-[13px] font-medium text-state-claimed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            Nobody
          </p>
        </Tip>
      ) : (
        <ul aria-label={`Members with ${skill.name}`} className="flex flex-col gap-1.5">
          {holders.map((m) => (
            <li key={m.id} className={cn("flex h-9 items-center gap-2 rounded-md border pr-1 pl-2", given(m.id) && "bg-state-claimed-bg")}>
              <MemberAvatar member={m} />
              <Link to={memberSettingsPath(m)} className="truncate rounded-sm text-[13.5px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {m.name}
              </Link>
              <span className="text-xs text-muted-foreground">{kindWord(m)}</span>
              {!readOnly && (
                <Tip label="Remove">
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    disabled={!facts && !fresh && !given(m.id)}
                    onClick={() => remove(m)}
                    className="ml-auto inline-flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    <XIcon aria-hidden className="size-4" />
                  </button>
                </Tip>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Add a Member"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            className="aria-expanded:border-foreground"
          >
            <PlusIcon aria-hidden /> Add
          </Button>
          {!fresh && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAgent(true)}>
              <BotIcon aria-hidden /> New agent
            </Button>
          )}
        </div>
      )}
      {!readOnly && adding && (
        <div
          className="mt-1 max-w-[440px] overflow-hidden rounded-md border shadow-soft"
          onKeyDown={(e) => {
            if (e.key === "Escape") setAdding(false);
          }}
        >
          <AddMember
            project={project}
            skill={skill}
            draft={draft}
            holders={holders ?? []}
            roster={roster}
            onPick={(id, join) => {
              onAdd(id, join);
              setAdding(false);
            }}
          />
        </div>
      )}
      {asking && (
        <FormDialog
          open
          onOpenChange={(o) => !o && setAsking(undefined)}
          title={`Remove ${asking.member.name} from ${skill.name}?`}
          description={asking.also}
          submitLabel="Remove"
          onSubmit={() => {
            onRemove(asking.member.id);
            setAsking(undefined);
          }}
        >
          {null}
        </FormDialog>
      )}
      {agent && !fresh && <CreateAgentDialog project={project} skill={skill as Skill} onClose={() => setAgent(false)} />}
    </section>
  );
}

/**
 * Add a Member: the Project's Members first, then the rest of the Organisation, who join the
 * Project too (for skill-review, everyone: it is taken in every Project). Picking edits the draft.
 */
function AddMember({
  project,
  skill,
  draft,
  holders,
  roster,
  onPick,
}: {
  project: Project;
  skill: StepSkill;
  draft: Draft;
  holders: Holder[];
  roster: Roster | undefined;
  onPick: (id: string, join: boolean) => void;
}) {
  const wide = orgWide(skill);
  const taking = new Set(holders.map((h) => h.id));
  const candidates = (roster?.members ?? []).filter((m) => !taking.has(m.id));
  const isIn = (id: string) => willBeIn(draft, id, !!roster?.inProject.has(id));
  const inside = candidates.filter((m) => wide || isIn(m.id));
  const outside = wide ? [] : candidates.filter((m) => !isIn(m.id));
  const item = (m: Holder, join: boolean) => (
    <CommandItem key={m.id} value={m.name} onSelect={() => onPick(m.id, join)}>
      <MemberAvatar member={m} card={false} />
      <span className="truncate">{m.name}</span>
      <span className="text-xs text-muted-foreground">{kindWord(m)}</span>
    </CommandItem>
  );
  return (
    <Command>
      <CommandInput placeholder="Find a Member" aria-label="Find a Member" autoFocus />
      <CommandList className="max-h-80">
        <CommandEmpty>{!roster ? "…" : candidates.length ? "No such Member." : `Every Member takes ${skill.name}.`}</CommandEmpty>
        {inside.length > 0 && <CommandGroup heading={wide ? undefined : `In ${project.name}`}>{inside.map((m) => item(m, false))}</CommandGroup>}
        {outside.length > 0 && <CommandGroup heading={`Not in ${project.name}`}>{outside.map((m) => item(m, true))}</CommandGroup>}
      </CommandList>
    </Command>
  );
}
