import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { invalidateAll, keys, useMembers, useSkills, useWorkflow } from "@/api/queries";
import { setWorkflow } from "@/api/writes";
import type { WorkflowRecord } from "../bind";
import { describeChanges, describePeople, fromRecord, problem, saveBody, type Draft } from "./draft";

/**
 * Editing a Project's Workflow as a list: every change is made on a draft and drawn at once, and
 * nothing is sent until Save — who takes the Steps included. Save sends the whole draft in one
 * `PUT …/workflow`, the new Skills and who takes the Steps with it, and `/v1` makes it in one
 * write. What `/v1` would refuse is said in words and not sent; what it did refuse is kept with
 * the draft, so nothing typed is lost. Undo steps back one change at a time; a run of typing in
 * one field is one change.
 */
export function useDraftEditor(project: string, projectName: string) {
  const qc = useQueryClient();
  const query = useWorkflow(project);
  const skills = useSkills();
  const members = useMembers();
  // The Workflow as it stood when the editing began: what the changes are counted against.
  const [base, setBase] = useState<WorkflowRecord | undefined>();
  const [draft, setDraftState] = useState<Draft | undefined>();
  const history = useRef<{ before: Draft; key?: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<unknown>();
  // Whether Save was pressed with something to fix: the fields needing it are marked from then on.
  const [tried, setTried] = useState(false);

  if (!base && query.data) {
    setBase(query.data);
    setDraftState(fromRecord(query.data));
  }

  /**
   * Applies an edit to the draft. Edits sharing `key` one after another (keystrokes in one field)
   * are one change for Undo.
   */
  function apply(edit: (d: Draft) => Draft, key?: string) {
    if (!draft) return;
    const next = edit(draft);
    if (next === draft) return;
    const last = history.current.at(-1);
    if (!(key && last?.key === key)) history.current.push({ before: draft, key });
    setDraftState(next);
    setRefused(undefined);
  }

  function undo() {
    const last = history.current.pop();
    if (last) setDraftState(last.before);
  }

  /** Ends a run of typing: the next keystroke in the same field is a change of its own. */
  function settle() {
    const last = history.current.at(-1);
    if (last) last.key = undefined;
  }

  // What the draft changes, as the header's list says it; its length is the count the header shows.
  const changeList = useMemo(() => {
    if (!base || !draft) return [];
    const skillName = (id: string | undefined) => (id ? (skills.data?.find((k) => k.id === id)?.name ?? draft.skills[id]?.name ?? "…") : "hold");
    const memberName = (id: string) => members.data?.find((m) => m.id === id)?.name ?? "…";
    return [...describeChanges(base, draft.wf, draft.moves, skillName), ...describePeople(draft, memberName, (id) => skillName(id), projectName)];
  }, [base, draft, skills.data, members.data, projectName]);
  const changes = changeList.length;
  const said = base && draft ? problem(draft, base, skills.data ?? []) : undefined;

  /** Sends the draft whole. Resolves to the record `/v1` made of it once it has taken it. */
  async function save(): Promise<WorkflowRecord | undefined> {
    if (!draft || !base) return undefined;
    setTried(true);
    if (said) return undefined;
    setSaving(true);
    setRefused(undefined);
    try {
      const reply = await setWorkflow(project, saveBody(draft));
      qc.setQueryData(keys.workflow(project), reply);
      invalidateAll(qc);
      history.current = [];
      setBase(reply);
      setDraftState(fromRecord(reply));
      setTried(false);
      return reply;
    } catch (err) {
      setRefused(err);
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  return {
    query,
    skills: skills.data,
    base,
    draft,
    apply,
    undo,
    settle,
    changes,
    changeList,
    problem: said,
    tried,
    saving,
    refused,
    save,
  };
}

export type DraftEditor = ReturnType<typeof useDraftEditor>;
