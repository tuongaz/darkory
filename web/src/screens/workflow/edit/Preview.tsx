import { useMemo } from "react";
import type { Skill } from "@/api/client";
import { lineTopology, WorkflowLine } from "@/components/workflowLine";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "../bind";
import { asLine, inOrder, type Group } from "./draft";

/**
 * The line the list makes, drawn above it while editing: the Workflow line itself, Steps by name
 * only and no Tasks, redrawn from the draft as it changes; what the draft changed (a new or
 * re-pointed outcome) amber and dashed. The Steps after a Parent are named under it.
 */
export function Preview({
  draft,
  base,
  skills,
  groups,
  onStep,
  className,
}: {
  draft: WorkflowRecord;
  base: WorkflowRecord;
  skills: Map<string, Pick<Skill, "name">>;
  groups: (s: RecordStep) => Group;
  /** Picks a Step clicked on the line. */
  onStep?: (id: string) => void;
  className?: string;
}) {
  const line = useMemo(() => asLine(draft, skills), [draft, skills]);
  const changed = useMemo(() => {
    const was = new Map(base.connectors.map((c) => [c.id, c]));
    return new Set(draft.connectors.filter((c) => !was.get(c.id) || was.get(c.id)!.to_step_id !== c.to_step_id || was.get(c.id)!.name !== c.name.trim()).map((c) => c.id));
  }, [draft, base]);
  const after = inOrder(draft.steps).filter((s) => groups(s) === "after");
  const baseIds = new Set(base.steps.map((s) => s.id));
  return (
    // A Step's name on the line picks it; the list beside is the keyboard's way to the same.
    <figure
      aria-label="Preview of the line"
      onClick={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-step]")?.dataset.step;
        if (id && onStep) onStep(id);
      }}
      className={cn("flex min-w-0 flex-col", onStep && "[&_[data-step]]:cursor-pointer [&_[data-step]:hover]:underline", className)}
    >
      <span role="img" aria-label={describe(line)} className="sr-only" />
      <WorkflowLine label="The line" workflow={line} tasks={[]} now={0} compactHeads noBranch noLoops density="tokens" highlight={changed} />
      {after.length > 0 && (
        <figcaption className="px-5 pb-2.5 text-xs text-muted-foreground">
          After a Parent ·{" "}
          {after.map((s, i) => {
            const prev = after[i - 1];
            const joined = prev && draft.connectors.some((c) => c.from_step_id === prev.id && c.to_step_id === s.id);
            return (
              <span key={s.id}>
                {i > 0 && (joined ? " → " : " · ")}
                <span className={cn(!baseIds.has(s.id) && "text-state-claimed")}>{s.name.trim() || "New Step"}</span>
              </span>
            );
          })}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * The line in words: "The line: Build → Review → Done. New Tasks start at Build. Break down: Plan,
 * whose Subtasks start at Build by default. Hold: Backlog, moved on by hand." → where a Connector joins
 * neighbours, · where none does.
 */
function describe(line: ReturnType<typeof asLine>): string {
  const t = lineTopology(line);
  const name = (id: string) => t.steps.get(id)?.name.trim() || (id === "done" ? "Done" : "New Step");
  const names = t.main.map(name);
  const parts = [`The line: ${names.map((n, i) => (i === 0 ? n : `${t.segments[i - 1].connector ? "→" : "·"} ${n}`)).join(" ")}.`];
  if (t.start) parts.push(`New Tasks start at ${name(t.start)}.`);
  if (t.before) parts.push(`Break down: ${name(t.before)}${t.start ? `, whose Subtasks start at ${name(t.start)} by default` : ""}.`);
  if (t.holds.length > 0) parts.push(`${t.holds.length === 1 ? "Hold" : "Holds"}: ${t.holds.map(name).join(", ")}, moved on by hand.`);
  return parts.join(" ");
}
