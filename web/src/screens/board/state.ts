// Where the Board's view choices live: the Display options per browser, the Filter in the address
// (so a filtered list can be linked), and the board-local event that opens File Task with a Status
// or Feature already chosen.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { Member, Skill } from "@/api/client";
import { sendIntent } from "@/app/intents";
import { serializeFilter, type FilterPill } from "@/components/filters/filterState";
import { defaultDisplay, type Display } from "./derive";

const displayKey = "darkory.board.display";

function readDisplay(): Display {
  try {
    const raw = localStorage.getItem(displayKey);
    return raw ? { ...defaultDisplay, ...(JSON.parse(raw) as Partial<Display>) } : defaultDisplay;
  } catch {
    return defaultDisplay;
  }
}

/** The Display options, remembered by this browser. */
export function useDisplay(): [Display, (change: Partial<Display>) => void] {
  const [display, setDisplay] = useState(readDisplay);
  const change = useCallback((c: Partial<Display>) => {
    setDisplay((d) => {
      const next = { ...d, ...c };
      try {
        localStorage.setItem(displayKey, JSON.stringify(next));
      } catch {
        // Storage refused (a private window): the choice holds until the page closes.
      }
      return next;
    });
  }, []);
  return [display, change];
}

/** The Filter's parameters before `filter.tasks`: ?skill=<name>, ?holder=<name>, ?blocked=1. */
const legacyKeys = ["skill", "holder", "blocked"] as const;
const taskFilterKey = "filter.tasks";

/**
 * Pills for an address written before `filter.tasks`: the Skill and the holder named, blocked.
 * A name that matches no Skill or Member is dropped.
 */
export function legacyTaskPills(params: URLSearchParams, lookup: { skills: Iterable<Skill>; members: Iterable<Member> }): FilterPill[] {
  const pills: FilterPill[] = [];
  const skill = params.get("skill");
  const skillId = skill && [...lookup.skills].find((s) => s.name === skill)?.id;
  if (skillId) pills.push({ field: "skill", op: "is", values: [skillId] });
  const holder = params.get("holder");
  const holderId = holder && [...lookup.members].find((m) => m.name === holder)?.id;
  if (holderId) pills.push({ field: "holder", op: "is", values: [holderId] });
  if (params.get("blocked") === "1") pills.push({ field: "blocked", op: "is", values: ["true"] });
  return pills;
}

/**
 * Rewrites an old ?skill=&holder=&blocked=1 link into `filter.tasks` once the Skills and Members
 * that name its values have loaded, in one write that also drops the old parameters, so links
 * made before the Filter took ids keep working.
 */
export function useLegacyTaskFilters(lookup: { skills: Map<string, Skill>; members: Map<string, Member> }) {
  const [params, setParams] = useSearchParams();
  const legacy = legacyKeys.some((k) => params.has(k));
  const ready = lookup.skills.size > 0 && lookup.members.size > 0;
  const { skills, members } = lookup;
  useEffect(() => {
    if (!legacy || !ready) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        const pills = legacyTaskPills(current, { skills: skills.values(), members: members.values() });
        for (const k of legacyKeys) next.delete(k);
        const kept = next.getAll(taskFilterKey).filter((t) => !pills.some((p) => t.startsWith(`${p.field}:`)));
        next.delete(taskFilterKey);
        for (const t of [...kept, ...pills.map(serializeFilter)]) next.append(taskFilterKey, t);
        return next;
      },
      { replace: true },
    );
  }, [legacy, ready, skills, members, setParams]);
}

/** What File Task can be opened with beyond the shell's intent: a Status (a column's +) or a Feature. */
export type FileTaskPreset = { team?: string; status?: string; feature?: string; title?: string };

const fileTaskEvent = "darkory:board-file-task";

/** Opens File Task with a Status or Feature chosen. Without either, the shell's intent does the same. */
export function openFileTask(preset: FileTaskPreset) {
  if (!preset.status && !preset.feature) {
    sendIntent({ kind: "file-task", team: preset.team });
    return;
  }
  window.dispatchEvent(new CustomEvent<FileTaskPreset>(fileTaskEvent, { detail: preset }));
}

/** Calls `handler` for every openFileTask with a preset while mounted. */
export function useFileTaskPreset(handler: (preset: FileTaskPreset) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (e: Event) => latest.current((e as CustomEvent<FileTaskPreset>).detail);
    window.addEventListener(fileTaskEvent, listener);
    return () => window.removeEventListener(fileTaskEvent, listener);
  }, []);
}
