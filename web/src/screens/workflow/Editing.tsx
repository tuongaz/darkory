import { useState } from "react";
import { useSearchParams } from "react-router";
import type { Project } from "@/api/client";
import { Refusal } from "@/components/Refusal";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowCanvas, type CanvasSelection } from "@/components/workflow/WorkflowCanvas";
import { useIsMobile } from "@/hooks/use-mobile";
import { addConnector, addStep, layoutSteps, placeStep, reconnect, removeConnector } from "./edits";
import { useEditingCanvas } from "./canvasData";
import { EditPanel } from "./Panel";
import { stepParam } from "./StepPeek";
import { TextView } from "./TextView";
import type { useWorkflowEditor } from "./useEditor";
import type { WorkflowView } from "./view";

/**
 * Settings › a Project › Workflow, for an admin: the canvas (or its list) editing, the selected
 * Step or Connector's panel beside it (a sheet on a phone), and under the canvas what `/v1`
 * would refuse, in words, or did refuse. `?step=<id>` opens with that Step selected (Edit in
 * Settings from the live canvas).
 */
export function EditingWorkflow({ project, view, editor }: { project: Project; view: WorkflowView; editor: ReturnType<typeof useWorkflowEditor> }) {
  const { workflow: record, apply, resolve } = editor;
  const workflow = useEditingCanvas(record);
  const phone = useIsMobile();
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<CanvasSelection>(() => {
    const id = params.get(stepParam);
    return id ? { kind: "step", id } : null;
  });
  // A new Step or Connector keeps its selection once /v1 gives it its id.
  const resolved = picked && { ...picked, id: resolve(picked.id) };
  const exists =
    resolved &&
    (resolved.kind === "step" ? record?.steps.some((s) => s.id === resolved.id) : record?.connectors.some((c) => c.id === resolved.id));
  const selection = exists ? resolved : null;

  if (editor.query.isError) return <Refusal error={editor.query.error} className="m-6" />;
  if (!record || !workflow) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const panel = selection && (
    <EditPanel project={project} record={record} workflow={workflow} selection={selection} apply={apply} onSelect={setPicked} />
  );
  const said = (editor.problem || !!editor.refused) && (
    <div className="pointer-events-auto max-w-[min(560px,calc(100%-96px))] rounded-md border border-danger-border bg-background px-3 py-2 shadow-soft">
      {editor.problem ? (
        <p role="alert" className="text-xs text-destructive">
          {editor.problem}
        </p>
      ) : (
        <Refusal error={editor.refused} />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {view === "text" ? (
          <div className="h-full overflow-auto">
            <TextView
              workflow={workflow}
              mode="edit"
              selection={selection}
              onStep={(s) => setPicked({ kind: "step", id: s.id })}
              onConnector={(id) => setPicked({ kind: "connector", id })}
            />
          </div>
        ) : (
          <WorkflowCanvas
            workflow={workflow}
            mode="edit"
            className="h-full"
            selection={selection}
            onSelectionChange={setPicked}
            onMove={(step, x, y) => apply((wf) => placeStep(wf, step.id, x, y))}
            onAddStep={(from, at) => {
              let select: string | undefined;
              apply((wf) => {
                const change = addStep(wf, from, at);
                select = change.select;
                return change;
              });
              if (select) setPicked({ kind: "step", id: select });
            }}
            onAddConnector={({ from, to }) => {
              let made: string | undefined;
              apply((wf) => {
                const change = addConnector(wf, from, to ?? undefined);
                made = change.next.connectors.at(-1)?.id;
                return change;
              });
              if (made) setPicked({ kind: "connector", id: made });
            }}
            onConnectorChange={(c, ends) => apply((wf) => reconnect(wf, c.id, { from: ends.from, to: ends.to ?? undefined }))}
            onDeleteConnector={(c) => apply((wf) => removeConnector(wf, c.id))}
            onLayout={(positions) => apply((wf) => layoutSteps(wf, positions))}
          />
        )}
        {said && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">{said}</div>}
      </div>
      {!phone && panel && (
        <aside aria-label="Selected" className="w-[340px] flex-none overflow-auto border-l bg-background">
          {panel}
        </aside>
      )}
      {phone && (
        <Sheet open={!!panel} onOpenChange={(o) => !o && setPicked(null)} modal={false}>
          <SheetContent side="bottom" showCloseButton={false} className="max-h-[75vh] gap-0 overflow-auto p-0" aria-describedby={undefined}>
            <SheetTitle className="sr-only">Selected</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
