import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { teamTasksPath, useCurrentTeam } from "./currentTeam";
import { sendIntent } from "./intents";

const chordMs = 1000;

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const searchKeys = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

/** Whether a key press belongs to a field being typed in rather than to the app. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Whether a dialog, a sheet, a menu or a list of choices is open over the page: keys then belong to it. */
function dialogOpen(): boolean {
  return document.querySelector(':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])[data-state="open"]') !== null;
}

/**
 * The only keys the design claims (F-B6): ⌘K (Ctrl K) toggles search, C files a Task, G then B
 * opens the current Team's board. C and G B do nothing while typing or while a dialog is open.
 */
export function useShortcuts(setSearchOpen: (update: (open: boolean) => boolean) => void) {
  const navigate = useNavigate();
  const team = useCurrentTeam();
  const latest = useRef({ navigate, team, setSearchOpen });
  useEffect(() => {
    latest.current = { navigate, team, setSearchOpen };
  });

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const { navigate, team, setSearchOpen } = latest.current;
      const key = e.key.toLowerCase();
      if (key === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dialogOpen()) return;
      if (key === "g" && !e.shiftKey) {
        gAt = Date.now();
        return;
      }
      const chord = gAt > 0 && Date.now() - gAt <= chordMs;
      gAt = 0;
      if (key === "b" && chord) {
        if (team) {
          e.preventDefault();
          navigate(teamTasksPath(team, "board"));
        }
        return;
      }
      if (key === "c" && !chord) {
        e.preventDefault();
        sendIntent({ kind: "file-task", team: team?.key });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
