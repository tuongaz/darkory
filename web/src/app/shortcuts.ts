import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { teamTasksPath, useCurrentTeam } from "./currentTeam";
import { sendIntent } from "./intents";
import { peekParam, usePeek } from "./peek";
import { taskRow, taskRows } from "./selection";

const chordMs = 1000;

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const searchKeys = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

/**
 * Every key the app answers, as the shortcuts sheet (?) lists them: each entry is one or more
 * ways to press it ("J" or "↓"), and each way one or more keys pressed in turn ("G" then "I").
 */
export const shortcutList: { section: string; keys: { label: string; ways: string[][] }[] }[] = [
  {
    section: "Anywhere",
    keys: [
      { label: "Search", ways: [[searchKeys]] },
      { label: "File a Task", ways: [["C"]] },
      { label: "Go to Inbox", ways: [["G", "I"]] },
      { label: "Go to My work", ways: [["G", "M"]] },
      { label: "Go to Agents", ways: [["G", "A"]] },
      { label: "Go to the board", ways: [["G", "B"]] },
      { label: "Shortcuts", ways: [["?"]] },
    ],
  },
  {
    section: "Tasks list and board",
    keys: [
      { label: "Next Task", ways: [["J"], ["↓"]] },
      { label: "Previous Task", ways: [["K"], ["↑"]] },
      { label: "Open the Task", ways: [["Enter"]] },
      { label: "Close the Task", ways: [["Esc"]] },
    ],
  },
];

/** Whether a key press belongs to a field being typed in rather than to the app. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Whether something open over the page owns the keys: a dialog, a menu or a list of choices, or a
 * card being dragged with the keyboard. The Task peek does not: the list behind it stays walkable.
 */
function keysTaken(): boolean {
  return (
    document.querySelector(
      ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])[data-state="open"]:not([data-peek]), [data-dragging]',
    ) !== null
  );
}

/** Whether the element is inside the open peek, whose body scrolls with ↓ and ↑. */
function inPeek(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-peek]") !== null;
}

/**
 * The keys of `shortcutList`. ⌘K (Ctrl K) toggles search; the rest do nothing while typing or
 * while a dialog or a menu is open. J, K, ↓ and ↑ walk the Tasks the page lists (its
 * `[data-task]` rows), and with the peek open move the peek along them; Enter opens the selected
 * Task's peek. Esc, which closes the peek, is the peek's own.
 */
export function useShortcuts({
  setSearchOpen,
  setShortcutsOpen,
  selected,
  select,
}: {
  setSearchOpen: (update: (open: boolean) => boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  selected: string | null;
  select: (key: string | null) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const team = useCurrentTeam();
  const { taskKey } = usePeek();
  const latest = useRef({ navigate, location, team, taskKey, selected, select, setSearchOpen, setShortcutsOpen });
  useEffect(() => {
    latest.current = { navigate, location, team, taskKey, selected, select, setSearchOpen, setShortcutsOpen };
  });

  useEffect(() => {
    let gAt = 0;
    const peekAt = (key: string, replace: boolean) => {
      const { navigate, location } = latest.current;
      const params = new URLSearchParams(location.search);
      params.set(peekParam, key);
      navigate({ pathname: location.pathname, search: `?${params}` }, { replace });
    };
    // One step along the page's Tasks; the first press selects the first (or last) one.
    const walk = (step: 1 | -1): boolean => {
      const { taskKey, selected, select } = latest.current;
      const rows = taskRows();
      if (rows.length === 0) return false;
      const keys = rows.map((r) => r.dataset.task!);
      const at = keys.indexOf(taskKey ?? selected ?? "");
      const next = at === -1 ? (step > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + step));
      const row = rows[next];
      select(keys[next]);
      row.scrollIntoView({ block: "nearest" });
      // With the peek open the focus stays in it; else it follows the ring, so Tab goes on from there.
      if (taskKey) {
        if (keys[next] !== taskKey) peekAt(keys[next], true);
      } else row.focus({ preventScroll: true });
      return true;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const { navigate, team, taskKey, selected, setSearchOpen, setShortcutsOpen } = latest.current;
      const key = e.key.toLowerCase();
      if (key === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || keysTaken()) return;
      if (key === "g" && !e.shiftKey) {
        gAt = Date.now();
        return;
      }
      const chord = gAt > 0 && Date.now() - gAt <= chordMs;
      gAt = 0;
      if (chord) {
        const to = { i: "/inbox", m: "/my-work", a: "/agents", b: team && teamTasksPath(team, "board") }[key];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (key === "c") {
        e.preventDefault();
        sendIntent({ kind: "file-task", team: team?.key });
        return;
      }
      const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      if ((key === "j" || key === "k" || arrow) && !e.shiftKey) {
        // In the peek ↓ and ↑ scroll its body; J and K move it along the list.
        if (arrow && inPeek(e.target)) return;
        if (walk(key === "j" || e.key === "ArrowDown" ? 1 : -1)) e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !taskKey && selected) {
        // Enter on the page or on a Task row; on anything else it is that thing's.
        const t = e.target;
        if (t !== document.body && !(t instanceof HTMLElement && t.dataset.task)) return;
        if (!taskRow(selected)) return;
        e.preventDefault();
        peekAt(selected, false);
      }
    };
    // Focus moved onto a row (Tab, a click) selects it, so the ring and the keys go on from there.
    const onFocus = (e: FocusEvent) => {
      const row = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("#main [data-task]") : null;
      if (row) latest.current.select(row.dataset.task!);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
}
