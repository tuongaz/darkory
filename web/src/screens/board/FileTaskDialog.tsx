// File a Task: C, ⌘K, a column's +, a Parent's Add Subtask, a Task's Ask a question and the Install
// checklist open it (BoardDialogs mounts it once for the whole app). A Task, a Subtask under a
// Parent, or a question aimed at a Member that blocks the Task it is about.
import { useMutation } from "@tanstack/react-query";
import { FolderGit2Icon, LinkIcon, SearchIcon, SplitIcon, UserRoundIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiError, type Project, type Task, type Workspace, type WorkflowStep } from "@/api/client";
import { useDirectory, useLabels, useProjects, useWorkflow, useWorkspaces } from "@/api/queries";
import { fileTask } from "@/api/writes";
import { findProject, useCurrentProject } from "@/app/currentProject";
import { usePeekLink } from "@/app/peek";
import { FormDialog } from "@/components/FormDialog";
import { InfoTip } from "@/components/InfoTip";
import { Key } from "@/components/Key";
import { LabelDot } from "@/components/LabelPill";
import { MemberAvatar } from "@/components/MemberAvatar";
import { ProjectMark } from "@/components/ProjectMark";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/clock";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { Combobox } from "./Combobox";
import { defaultFileStep, isParent, stepsInOrder, stepWithSkill } from "./derive";
import { MultiCombobox } from "./MultiCombobox";
import { useProjectTasks } from "./queries";
import type { FileTaskPreset } from "./state";

/**
 * One field of the dialog's 12-column form (kit `.field`): its label over its control, and what
 * is wrong with it. `info` explains it from an ⓘ beside the label, outside the `<label>` so the
 * control's name stays the label's words.
 */
function Field({ label, htmlFor, error, info, className, children }: { label: string; htmlFor?: string; error?: string; info?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <span className="flex h-[18px] items-center gap-1">
        <Label htmlFor={htmlFor} className="text-[12.5px] font-medium">
          {label}
        </Label>
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </span>
      {children}
      {error && (
        <p role="alert" className="text-xs text-state-blocked">
          {error}
        </p>
      )}
    </div>
  );
}

/** A switch with its label beside it, and its ⓘ. */
function SwitchField({ id, label, checked, onChange, info }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; info?: ReactNode }) {
  return (
    <span className="flex h-8 min-w-0 items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-[12.5px] font-medium">
        {label}
      </Label>
      {info && <InfoTip label={label}>{info}</InfoTip>}
    </span>
  );
}

/**
 * One decision the filer makes, under a quiet heading: a group named by it, on the dialog's
 * 12-column grid. `side` sits at the heading's right (the Question switch).
 */
function Section({ title, side, children }: { title: string; side?: ReactNode; children?: ReactNode }) {
  const id = `file-task-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div role="group" aria-labelledby={id} className="grid grid-cols-1 gap-x-3 gap-y-2.5 border-t pt-3 sm:col-span-12 sm:grid-cols-12">
      <div className="flex h-5 items-center gap-2 sm:col-span-12">
        <h3 id={id} className="text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {side}
      </div>
      {children}
    </div>
  );
}

/** A refusal reworded where `/v1`'s message names a rule the filer can act on. */
function inWords(err: unknown, words: (code: string) => string | undefined): unknown {
  if (!(err instanceof ApiError)) return err;
  const said = words(err.code);
  return said ? new ApiError(err.status, err.code, said, err.details) : err;
}

/** The Workspaces a new Task names unless the filer says otherwise: a Subtask its Parent's, else the Project's default. */
function defaultWorkspaces(project: Project | undefined, parent: Task | undefined, workspaces: Workspace[]): string[] {
  const known = (ids: string[]) => ids.filter((id) => workspaces.some((w) => w.id === id));
  if (parent) return known(parent.workspace_ids ?? []);
  return known(project?.default_workspace_id ? [project.default_workspace_id] : []);
}

/** A Step as the Step field lists it: its name, its Skill (or hold), and who takes Tasks there. */
function StepOption({ step, skill }: { step: WorkflowStep; skill: string | undefined }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{step.name}</span>
      <span className="text-xs text-muted-foreground">{skill ?? "hold"}</span>
      {step.takers.length > 0 && (
        <span className="flex items-center -space-x-1" aria-label={`Taken by ${step.takers.map((t) => t.name).join(", ")}`}>
          {step.takers.slice(0, 4).map((t) => (
            <MemberAvatar key={t.id} member={t} card={false} />
          ))}
        </span>
      )}
      {skill && step.takers.length === 0 && <span className="text-xs text-state-claimed">No Member has it</span>}
    </span>
  );
}

export function FileTaskDialog({ preset, onClose }: { preset: FileTaskPreset; onClose: () => void }) {
  const me = useCurrentMe();
  const now = useNow();
  const projects = useProjects().data ?? [];
  const { memberList, skills } = useDirectory();
  const workspaces = useWorkspaces().data ?? [];
  const navigate = useNavigate();
  const peek = usePeekLink();
  const titleRef = useRef<HTMLInputElement>(null);
  const skillName = (id: string) => skills.get(id)?.name;

  const [projectKey, setProjectKey] = useState<string | undefined>(preset.project);
  // Until a Project is named, the current one: a dialog opened before the Projects loaded (C on a
  // fresh page) files in the Project of the address once they arrive.
  const current = useCurrentProject();
  const project = findProject(projects, projectKey) ?? current;
  const key = project?.key ?? "";
  const tasks = useProjectTasks(key);
  const workflow = useWorkflow(key || undefined);
  const labels = useLabels(key || undefined);
  const workflows = workflow.data?.workflows ?? [];
  const steps = stepsInOrder({ workflows, steps: workflow.data?.steps ?? [] });

  const [title, setTitle] = useState(preset.title ?? "");
  const [description, setDescription] = useState("");
  const [parentKey, setParentKey] = useState<string | undefined>(preset.parent);
  const [chosenStep, setStep] = useState<string | undefined>(preset.step);
  const [breakdown, setBreakdown] = useState(false);
  const [labelIds, setLabels] = useState<string[]>([]);
  const [ownerId, setOwner] = useState<string>(me.member.id);
  const [autoComplete, setAutoComplete] = useState<boolean>();
  const [acceptance, setAcceptance] = useState<boolean>();
  const [chosenWorkspaces, setWorkspaces] = useState<string[]>();
  const [aim, setAim] = useState<string | undefined>(preset.aim);
  const [blocksKey, setBlocks] = useState<string | undefined>(preset.blocks);
  const [asking, setAsking] = useState(!!preset.aim || !!preset.blocks);
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<{ title?: string }>({});

  const all = tasks.data ?? [];
  const byKey = new Map(all.map((t) => [t.key, t]));
  const blocked = blocksKey ? byKey.get(blocksKey) : undefined;
  // A question joins the Parent of the Task it blocks; otherwise the Parent is the filer's.
  const parent = blocksKey ? (blocked?.parent_id ? all.find((t) => t.id === blocked.parent_id) : undefined) : parentKey ? byKey.get(parentKey) : undefined;
  const subtask = !!parent || !!parentKey;
  const question = !!aim || !!blocksKey;
  const breakdownStep = stepWithSkill({ workflows, steps }, "breakdown", skillName);
  const acceptanceStep = stepWithSkill({ workflows, steps }, "acceptance", skillName);
  const canBreakDown = !!breakdownStep && !subtask && !question;
  // What it does as a Parent is asked of a Task that may become one: not a Subtask, not a question.
  const parentToBe = !subtask && !question;
  const breaking = canBreakDown && breakdown;
  const fallback = defaultFileStep({ workflows, steps }, skillName);
  const stepId = steps.some((s) => s.id === chosenStep) ? chosenStep! : fallback?.id;
  const workspaceIds = chosenWorkspaces ?? defaultWorkspaces(project, parent, workspaces);
  const parentHolder = parent && !blocksKey ? liveClaim(parent, now)?.holder_id : undefined;
  const splits = !!parentHolder && parentHolder === me.member.id;

  const stepItem = (s: WorkflowStep) => (
    <SelectItem key={s.id} value={s.id}>
      <StepOption step={s} skill={s.skill_id ? skillName(s.skill_id) : undefined} />
    </SelectItem>
  );

  const parents = all.filter((t) => t.state === "open" && !t.parent_id);
  const blockable = all.filter((t) => t.state === "open" && !isParent(t));
  // What it waits on, among what is still open in this Project; never the Task it blocks.
  const waitsOn = blockedBy.filter((k) => k !== blocksKey && blockable.some((t) => t.key === k));

  const file = useMutation({
    mutationFn: () =>
      fileTask({
        project: key,
        title: title.trim(),
        description: description.trim() || undefined,
        parent: !blocksKey ? parentKey : undefined,
        // A Subtask's Owner is its Parent's and cannot be named.
        owner: subtask ? undefined : ownerId,
        step: aim || breaking ? undefined : stepId,
        breakdown: breaking || undefined,
        auto_complete: parentToBe ? (autoComplete ?? project?.auto_complete) : undefined,
        acceptance: parentToBe && acceptanceStep ? (acceptance ?? project?.acceptance) : undefined,
        labels: labelIds.length ? labelIds : undefined,
        // Named whenever the field is shown, so taking the default out files the Task in none.
        workspaces: workspaces.length ? workspaceIds : undefined,
        // A Parent is never blocked: Break down files one.
        blocked_by: !breaking && waitsOn.length ? waitsOn : undefined,
        aim,
        blocks: blocksKey,
        note: splits && note.trim() ? note.trim() : undefined,
      }),
    onSuccess: (filed) => {
      const k = filed.task.key;
      toast(`Filed ${k}`, { description: filed.task.title, action: { label: "Open", onClick: () => navigate(peek(k)) } });
      if (!more) return onClose();
      setTitle("");
      setDescription("");
      setNote("");
      file.reset();
      titleRef.current?.focus();
    },
  });

  const submit = () => {
    const next = { title: title.trim() ? undefined : "Name the Task." };
    setErrors(next);
    if (next.title) return;
    file.mutate();
  };

  const name = (id: string | undefined) => (id && memberList.find((m) => m.id === id)?.name) || "its holder";
  const projectName = project?.name ?? "this Project";
  const error = inWords(file.error, (code) => {
    switch (code) {
      case "forbidden":
        return blocksKey
          ? `Only ${blocksKey}'s holder, its Owner or a Member of ${projectName} files a question that blocks it.`
          : `Only Members of ${projectName} file its Tasks; an admin can add you to ${projectName}.`;
      case "held":
        return `${name(parentHolder)} holds ${parentKey}: only they file Subtasks under it, which ends their Claim.`;
      case "one_level":
        return `${parentKey} is itself a Subtask: a Subtask has no Subtasks of its own.`;
      case "ended":
        return blocksKey ? `${blocksKey} has ended: nothing waits on the answer.` : `${parentKey} has ended and takes no new Subtasks.`;
      case "not_holder":
        return `${blocksKey} is held by someone else; only its holder files a question that blocks it.`;
      case "no_step":
        return breaking ? `${projectName}'s Workflow has no Step carrying breakdown.` : `${projectName}'s Workflow has no Steps yet.`;
      case "conflict":
        return blocksKey ? `${blocksKey} is a Parent: a question blocks one of its Subtasks.` : `${parentKey} blocks or waits on an open Task: a Parent neither blocks nor is blocked.`;
      case "cycle":
        return blocksKey ? `${blocksKey} already waits on this, directly or through other Tasks.` : "It would wait on itself, through the Tasks it is blocked by.";
      default:
        return undefined;
    }
  });

  const members = memberList.filter((m) => !m.deactivated_at);
  const taskOption = (t: Task) => ({ value: t.key, label: t.title, keywords: [t.key], icon: <Key>{t.key}</Key> });
  const breakdownAt = breakdownStep?.name;

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="File a Task"
      submitLabel="File Task"
      onSubmit={submit}
      pending={file.isPending}
      error={error}
      hint={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={more} onCheckedChange={setMore} aria-label="Create more" />
            Create more
          </label>
          {splits && (
            <span className="flex items-center gap-1.5 text-state-claimed">
              <SplitIcon className="size-3.5" aria-hidden />
              This ends your Claim on {parentKey}
            </span>
          )}
        </span>
      }
    >
      <div className="-mx-1 grid max-h-[calc(100svh-13rem)] grid-cols-1 gap-x-3 gap-y-3.5 overflow-y-auto px-1 py-1 sm:grid-cols-12">
        {/* The Task itself. */}
        <Field label="Title" htmlFor="file-task-title" error={errors.title} className="sm:col-span-12">
          <Input
            id="file-task-title"
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            maxLength={200}
            aria-invalid={!!errors.title || undefined}
            className="h-9 text-[15px] font-medium"
          />
        </Field>
        <Field label="Description" htmlFor="file-task-description" className="sm:col-span-12">
          <Textarea id="file-task-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description" className="min-h-16" />
        </Field>
        <Field label="Labels" htmlFor="file-task-labels" className="sm:col-span-12">
          <MultiCombobox
            id="file-task-labels"
            values={labelIds}
            onChange={setLabels}
            options={(labels.data ?? []).map((l) => ({
              value: l.id,
              label: l.name,
              icon: <LabelDot label={l} />,
              detail: <span className="text-xs text-muted-foreground">{l.project_id ? projectName : "Organisation"}</span>,
            }))}
            placeholder="None"
            searchPlaceholder="Search Labels"
            empty="No Label"
          />
        </Field>
        {splits && (
          <Field label="Note" htmlFor="file-task-note" info={`Added to ${parentKey}'s Notes as your Claim ends.`} className="sm:col-span-12">
            <Textarea id="file-task-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it splits, for whoever takes the Subtasks" className="min-h-14" />
          </Field>
        )}

        {/* Whose it is: its Project, its Parent, and its Owner, which a Subtask takes from its Parent. */}
        <Section title="Belongs to">
          <Field label="Project" htmlFor="file-task-project" className="sm:col-span-4">
            <Select
              value={key}
              onValueChange={(k) => {
                setProjectKey(k);
                // What was chosen in another Project's Workflow and Tasks does not carry over.
                setParentKey(undefined);
                setStep(undefined);
                setLabels([]);
                setBlocks(undefined);
                setBlockedBy([]);
                setWorkspaces(undefined);
              }}
            >
              <SelectTrigger id="file-task-project" className="w-full">
                <SelectValue placeholder="Choose a Project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.key}>
                    <ProjectMark project={p} />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Parent" htmlFor="file-task-parent" className={subtask ? "sm:col-span-8" : "sm:col-span-4"}>
            {blocksKey ? (
              <p className="flex h-9 items-center truncate text-muted-foreground">{parent ? <>Joins {parent.key}, beside {blocksKey}</> : <>Beside {blocksKey}</>}</p>
            ) : (
              <Combobox
                id="file-task-parent"
                value={parentKey}
                onChange={setParentKey}
                options={parents.map(taskOption)}
                placeholder="None"
                searchPlaceholder="Search Tasks"
                empty={`No open Task in ${projectName}`}
                icon={<SearchIcon />}
              />
            )}
          </Field>
          {!subtask && (
            <Field label="Owner" htmlFor="file-task-owner" className="sm:col-span-4">
              <Combobox
                id="file-task-owner"
                value={ownerId}
                onChange={(v) => setOwner(v ?? me.member.id)}
                options={members.map((m) => ({
                  value: m.id,
                  label: m.name,
                  icon: <MemberAvatar member={m} card={false} />,
                  detail: m.id === me.member.id ? <span className="text-muted-foreground">· you</span> : undefined,
                }))}
                placeholder="Choose a Member"
                searchPlaceholder="Search Members"
                empty="No Member"
              />
            </Field>
          )}
        </Section>

        {/* Where it starts: its Step, what it waits on, and where its Shifts work. */}
        <Section title="Start">
          <Field
            label="Step"
            htmlFor="file-task-step"
            className={breaking ? "sm:col-span-12" : "sm:col-span-6"}
            info={breaking ? `Filed as a Parent, it is at no Step; its Breakdown waits at ${breakdownAt}.` : aim ? `Aimed at ${name(aim)}, it waits with them at no Step.` : undefined}
          >
            <Select value={breaking || aim ? "" : stepId} onValueChange={setStep} disabled={breaking || !!aim}>
              <SelectTrigger id="file-task-step" className="w-full">
                <SelectValue placeholder={breaking ? "None: a Parent" : aim ? `With ${name(aim)}` : steps.length ? "Choose a Step" : "This Workflow has no Steps"} />
              </SelectTrigger>
              <SelectContent>
                {workflows.length > 1
                  ? // A Project of several Workflows: each one's Steps under its name, in the Project's order.
                    [...workflows]
                      .sort((a, b) => a.position - b.position)
                      .map((w) => (
                        <SelectGroup key={w.id}>
                          <SelectLabel>{w.name}</SelectLabel>
                          {steps.filter((s) => s.workflow_id === w.id).map(stepItem)}
                        </SelectGroup>
                      ))
                  : steps.map(stepItem)}
              </SelectContent>
            </Select>
          </Field>
          {!breaking && (
            <Field label="Blocked by" htmlFor="file-task-blocked-by" info="Not takeable until these end." className="sm:col-span-6">
              <MultiCombobox
                id="file-task-blocked-by"
                values={waitsOn}
                onChange={setBlockedBy}
                options={blockable.filter((t) => t.key !== blocksKey).map(taskOption)}
                placeholder="Nothing"
                searchPlaceholder="Search Tasks"
                empty="No open Task"
                icon={<LinkIcon />}
              />
            </Field>
          )}
          {workspaces.length > 0 && (
            <Field label="Workspaces" htmlFor="file-task-workspaces" info={subtask ? "Its branch starts from its Parent's." : undefined} className="sm:col-span-12">
              <MultiCombobox
                id="file-task-workspaces"
                values={workspaceIds}
                onChange={setWorkspaces}
                options={workspaces.map((w) => ({
                  value: w.id,
                  label: w.name,
                  icon: <FolderGit2Icon />,
                  detail: <span className="font-mono text-xs text-muted-foreground">{w.path}</span>,
                }))}
                placeholder="None"
                searchPlaceholder="Search Workspaces"
                empty="No Workspace"
                icon={<FolderGit2Icon />}
              />
            </Field>
          )}
        </Section>

        {/* As a Parent: what Darkory files under it, and how it ends. A Subtask has no Subtasks, and a
            question waits for its answer; either files with the Project's defaults. */}
        {parentToBe && (
          <Section title="Subtasks">
            <div className="flex flex-wrap gap-x-6 gap-y-1 sm:col-span-12">
              {canBreakDown && (
                <SwitchField
                  id="file-task-breakdown"
                  label="Break down"
                  checked={breakdown}
                  onChange={setBreakdown}
                  info={`Files its Breakdown at ${breakdownAt}: whoever takes it files the other Subtasks.`}
                />
              )}
              <SwitchField
                id="file-task-auto-complete"
                label="Auto-complete"
                checked={autoComplete ?? project?.auto_complete ?? false}
                onChange={setAutoComplete}
                info="Completes itself when its last Subtask ends Done."
              />
              {acceptanceStep && (
                <SwitchField
                  id="file-task-acceptance"
                  label="Acceptance"
                  checked={acceptance ?? project?.acceptance ?? false}
                  onChange={setAcceptance}
                  info={
                    // "An Acceptance at Acceptance" says the word twice when the Step is named for it.
                    acceptanceStep.name.trim().toLowerCase() === "acceptance"
                      ? "Acceptance runs before it completes."
                      : `Runs at the ${acceptanceStep.name} Step before it completes.`
                  }
                />
              )}
            </div>
          </Section>
        )}

        {/* A question: aimed at a Member by name, blocking the Task it is about. Off, it asks nothing. */}
        <Section
          title="Question"
          side={
            <>
              <InfoTip label="Question">Aimed at a Member, it waits with them at no Step. Blocking a Task, it joins that Task&apos;s Parent.</InfoTip>
              <Switch
                aria-label="Question"
                checked={asking}
                onCheckedChange={(on) => {
                  setAsking(on);
                  if (on) return;
                  setAim(undefined);
                  setBlocks(undefined);
                }}
                className="ml-auto"
              />
            </>
          }
        >
          {asking && (
            <>
              <Field label="Aim at" htmlFor="file-task-aim" className="sm:col-span-6">
                <Combobox
                  id="file-task-aim"
                  value={aim}
                  onChange={(v) => {
                    setAim(v);
                    if (v) setBreakdown(false);
                  }}
                  options={members.map((m) => ({ value: m.id, label: m.name, icon: <MemberAvatar member={m} card={false} /> }))}
                  placeholder="No one by name"
                  searchPlaceholder="Search Members"
                  empty="No Member"
                  icon={<UserRoundIcon />}
                />
              </Field>
              <Field label="Blocks" htmlFor="file-task-blocks" className="sm:col-span-6">
                <Combobox
                  id="file-task-blocks"
                  value={blocksKey}
                  onChange={(v) => {
                    setBlocks(v);
                    if (v) {
                      setParentKey(undefined);
                      setBreakdown(false);
                    }
                  }}
                  options={blockable.map(taskOption)}
                  placeholder="Nothing"
                  searchPlaceholder="Search Tasks"
                  empty="No open Task"
                  icon={<LinkIcon />}
                />
              </Field>
            </>
          )}
        </Section>
      </div>
    </FormDialog>
  );
}
