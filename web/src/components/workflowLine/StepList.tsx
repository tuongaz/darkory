import type { KeyboardEventHandler } from "react";
import { Link } from "react-router";
import { blockedWords, tokenLabel, tokenState, tokenTime, type LineTask } from "./model";
import { Glyph } from "./Token";

/** How many of a Step's Tasks its list shows before it links to the rest. */
export const LIST_ROWS = 5;

/**
 * A Step's list, open in place under its count (vf-4): "Build · 13 waiting", then the Tasks behind
 * the count in order (glyph · key · title · age; a blocked one says by what), the first five, then
 * "8 more Tasks", a link to the Tasks list filtered to the Step. The rows share their columns, so
 * a long key widens them all. A row selects its Task when the line can; else it only reads.
 */
export function StepList({
  id,
  title,
  tasks,
  hold,
  now,
  href,
  onPick,
  onKeyDown,
}: {
  id: string;
  title: string;
  tasks: readonly LineTask[];
  hold: boolean;
  now: number;
  /** The Tasks list at this Step; without it the rest are only counted. */
  href?: string;
  onPick?: (task: LineTask) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const more = tasks.length - LIST_ROWS;
  const rest = more > 0 ? `${more} more ${more === 1 ? "Task" : "Tasks"}` : undefined;
  return (
    <div id={id} role="group" aria-label={title} data-step-list onKeyDown={onKeyDown} className="mt-0.5 w-full max-w-[300px] basis-full rounded-lg border bg-popover px-1 py-1.5 text-xs text-popover-foreground shadow-pop">
      <div className="px-2 pt-0.5 pb-1.5 font-semibold">{title}</div>
      {/* Two empty edge columns stand for the rows' padding: a subgrid's own padding would push its first cell over its track. */}
      <ul className="grid grid-cols-[0_14px_max-content_minmax(0,1fr)_auto_0] gap-x-2">
        {tasks.slice(0, LIST_ROWS).map((t) => {
          const state = tokenState(t, hold);
          const since = t.holder ? t.heldSince : t.since;
          const by = blockedWords(t);
          const cells = (
            <>
              <span className="col-start-2 flex">
                <Glyph state={state} />
              </span>
              <span className="font-mono text-[11.5px]">{t.key}</span>
              <span className="min-w-0">
                {t.title}
                {by && <span className="ml-1.5 whitespace-nowrap text-state-blocked/75">{by}</span>}
              </span>
              <span className="text-right text-muted-foreground tabular-nums">{since !== undefined ? tokenTime(now - since) : ""}</span>
            </>
          );
          const row = "col-span-6 grid grid-cols-subgrid items-center rounded py-1 text-left";
          return (
            <li key={t.id} className="col-span-6 grid grid-cols-subgrid">
              {onPick ? (
                <button type="button" data-task={t.key} aria-label={tokenLabel(t, state)} onClick={() => onPick(t)} className={`${row} hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring`}>
                  {cells}
                </button>
              ) : (
                <div data-task={t.key} className={row}>
                  {cells}
                </div>
              )}
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
