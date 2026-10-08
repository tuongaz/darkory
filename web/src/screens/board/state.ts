// Where the Tasks screens' view choices live: the Display per browser, which Parents' rows are
// open and which groups are folded, also per browser, and the screen-local event that opens File
// a Task with more chosen than the shell's intent carries (a question's Blocks and Aim).
import { useCallback, useEffect, useRef, useState } from "react";
import { sendIntent } from "@/app/intents";
import { defaultDisplay, type Display } from "./derive";

function read<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused (a private window): the choice holds until the page closes.
  }
}

const displayKey = "darkory.tasks.display";

/** The Display options, remembered by this browser. */
export function useDisplay(): [Display, (change: Partial<Display>) => void] {
  const [display, setDisplay] = useState<Display>(() =>
    read(displayKey, defaultDisplay, (raw) => ({ ...defaultDisplay, ...(JSON.parse(raw) as Partial<Display>) })),
  );
  const change = useCallback((c: Partial<Display>) => {
    setDisplay((d) => {
      const next = { ...d, ...c };
      write(displayKey, next);
      return next;
    });
  }, []);
  return [display, change];
}

/** A set of ids remembered by this browser under `key`: open Parents, folded groups. */
export function useRememberedSet(key: string, initial: string[] = []): [Set<string>, (id: string, on: boolean) => void] {
  const [ids, setIds] = useState<Set<string>>(() => new Set(read(key, initial, (raw) => JSON.parse(raw) as string[])));
  const toggle = useCallback(
    (id: string, on: boolean) => {
      setIds((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        write(key, [...next]);
        return next;
      });
    },
    [key],
  );
  return [ids, toggle];
}

/** The Parents whose rows are open on the list. */
export const expandedKey = "darkory.tasks.expanded";
/** The list's folded groups; Dropped starts folded. */
export const foldedKey = "darkory.tasks.folded";

/**
 * What File a Task can be opened with beyond the shell's intent: a question's `blocks` (a key)
 * and `aim` (a Member id), besides the Project, Step, Parent and title the intent carries.
 */
export type FileTaskPreset = { project?: string; step?: string; parent?: string; title?: string; blocks?: string; aim?: string };

const fileTaskEvent = "darkory:tasks-file-task";

/** Opens File a Task with `preset`; without a question's fields the shell's intent does the same. */
export function openFileTask(preset: FileTaskPreset) {
  if (!preset.blocks && !preset.aim) {
    sendIntent({ kind: "file-task", project: preset.project, step: preset.step, parent: preset.parent, title: preset.title });
    return;
  }
  window.dispatchEvent(new CustomEvent<FileTaskPreset>(fileTaskEvent, { detail: preset }));
}

/** Calls `handler` for every `openFileTask` with a question's fields while mounted. */
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
