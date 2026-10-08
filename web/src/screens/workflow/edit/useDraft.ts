import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { invalidateAll, keys, useSkills, useWorkflow } from "@/api/queries";
import { createSkill, setWorkflow } from "@/api/writes";
import { toBody, type WorkflowRecord } from "../bind";
import { countChanges, fromRecord, isNewSkill, problem, type Draft } from "./draft";

/**
 * Editing a Project's Workflow as a list: every change is made on a draft and drawn at once, and
 * nothing is sent until Save. Save creates the new generic Skills the draft's Steps carry, then
 * sends the whole Workflow in one `PUT …/workflow`. What `/v1` would refuse is said in words and
 * not sent; what it did refuse is kept with the draft, so nothing typed is lost. Undo steps back
 * one change at a time; a run of typing in one field is one change.
 */
export function useDraftEditor(project: string) {
  const qc = useQueryClient();
  const query = useWorkflow(project);
  const skills = useSkills();
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

  const changes = useMemo(() => (base && draft ? countChanges(base, draft.wf) : 0), [base, draft]);
  const said = base && draft ? problem(draft, base, skills.data ?? []) : undefined;

  /** Creates the new Skills, then sends the Workflow. Resolves true once `/v1` has taken it. */
  async function save(): Promise<boolean> {
    if (!draft || !base) return false;
    setTried(true);
    if (said) return false;
    setSaving(true);
    setRefused(undefined);
    let d = draft;
    try {
      for (const [placeholder, s] of Object.entries(d.skills)) {
        const made = await createSkill({ name: s.name, kind: "generic", body: s.body });
        // The draft carries the Skill by its id from now on, so a refused Workflow does not create it twice.
        d = adoptSkill(d, placeholder, made.skill.id);
        setDraftState(d);
        // Undo steps back to drafts carrying the Skill by its id too: it exists now.
        const id = made.skill.id;
        history.current = history.current.map((h) => ({ ...h, before: adoptSkill(h.before, placeholder, id) }));
        void qc.invalidateQueries({ queryKey: keys.skills });
      }
      const body = toBody(d.wf, d.moves);
      if (body.steps.some((s) => isNewSkill(s.skill))) throw new Error("A new Skill was not created.");
      const reply = await setWorkflow(project, body);
      qc.setQueryData(keys.workflow(project), reply);
      invalidateAll(qc);
      history.current = [];
      setBase(reply);
      setDraftState(fromRecord(reply));
      setTried(false);
      return true;
    } catch (err) {
      setRefused(err);
      return false;
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
    problem: said,
    tried,
    saving,
    refused,
    save,
  };
}

export type DraftEditor = ReturnType<typeof useDraftEditor>;

/** `d` carrying the Skill `placeholder` stood for by its id, and no longer creating it. */
function adoptSkill(d: Draft, placeholder: string, id: string): Draft {
  if (!(placeholder in d.skills)) return d;
  return {
    ...d,
    skills: Object.fromEntries(Object.entries(d.skills).filter(([k]) => k !== placeholder)),
    wf: { ...d.wf, steps: d.wf.steps.map((s) => (s.skill_id === placeholder ? { ...s, skill_id: id } : s)) },
  };
}
