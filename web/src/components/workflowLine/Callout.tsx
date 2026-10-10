import { ArrowRightIcon, ArrowUpRightIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode, type Ref } from "react";
import { InfoTip } from "@/components/InfoTip";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { cn } from "@/lib/utils";
import { standing, unblocksWhen, type Chain, type ChainStanding } from "./data";
import { tokenTime, type LineMember, type LineTask } from "./model";
import { Glyph } from "./Token";

const standingWords = (t: LineTask, s: ChainStanding, me: string) =>
  s === "working" ? `Working · ${t.holder?.name}` : s === "with" ? (t.aimedAt?.id === me ? "With you" : `With ${t.aimedAt?.name}`) : s === "takeable" ? "Takeable" : s === "blocked" ? "" : "Waiting";

/** The chain's first move for the viewer, after "First:": "answer MAIN-2", "take MAIN-3". */
const firstWords = (first: Chain["first"]) => (first.kind === "answer" ? `answer ${first.task.key}` : first.kind === "take" ? `take ${first.task.key}` : undefined);

/** What a blocker holds up: "Blocks 1 · 2 in chain", and each Task's "MAIN-3 unblocks when MAIN-2 ends". */
function holdsUp(chain: Chain): { count: string; when: string } | undefined {
  const t = chain.task;
  if (chain.downstream.length === 0) return undefined;
  const direct = chain.downstream.filter((d) => d.blockers.some((b) => b.id === t.id)).length;
  return {
    count: `Blocks ${direct}${chain.downstream.length > 1 ? ` · ${chain.downstream.length} in chain` : ""}`,
    when: chain.downstream
      .map((d) => {
        const by = d.blockers.map((b) => b.key);
        return `${d.key} unblocks when ${by.join(" and ")} ${by.length === 1 ? "ends" : "end"}`;
      })
      .join("; "),
  };
}

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
 * What a selected token says beside the horizontal line (DEP-1): the Task and how it stands; the
 * chain as status pills, what must end first on the left; when it unblocks; and the first thing
 * in the chain for the viewer, with its action. A blocker says what it holds up. The vertical line
 * says it in its strip (`WayStrip`); this goes with the horizontal line.
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
        <p className="text-muted-foreground">{holdsUp(chain)?.when}</p>
      )}
      {blocked && (
        <div className="flex items-center gap-2">
          <span>
            <b className="font-semibold">First:</b>{" "}
            {firstWords(chain.first) ?? <span className="text-muted-foreground">nothing for you</span>}
          </span>
          {chain.first.kind !== "none" && action && <span className="ml-auto">{action}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * A selected Task's way, in a strip above the line (vf-7): "DARK-21's way", its holder, key and
 * age, what it can do next ("next: pass → Review", each outcome open to it from its Step); when
 * its chain says something must end first, when it unblocks and the first move, with its button
 * (Answer, Claim) and the question waiting with a Member; when it blocks others, how many, which
 * ones behind an ⓘ; and × that clears the selection. A region of its own; on a phone it stacks.
 */
export function WayStrip({
  chain,
  next,
  me,
  action,
  aimed,
  onOpen,
  onClear,
  now,
  ref,
}: {
  chain: Chain;
  /** The Task's next outcomes from its Step, each with its target's name. */
  next: readonly { outcome: string; to: string }[];
  me: string;
  action?: ReactNode;
  /** A question the chain waits on, with a Member at no Step. */
  aimed?: LineTask;
  onOpen?: (key: string) => void;
  onClear: () => void;
  now: number;
  ref?: Ref<HTMLElement>;
}) {
  const t = chain.task;
  const since = t.holder ? t.heldSince : t.since;
  const when = unblocksWhen(chain);
  const blocked = t.blockers.length > 0;
  const first = firstWords(chain.first);
  const up = holdsUp(chain);
  const name = `${t.key}'s way`;
  const asker = (m: LineMember) => (m.id === me ? "you" : m.name);
  return (
    <section ref={ref} tabIndex={-1} role="region" aria-label={name} data-way={t.id} className="@container mb-3 outline-none">
      <div className="relative flex flex-col items-start gap-1.5 rounded-lg border border-foreground bg-background py-1 pr-9 pl-1.5 text-xs @xl:flex-row @xl:flex-wrap @xl:items-center @xl:gap-x-3">
        <span className="rounded-full bg-foreground px-2 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap text-background">{name}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {t.holder ? <MemberAvatar member={t.holder} working={t.holder.working} /> : <Glyph state={blocked ? "blocked" : "waiting"} />}
          {onOpen ? (
            <button type="button" data-way-key aria-label={`Open ${t.key}`} onClick={() => onOpen(t.key)} className="rounded font-mono text-[11.5px] hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              {t.key}
            </button>
          ) : (
            <span className="font-mono text-[11.5px]">{t.key}</span>
          )}
          {since !== undefined && <span className="text-muted-foreground tabular-nums">{tokenTime(now - since)}</span>}
          {next.length > 0 && (
            <span className="ml-1">
              next:{" "}
              {next.map((n, i) => (
                <Fragment key={`${n.outcome}:${n.to}`}>
                  {i > 0 && " · "}
                  <b className="font-semibold">{n.outcome}</b> → {n.to}
                </Fragment>
              ))}
            </span>
          )}
          {when && <span className="text-state-blocked">{when}</span>}
          {up && (
            <>
              <span className="font-semibold">{up.count}</span>
              {!blocked && (
                <InfoTip label={`${up.count}: ${up.when}`} className="-ml-1">
                  {up.when}
                </InfoTip>
              )}
            </>
          )}
          {aimed?.aimedAt && (
            <span
              className="inline-flex h-[22px] items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-state-waiting pr-2 pl-1 whitespace-nowrap"
              aria-label={`${aimed.key} ${aimed.title}, with ${asker(aimed.aimedAt)}`}
            >
              <MemberAvatar member={aimed.aimedAt} />
              <span className="font-mono text-[11px]">{aimed.key}</span>
              <span className="text-muted-foreground">with {asker(aimed.aimedAt)}</span>
            </span>
          )}
        </span>
        {blocked && (
          <span className="flex items-center gap-2">
            <span>
              <b className="font-semibold">First:</b> {first ?? <span className="text-muted-foreground">nothing for you</span>}
            </span>
            {first && action}
          </span>
        )}
        <button
          type="button"
          aria-label="Clear"
          onClick={onClear}
          className="absolute top-1 right-1 inline-grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring @xl:top-1/2 @xl:-translate-y-1/2"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
