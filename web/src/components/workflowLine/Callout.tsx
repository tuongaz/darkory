import { XIcon } from "lucide-react";
import { Fragment, type ReactNode, type Ref } from "react";
import { InfoTip } from "@/components/InfoTip";
import { MemberAvatar } from "@/components/MemberAvatar";
import { unblocksWhen, type Chain } from "./data";
import { tokenTime, type LineMember, type LineTask } from "./model";
import { Glyph } from "./Token";

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
