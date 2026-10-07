import { ArrowRightIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countTasks, deleteProblem, outgoing, stepsInOrder, targetName, type Connector, type Step, type Workflow } from "./model";

/*
 * The canvas's own minimal side panel, so that editing can be driven and tested here; the Settings
 * side panel (M4) replaces it with the full one: Skill pick-or-create, the Project's Members with
 * it, add a Member, create an agent, rename, reorder.
 */

function Frame({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <section
      aria-label="Selected"
      className="flex w-[264px] max-w-[calc(100vw-48px)] flex-col gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-pop"
    >
      <header className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 truncate font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Problems in words, as /v1 would refuse them, before anything is sent. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

/**
 * A selected step: its name, Skill, the Connectors out of it (each removable), and Delete. A
 * step with Tasks at it asks which step they move to first, as `/v1` refuses `step_in_use`
 * without one.
 */
export function StepPanel({
  workflow,
  step,
  onClose,
  onDeleteStep,
  onDeleteConnector,
}: {
  workflow: Workflow;
  step: Step;
  onClose: () => void;
  onDeleteStep?: (step: Step, moveTo?: string) => void;
  onDeleteConnector?: (connector: Connector) => void;
}) {
  const others = stepsInOrder(workflow).filter((s) => s.id !== step.id);
  const [moveTo, setMoveTo] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const out = outgoing(workflow, step.id);
  return (
    <Frame title={step.name} onClose={onClose}>
      <dl className="flex flex-col gap-1.5">
        <Fact label="Skill">{step.skill ? step.skill.name : <span className="text-muted-foreground">None: a hold</span>}</Fact>
        <Fact label="Tasks">{step.tasks === 0 ? <span className="text-muted-foreground">None</span> : countTasks(step.tasks)}</Fact>
      </dl>
      <div className="flex flex-col gap-1">
        <h3 className="text-xs text-muted-foreground">Connectors out</h3>
        {out.length === 0 ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <ul aria-label={`Connectors out of ${step.name}`} className="flex flex-col">
            {out.map((c) => (
              <li key={c.id} className="flex h-7 min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{c.name}</span>
                <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
                <span className="truncate text-muted-foreground">{targetName(workflow, c.to)}</span>
                {onDeleteConnector && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label={`Remove ${c.name} to ${targetName(workflow, c.to)}`}
                    onClick={() => onDeleteConnector(c)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onDeleteStep && (
        <div className="flex flex-col gap-2 border-t pt-3">
          {step.tasks > 0 && others.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Its {countTasks(step.tasks)} move to</span>
              <Select
                value={moveTo}
                onValueChange={(v) => {
                  setMoveTo(v);
                  setProblem(undefined);
                }}
              >
                <SelectTrigger size="sm" aria-label={`Step that receives the Tasks at ${step.name}`} className="h-8 w-full">
                  <SelectValue placeholder="Pick a step" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {others.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {problem && <Problem>{problem}</Problem>}
          <Button
            variant="outline"
            size="xs"
            className="self-start text-destructive"
            onClick={() => {
              const p = deleteProblem(workflow, step, moveTo);
              setProblem(p);
              if (!p) onDeleteStep(step, step.tasks > 0 ? moveTo : undefined);
            }}
          >
            <Trash2Icon />
            Delete {step.name}
          </Button>
        </div>
      )}
    </Frame>
  );
}

/** A selected Connector: its outcome, where it leads from and to, and Delete. */
export function ConnectorPanel({
  workflow,
  connector,
  onClose,
  onDeleteConnector,
}: {
  workflow: Workflow;
  connector: Connector;
  onClose: () => void;
  onDeleteConnector?: (connector: Connector) => void;
}) {
  return (
    <Frame title={connector.name} onClose={onClose}>
      <p className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{targetName(workflow, connector.from)}</span>
        <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
        <span className="truncate">{targetName(workflow, connector.to)}</span>
      </p>
      <p className="text-xs text-muted-foreground">Drag either end of its line onto another step to reconnect it.</p>
      {onDeleteConnector && (
        <Button variant="outline" size="xs" className="self-start text-destructive" onClick={() => onDeleteConnector(connector)}>
          <Trash2Icon />
          Delete {connector.name}
        </Button>
      )}
    </Frame>
  );
}
