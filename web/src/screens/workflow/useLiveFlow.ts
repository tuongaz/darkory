import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Activity } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { quiet, type FlowState } from "@/components/workflow/live";
import { effectOf, type FlowContext, type FlowEffect } from "./flowEvents";

/** How long a callout stays above its Step, and a picked-up chip pulses. */
export const CALLOUT_MS = 6_000;
/** How long a Step's node is outlined after a pickup, a let-go, a lapse or a take-back. */
export const GLOW_MS = 2_400;
/** How long a token takes along its Connector. */
export const TRAVEL_MS = 1_200;
/** How long a chip that has just arrived at its Step stays highlighted. */
export const ARRIVE_MS = 2_000;
/** The callouts a Step shows at once, newest on top. */
export const SHOWN_CALLOUTS = 3;

const LIFE = Math.max(CALLOUT_MS, TRAVEL_MS + ARRIVE_MS);

/** An effect and when it began, in ms. */
export type Active = { effect: FlowEffect; at: number };

/**
 * The canvas at `now` from the effects begun before it, oldest first, so a later one wins. With
 * reduced motion nothing travels: the chip simply appears at its Step, and the callouts and the
 * trail still say what happened.
 */
export function flowState(active: Active[], now: number, reduced: boolean): FlowState {
  const s: FlowState = { callouts: new Map(), pulses: new Map(), glows: new Map(), tokens: [], transit: new Set(), arrived: new Set(), lit: new Set() };
  for (const { effect: e, at } of active) {
    const age = now - at;
    if (age < 0) continue;
    if (e.callout && age < CALLOUT_MS) {
      const list = s.callouts.get(e.callout.stepId) ?? [];
      s.callouts.set(e.callout.stepId, [{ id: e.seq, tone: e.callout.tone, who: e.callout.who, text: e.callout.text }, ...list].slice(0, SHOWN_CALLOUTS));
    }
    if (e.pulse && age < CALLOUT_MS) s.pulses.set(e.taskId, e.pulse.tone);
    if (e.pulse && age < GLOW_MS) s.glows.set(e.pulse.stepId, e.pulse.tone);
    if (e.arrive && age < ARRIVE_MS) s.arrived.add(e.taskId);
    if (e.travel) {
      // A later moment of the Task (picked up again at its new Step) ends the pulse of an earlier one.
      if (age < TRAVEL_MS) {
        s.pulses.delete(e.taskId);
        if (e.travel.connectorId) s.lit.add(e.travel.connectorId);
        if (!reduced) {
          s.tokens.push({ id: e.seq, key: e.key, travel: e.travel });
          s.transit.add(e.taskId);
        } else s.arrived.add(e.taskId);
      } else if (age < TRAVEL_MS + ARRIVE_MS) s.arrived.add(e.taskId);
    }
  }
  return s;
}

/** When the canvas next changes after `now`: the earliest end of a phase still to come. */
export function nextChange(active: Active[], now: number): number | undefined {
  let next: number | undefined;
  const consider = (t: number) => {
    if (t > now && (next === undefined || t < next)) next = t;
  };
  for (const { effect: e, at } of active) {
    if (e.callout || e.pulse) consider(at + CALLOUT_MS);
    if (e.pulse) consider(at + GLOW_MS);
    if (e.arrive) consider(at + ARRIVE_MS);
    if (e.travel) {
      consider(at + TRAVEL_MS);
      consider(at + TRAVEL_MS + ARRIVE_MS);
    }
  }
  return next;
}

/**
 * The live canvas's moments: each Activity entry about this Project's Tasks that arrives over the
 * stream while the page is open (never the history it opened on) becomes an effect, which plays
 * for a few seconds and goes. `ctx` names the entries' ids; a Task filed and claimed before its
 * record is read is known by its filing.
 */
export function useLiveFlow(ctx: FlowContext, reduced: boolean): FlowState {
  const live = useLiveEntries();
  const seen = useRef(live[0]?.seq ?? 0);
  const filed = useRef(new Map<string, { key: string; step_id?: string; project_id?: string }>());
  const context = useRef(ctx);
  useEffect(() => {
    context.current = ctx;
  });
  const [active, setActive] = useState<Active[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const fresh: Activity[] = live.filter((e) => e.seq > seen.current).reverse();
    if (fresh.length === 0) return;
    seen.current = live[0].seq;
    const c = context.current;
    for (const e of fresh) {
      const key = e.payload.key;
      if (e.kind === "task.filed" && typeof key === "string") {
        const str = (k: string) => (typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined);
        filed.current.set(e.subject_id, { key, step_id: str("step_id"), project_id: str("project_id") });
      }
    }
    const known: FlowContext = { ...c, task: (id) => c.task(id) ?? filed.current.get(id) };
    const t = Date.now();
    const made = fresh.map((e) => effectOf(e, known)).filter((x): x is FlowEffect => !!x);
    if (made.length === 0) return;
    setActive((was) => [...was.filter((a) => t - a.at < LIFE), ...made.map((effect) => ({ effect, at: t }))]);
    setNow(t);
  }, [live]);

  useEffect(() => {
    const next = nextChange(active, now);
    if (next === undefined) return;
    const timer = setTimeout(() => {
      const t = Date.now();
      setNow(t);
      setActive((was) => was.filter((a) => t - a.at < LIFE));
    }, next - now);
    return () => clearTimeout(timer);
  }, [active, now]);

  return useMemo(() => (active.length === 0 ? quiet : flowState(active, now, reduced)), [active, now, reduced]);
}

const reducedQuery = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mql = window.matchMedia(reducedQuery);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Whether the system asks for reduced motion: then nothing travels or pulses. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(reducedQuery).matches, () => false);
}
