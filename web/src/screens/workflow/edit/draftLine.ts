import { useMemo } from "react";
import type { Skill } from "@/api/client";
import { lineTopology, railParts, type LineWorkflow } from "@/components/workflowLine";
import type { WorkflowRecord } from "../bind";
import { asLine, type Group } from "./draft";

/**
 * What the line's layout is read from, and nothing else: the Workflows and Steps in their order,
 * each Step's Skill (or none), each Connector's ends and order, the Workflow drawn and where new
 * Steps were placed. No name: typing one never lays the line out again.
 */
export function structureKey(wf: WorkflowRecord, skills: ReadonlyMap<string, Pick<Skill, "name">>, drawn: string | undefined, placed: ReadonlyMap<string, Group>): string {
  return JSON.stringify([
    drawn ?? null,
    wf.workflows.map((w) => [w.id, w.position]),
    wf.steps.map((s) => [s.id, s.workflow_id, s.position, s.skill_id ? (skills.get(s.skill_id)?.name ?? s.skill_id) : null]),
    wf.connectors.map((c) => [c.id, c.from_step_id, c.to_step_id ?? null, c.position]),
    [...placed],
  ]);
}

/**
 * The draft as the line lays it out (its topology and rails), kept while only names change: the
 * same objects until a Step, a Skill or a Connector's ends or order do. The names the editor draws
 * are read from the draft, not from these.
 */
export function useDraftLine(wf: WorkflowRecord, skills: ReadonlyMap<string, Pick<Skill, "name">>, drawn: string | undefined, placed: ReadonlyMap<string, Group>) {
  const key = structureKey(wf, skills, drawn, placed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const line = useMemo<LineWorkflow>(() => ({ ...asLine(wf, skills as Map<string, Pick<Skill, "name">>, drawn), placed }), [key]);
  const t = useMemo(() => lineTopology(line), [line]);
  const parts = useMemo(() => railParts(t), [t]);
  return { key, line, t, parts };
}
