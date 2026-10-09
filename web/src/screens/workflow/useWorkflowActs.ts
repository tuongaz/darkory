import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Project } from "@/api/client";
import { invalidateAll, keys, useSkills, useWorkflow } from "@/api/queries";
import { setWorkflow } from "@/api/writes";
import { workflowEditPath } from "@/app/currentProject";
import { refusalToast } from "@/screens/inbox/toast";
import { same, type WorkflowRecord } from "./bind";
import { addWorkflow, deleteWorkflow, fromRecord, moveWorkflowTo, problem, saveBody, startMoves, type Draft, type RecordWorkflow, type Repoint } from "./edit/draft";
import type { EditorState } from "./routeWorkflow";

/**
 * What an admin does to a Project's Workflows from their list: add one (named "Workflow <count +
 * 1>", its editor opened with the name to type), move one earlier or later (the toast naming where
 * New Tasks start when the move changes it) and delete one (the last stays). Each is written at
 * once, one `PUT …/workflow` of the whole graph, and said in a toast; what `/v1` refuses is said in
 * its words. None is undone here: the editor's ⌘Z covers only its own draft. `admin` says whether
 * the acts are offered at all; anyone else reads the list alone.
 */
export function useWorkflowActs(project: Project, admin: boolean) {
  const query = useWorkflow(project.key);
  const graph = query.data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The Skills only tell a move's toast where New Tasks start: read for an admin alone.
  const skills = useSkills({ enabled: admin }).data;
  const skillMap = useMemo(() => skills && new Map(skills.map((s) => [s.id, s])), [skills]);
  // One write at a time: the controls wait while one is on its way, and a second click in the
  // same moment, before they are drawn waiting, sends nothing.
  const sending = useRef(false);
  const write = useMutation({
    mutationFn: (draft: Draft) => setWorkflow(project.key, saveBody(draft)),
    onSuccess: (reply) => {
      qc.setQueryData(keys.workflow(project.key), reply);
      invalidateAll(qc);
    },
    onError: refusalToast,
    onSettled: () => {
      sending.current = false;
    },
  });
  const busy = write.isPending;

  /** Writes the graph `edit` makes of the one read; `then` says what it did. */
  const act = (edit: (d: Draft) => Draft, then: (reply: WorkflowRecord, sent: Draft) => void) => {
    if (!graph || busy || sending.current) return;
    const next = edit(fromRecord(graph));
    const said = problem(next, graph, []);
    if (said) return void toast.error(said);
    sending.current = true;
    write.mutate(next, { onSuccess: (reply) => then(reply, next) });
  };

  const add = () => {
    let made = "";
    act(
      (d) => {
        const r = addWorkflow(d);
        made = r.id;
        return r.draft;
      },
      (reply, sent) => {
        const name = sent.wf.workflows.find((w) => w.id === made)?.name ?? "";
        const saved = reply.workflows.find((w) => same(w.name, name));
        toast(`Added ${name}`);
        if (saved) navigate(workflowEditPath(project, saved.id), { state: { rename: true } satisfies EditorState });
      },
    );
  };

  // A move that changes the first Workflow may change where New Tasks start (`startStep`'s rule):
  // the toast says where they start now.
  const move = (w: RecordWorkflow, onto: RecordWorkflow, by: -1 | 1) => {
    const read = graph;
    if (!read || !skillMap) return;
    act(
      (d) => moveWorkflowTo(d, w.id, onto.id),
      (_, sent) => {
        const moved = `Moved ${w.name} ${by < 0 ? "earlier" : "later"}`;
        const start = sent.wf.steps.length > 0 ? startMoves(read, sent.wf, skillMap) : undefined;
        toast(start ? `${moved}. ${start}.` : moved);
      },
    );
  };

  /** Deletes `w` as its dialog says: where its Tasks go (`moves`) and where outcomes into it lead instead (`repoint`). */
  const remove = (w: RecordWorkflow, moves: Record<string, string>, repoint: Repoint) =>
    act(
      (d) => deleteWorkflow(d, w.id, moves, repoint),
      () => toast(`Deleted ${w.name}`),
    );

  return { query, graph, skillMap, busy, add, move, remove };
}

export type WorkflowActs = ReturnType<typeof useWorkflowActs>;
