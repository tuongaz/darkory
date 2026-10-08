import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Project, Skill } from "@/api/client";
import { useSkills } from "@/api/queries";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countTasks, stepsInOrder, targetName, unstaffed, type Workflow } from "@/components/workflow/model";
import type { CanvasSelection } from "@/components/workflow/WorkflowCanvas";
import { cn } from "@/lib/utils";
import type { RecordConnector, RecordStep, WorkflowRecord } from "./bind";
import {
  addConnector,
  deleteStep,
  nameMax,
  reconnect,
  removeConnector,
  renameConnector,
  renameStep,
  reorderConnector,
  reorderStep,
  setStepSkill,
  unusedName,
  type Change,
} from "./edits";
import { AddMember, CreateAgent, CreateSkillDialog } from "./people";

/** What the panel changes the Workflow with: the editor's `apply`, which says a refusal in words. */
export type Apply = (make: Change | ((wf: WorkflowRecord) => Change)) => string | undefined;

type PanelProps = {
  project: Project;
  record: WorkflowRecord;
  workflow: Workflow;
  selection: NonNullable<CanvasSelection>;
  apply: Apply;
  onSelect: (selection: CanvasSelection) => void;
};

/** The selected Step or Connector, edited. */
export function EditPanel(props: PanelProps) {
  const { record, selection } = props;
  if (selection.kind === "step") {
    const step = record.steps.find((s) => s.id === selection.id);
    return step ? <StepEditor key={step.id} {...props} step={step} /> : null;
  }
  const connector = record.connectors.find((c) => c.id === selection.id);
  return connector ? <ConnectorEditor key={connector.id} {...props} connector={connector} /> : null;
}

const DONE = "@done";
const toValue = (to: string | undefined) => to ?? DONE;
const fromValue = (v: string) => (v === DONE ? undefined : v);

function Frame({ title, label, onClose, children }: { title: ReactNode; label: string; onClose: () => void; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col">
      <header className="flex h-11 flex-none items-center gap-2 border-b px-4">
        <h2 className="min-w-0 truncate font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex flex-col gap-5 p-4">{children}</div>
    </section>
  );
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * A name edited in place: sent when the field is left or Enter pressed, put back on Esc or when
 * `/v1` would refuse it (the refusal shows under the canvas).
 */
function NameField({ value, label, onCommit }: { value: string; label: string; onCommit: (name: string) => string | undefined }) {
  const [name, setName] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setName(value);
  }
  const commit = () => {
    if (name.trim() === value) return setName(value);
    if (onCommit(name)) setName(value);
  };
  return (
    <Input
      aria-label={label}
      maxLength={nameMax}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setName(value);
          e.stopPropagation();
        }
      }}
      className="h-8"
    />
  );
}

/** Up and down in an order: the Workflow's, or among a Step's outcomes. */
function OrderButtons({ what, first, last, onMove }: { what: string; first: boolean; last: boolean; onMove: (by: -1 | 1) => void }) {
  return (
    <>
      <Button variant="ghost" size="icon-xs" aria-label={`Move ${what} earlier`} disabled={first} onClick={() => onMove(-1)}>
        <ArrowUpIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label={`Move ${what} later`} disabled={last} onClick={() => onMove(1)}>
        <ArrowDownIcon />
      </Button>
    </>
  );
}

const NONE = "@none";
const CREATE = "@create";

/**
 * A Step: its name, its Skill (pick a generic one, create one, or none for a hold), who takes its
 * Tasks with Add Member and Create an agent, its place in the order, the Connectors out of it
 * (rename, retarget, reorder, remove, Connect to…) and into it, and Delete, which asks where its
 * Tasks go first.
 */
function StepEditor({ project, record, workflow, apply, onSelect, step }: PanelProps & { step: RecordStep }) {
  const skills = useSkills();
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const shown = workflow.steps.find((s) => s.id === step.id);
  const skill = skills.data?.find((s) => s.id === step.skill_id);
  // Generic Skills, the builtin ones among them; a company Skill only when the Step carries one.
  const offered = (skills.data ?? []).filter((s) => s.kind === "generic" || s.id === step.skill_id);
  const order = stepsInOrder(workflow);
  const at = order.findIndex((s) => s.id === step.id);
  const out = record.connectors.filter((c) => c.from_step_id === step.id).sort((a, b) => a.position - b.position);
  const into = record.connectors.filter((c) => c.to_step_id === step.id);
  const pickSkill = (s: Skill | undefined) => apply((wf) => setStepSkill(wf, step.id, s));

  return (
    <Frame title={step.name} label={`Step ${step.name}`} onClose={() => onSelect(null)}>
      <Section title="Name">
        <NameField value={step.name} label={`Name of ${step.name}`} onCommit={(name) => apply((wf) => renameStep(wf, step.id, name))} />
      </Section>

      <Section title="Skill">
        <Select
          value={step.skill_id ?? NONE}
          onValueChange={(v) => {
            if (v === CREATE) return setCreatingSkill(true);
            pickSkill(v === NONE ? undefined : skills.data?.find((s) => s.id === v));
          }}
        >
          <SelectTrigger size="sm" aria-label={`Skill of ${step.name}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={NONE}>None: a hold</SelectItem>
            <SelectSeparator />
            {offered.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
                {s.builtin && <span className="text-xs text-muted-foreground">Darkory's</span>}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={CREATE}>
              <PlusIcon />
              Create a Skill…
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {step.skill_id
            ? "A Member with this Skill takes the Tasks here. Changing it leaves them where they are."
            : "Nobody is offered a Task at a hold; a human moves it on."}
        </p>
      </Section>

      {skill && (
        <Section title={`Members with ${skill.name}`}>
          {shown && unstaffed(shown) ? (
            <p className="flex items-center gap-1.5 font-medium text-state-claimed">
              <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
              No Member of {project.name} has it: its Tasks wait for nobody.
            </p>
          ) : (
            <ul aria-label={`Members with ${skill.name}`} className="flex flex-col gap-1">
              {step.takers.map((t) => (
                <li key={t.id} className="flex h-7 min-w-0 items-center gap-2">
                  <MemberAvatar member={t} />
                  <span className="truncate">{t.name}</span>
                  {t.kind === "agent" && <Pill tone="agent">Agent</Pill>}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-1.5">
            <AddMember project={project} skill={skill} takers={step.takers} />
            <CreateAgent project={project} skill={skill} />
          </div>
        </Section>
      )}

      <Section
        title="Order"
        actions={<OrderButtons what={step.name} first={at <= 0} last={at === order.length - 1} onMove={(by) => apply((wf) => reorderStep(wf, step.id, by))} />}
      >
        <p className="text-xs text-muted-foreground">
          Step {at + 1} of {order.length}: the board shows the Steps in this order.
        </p>
      </Section>

      <Section title="Connectors out">
        {out.length === 0 && <p className="text-muted-foreground">None: a human moves its Tasks on.</p>}
        {out.length > 0 && (
          <ul aria-label={`Connectors out of ${step.name}`} className="flex flex-col gap-2">
            {out.map((c, i) => (
              <OutRow key={c.id} record={record} workflow={workflow} connector={c} first={i === 0} last={i === out.length - 1} apply={apply} />
            ))}
          </ul>
        )}
        <ConnectTo record={record} step={step} apply={apply} />
      </Section>

      {into.length > 0 && (
        <Section title="Connectors in">
          <ul aria-label={`Connectors into ${step.name}`} className="flex flex-col">
            {into.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "connector", id: c.id })}
                  className="-mx-1 flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate text-muted-foreground">from {targetName(workflow, c.from_step_id)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="flex flex-col gap-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">{step.tasks === 0 ? "No Task is here." : `${countTasks(step.tasks)} here now.`}</p>
        <Button
          variant="outline"
          size="xs"
          className="self-start text-destructive"
          onClick={() => (step.tasks > 0 ? setDeleting(true) : apply((wf) => deleteStep(wf, step.id)) === undefined && onSelect(null))}
        >
          <Trash2Icon />
          Delete {step.name}
        </Button>
      </div>

      {creatingSkill && (
        <CreateSkillDialog
          onClose={() => setCreatingSkill(false)}
          onCreated={(s) => {
            setCreatingSkill(false);
            pickSkill(s);
          }}
        />
      )}
      {deleting && (
        <DeleteStepDialog
          record={record}
          step={step}
          apply={apply}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onSelect(null);
          }}
        />
      )}
    </Frame>
  );
}

/** A Connector out of the selected Step: its outcome renamed in place, where it leads, its order, Remove. */
function OutRow({
  record,
  workflow,
  connector: c,
  first,
  last,
  apply,
}: {
  record: WorkflowRecord;
  workflow: Workflow;
  connector: RecordConnector;
  first: boolean;
  last: boolean;
  apply: Apply;
}) {
  const from = record.steps.find((s) => s.id === c.from_step_id)!;
  const to = targetName(workflow, c.to_step_id ?? null);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2">
      <div className="flex min-w-0 items-center gap-1">
        <NameField value={c.name} label={`Outcome ${c.name} out of ${from.name}`} onCommit={(name) => apply((wf) => renameConnector(wf, c.id, name))} />
        <OrderButtons what={c.name} first={first} last={last} onMove={(by) => apply((wf) => reorderConnector(wf, c.id, by))} />
        <Button variant="ghost" size="icon-xs" aria-label={`Remove ${c.name} to ${to}`} onClick={() => apply((wf) => removeConnector(wf, c.id))}>
          <Trash2Icon />
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
        <TargetSelect
          record={record}
          from={c.from_step_id}
          value={toValue(c.to_step_id)}
          label={`Where ${c.name} out of ${from.name} leads`}
          onChange={(v) => apply((wf) => reconnect(wf, c.id, { from: c.from_step_id, to: fromValue(v) }))}
        />
      </div>
    </li>
  );
}

/** Another Step of the Workflow, or Done: where a Connector out of `from` may lead. */
function TargetSelect({
  record,
  from,
  value,
  label,
  onChange,
  placeholder,
}: {
  record: WorkflowRecord;
  from: string;
  value: string | undefined;
  label: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const targets = [...record.steps].sort((a, b) => a.position - b.position).filter((s) => s.id !== from);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-7 w-full min-w-0 flex-1">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {targets.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
        <SelectItem value={DONE}>Done</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Connect to…: a new Connector out of the Step, into a Step picked or Done, named by its outcome
 * (a free one offered). Dragging from a Step's right side on the canvas does the same.
 */
function ConnectTo({ record, step, apply }: { record: WorkflowRecord; step: RecordStep; apply: Apply }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string | undefined>();
  const taken = record.connectors.filter((c) => c.from_step_id === step.id).map((c) => c.name);
  const [name, setName] = useState("");
  if (!open) {
    return (
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() => {
          setName(unusedName(taken.length === 0 ? "pass" : "next", taken));
          setTo(undefined);
          setOpen(true);
        }}
      >
        <PlusIcon />
        Connect to…
      </Button>
    );
  }
  const add = () => {
    if (!to) return;
    if (apply((wf) => addConnector(wf, step.id, fromValue(to), name)) === undefined) setOpen(false);
  };
  return (
    <form
      aria-label={`Connect ${step.name} to a Step`}
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <TargetSelect record={record} from={step.id} value={to} label="Lead to" placeholder="Lead to…" onChange={setTo} />
      <Input aria-label="Outcome" placeholder="Outcome, such as pass" maxLength={nameMax} value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!to || !name.trim()}>
          Connect
        </Button>
      </div>
    </form>
  );
}

/** Delete a Step with Tasks at it: asks which Step they move to (`moves`), as `/v1` requires. */
function DeleteStepDialog({
  record,
  step,
  apply,
  onClose,
  onDeleted,
}: {
  record: WorkflowRecord;
  step: RecordStep;
  apply: Apply;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const others = [...record.steps].sort((a, b) => a.position - b.position).filter((s) => s.id !== step.id);
  const [to, setTo] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${step.name}`}
      description={`${countTasks(step.tasks)} ${step.tasks === 1 ? "is" : "are"} at ${step.name}. Say which Step ${step.tasks === 1 ? "it moves" : "they move"} to; a Claim on ${step.tasks === 1 ? "it" : "them"} stays.`}
      submitLabel={`Delete ${step.name}`}
      destructive
      submitDisabled={!to}
      onSubmit={() => {
        const p = apply((wf) => deleteStep(wf, step.id, to));
        setProblem(p);
        if (!p) onDeleted();
      }}
    >
      <FormRows>
        <FormRow label="Move them to">
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger aria-label={`Step that receives the Tasks at ${step.name}`} className="w-full">
              <SelectValue placeholder="Pick a Step" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {others.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      </FormRows>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </FormDialog>
  );
}

/**
 * A Connector: its outcome, the Step it leads out of and where it leads (either end changed here
 * or by dragging it on the canvas), its order among its Step's outcomes, and Remove.
 */
function ConnectorEditor({ record, workflow, apply, onSelect, connector: c }: PanelProps & { connector: RecordConnector }) {
  const from = record.steps.find((s) => s.id === c.from_step_id);
  const out = record.connectors.filter((x) => x.from_step_id === c.from_step_id).sort((a, b) => a.position - b.position);
  const at = out.findIndex((x) => x.id === c.id);
  const to = targetName(workflow, c.to_step_id ?? null);
  return (
    <Frame title={c.name} label={`Connector ${c.name}`} onClose={() => onSelect(null)}>
      <Section title="Outcome">
        <NameField value={c.name} label={`Outcome ${c.name}`} onCommit={(name) => apply((wf) => renameConnector(wf, c.id, name))} />
        <p className="text-xs text-muted-foreground">What whoever holds a Task at {from?.name} names when they advance it this way.</p>
      </Section>
      <Section title="From">
        <Select value={c.from_step_id} onValueChange={(v) => apply((wf) => reconnect(wf, c.id, { from: v, to: c.to_step_id }))}>
          <SelectTrigger size="sm" aria-label={`Step ${c.name} leads out of`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {[...record.steps]
              .sort((a, b) => a.position - b.position)
              .filter((s) => s.id !== c.to_step_id)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {from && (
          <button
            type="button"
            onClick={() => onSelect({ kind: "step", id: from.id })}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Open {from.name}
          </button>
        )}
      </Section>
      <Section title="To">
        <TargetSelect
          record={record}
          from={c.from_step_id}
          value={toValue(c.to_step_id)}
          label={`Where ${c.name} leads`}
          onChange={(v) => apply((wf) => reconnect(wf, c.id, { from: c.from_step_id, to: fromValue(v) }))}
        />
        <p className={cn("text-xs text-muted-foreground")}>{c.to_step_id ? `The Task waits at ${to} for whoever has its Skill.` : "Advancing into Done completes the Task."}</p>
      </Section>
      <Section
        title="Order"
        actions={<OrderButtons what={c.name} first={at <= 0} last={at === out.length - 1} onMove={(by) => apply((wf) => reorderConnector(wf, c.id, by))} />}
      >
        <p className="text-xs text-muted-foreground">
          Outcome {at + 1} of {out.length} out of {from?.name}.
        </p>
      </Section>
      <div className="border-t pt-4">
        <Button
          variant="outline"
          size="xs"
          className="text-destructive"
          onClick={() => apply((wf) => removeConnector(wf, c.id)) === undefined && onSelect(null)}
        >
          <Trash2Icon />
          Remove {c.name}
        </Button>
      </div>
    </Frame>
  );
}
