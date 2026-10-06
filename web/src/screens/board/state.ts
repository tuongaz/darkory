// Where the Board's view choices live: the Display options per browser, the Filter in the address
// (so a filtered list can be linked), and the board-local event that opens File Task with a Status
// or Feature already chosen.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { sendIntent } from "@/app/intents";
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

/** The Filter's choices, by name, in the address: ?skill=, ?holder=, ?blocked=1. */
export type FilterParams = { skill?: string; holder?: string; blocked?: boolean };

export function useFilterParams(): [FilterParams, (change: Partial<FilterParams>) => void] {
  const [params, setParams] = useSearchParams();
  const filters: FilterParams = {
    skill: params.get("skill") ?? undefined,
    holder: params.get("holder") ?? undefined,
    blocked: params.get("blocked") === "1" || undefined,
  };
  const change = useCallback(
    (c: Partial<FilterParams>) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          for (const [k, v] of Object.entries(c)) {
            if (v === undefined || v === false || v === "") next.delete(k);
            else next.set(k, v === true ? "1" : String(v));
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [filters, change];
}

/** What File Task can be opened with beyond the shell's intent: a Status (a column's +) or a Feature. */
export type FileTaskPreset = { team?: string; status?: string; feature?: string };

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
