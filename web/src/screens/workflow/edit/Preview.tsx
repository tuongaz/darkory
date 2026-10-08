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
  className,
}: {
  draft: WorkflowRecord;
  base: WorkflowRecord;
  skills: Map<string, Pick<Skill, "name">>;
  groups: (s: RecordStep) => Group;
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
    <figure aria-label="Preview of the line" className={cn("flex min-w-0 flex-col", className)}>
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

/** The main line in words: "The line: Backlog · Plan · Build → Review → Done", → where a Connector joins neighbours. */
function describe(line: ReturnType<typeof asLine>): string {
  const t = lineTopology(line);
  const names = t.main.map((id) => (t.steps.get(id)?.name.trim() || (id === "done" ? "Done" : "New Step")));
  return `The line: ${names.map((name, i) => (i === 0 ? name : `${t.segments[i - 1].connector ? "→" : "·"} ${name}`)).join(" ")}`;
}
