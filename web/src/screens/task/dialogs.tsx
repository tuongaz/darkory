import { useMutation } from "@tanstack/react-query";
import { ArrowRightIcon, FileTextIcon, HeartPulseIcon, LinkIcon, MessageSquareIcon, UsersIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, ApiError, call, type Connector, type RunnerSession, type TaskDetail } from "@/api/client";
import { useDirectory, useOpenTasks, useTasks } from "@/api/queries";
import { useNow } from "@/clock";
import { FormDialog } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { WorkGlyph } from "@/components/WorkGlyph";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { Combobox } from "../board/Combobox";
import { isParent, stepWithSkill } from "../board/derive";
import { useMemberName, useSkillName } from "./format";
import { Avatar } from "./parts";
import { useSkillDetail, useTaskWorkflow } from "./queries";

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

/** What a confirm will do, one consequence per line (Take back, Drop, Move). */
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

function done(title: string, onOpenChange: (open: boolean) => void) {
  return () => {
    toast.success(title);
    onOpenChange(false);
  };
}

function NoteField({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <Field label="Note" htmlFor={id} optional>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
  );
}

/** A refusal of an advance or Complete reworded where it names what to do instead. */
function advanceRefusal(err: unknown, key: string): unknown {
  if (!(err instanceof ApiError)) return err;
  const outcomes = err.detailList("outcomes");
  if ((err.code === "no_connector" || err.code === "use_advance") && outcomes.length) {
    return new ApiError(err.status, err.code, `${key} leaves its Step along one of: ${outcomes.join(", ")}.`, err.details);
  }
  if (err.code === "proposal_stale") {
    return new ApiError(err.status, err.code, `A proposal was written against a version that is no longer current; ${key} went back with the refusal as its Note.`, err.details);
  }
  return err;
}

/**
 * The holder ends their work along a Connector: into a Step, where the Task waits for whoever has
 * its Skill, or into Done, which completes it. A Note goes with it.
 */
export function AdvanceDialog({ detail, connector, open, onOpenChange }: DialogProps & { connector: Connector }) {
  const { task } = detail;
  const { steps } = useTaskWorkflow(detail.task.project_id);
  const skill = useSkillName();
  const [note, setNote] = useState("");
  const to = connector.to_step_id ? steps.find((s) => s.id === connector.to_step_id) : undefined;
  const intoDone = !connector.to_step_id;
  const advance = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/advance", { params: { path: { task: task.id } }, body: { outcome: connector.name, note: note.trim() || undefined } })),
    onSuccess: done(intoDone ? `${task.key} completed` : `${task.key} advanced to ${to?.name ?? "its next Step"}`, onOpenChange),
  });
  const pending = detail.proposals.filter((p) => p.state === "pending");
  const publishes = intoDone && skill(task.skill_id) === "skill-review" && pending.length > 0;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intoDone ? `Complete ${task.key} · ${connector.name}` : `Advance ${task.key} · ${connector.name}`}
      description={task.title}
      hint={
        publishes
          ? `Publishes ${pending.map((p) => skill(p.skill_id)).join(", ")}`
          : intoDone
            ? `${task.key} ends Done`
            : `Waits at ${to?.name ?? "the next Step"}${to?.skill_id ? ` for ${skill(to.skill_id)}` : ""}; your Claim ends`
      }
      submitLabel={intoDone ? "Complete" : "Advance"}
      onSubmit={() => advance.mutate()}
      pending={advance.isPending}
      error={advanceRefusal(advance.error, task.key)}
    >
      <NoteField id="advance-note" value={note} onChange={setNote} placeholder={intoDone ? "What you did, for the record" : "For whoever works the Task next"} />
    </FormDialog>
  );
}

/** Completes a Task aimed at its holder (at no Step), or a Parent by its Owner once every Subtask has ended. */
export function CompleteDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const { steps } = useTaskWorkflow(detail.task.project_id);
  const skill = useSkillName();
  const [note, setNote] = useState("");
  const complete = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.id } }, body: { note: note.trim() || undefined } })),
    onSuccess: done(`${task.key} completed`, onOpenChange),
  });
  const retro = isParent(task) ? stepWithSkill(steps, "retro", (id) => skill(id)) : undefined;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Complete ${task.key}`}
      description={task.title}
      hint={retro ? `${task.key} ends Done; its Retrospective is filed at ${retro.name}` : `${task.key} ends Done`}
      submitLabel="Complete"
      onSubmit={() => complete.mutate()}
      pending={complete.isPending}
      error={advanceRefusal(complete.error, task.key)}
    >
      <NoteField id="complete-note" value={note} onChange={setNote} placeholder="What was done, for the record" />
    </FormDialog>
  );
}

export function ReleaseDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
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
      hint={`Ends your Claim; ${task.key} stays where it is`}
      submitLabel="Release"
      onSubmit={() => release.mutate()}
      pending={release.isPending}
      error={release.error}
    >
      <NoteField id="release-note" value={note} onChange={setNote} placeholder="For whoever works the Task next" />
    </FormDialog>
  );
}

/** Moves the Task to any Step by hand; moving a held Task ends the Claim, as a take-back would. */
export function MoveDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const now = useNow();
  const name = useMemberName();
  const skill = useSkillName();
  const { steps } = useTaskWorkflow(detail.task.project_id);
  const claim = liveClaim(task, now);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const target = steps.find((s) => s.id === to);
  const move = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/step", { params: { path: { task: task.id } }, body: { step: to, note: note.trim() || undefined } })),
    onSuccess: done(`${task.key} moved to ${target?.name}`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${task.key}`}
      description={task.title}
      hint={claim ? `Ends ${name(claim.holder_id)}'s Claim` : task.aimed_at_id ? `Waits at the Step instead of with ${name(task.aimed_at_id)}` : undefined}
      submitLabel="Move"
      submitDisabled={!to}
      onSubmit={() => move.mutate()}
      pending={move.isPending}
      error={move.error}
    >
      <Field label="Step" htmlFor="move-step" help={target ? (target.skill_id ? `Waits there for ${skill(target.skill_id)}` : "A hold: no one is offered it there") : undefined}>
        <Select value={to} onValueChange={setTo}>
          <SelectTrigger id="move-step" className="w-full">
            <SelectValue placeholder="Choose a Step" />
          </SelectTrigger>
          <SelectContent>
            {steps
              .filter((s) => s.id !== task.step_id)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                  <span className="text-xs text-muted-foreground">{s.skill_id ? skill(s.skill_id) : "hold"}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
      <NoteField id="move-note" value={note} onChange={setNote} placeholder="Why it moves" />
    </FormDialog>
  );
}

/** Ends another Member's Claim, listing what happens as the record will show it. */
export function TakeBackDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, notes, step } = detail;
  const now = useNow();
  const claim = liveClaim(task, now);
  const name = useMemberName();
  const [reason, setReason] = useState("");
  const takeBack = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/take-back", { params: { path: { task: task.id } }, body: { reason: reason.trim() || undefined } })),
    onSuccess: done(`${task.key} taken back`, onOpenChange),
  });
  const blockers = detail.blockers.filter((b) => b.state === "open");
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
        <Consequence mark={<ArrowRightIcon />}>{step ? `It stays at ${step.name}, takeable again` : "It stays where it is, takeable again"}</Consequence>
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

/** An admin ends the Runner's session on the Task: the Runner releases the Claim with a Note. */
export function StopSessionDialog({ detail, session, open, onOpenChange }: DialogProps & { session: RunnerSession }) {
  const { task, step } = detail;
  const name = useMemberName();
  const stop = useMutation({
    mutationFn: () => call(api.POST("/v1/runner/sessions/{task}/stop", { params: { path: { task: task.id } } })),
    onSuccess: done(`The session on ${task.key} is stopping`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Stop the session on ${task.key}?`}
      description={task.title}
      submitLabel="Stop session"
      destructive
      onSubmit={() => stop.mutate()}
      pending={stop.isPending}
      error={stop.error}
    >
      <Consequences>
        <Consequence mark={<Avatar id={session.member_id} />}>{name(session.member_id)}&apos;s session ends now</Consequence>
        <Consequence mark={<MessageSquareIcon />}>Its Claim is released, with a Note saying so</Consequence>
        <Consequence mark={<ArrowRightIcon />}>{step ? `It stays at ${step.name}` : "It stays where it is"}</Consequence>
        <Consequence mark={<FileTextIcon />}>The session&apos;s log is attached as Evidence</Consequence>
      </Consequences>
    </FormDialog>
  );
}

export function DropTaskDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const now = useNow();
  const claim = liveClaim(task, now);
  const name = useMemberName();
  const { steps } = useTaskWorkflow(detail.task.project_id);
  const skill = useSkillName();
  const [reason, setReason] = useState("");
  const drop = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/drop", { params: { path: { task: task.id } }, body: { reason: reason.trim() || undefined } })),
    onSuccess: done(`${task.key} dropped`, onOpenChange),
  });
  const openSubtasks = detail.subtasks.filter((s) => s.state === "open");
  const retro = isParent(task) ? stepWithSkill(steps, "retro", (id) => skill(id)) : undefined;
  const pending = detail.proposals.filter((p) => p.state === "pending");
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
        <Consequence mark={<WorkGlyph glyph={{ glyph: "dropped" }} />}>{task.key} ends Dropped</Consequence>
        {openSubtasks.length > 0 && (
          <Consequence mark={<UsersIcon />}>
            {openSubtasks.length === 1 ? "Its open Subtask is" : `Its ${openSubtasks.length} open Subtasks are`} dropped with it
          </Consequence>
        )}
        {claim && <Consequence mark={<Avatar id={claim.holder_id} />}>{name(claim.holder_id)}&apos;s Claim ends</Consequence>}
        {retro && <Consequence mark={<FileTextIcon />}>Its Retrospective is filed at {retro.name}</Consequence>}
        {pending.length > 0 && <Consequence mark={<MessageSquareIcon />}>Its proposals are not published</Consequence>}
      </Consequences>
      <Field label="Reason" htmlFor="drop-reason" optional>
        <Textarea id="drop-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it will not be done" />
      </Field>
    </FormDialog>
  );
}

/** Makes another Member the Owner of a Task with no Parent, and of its Subtasks. */
export function PassOwnershipDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task, subtasks } = detail;
  const { memberList } = useDirectory();
  const [owner, setOwner] = useState<string>();
  const name = useMemberName();
  const pass = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/owner", { params: { path: { task: task.id } }, body: { owner: owner! } })),
    onSuccess: done(`${name(owner)} owns ${task.key}`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Pass ownership of ${task.key}`}
      description={task.title}
      hint={subtasks.length ? `Its ${subtasks.length === 1 ? "Subtask" : `${subtasks.length} Subtasks`} too; Claims stay as they are` : "Claims stay as they are"}
      submitLabel="Pass ownership"
      submitDisabled={!owner || owner === task.owner_id}
      onSubmit={() => pass.mutate()}
      pending={pass.isPending}
      error={pass.error}
    >
      <Field label="New Owner" htmlFor="pass-owner">
        <Combobox
          id="pass-owner"
          value={owner}
          onChange={setOwner}
          options={memberList
            .filter((m) => !m.deactivated_at && m.id !== task.owner_id)
            .map((m) => ({ value: m.id, label: m.name, icon: <MemberAvatar member={m} /> }))}
          placeholder="Choose a Member"
          searchPlaceholder="Search Members"
          empty="No Member"
        />
      </Field>
    </FormDialog>
  );
}

/** Moves a Task with no Parent to a place in its Project's Rank. */
export function RankDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const { project } = useTaskWorkflow(detail.task.project_id);
  const ranked = (useTasks({ project: project?.key ?? task.project_id }).data ?? []).filter((t) => !t.parent_id);
  const [position, setPosition] = useState(String(task.rank ?? 1));
  const n = Number(position);
  const valid = Number.isInteger(n) && n >= 1;
  const rank = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/rank", { params: { path: { task: task.id } }, body: { position: n } })),
    onSuccess: done(`${task.key} is #${Math.min(n, ranked.length || n)} in the Rank`, onOpenChange),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Rank ${task.key}`}
      description={task.title}
      hint={`Now #${task.rank ?? "?"} of ${ranked.length} in ${project?.name ?? "its Project"}; ended Tasks keep their places`}
      submitLabel="Rank"
      submitDisabled={!valid || n === task.rank}
      onSubmit={() => rank.mutate()}
      pending={rank.isPending}
      error={rank.error}
    >
      <Field label="Position" htmlFor="rank-position" help="1 is first; past the end is last.">
        <Input id="rank-position" type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} className="w-28" />
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
              className={cn("h-7 cursor-pointer rounded-[5px] px-3 text-muted-foreground", outcome === value && "bg-background font-medium text-foreground shadow-soft")}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="What happened" htmlFor="observe-body">
        <Textarea id="observe-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="For its Parent's Retrospective" />
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
  // A Parent neither blocks nor is blocked.
  const choices = (tasks.data ?? []).filter((t) => !already.has(t.id) && !isParent(t));
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

/**
 * A Retrospective's proposal for a company Skill: the current text, edited, for skill-review to
 * publish. A Task carries one pending proposal per Skill; a new one for the same Skill replaces it.
 */
export function ProposeDialog({ detail, open, onOpenChange }: DialogProps) {
  const { task } = detail;
  const { skillList } = useDirectory();
  const company = skillList.filter((s) => s.kind === "company");
  const [skill, setSkill] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const current = useSkillDetail(skill || undefined).data?.current;
  const replaces = detail.proposals.find((p) => p.skill_id === skill && p.state === "pending");
  const propose = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/skill-proposals", {
          params: { path: { task: task.id } },
          body: { skill, based_on_version: current!.version, body: body ?? current!.body },
        }),
      ),
    onSuccess: () => {
      toast.success("Proposal written", { description: "Advance it to skill review next" });
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
      hint={current ? `Against version ${current.version}${replaces ? "; replaces its pending proposal" : ""}` : undefined}
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
        <Textarea id="propose-body" value={text} onChange={(e) => setBody(e.target.value)} disabled={!current} className="max-h-80 min-h-40 font-mono text-xs" />
      </Field>
    </FormDialog>
  );
}
