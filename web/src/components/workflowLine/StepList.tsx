import { Link } from "react-router";
import { tokenLabel, tokenState, tokenTime, type LineTask } from "./model";
import { Glyph } from "./Token";

/** How many of a Step's Tasks its list shows before it links to the rest. */
export const LIST_ROWS = 5;

/**
 * A Step's list, open in place under its count (vf-4): "Build · 13 waiting", then the Tasks behind
 * the count in order (glyph · key · title · age), the first five, then "8 more Tasks", a link to
 * the Tasks list filtered to the Step.
 */
export function StepList({
  id,
  title,
  tasks,
  hold,
  now,
  href,
  onPick,
}: {
  id: string;
  title: string;
  tasks: readonly LineTask[];
  hold: boolean;
  now: number;
  /** The Tasks list at this Step; without it the rest are only counted. */
  href?: string;
  onPick?: (task: LineTask) => void;
}) {
  const more = tasks.length - LIST_ROWS;
  const rest = more > 0 ? `${more} more ${more === 1 ? "Task" : "Tasks"}` : undefined;
  return (
    <div id={id} role="group" aria-label={title} data-step-list className="mt-0.5 w-full max-w-[300px] basis-full rounded-lg border bg-popover px-1 py-1.5 text-xs text-popover-foreground shadow-pop">
      <div className="px-2 pt-0.5 pb-1.5 font-semibold">{title}</div>
      <ul className="flex flex-col">
        {tasks.slice(0, LIST_ROWS).map((t) => {
          const state = tokenState(t, hold);
          const since = t.holder ? t.heldSince : t.since;
          return (
            <li key={t.id}>
              <button
                type="button"
                data-task={t.key}
                aria-label={tokenLabel(t, state)}
                onClick={onPick && (() => onPick(t))}
                className="grid w-full grid-cols-[14px_64px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Glyph state={state} />
                <span className="font-mono text-[11.5px]">{t.key}</span>
                <span className="min-w-0">{t.title}</span>
                <span className="text-muted-foreground tabular-nums">{since !== undefined ? tokenTime(now - since) : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {rest && (
        <div className="mt-1 border-t px-2 pt-1.5 pb-0.5 text-muted-foreground">
          {href ? (
            <Link to={href} className="hover:text-foreground hover:underline">
              {rest}
            </Link>
          ) : (
            rest
          )}
        </div>
      )}
    </div>
  );
}
