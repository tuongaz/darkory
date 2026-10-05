import { useSyncExternalStore } from "react";

const tickMs = 15_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  now = Date.now();
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, tickMs);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time in Unix milliseconds, re-rendering every few seconds so expiries stay true. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
