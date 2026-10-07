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

/** The Filter's parameters before `filter.<entity>`: by name, one value each. */
const legacyTaskKeys = ["skill", "holder", "blocked"];
const legacyFeatureKeys = ["owner"];

type Lookup = { skills: Map<string, Skill>; members: Map<string, Member> };

const idOf = <T extends { id: string; name: string }>(items: Map<string, T>, name: string | null) =>
  name ? [...items.values()].find((x) => x.name === name)?.id : undefined;

/**
 * Pills for a Tasks address written before `filter.tasks`: ?skill=<name>, ?holder=<name> and
 * ?blocked=1. A name that matches no Skill or Member is dropped.
 */
export function legacyTaskPills(params: URLSearchParams, lookup: Lookup): FilterPill[] {
  const pills: FilterPill[] = [];
  const skill = idOf(lookup.skills, params.get("skill"));
  if (skill) pills.push({ field: "skill", op: "is", values: [skill] });
  const holder = idOf(lookup.members, params.get("holder"));
  if (holder) pills.push({ field: "holder", op: "is", values: [holder] });
  if (params.get("blocked") === "1") pills.push({ field: "blocked", op: "is", values: ["true"] });
  return pills;
}

/** Pills for a Features address written before `filter.features`: ?owner=<name>. */
export function legacyFeaturePills(params: URLSearchParams, lookup: Lookup): FilterPill[] {
  const owner = idOf(lookup.members, params.get("owner"));
  return owner ? [{ field: "owner", op: "is", values: [owner] }] : [];
}

/**
 * Rewrites an old link's by-name parameters into `filter.<entity>` once the Skills and Members
 * that name its values have loaded, in one write that also drops the old parameters, so links
 * made before the Filter took ids keep working.
 */
function useLegacyFilters(entity: string, keys: string[], toPills: (params: URLSearchParams, lookup: Lookup) => FilterPill[], lookup: Lookup) {
  const [params, setParams] = useSearchParams();
  const legacy = keys.some((k) => params.has(k));
  const ready = lookup.skills.size > 0 && lookup.members.size > 0;
  const { skills, members } = lookup;
  useEffect(() => {
    if (!legacy || !ready) return;
    const key = `filter.${entity}`;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        const pills = toPills(current, { skills, members });
        for (const k of keys) next.delete(k);
        const kept = next.getAll(key).filter((t) => !pills.some((p) => t.startsWith(`${p.field}:`)));
        next.delete(key);
        for (const t of [...kept, ...pills.map(serializeFilter)]) next.append(key, t);
        return next;
      },
      { replace: true },
    );
  }, [legacy, ready, entity, keys, toPills, skills, members, setParams]);
}

/** Team › Tasks' old ?skill=&holder=&blocked=1 links. */
export function useLegacyTaskFilters(lookup: Lookup) {
  useLegacyFilters("tasks", legacyTaskKeys, legacyTaskPills, lookup);
}

/** Team › Features' old ?owner= links. */
export function useLegacyFeatureFilters(lookup: Lookup) {
  useLegacyFilters("features", legacyFeatureKeys, legacyFeaturePills, lookup);
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
