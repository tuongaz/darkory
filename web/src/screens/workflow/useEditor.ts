import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { invalidateAll, keys, useWorkflow } from "@/api/queries";
import { adoptIds, newIds, toBody, type WorkflowRecord } from "./bind";
import { problem, restore, type Change } from "./edits";
import { setWorkflow } from "./writes";

/** The toast every change shows, replaced by the next: the last change, with its Undo. */
export const changeToast = "workflow-change";

type Last = { label: string; before: WorkflowRecord; undoNote?: string };

/**
 * Editing a Project's Workflow: every change is drawn at once and sent as the whole Workflow in
 * one `PUT …/workflow`. Changes made while one is on its way are drawn too and sent together
 * after it, so nothing waits and nothing is lost; a refusal puts back the Workflow `/v1` last
 * accepted and says why. What `/v1` would refuse is said in words and not sent (`problem`). The
 * last change's toast carries Undo, which sends the Workflow as it was before it.
 */
export function useWorkflowEditor(project: string) {
  const qc = useQueryClient();
  const query = useWorkflow(project);
  const key = keys.workflow(project);

  // The Workflow as drawn while changes are unsent or on their way; undefined when it is the record.
  const [draft, setDraftState] = useState<WorkflowRecord | undefined>();
  const draftRef = useRef<WorkflowRecord | undefined>(undefined);
  const setDraft = (wf: WorkflowRecord | undefined) => {
    draftRef.current = wf;
    setDraftState(wf);
  };
  const run = useRef({ sending: false, again: false, moves: {} as Record<string, string>, accepted: undefined as WorkflowRecord | undefined });
  const last = useRef<Last | undefined>(undefined);
  // A new Step's `new:…` id, once /v1 has given it one: a selection follows it.
  const [aliases, setAliases] = useState<Map<string, string>>(() => new Map());
  const [saving, setSaving] = useState(false);
  // Whether this page has changed the Workflow: "Saved" says nothing before.
  const [touched, setTouched] = useState(false);
  // What /v1 would refuse, in words, not sent; and what it did refuse.
  const [problemText, setProblem] = useState<string | undefined>();
  const [refused, setRefused] = useState<unknown>();

  const current = () => draftRef.current ?? qc.getQueryData<WorkflowRecord>(key);

  const flush = async () => {
    const r = run.current;
    if (r.sending) {
      r.again = true;
      return;
    }
    r.sending = true;
    setSaving(true);
    try {
      for (;;) {
        r.again = false;
        const sent = draftRef.current!;
        const moves = r.moves;
        r.moves = {};
        let reply: WorkflowRecord;
        try {
          reply = await setWorkflow(project, toBody(sent, moves));
        } catch (err) {
          // Back to what /v1 last accepted; the changes since were drawn on the refused one.
          await qc.cancelQueries({ queryKey: key });
          if (r.accepted) qc.setQueryData(key, r.accepted);
          setDraft(undefined);
          r.again = false;
          r.moves = {};
          last.current = undefined;
          const message = err instanceof ApiError ? err.message : "The Workflow could not be saved.";
          setRefused(err);
          toast.error(`Not saved: ${message}`, { id: changeToast });
          void qc.invalidateQueries({ queryKey: key });
          return;
        }
        r.accepted = reply;
        const named = newIds(sent, reply);
        if (named.size > 0) setAliases((prev) => new Map([...prev, ...named]));
        if (last.current) last.current.before = adoptIds(last.current.before, named);
        if (r.again) {
          // More was drawn on top while this was on its way: it takes the new ids and goes next.
          setDraft(adoptIds(draftRef.current!, named));
          continue;
        }
        await qc.cancelQueries({ queryKey: key });
        qc.setQueryData(key, reply);
        setDraft(undefined);
        break;
      }
    } finally {
      r.sending = false;
      setSaving(false);
    }
    // The Tasks' Steps, the board and the counts read the Workflow too.
    invalidateAll(qc);
  };

  /**
   * Applies a change: refused in words (returned, and kept in `problem`) when `/v1` would refuse
   * it; else drawn at once and sent. Returns undefined when it was taken.
   */
  function apply(make: Change | ((wf: WorkflowRecord) => Change)): string | undefined {
    const wf = current();
    if (!wf) return undefined;
    const change = typeof make === "function" ? make(wf) : make;
    const p = problem(change.next, wf, change.moves);
    setProblem(p);
    setRefused(undefined);
    if (p) return p;
    if (!run.current.sending) run.current.accepted = qc.getQueryData<WorkflowRecord>(key);
    run.current.moves = { ...run.current.moves, ...change.moves };
    setDraft(change.next);
    setTouched(true);
    last.current = { label: change.label, before: wf, undoNote: change.undoNote };
    const thisChange = last.current;
    toast(change.label, {
      id: changeToast,
      description: change.undoNote,
      action: {
        label: "Undo",
        onClick: () => {
          if (last.current !== thisChange) return;
          const now = current();
          if (now) apply(restore(now, last.current.before, thisChange.label));
        },
      },
    });
    void flush();
    return undefined;
  }

  /** A selection's id as the record names it now: a new Step's, once /v1 has given it one. */
  const resolve = useCallback((id: string) => aliases.get(id) ?? id, [aliases]);

  return {
    query,
    /** The Workflow as drawn: the record, or the changes on their way. */
    workflow: draft ?? query.data,
    apply,
    resolve,
    saving,
    touched,
    problem: problemText,
    refused,
    clear: () => {
      setProblem(undefined);
      setRefused(undefined);
    },
  };
}
