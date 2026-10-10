import { useSortable } from "@dnd-kit/sortable";
import { MoreHorizontalIcon } from "lucide-react";
import { useId, useRef, type KeyboardEvent, type RefCallback } from "react";
import type { Project, Skill } from "@/api/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { RecordStep } from "../bind";
import { nameMax } from "../edits";
import { isNewSkill, workflowsOf, type Draft } from "./draft";
import type { Holder, Roster } from "./holders";
import { stepWord, type OnLineActions } from "./lineEdit";
import type { OrgFacts } from "./reach";
import { SkillPicker } from "./SkillPicker";
import { type StepSkill } from "./TakenBy";
import { Takers } from "./Takers";

/** One Step's fields on the line: its grip, name, Skill, who takes it, and its ⋯ menu. */
export function StepHead({
  step,
  clash,
  clashIn,
  changed,
  invalid,
  skills,
  skillMap,
  pending,
  holderNames,
  holders,
  project,
  draft,
  roster,
  facts,
  workflows,
  canUp,
  canDown,
  actions,
  inputRef,
  gripRef,
  onGripKey,
}: {
  step: RecordStep;
  clash: RecordStep | undefined;
  clashIn: (s: RecordStep) => string;
  changed: boolean;
  invalid: boolean;
  skills: Skill[];
  skillMap: Map<string, Skill>;
  pending: Draft["skills"];
  holderNames: Map<string, string[]>;
  holders?: Map<string, Holder[]>;
  project: Project;
  draft: Draft;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  workflows: ReturnType<typeof workflowsOf>;
  canUp: boolean;
  canDown: boolean;
  actions: OnLineActions;
  inputRef: (id: string) => RefCallback<HTMLElement>;
  gripRef: (el: HTMLButtonElement | null) => void;
  onGripKey: (e: KeyboardEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging, isOver } = useSortable({ id: step.id });
  const word = stepWord(step);
  const clashId = useId();
  const empty = !step.name.trim();
  const skill = step.skill_id && !isNewSkill(step.skill_id) ? skillMap.get(step.skill_id) : undefined;
  const pendingName = isNewSkill(step.skill_id) ? pending[step.skill_id!]?.name : undefined;
  // The Skill who takes it is about: one that exists, or the new one made on Save.
  const stepSkill: StepSkill | undefined = skill ?? (pendingName ? { id: step.skill_id!, name: pendingName, builtin: false } : undefined);
  const { onKeyDown: dndKey, ...gripListeners } = listeners ?? {};
  // An item that puts the focus in a field (a Step added, the Step moved to another Workflow): the menu leaves it there as it closes.
  const focused = useRef(false);
  return (
    <div
      ref={setNodeRef}
      data-step-head={step.id}
      data-changed={changed ? "" : undefined}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      className={cn(
        "relative flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1",
        isDragging && "z-20 rounded-md bg-background shadow-soft",
        isOver && !isDragging && "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-ring",
      )}
    >
      <button
        type="button"
        ref={(el) => {
          setActivatorNodeRef(el);
          gripRef(el);
        }}
        {...attributes}
        {...gripListeners}
        // dnd-kit calls the grip "sortable"; it is a button named for what it does.
        aria-roledescription={undefined}
        aria-label={`Move ${word}: drag, or Alt+↑ and Alt+↓`}
        onKeyDown={(e) => {
          onGripKey(e);
          if (!e.defaultPrevented) (dndKey as ((e: KeyboardEvent) => void) | undefined)?.(e);
        }}
        className="-ml-1 flex h-6 w-3 flex-none cursor-grab touch-none items-center justify-center rounded-sm text-[13px] font-semibold tracking-[-3px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span aria-hidden>⋮⋮</span>
      </button>
      <input
        ref={inputRef(step.id)}
        value={step.name}
        placeholder="Name the Step"
        maxLength={nameMax}
        aria-label={`Name of ${word}`}
        aria-invalid={(invalid && empty) || !!clash || undefined}
        aria-describedby={clash ? clashId : undefined}
        onChange={(e) => actions.renameStep(step.id, e.target.value)}
        onBlur={actions.settle}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            actions.reorder(step.id, e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        style={{ width: `calc(${Math.max(step.name.length, 9)}ch + 18px)` }}
        className={cn(
          "h-7 max-w-[200px] min-w-0 rounded-md border border-input bg-background px-2 text-sm font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
          changed && "border-state-waiting text-state-waiting",
        )}
      />
      {clash && (
        <span id={clashId} className="text-[11px] text-destructive">
          Named already in {clashIn(clash)}
        </span>
      )}
      <SkillPicker
        value={step.skill_id}
        label={`Skill of ${word}`}
        skills={skills}
        pending={pending}
        holders={holderNames}
        onChange={(choice) => actions.skill(step.id, choice)}
        className="h-6 w-auto max-w-[150px] gap-1 px-1.5 text-[11px]"
      />
      {stepSkill && (
        <Takers
          step={step}
          word={word}
          skill={stepSkill}
          takers={holders ? (holders.get(stepSkill.id) ?? []) : undefined}
          project={project}
          draft={draft}
          roster={roster}
          facts={facts}
          actions={actions}
        />
      )}
      {/* Not modal: a field an item focuses keeps the focus as the menu closes. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More for ${word}`}
            className="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56"
          onCloseAutoFocus={(e) => {
            if (focused.current) e.preventDefault();
            focused.current = false;
          }}
        >
          <DropdownMenuItem disabled={!canUp} onSelect={() => actions.reorder(step.id, -1)}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canDown} onSelect={() => actions.reorder(step.id, 1)}>
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              focused.current = true;
              actions.insertAfter(step.id);
            }}
          >
            Add Step after {word}
          </DropdownMenuItem>
          {workflows.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to Workflow</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {workflows
                  .filter((w) => w.id !== step.workflow_id)
                  .map((w) => (
                    <DropdownMenuItem
                      key={w.id}
                      onSelect={() => {
                        focused.current = true;
                        actions.moveToWorkflow(step.id, w.id);
                      }}
                    >
                      {w.name.trim() || "New Workflow"}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.deleteStep(step.id)}>
            Delete {word}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
