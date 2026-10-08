import { CheckIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { useDirectory, useWorkflow } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { ProjectMark } from "@/components/ProjectMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { TaskGlyph } from "@/screens/inbox/parts";
import { liveClaim } from "@/work";
import { useAnswer, useComplete, useMoveTo, useResume, useTake } from "./acts";
import { actLabel, consequence, type NeedItem } from "./needs";
import { ageText } from "@/lib/time";

/** What a card tells its list when a question was answered: the green line that stands in for it a moment. */
export type Answered = { key: string; unblocks: string[]; at: string };

/**
 * One decision as a card (kit `.nc`): its age large with what the age counts (asked, held,
 * waiting, ready, lapsed), the Task's title in full, its key and why it is with me, what acting on
 * it unblocks, and its one act. A question carries its answer box, which claims, adds the answer
 * as a Note and completes it in one submit, and says in the card why when any step is refused,
 * keeping the words typed. `project` puts the Project's mark before the key, for the Inbox.
 */
export function NeedCard({
  item,
  primary,
  project,
  className,
  onHover,
  onAnswered,
}: {
  item: NeedItem;
  primary?: boolean;
  project?: Project;
  className?: string;
  onHover?: (taskId: string | null) => void;
  onAnswered?: (answered: Answered) => void;
}) {
  const now = useNow();
  const peek = usePeekLink();
  const meId = useCurrentMe().member.id;
  const t = item.task;
  const hover = onHover && {
    onMouseEnter: () => onHover(t.id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(t.id),
    onBlur: () => onHover(null),
  };
  return (
    <article
      data-need={t.key}
      data-act={item.act}
      aria-label={`${t.key} ${t.title}`}
      {...hover}
      className={cn(
        "grid grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg border bg-card px-3 py-2 text-card-foreground max-sm:grid-cols-[56px_minmax(0,1fr)_auto] max-sm:px-2.5",
        className,
      )}
    >
      <div className="row-span-2 self-start leading-none">
        <b className="block text-base leading-5 font-semibold whitespace-nowrap tabular-nums max-sm:text-[15px]">{ageText(now - Date.parse(item.since))}</b>
        <span className="mt-px block text-[10.5px] text-muted-foreground">{item.ageLabel}</span>
      </div>
      <div className="flex min-w-0 items-start gap-[7px]">
        <span className="mt-0.5 max-sm:hidden">
          <TaskGlyph task={t} />
        </span>
        <Link
          to={peek(t.key)}
          className={cn("min-w-0 leading-[17px] font-medium underline-offset-2 outline-none hover:underline focus-visible:underline", item.act === "answer" && "text-[13.5px] leading-[18px]")}
        >
          {t.title}
        </Link>
      </div>
      <p className="col-start-2 min-w-0 pl-[21px] text-[11.5px] leading-[15px] text-muted-foreground max-sm:pl-0">
        {project && <ProjectMark project={project} className="mr-1 align-[-2px]" />}
        <Key>{t.key}</Key> · {item.why}
      </p>
      <div className="col-start-3 row-span-2 row-start-1 flex flex-col items-end gap-[5px]">
        {consequence(item) && <span className="text-[11.5px] font-medium whitespace-nowrap text-state-waiting">{consequence(item)}</span>}
        {item.act !== "answer" && <ActButton item={item} primary={primary} />}
      </div>
      {item.act === "answer" && <AnswerBox item={item} primary={primary} holdsIt={liveClaim(t, now)?.holder_id === meId} onAnswered={onAnswered} />}
    </article>
  );
}

/** The answer box: one submit claims, notes and completes; a refusal shows here and keeps the words. */
function AnswerBox({ item, primary, holdsIt, onAnswered }: { item: NeedItem; primary?: boolean; holdsIt: boolean; onAnswered?: (a: Answered) => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const answer = useAnswer(item.task, holdsIt, () => onAnswered?.({ key: item.task.key, unblocks: item.unblocks.map((u) => u.key), at: new Date().toISOString() }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) answer.mutate(text.trim());
    else box.current?.focus();
  };
  return (
    <form onSubmit={submit} className="col-span-2 col-start-2 mt-1.5 flex flex-col gap-1.5 pl-[21px] max-sm:col-span-3 max-sm:col-start-1 max-sm:pl-0">
      <div className="flex gap-2">
        <Input
          ref={box}
          aria-label={`Your answer to ${item.task.key}`}
          placeholder="Your answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={answer.isPending}
          aria-invalid={answer.isError || undefined}
          className={cn("h-8 flex-1", answer.isError && "border-state-blocked")}
        />
        <Button type="submit" variant={primary ? "default" : "outline"} disabled={answer.isPending}>
          Answer
        </Button>
      </div>
      {answer.error && (
        <p role="alert" className="flex items-baseline gap-2 text-xs text-state-blocked">
          <code className="rounded-sm bg-state-blocked-bg px-1">{answer.error.code}</code>
          <span>{answer.error.message}</span>
        </p>
      )}
    </form>
  );
}

/** A decision's one button, outside the answer box: on a card, and on the Inbox's row. */
export function ActButton({ item, primary }: { item: NeedItem; primary?: boolean }) {
  // Above a row's link, which covers the row.
  return <span className="relative z-10">{act(item, primary)}</span>;
}

function act(item: NeedItem, primary?: boolean) {
  const variant = primary ? "default" : "outline";
  const label = actLabel(item);
  const aria = `${label} ${item.task.key}`;
  switch (item.act) {
    case "complete":
      return <CompleteAct item={item} variant={variant} aria={aria} />;
    case "take":
      return <TakeAct item={item} variant={variant} aria={aria} />;
    case "resume":
      return <ResumeAct item={item} variant={variant} aria={aria} label={label} />;
    case "move":
      return <MoveAct item={item} variant={variant} aria={aria} />;
    default:
      return <ReviewAct item={item} variant={variant} aria={aria} label={label} />;
  }
}

type ActProps = { item: NeedItem; variant: "default" | "outline"; aria: string };

function CompleteAct({ item, variant, aria }: ActProps) {
  const complete = useComplete(item.task);
  return (
    <Button size="sm" variant={variant} aria-label={aria} disabled={complete.isPending} onClick={() => complete.mutate()}>
      Complete
    </Button>
  );
}

function TakeAct({ item, variant, aria }: ActProps) {
  const take = useTake(item.task);
  return (
    <Button size="sm" variant={variant} aria-label={aria} disabled={take.isPending} onClick={() => take.mutate()}>
      Take
    </Button>
  );
}

function ResumeAct({ item, variant, aria, label }: ActProps & { label: string }) {
  const resume = useResume(item.agents ?? []);
  return (
    <Button size="sm" variant={variant} aria-label={aria} disabled={resume.isPending} onClick={() => resume.mutate()}>
      {label}
    </Button>
  );
}

function ReviewAct({ item, variant, aria, label }: ActProps & { label: string }) {
  const peek = usePeekLink();
  return (
    <Button asChild size="sm" variant={variant}>
      <Link to={peek(item.task.key)} aria-label={aria}>
        {label}
      </Link>
    </Button>
  );
}

/** Move on: the Steps of the Task's Workflow to move it to, by hand. */
function MoveAct({ item, variant, aria }: ActProps) {
  const [open, setOpen] = useState(false);
  const { projects } = useDirectory();
  const key = projects.get(item.task.project_id)?.key;
  const workflow = useWorkflow(open ? key : undefined);
  const move = useMoveTo(item.task);
  const steps = (workflow.data?.steps ?? []).filter((s) => s.id !== item.task.step_id);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={variant} aria-label={aria} disabled={move.isPending}>
          Move on
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Move {item.task.key} to</p>
        <ul aria-label={`Steps to move ${item.task.key} to`}>
          {workflow.isPending && <li className="px-2 py-1.5 text-xs text-muted-foreground">Reading the Steps…</li>}
          {steps.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => {
                  setOpen(false);
                  move.mutate({ id: s.id, name: s.name });
                }}
              >
                <span className="truncate font-medium">{s.name}</span>
                {!s.skill_id && <span className="ml-auto text-2xs text-muted-foreground">hold</span>}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The line that stands in for an answered question a moment: "Answered MAIN-13 · MAIN-4 waiting". */
export function AnsweredLine({ answered, children }: { answered: Answered; children?: ReactNode }) {
  const at = new Date(answered.at);
  return (
    <div role="status" className="flex h-9 items-center gap-2 rounded-lg bg-state-done-bg px-3 text-[12.5px]">
      <span className="grid size-3.5 place-items-center rounded-full bg-state-done">
        <CheckIcon className="size-[9px] text-on-solid" strokeWidth={3} aria-hidden />
      </span>
      <span className="font-medium">Answered</span>
      <Key>{answered.key}</Key>
      {answered.unblocks.length > 0 && <span className="text-muted-foreground">· {answered.unblocks.join(", ")} waiting</span>}
      <time dateTime={answered.at} className="ml-auto text-xs text-muted-foreground tabular-nums">
        {at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}
      </time>
      {children}
    </div>
  );
}
