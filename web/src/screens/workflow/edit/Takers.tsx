import type { Project } from "@/api/client";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { RecordStep } from "../bind";
import type { Draft } from "./draft";
import type { Holder, Roster } from "./holders";
import type { OnLineActions } from "./lineEdit";
import type { OrgFacts } from "./reach";
import { TakenBy, type StepSkill } from "./TakenBy";

/**
 * Who takes a Step's Tasks, as the line draws them: their avatars ("Nobody" when no one does,
 * and each Task's Owner takes it). A click opens who takes it to change, in the draft.
 */
export function Takers({
  step,
  word,
  skill,
  takers,
  project,
  draft,
  roster,
  facts,
  actions,
}: {
  step: RecordStep;
  word: string;
  skill: StepSkill;
  takers: Holder[] | undefined;
  project: Project;
  draft: Draft;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  actions: OnLineActions;
}) {
  // Kept mounted while who takes it is read again (a Member just made): what it opened stays open.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Who takes ${word}`}
          className="inline-flex h-6 items-center rounded-full px-0.5 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
        >
          {!takers ? (
            <span className="px-1 text-xs text-muted-foreground">…</span>
          ) : takers.length === 0 ? (
            <span className="px-1 text-xs font-medium text-state-claimed">Nobody</span>
          ) : (
            <>
              {takers.slice(0, 3).map((m, i) => (
                <MemberAvatar key={m.id} member={m} card={false} className={cn(i > 0 && "-ml-0.5")} />
              ))}
              {takers.length > 3 && <span className="pl-1 text-[11px] text-muted-foreground">+{takers.length - 3}</span>}
              <span className="sr-only">{takers.map((m) => m.name).join(", ")}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[360px] max-w-[calc(100vw-32px)] p-3"
        // A dialog it opens (Remove asks first, New agent) is outside it: it stays open behind.
        onInteractOutside={(e) => (e.target as Element | null)?.closest?.("[role=dialog],[role=alertdialog]") && e.preventDefault()}
        onFocusOutside={(e) => (e.target as Element | null)?.closest?.("[role=dialog],[role=alertdialog]") && e.preventDefault()}
      >
        <TakenBy
          project={project}
          stepId={step.id}
          skill={skill}
          draft={draft}
          holders={takers}
          roster={roster}
          facts={facts}
          readOnly={false}
          onAdd={(member, join) => actions.addTaker(step.id, member, join)}
          onRemove={(member) => actions.removeTaker(step.id, member)}
        />
      </PopoverContent>
    </Popover>
  );
}
