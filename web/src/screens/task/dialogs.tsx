import { useMutation } from "@tanstack/react-query";
import { HeartPulseIcon, LinkIcon, MessageSquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, call, type TaskDetail } from "@/api/client";
import { useDirectory, useOpenTasks } from "@/api/queries";
import { useNow } from "@/clock";
import { FormDialog } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { StatusGlyph } from "@/components/StatusGlyph";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { statusGlyph, useMemberName, useSkillName } from "./format";
import { Avatar } from "./parts";
import { useSkillDetail, useStatuses, useTakers } from "./queries";

type DialogProps = { detail: TaskDetail; open: boolean; onOpenChange: (open: boolean) => void };

/** A field as the dialogs draw it: the label over the control, "optional" beside it, a line of help under it. */
export function Field({ label, htmlFor, optional, help, children }: { label: string; htmlFor?: string; optional?: boolean; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-[12.5px] font-medium">
        {label}
        {optional && <span className="font-normal text-muted-foreground">optional</span>}
      </Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

/** What a confirm will do, one consequence per line (Take back, Drop). */
function Consequences({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-2.5">{children}</ul>;
}

function Consequence({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2.5">
      <span className="grid size-5 flex-none place-items-center text-muted-foreground [&_svg]:size-3.5">{mark}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** The first Status of a kind: where Darkory moves a Task on its own acts. */
function useFirstOf(kind: "todo") {
  const statuses = useStatuses().data;
  return { status: statuses?.find((s) => s.kind === kind), statuses };
}

function done(title: string, onOpenChange: (open: boolean) => void) {
  return () => {
    toast.success(title);
    onOpenChange(false);
  };
}

export function CompleteDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, proposal } = detail;
  const skill = useSkillName();
  const [note, setNote] = useState("");
  const complete = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.id } }, body: { note: note.trim() || undefined } })),
    onSuccess: done(`${task.key} completed`, onOpenChange),
  });
  // Completing a review that carries a pending proposal publishes it.
  const publishes = proposal?.state === "pending" && skill(task.skill_id) === "skill-review";
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Complete ${task.key}`}
      description={task.title}
      hint={publishes ? `Publishes ${skill(proposal.skill_id)} version ${proposal.based_on_version + 1}` : `${task.key} ends Done`}
      submitLabel="Complete"
      onSubmit={() => complete.mutate()}
      pending={complete.isPending}
      error={complete.error}
    >
      <Field label="Note" htmlFor="complete-note" optional>
        <Textarea id="complete-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you did, for the record" />
      </Field>
    </FormDialog>
  );
}

const unchanged = "unchanged";

export function HandOverDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, status } = detail;
  const { skillList } = useDirectory();
  const statuses = useStatuses().data;
  const [skill, setSkill] = useState("");
  const [next, setNext] = useState(unchanged);
  const [note, setNote] = useState("");
  const handover = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/handover", {
          params: { path: { task: task.id } },
          body: { skill, note: note.trim() || undefined, status: next === unchanged ? undefined : next },
        }),
      ),
    onSuccess: done(`${task.key} handed over`, onOpenChange),
  });
  const choices = (statuses ?? []).filter((s) => s.kind === "backlog" || s.kind === "todo" || s.kind === "in_progress");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Hand over ${task.key}`}
      description={task.title}
      hint={`Ends your Claim on ${task.key}`}
      submitLabel="Hand over"
      submitDisabled={!skill}
      onSubmit={() => handover.mutate()}
      pending={handover.isPending}
      error={handover.error}
    >
      <Field label="Skill it needs next" htmlFor="handover-skill" help={skill ? <TakersLine detail={detail} skillId={skill} /> : undefined}>
        <Select value={skill} onValueChange={setSkill}>
          <SelectTrigger id="handover-skill" className="w-full">
            <SelectValue placeholder="Choose a Skill" />
          </SelectTrigger>
          <SelectContent>
            {skillList.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Status after hand over" htmlFor="handover-status">
        <Select value={next} onValueChange={setNext}>
          <SelectTrigger id="handover-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={unchanged}>
              <StatusGlyph glyph={statusGlyph(status, statuses)} label="" />
              {status.name}
              <span className="text-muted-foreground">· unchanged</span>
            </SelectItem>
            {choices
              .filter((s) => s.id !== status.id)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <StatusGlyph glyph={statusGlyph(s, statuses)} label="" />
                  {s.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Note" htmlFor="handover-note" optional>
        <Textarea id="handover-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For whoever works the Task next" />
      </Field>
    </FormDialog>
  );
}

/** "Takeable by reviewer, tuongaz": who could take the Task after a Handover to `skillId`. */
function TakersLine({ detail, skillId }: { detail: TaskDetail; skillId: string }) {
  const ids = useTakers(detail, skillId);
  const name = useMemberName();
  if (!ids) return <>Finding who has it…</>;
  if (!ids.length) return <>Nobody could take it</>;
  return <>Takeable by {ids.map(name).join(", ")}</>;
}

export function ReleaseDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, status } = detail;
  const todo = useFirstOf("todo").status;
  const [note, setNote] = useState("");
  const release = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/release", { params: { path: { task: task.id } }, body: { note: note.trim() || undefined } })),
    onSuccess: done(`${task.key} released`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Release ${task.key}`}
      description={task.title}
      hint={status.kind === "in_progress" && todo ? `Status → ${todo.name}` : `Ends your Claim on ${task.key}`}
      submitLabel="Release"
      onSubmit={() => release.mutate()}
      pending={release.isPending}
      error={release.error}
    >
      <Field label="Note" htmlFor="release-note" optional>
        <Textarea id="release-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For whoever works the Task next" />
      </Field>
    </FormDialog>
  );
}

/** F-T4: ends another Member's Claim, listing what happens as the record will show it. */
export function TakeBackDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, status, notes } = detail;
  const now = useNow();
  const claim = liveClaim(task, now);
  const name = useMemberName();
  const { status: todo, statuses } = useFirstOf("todo");
  const [reason, setReason] = useState("");
  const takeBack = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/take-back", { params: { path: { task: task.id } }, body: { reason: reason.trim() || undefined } })),
    onSuccess: done(`${task.key} taken back`, onOpenChange),
  });
  const blockers = detail.blockers.filter((b) => b.state === "open");
  const moves = status.kind === "in_progress" && todo;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Take back ${task.key}?`}
      description={task.title}
      submitLabel="Take back"
      onSubmit={() => takeBack.mutate()}
      pending={takeBack.isPending}
      error={takeBack.error}
    >
      <Consequences>
        {claim && <Consequence mark={<Avatar id={claim.holder_id} />}>{name(claim.holder_id)}&apos;s Claim ends now</Consequence>}
        <Consequence mark={<StatusGlyph glyph={moves ? statusGlyph(todo, statuses) : statusGlyph(status, statuses)} label="" />}>
          {moves ? `Status → ${todo.name}` : `Status stays ${status.name}`}
        </Consequence>
        {claim?.heartbeat_timeout_seconds ? <Consequence mark={<HeartPulseIcon />}>Its next Heartbeat answers taken back</Consequence> : null}
        {blockers.length > 0 && (
          <Consequence mark={<LinkIcon />}>
            {task.key} stays Blocked by {blockers.map((b) => b.key).join(", ")}
          </Consequence>
        )}
        {notes.length > 0 && (
          <Consequence mark={<MessageSquareIcon />}>
            {notes.length === 1 ? "Its Note stays" : "Its Notes stay"} on {task.key}
          </Consequence>
        )}
      </Consequences>
      <Field label="Reason" htmlFor="take-back-reason" optional>
        <Textarea id="take-back-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you took it back" />
      </Field>
    </FormDialog>
  );
}

export function DropTaskDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, proposal } = detail;
  const now = useNow();
  const claim = liveClaim(task, now);
  const name = useMemberName();
  const [reason, setReason] = useState("");
  const drop = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/drop", { params: { path: { task: task.id } }, body: { reason: reason.trim() || undefined } })),
    onSuccess: done(`${task.key} dropped`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Drop ${task.key}?`}
      description={task.title}
      submitLabel="Drop Task"
      destructive
      onSubmit={() => drop.mutate()}
      pending={drop.isPending}
      error={drop.error}
    >
      <Consequences>
        <Consequence mark={<StatusGlyph glyph="dropped" label="" />}>{task.key} ends Dropped</Consequence>
        {claim && <Consequence mark={<Avatar id={claim.holder_id} />}>{name(claim.holder_id)}&apos;s Claim ends</Consequence>}
        {proposal?.state === "pending" && <Consequence mark={<MessageSquareIcon />}>Its proposal is not published</Consequence>}
      </Consequences>
      <Field label="Reason" htmlFor="drop-reason" optional>
        <Textarea id="drop-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it will not be done" />
      </Field>
    </FormDialog>
  );
}

export function ObserveDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const skill = useSkillName();
  const [outcome, setOutcome] = useState<"worked" | "didnt_work">("worked");
  const [body, setBody] = useState("");
  const observe = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/observations", { params: { path: { task: task.id } }, body: { outcome, body: body.trim() } })),
    onSuccess: done(`Observation recorded on ${task.key}`, onOpenChange),
  });
  const under = skill(task.claim?.skill_id);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Observation on ${task.key}`}
      description={task.title}
      hint={under ? `Recorded under ${under}` : undefined}
      submitLabel="Record"
      submitDisabled={!body.trim()}
      onSubmit={() => observe.mutate()}
      pending={observe.isPending}
      error={observe.error}
    >
      <Field label="Outcome">
        <div role="radiogroup" aria-label="Outcome" className="inline-flex w-fit rounded-md bg-muted p-0.5">
          {(
            [
              ["worked", "Worked"],
              ["didnt_work", "Didn't work"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={outcome === value}
              onClick={() => setOutcome(value)}
              className={cn(
                "h-7 cursor-pointer rounded-[5px] px-3 text-muted-foreground",
                outcome === value && "bg-background font-medium text-foreground shadow-soft",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="What happened" htmlFor="observe-body">
        <Textarea id="observe-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="For the Feature's Retrospective" />
      </Field>
    </FormDialog>
  );
}

/** Lets another Task block this one: a question already filed, or work it waits on. */
export function BlockerDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const tasks = useOpenTasks();
  const [chosen, setChosen] = useState<{ id: string; key: string } | null>(null);
  const add = useMutation({
    mutationFn: (blocker: string) => call(api.PUT("/v1/tasks/{task}/blockers/{blocker}", { params: { path: { task: task.id, blocker } } })),
    onSuccess: done(`${task.key} is blocked by ${chosen?.key}`, onOpenChange),
  });
  const already = new Set([task.id, ...detail.blockers.map((b) => b.id)]);
  const choices = (tasks.data ?? []).filter((t) => !already.has(t.id));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add blocker to ${task.key}`}
      description={task.title}
      hint={chosen ? `${task.key} waits until ${chosen.key} ends` : undefined}
      submitLabel="Add blocker"
      submitDisabled={!chosen}
      onSubmit={() => chosen && add.mutate(chosen.id)}
      pending={add.isPending}
      error={add.error}
      size="md"
    >
      <Command className="rounded-md border" label="Blocked by">
        <CommandInput placeholder="Find an open Task by key or title" />
        <CommandList className="max-h-56">
          <CommandEmpty>No open Task matches.</CommandEmpty>
          {choices.map((t) => (
            <CommandItem
              key={t.id}
              value={`${t.key} ${t.title}`}
              onSelect={() => setChosen({ id: t.id, key: t.key })}
              data-checked={chosen?.id === t.id}
              className="data-[checked=true]:bg-accent"
            >
              <Key>{t.key}</Key>
              <span className="truncate">{t.title}</span>
              {chosen?.id === t.id && (
                <Pill tone="waiting" className="ml-auto">
                  Chosen
                </Pill>
              )}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </FormDialog>
  );
}

/** A Retrospective's proposal for a company Skill: the current text, edited, for skill-review to publish. */
export function ProposeDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const { skillList } = useDirectory();
  const company = skillList.filter((s) => s.kind === "company");
  const [skill, setSkill] = useState(detail.proposal?.skill_id ?? "");
  const [body, setBody] = useState<string | null>(null);
  const current = useSkillDetail(skill || undefined).data?.current;
  const propose = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/skill-proposals", {
          params: { path: { task: task.id } },
          body: { skill, based_on_version: current!.version, body: body ?? current!.body },
        }),
      ),
    onSuccess: () => {
      toast.success("Proposal written", { description: "Hand it over to skill-review next" });
      onOpenChange(false);
    },
  });
  const text = body ?? current?.body ?? "";
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Propose a Skill version"
      description={task.title}
      hint={current ? `Against version ${current.version}` : undefined}
      submitLabel="Propose"
      submitDisabled={!current || text === current.body}
      onSubmit={() => propose.mutate()}
      pending={propose.isPending}
      error={propose.error}
      size="lg"
    >
      <Field label="Skill" htmlFor="propose-skill">
        <Select
          value={skill}
          onValueChange={(s) => {
            setSkill(s);
            setBody(null);
          }}
        >
          <SelectTrigger id="propose-skill" className="w-full">
            <SelectValue placeholder="Choose a company Skill" />
          </SelectTrigger>
          <SelectContent>
            {company.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Text" htmlFor="propose-body">
        <Textarea
          id="propose-body"
          value={text}
          onChange={(e) => setBody(e.target.value)}
          disabled={!current}
          className="max-h-80 min-h-40 font-mono text-xs"
        />
      </Field>
    </FormDialog>
  );
}
