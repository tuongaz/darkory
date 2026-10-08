import { ChevronLeftIcon, MoreHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { RefCallback } from "react";
import type { Project, Skill } from "@/api/client";
import { countTasks } from "@/components/workflow/model";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "../bind";
import { nameMax } from "../edits";
import { isNewSkill, outcomes, tasksAt, type Draft } from "./draft";
import { orgWide, type Holder } from "./holders";
import { AddOutcome, Outcome, type OutcomeActions } from "./Outcomes";
import type { OrgFacts } from "./reach";
import { SkillPicker, type SkillChoice } from "./SkillPicker";
import { TakenBy } from "./TakenBy";

/*
 * The picked Step, edited beside the list: its name and a menu (move, add a Step after, delete);
 * how many Tasks are at it; its Skill; who takes it (TakenBy, which acts at once); its outcomes, the
 * main one picked by a radio; and Delete Step at the foot. Read-only for a Member who is not an
 * admin: the same facts as text.
 */

export type PanelActions = OutcomeActions & {
  main: (id: string) => void;
  renameStep: (name: string) => void;
  settleName: () => void;
  skill: (choice: SkillChoice) => void;
  reorder: (by: -1 | 1) => void;
  insertAfter: () => void;
  deleteStep: () => void;
};

export function StepPanel({
  project,
  step,
  n,
  draft,
  base,
  order,
  skills,
  holders,
  facts,
  readOnly,
  invalid,
  canMove,
  actions,
  nameRef,
  onBack,
}: {
  project: Project;
  step: RecordStep;
  n: number;
  draft: Draft;
  base: WorkflowRecord;
  order: RecordStep[];
  skills: Skill[];
  holders?: Map<string, Holder[]>;
  facts: OrgFacts | undefined;
  readOnly: boolean;
  invalid: boolean;
  canMove: { up: boolean; down: boolean };
  actions: PanelActions;
  nameRef: (id: string) => RefCallback<HTMLInputElement>;
  /** On a phone: back to the list. */
  onBack?: () => void;
}) {
  const name = step.name.trim() || "the new Step";
  const fresh = !base.steps.some((s) => s.id === step.id);
  const skill = step.skill_id && !isNewSkill(step.skill_id) ? skills.find((s) => s.id === step.skill_id) : undefined;
  const pendingName = isNewSkill(step.skill_id) ? draft.skills[step.skill_id!]?.name : undefined;
  const out = outcomes(draft.wf, step.id);
  const tasks = tasksAt(draft, step.id);
  const holderNames = new Map([...(holders ?? new Map<string, Holder[]>())].map(([id, list]) => [id, list.map((h) => h.name)]));
  const wide = !!skill && orgWide(skill);

  return (
    <section aria-label={`Step ${n}: ${step.name.trim() || "New Step"}`} className="flex flex-col gap-5 px-6 pt-4 pb-8 max-md:px-4">
      {onBack && (
        <button type="button" onClick={onBack} className="-mb-2 flex items-center gap-1 self-start text-[13px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <ChevronLeftIcon aria-hidden className="size-4" /> Steps
        </button>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {readOnly ? (
            <h2 className="flex h-9 min-w-0 flex-1 items-center truncate text-[15px] font-semibold">{step.name}</h2>
          ) : (
            <input
              ref={nameRef(step.id)}
              value={step.name}
              placeholder="Name the Step"
              maxLength={nameMax}
              aria-label={`Name of Step ${n}`}
              aria-invalid={(invalid && !step.name.trim()) || undefined}
              onChange={(e) => actions.renameStep(e.target.value)}
              onBlur={actions.settleName}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-muted aria-invalid:border-destructive dark:bg-input/30"
            />
          )}
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More for ${name}`}
                  className="inline-flex size-8 flex-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
                >
                  <MoreHorizontalIcon aria-hidden className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem disabled={!canMove.up} onSelect={() => actions.reorder(-1)}>
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canMove.down} onSelect={() => actions.reorder(1)}>
                  Move down
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.insertAfter}>Add Step after {name}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={actions.deleteStep}>
                  Delete {name}…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{fresh ? "New · no Tasks" : tasks > 0 ? `${countTasks(tasks)} here` : "No Task here"}</span>
      </div>

      <section aria-label="Skill" className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-[13px] font-semibold">Skill</h3>
          <span className="text-xs text-muted-foreground">
            {!step.skill_id
              ? readOnly
                ? ""
                : "Pick one, or leave it a hold"
              : wide
                ? "Anyone in the Organisation with it takes this Step's Tasks"
                : `Members of ${project.name} with it take this Step's Tasks`}
          </span>
        </div>
        {readOnly ? (
          <span className={cn("font-mono text-[12px]", !step.skill_id && "font-sans text-[13px] text-muted-foreground")}>
            {skill?.name ?? pendingName ?? "Hold · moved by hand"}
          </span>
        ) : (
          <SkillPicker
            value={step.skill_id}
            label={`Skill of ${name}`}
            skills={skills}
            pending={draft.skills}
            holders={holderNames}
            onChange={actions.skill}
            className="w-[280px] max-md:w-full"
          />
        )}
        {!step.skill_id && <p className="text-xs text-muted-foreground">No Skill: a hold. Nobody is offered its Tasks; a human moves them on.</p>}
      </section>

      {step.skill_id &&
        (skill ? (
          <TakenBy project={project} stepName={name} skill={skill} holders={holders ? (holders.get(skill.id) ?? []) : undefined} skills={skills} facts={facts} readOnly={readOnly} />
        ) : (
          <section aria-label="Taken by" className="flex flex-col gap-1.5">
            <h3 className="text-[13px] font-semibold">Taken by</h3>
            <p className="text-xs text-muted-foreground">{pendingName} is created on Save: add its Members after.</p>
          </section>
        ))}
      {!step.skill_id && (
        <section aria-label="Taken by" className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold">Taken by</h3>
          <p className="text-xs text-muted-foreground">Moved on by hand.</p>
        </section>
      )}

      <section aria-label="Outcomes" className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-[13px] font-semibold">Outcomes</h3>
          {out.length > 1 && <span className="text-xs text-muted-foreground">● main: the line follows it</span>}
        </div>
        {out.length === 0 && step.skill_id && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-state-claimed">
            <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
            No way out: Tasks here can only be moved by hand.
          </p>
        )}
        <div role="radiogroup" aria-label={`Main outcome out of ${name}`} className="flex flex-col gap-1.5">
          {out.map((c, i) => (
            <div key={c.id} className="group/out flex min-h-8 items-center gap-2.5">
              {out.length > 1 && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={i === 0}
                  aria-label={`${c.name.trim() || "outcome"}: the main way on`}
                  disabled={readOnly}
                  onClick={() => actions.main(c.id)}
                  className="flex size-5 flex-none items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className={cn("size-3.5 rounded-full border-[1.5px] border-ring", i === 0 && "border-foreground bg-foreground shadow-[inset_0_0_0_2.5px_var(--background)]")} />
                </button>
              )}
              <Outcome wf={draft.wf} base={base} step={step} order={order} readOnly={readOnly} invalid={invalid} actions={actions} nameRef={nameRef} c={c} />
            </div>
          ))}
        </div>
        {!readOnly && <AddOutcome step={step} onAdd={actions.add} />}
      </section>

      {!readOnly && (
        <div className="border-t pt-4">
          <button
            type="button"
            onClick={actions.deleteStep}
            aria-label={`Delete ${name}`}
            className="rounded-sm text-[13px] font-medium text-destructive outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Delete Step
          </button>
        </div>
      )}
    </section>
  );
}
