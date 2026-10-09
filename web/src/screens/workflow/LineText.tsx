import { ArrowRightIcon } from "lucide-react";
import { MemberAvatar } from "@/components/MemberAvatar";
import type { LineData, LineTask } from "@/components/workflowLine";
import { blockedBy, inProjectOrder, sideSteps, tokenState, tokenTime, type LineStepFacts } from "@/components/workflowLine/model";
import { spanText } from "@/lib/time";
import { breakdownSentence, ENTRY_LABEL, entryHint, holdSentence } from "@/components/workflowLine/words";
import { cn } from "@/lib/utils";

/**
 * The Workflow as a list, for a screen reader and a narrow window: each Step in order with who
 * takes its Tasks, its median, the Tasks at it now (held, waiting, blocked and by what, how long),
 * the scope's "+N" and the Connectors out of it; then the Steps after a Parent, and the questions
 * waiting with a Member at no Step. It says what the line draws: where new Tasks start, the
 * breakdown Step and what its Subtasks do, and that a hold's Tasks move on by hand. A Task opens
 * its peek. Of a Project of several Workflows it lists the one drawn: an outcome into another
 * names it ("bug → Bugs › Investigate"), and a Step Tasks reach from another says so ("from Triage
 * · bug").
 */
export function LineText({ data, now, onTask }: { data: LineData; now: number; onTask: (key: string) => void }) {
  const every = [...data.facts.steps].sort(inProjectOrder(data.facts.workflows));
  const drawn = data.drawnSteps;
  const steps = drawn ? every.filter((s) => drawn.has(s.id)) : every;
  const workflowOf = (id: string) => data.facts.workflows.find((w) => w.id === every.find((s) => s.id === id)?.workflow_id)?.name ?? "Another Workflow";
  const at = new Map<string, LineTask[]>();
  for (const t of data.scoped.drawn) at.set(t.stepId!, [...(at.get(t.stepId!) ?? []), t]);
  for (const list of at.values()) list.sort((a, b) => Number(!!b.holder) - Number(!!a.holder) || (a.since ?? 0) - (b.since ?? 0));
  const name = (to: string | null) => {
    if (to === null) return "Done";
    const s = every.find((x) => x.id === to);
    if (!s) return "a Step";
    return drawn && !drawn.has(s.id) ? `${workflowOf(s.id)} › ${s.name}` : s.name;
  };
  const questions = data.all.filter((t) => t.aimedAt && !t.stepId);
  const sides = sideSteps(data.facts);
  // Where New Tasks start, when it is on this list.
  const start = sides.start !== undefined && (!drawn || drawn.has(sides.start)) ? name(sides.start) : undefined;

  const row = (t: LineTask, s: LineStepFacts) => {
    const state = tokenState(t, !s.skill);
    const since = t.holder ? t.heldSince : t.since;
    const by = blockedBy(t);
    return (
      <li key={t.id}>
        <button
          type="button"
          onClick={() => onTask(t.key)}
          data-task={t.key}
          aria-label={`${t.key} ${t.title}, ${t.holder ? `held by ${t.holder.name}` : by ? `blocked ${by}` : state === "hold" ? "in the hold" : "waiting"}`}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {t.holder ? (
            <MemberAvatar member={t.holder} working={t.holder.working} />
          ) : (
            <span aria-hidden className={cn("size-3.5 flex-none rounded-full border-[1.5px]", state === "blocked" ? "border-state-blocked" : state === "hold" ? "border-dashed border-muted-foreground" : "border-state-waiting")} />
          )}
          <span className="flex-none font-mono text-[11.5px] font-medium">{t.key}</span>
          <span className="min-w-0 truncate">{t.title}</span>
          <span className="ml-auto flex flex-none items-center gap-2 text-muted-foreground">
            {by && <span className="font-medium text-state-blocked">{by}</span>}
            {t.holder && <span>{t.holder.name}</span>}
            {since !== undefined && <span className="tabular-nums">{tokenTime(now - since)}</span>}
          </span>
        </button>
      </li>
    );
  };

  const step = (s: LineStepFacts, i: number) => {
    const list = at.get(s.id) ?? [];
    const hidden = data.scoped.hidden.get(s.id) ?? 0;
    const out = data.facts.connectors.filter((c) => c.from === s.id).sort((a, b) => a.position - b.position);
    const entries = drawn ? data.facts.connectors.filter((c) => c.to === s.id && !drawn.has(c.from)) : [];
    return (
      <li key={s.id} className={cn("rounded-lg border bg-card", !s.skill && "border-dashed")}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-3 pt-2.5 pb-1.5">
          <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="truncate font-semibold">{s.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{s.skill?.name ?? "hold"}</span>
          {s.id === sides.start && <span className="rounded-full border px-1.5 text-[11px] leading-4 font-medium">{ENTRY_LABEL}</span>}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {list.length} {list.length === 1 ? "Task" : "Tasks"}
            {hidden > 0 && ` · +${hidden} outside the scope`}
            {s.medianMs !== undefined && ` · median ${spanText(s.medianMs)}`}
          </span>
        </div>
        {entries.length > 0 && (
          <ul aria-label={`Into ${s.name} from other Workflows`} className="flex flex-wrap gap-x-4 gap-y-0.5 px-3 pb-1.5 text-xs text-muted-foreground">
            {entries.map((c) => (
              <li key={c.id}>
                from {workflowOf(c.from)} · {c.name}
              </li>
            ))}
          </ul>
        )}
        {(!s.skill || sides.before.has(s.id)) && <p className="px-3 pb-1.5 text-xs text-muted-foreground">{s.skill ? breakdownSentence(start) : holdSentence()}</p>}
        {list.length > 0 && (
          <ul aria-label={`Tasks at ${s.name}`} className="flex flex-col border-t px-1.5 py-1">
            {list.map((t) => row(t, s))}
          </ul>
        )}
        {out.length > 0 && (
          <ul aria-label={`Connectors out of ${s.name}`} className="flex flex-wrap gap-x-4 gap-y-0.5 border-t px-3 py-1.5 text-xs">
            {out.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <span className="font-medium">{c.name}</span>
                <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
                <span className="text-muted-foreground">{name(c.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-5 sm:px-6">
      {steps.length === 0 && <p className="text-muted-foreground">No Steps yet: nothing can be filed in this Project.</p>}
      {start && <p className="text-sm">{entryHint(start)}.</p>}
      <ol aria-label="Steps" className="flex flex-col gap-2">
        {steps.map(step)}
        <li className="flex items-center gap-2 rounded-lg border px-3 py-2.5">
          <span aria-hidden className="size-3.5 rounded-full bg-state-done" />
          <span className="font-semibold">Done</span>
          {data.doneToday !== undefined && <span className="ml-auto text-xs text-muted-foreground">{data.doneToday} today</span>}
        </li>
      </ol>
      {questions.length > 0 && (
        <section aria-label="With a Member" className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">With a Member, at no Step</h3>
          <ul className="flex flex-col rounded-lg border px-1.5 py-1">
            {questions.map((q) => (
              <li key={q.id}>
                <button type="button" onClick={() => onTask(q.key)} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent">
                  {q.aimedAt && <MemberAvatar member={q.aimedAt} />}
                  <span className="flex-none font-mono text-[11.5px] font-medium">{q.key}</span>
                  <span className="min-w-0 truncate">{q.title}</span>
                  <span className="ml-auto flex-none text-muted-foreground">With {q.aimedAt?.id === data.me.id ? "you" : q.aimedAt?.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">A Task advanced into Done is complete. Its Owner drops it from any Step, into Dropped.</p>
    </div>
  );
}
