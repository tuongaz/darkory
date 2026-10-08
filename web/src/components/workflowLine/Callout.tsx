import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Pill } from "@/components/Pill";
import { cn } from "@/lib/utils";
import { standing, unblocksWhen, type Chain, type ChainStanding } from "./data";
import { tokenTime, type LineTask } from "./model";

const standingWords = (t: LineTask, s: ChainStanding, me: string) =>
  s === "working" ? `Working · ${t.holder?.name}` : s === "with" ? (t.aimedAt?.id === me ? "With you" : `With ${t.aimedAt?.name}`) : s === "takeable" ? "Takeable" : s === "blocked" ? "" : "Waiting";

/** A Task in the chain as a pill: its ring, key and how it stands ("With you", "Takeable"). */
export function ChainPill({ task, takeable, me, now }: { task: LineTask; takeable: ReadonlySet<string>; me: string; now: number }) {
  const s = standing(task, takeable);
  const words = standingWords(task, s, me);
  return (
    <span
      data-standing={s}
      className={cn(
        "inline-flex h-[22px] items-center gap-1 rounded-full border-[1.5px] px-1.5 text-[11px] whitespace-nowrap",
        s === "working" ? "border-state-claimed bg-state-claimed-bg" : s === "blocked" ? "border-state-blocked" : "border-state-waiting",
      )}
    >
      <span
        aria-hidden
        className={cn("size-3 rounded-full border-[1.5px]", s === "working" ? "border-state-claimed bg-state-claimed" : s === "blocked" ? "border-state-blocked" : "border-state-waiting")}
      />
      <span className="font-mono text-[11px]">{task.key}</span>
      {words && <span className="text-muted-foreground">{words}</span>}
      {s === "blocked" && task.since !== undefined && <span className="text-muted-foreground">{tokenTime(now - task.since)}</span>}
    </span>
  );
}

/**
 * What a selected token says beside the line (DEP-1): the Task and how it stands; the chain as
 * status pills, what must end first on the left; when it unblocks; and the first thing in the
 * chain for the viewer, with its action. A blocker says what it holds up.
 */
export function ChainCallout({
  chain,
  me,
  takeable,
  action,
  onOpen,
  now,
}: {
  chain: Chain;
  me: string;
  takeable: ReadonlySet<string>;
  action?: ReactNode;
  onOpen?: (key: string) => void;
  now: number;
}) {
  const t = chain.task;
  const s = standing(t, takeable);
  const pill = (x: LineTask) => <ChainPill key={x.id} task={x} takeable={takeable} me={me} now={now} />;
  const when = unblocksWhen(chain);
  const blocked = t.blockers.length > 0;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{t.key}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold">{t.title}</span>
        {s === "blocked" ? <Pill tone="blocked">Blocked</Pill> : s === "working" ? <Pill tone="claimed">Working</Pill> : <Pill tone="waiting">{s === "with" ? "Question" : "Waiting"}</Pill>}
        <span className="whitespace-nowrap text-muted-foreground">
          {blocked ? (t.blockers.length === 1 ? `by ${t.blockers[0].key}` : `by ${t.blockers.length}`) : t.holder ? `${t.holder.name} · ${t.heldSince ? tokenTime(now - t.heldSince) : ""}` : ""}
        </span>
        {onOpen && (
          <button type="button" onClick={() => onOpen(t.key)} className="ml-auto inline-flex flex-none items-center gap-0.5 text-foreground underline underline-offset-2">
            Open {t.key}
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </button>
        )}
      </div>
      {chain.upstream.length > 0 && (
        <div aria-label="Blocked by" className="flex flex-wrap items-center gap-1.5">
          {chain.upstream.map((path, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-muted-foreground">·</span>}
              {path.map((x, j) => (
                <Fragment key={x.id}>
                  {j > 0 && <ArrowRightIcon aria-hidden className="size-3" />}
                  {pill(x)}
                </Fragment>
              ))}
            </Fragment>
          ))}
          {chain.upstream.length === 1 && (
            <>
              <ArrowRightIcon aria-hidden className="size-3" />
              {pill(t)}
            </>
          )}
        </div>
      )}
      {chain.downstream.length > 0 && (
        <div aria-label="Blocks" className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">Blocks {chain.downstream.filter((d) => d.blockers.some((b) => b.id === t.id)).length}</span>
          {chain.downstream.length > 1 && <span className="text-muted-foreground">· {chain.downstream.length} in chain</span>}
          {chain.downstream.map((x, j) => (
            <Fragment key={x.id}>
              {j > 0 && <ArrowRightIcon aria-hidden className="size-3" />}
              {pill(x)}
            </Fragment>
          ))}
        </div>
      )}
      {when && <p>{when}</p>}
      {!blocked && chain.downstream.length > 0 && (
        <p className="text-muted-foreground">
          {chain.downstream
            .map((d) => {
              const by = d.blockers.map((b) => b.key);
              return `${d.key} unblocks when ${by.join(" and ")} ${by.length === 1 ? "ends" : "end"}`;
            })
            .join("; ")}
        </p>
      )}
      {blocked && (
        <div className="flex items-center gap-2">
          <span>
            <b className="font-semibold">First:</b>{" "}
            {chain.first.kind === "answer" ? `answer ${chain.first.task.key}` : chain.first.kind === "take" ? `take ${chain.first.task.key}` : <span className="text-muted-foreground">nothing for you</span>}
          </span>
          {chain.first.kind !== "none" && action && <span className="ml-auto">{action}</span>}
        </div>
      )}
    </div>
  );
}
