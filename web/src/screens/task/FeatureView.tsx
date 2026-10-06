import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BanIcon, ChevronDownIcon, EllipsisIcon, LinkIcon, PaperclipIcon, PlusIcon, SearchXIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";
import { Link, useParams, type To } from "react-router";
import { toast } from "sonner";
import { ApiError, api, call, evidenceURL, isUnauthenticated, type Evidence, type FeatureDetail, type Task, type TaskDetail } from "@/api/client";
import { keys, useDirectory } from "@/api/queries";
import { teamFeaturesPath, teamTasksPath } from "@/app/currentTeam";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { FormDialog } from "@/components/FormDialog";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { SectionHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { StatusGlyph } from "@/components/StatusGlyph";
import { TeamMark } from "@/components/TeamMark";
import { ClockTime } from "@/components/Time";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { Field } from "./dialogs";
import { orderTasks, sizeText, statusGlyph, useMemberName, type StatusLike } from "./format";
import { Avatar, MemberName, Needs, TaskLink } from "./parts";
import { useFeature, useFeatureObservations, useStatuses, useTasks } from "./queries";
import { lapsedClaim } from "./record";
import { OutcomePill } from "./TaskRecord";

const kinds = { work: undefined, breakdown: "Break down", retrospective: "Retrospective" } as const;

/** /features/:feature (F-F1): the header, the Tasks by Status, the Evidence, the unreviewed Observations. */
export function FeaturePage() {
  const { feature: ref = "" } = useParams();
  const q = useFeature(ref);
  const { teams } = useDirectory();
  const me = useCurrentMe();
  const d = q.data;
  const team = d ? teams.get(d.feature.team_id) : undefined;
  const owner = d?.feature.owner_id === me.member.id;
  return (
    <>
      <TopBar
        crumbs={
          d
            ? [
                { label: team?.name ?? "Team", icon: team && <TeamMark team={team} />, to: team && teamTasksPath(team) },
                { label: "Features", to: team && teamFeaturesPath(team) },
                { label: d.feature.title },
              ]
            : [{ label: "Feature" }, { label: ref }]
        }
        primary={d && owner && <OwnerActions detail={d} />}
      />
      <Content className="px-6 py-7 lg:px-12">
        {d ? <FeatureBody detail={d} /> : <FeatureMissing query={q} />}
      </Content>
    </>
  );
}

function FeatureMissing({ query }: { query: ReturnType<typeof useFeature> }) {
  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  if (query.error instanceof ApiError && query.error.code === "not_found") {
    return (
      <EmptyState icon={<SearchXIcon />} title="No such Feature">
        Nothing has this key.
      </EmptyState>
    );
  }
  return isUnauthenticated(query.error) ? null : <Refusal error={query.error} />;
}

const featureStates = {
  open: { label: "Open", tone: "outline" },
  shipped: { label: "Shipped", tone: "done" },
  dropped: { label: "Dropped", tone: "dropped" },
} as const;

function FeatureBody({ detail }: { detail: FeatureDetail }) {
  const { feature } = detail;
  const statuses = useStatuses().data;
  const details = useTasks(detail.tasks.map((t) => t.key));
  const state = featureStates[feature.state];
  const tasks = orderTasks(detail.tasks, statuses);
  const counts = feature.task_counts;
  return (
    <div className="flex max-w-[1100px] flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <Key>{feature.key}</Key>
        <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{feature.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground">
          <Pill tone={state.tone}>{state.label}</Pill>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <span>
            Rank <b className="font-medium text-foreground">#{feature.rank}</b>
          </span>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <span className="inline-flex items-center gap-1.5">
            Owner <MemberName id={feature.owner_id} className="text-foreground" />
          </span>
        </div>
        {feature.description && <p className="mt-1.5 whitespace-pre-wrap">{feature.description}</p>}
      </header>

      <section aria-label="Tasks" className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <SectionHeader title="Tasks" count={detail.tasks.length} />
          <span className="text-muted-foreground tabular-nums">
            · {counts.done} done · {counts.open} open{counts.dropped ? ` · ${counts.dropped} dropped` : ""}
          </span>
        </div>
        <div>
          <div className="flex h-7 items-center gap-2.5 border-b px-2 text-xs font-medium text-muted-foreground" aria-hidden>
            <span className="w-[80px]">Status</span>
            <span className="flex-1">Task</span>
            <span className="hidden w-[140px] md:block">Needs</span>
            <span className="w-[72px]" />
          </div>
          <ul>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} detail={details.byKey.get(t.key)} statuses={statuses} />
            ))}
          </ul>
        </div>
      </section>

      <FeatureEvidence detail={detail} tasks={details.byKey} pending={details.pending} />
      <UnreviewedObservations detail={detail} />
    </div>
  );
}

/** One of the Feature's Tasks, opening its peek: Status, key, title, its marks, what it needs, who holds it. */
function TaskRow({ task, detail, statuses }: { task: Task; detail: TaskDetail | undefined; statuses: StatusLike[] | undefined }) {
  const peek = usePeekLink();
  const now = useNow();
  const status = statuses?.find((s) => s.id === task.status_id);
  const claim = liveClaim(task, now);
  const lapsed = !claim && detail ? lapsedClaim(detail) : undefined;
  const ended = task.state !== "open";
  const kind = kinds[task.kind];
  // A question (a Task aimed at a Member) says which Task waits on its answer.
  const blocks = task.aimed_at_id && !ended ? (detail?.blocking.filter((b) => b.state === "open") ?? []) : [];
  const last = detail?.claims.at(-1);
  const who = claim?.holder_id ?? (task.state === "done" && last?.how_ended === "completed" ? last.holder_id : undefined);
  return (
    <li>
      <Link
        to={peek(task.key)}
        className={cn("flex h-9 items-center gap-2.5 border-b px-2 hover:bg-accent", ended && "text-muted-foreground")}
        aria-label={`${task.key} ${task.title}`}
      >
        {status ? <StatusGlyph glyph={statusGlyph(status, statuses)} label={status.name} /> : <span className="size-3.5" />}
        <Key className="w-[56px]">{task.key}</Key>
        <span className={cn("min-w-0 flex-1 truncate", !ended && "font-medium")}>{task.title}</span>
        <span className="hidden flex-none items-center gap-1.5 sm:flex">
          {lapsed?.ended_at && (
            <Pill tone="dropped">
              Lapsed <ClockTime at={lapsed.ended_at} />
            </Pill>
          )}
          {task.open_blockers?.[0] && <Pill tone="blocked">Blocked by {task.open_blockers[0].key}</Pill>}
          {blocks[0] && (
            <Pill tone="secondary">
              <LinkIcon aria-hidden />
              blocks {blocks[0].key}
            </Pill>
          )}
          {claim?.expires_at && <HeartbeatMeter claim={claim} variant="compact" />}
          {kind && <Pill tone="secondary">{kind}</Pill>}
          {detail && detail.evidence.length > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${detail.evidence.length} Evidence`}>
              <PaperclipIcon className="size-3" aria-hidden />
              {detail.evidence.length}
            </span>
          )}
        </span>
        <span className="hidden w-[140px] flex-none truncate md:block">{!kind && !ended && <Needs task={task} short />}</span>
        <span className="flex w-5 flex-none justify-center">{who && <Avatar id={who} />}</span>
        <span className="w-11 flex-none text-right text-muted-foreground tabular-nums">
          <ClockTime at={task.ended_at ?? task.waiting_since} />
        </span>
      </Link>
    </li>
  );
}

/** The Feature's own Evidence and its Tasks', merged here: /v1 gives each on its own record. */
function FeatureEvidence({ detail, tasks, pending }: { detail: FeatureDetail; tasks: Map<string, TaskDetail>; pending: boolean }) {
  const name = useMemberName();
  const byId = new Map(detail.tasks.map((t) => [t.id, t]));
  const all: Evidence[] = [...detail.evidence, ...[...tasks.values()].flatMap((t) => t.evidence)].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2">
      <SectionHeader title="Evidence" count={pending ? undefined : all.length} />
      {pending && all.length === 0 ? (
        <Skeleton className="h-9 w-full" />
      ) : all.length === 0 ? (
        <p className="text-muted-foreground">None yet</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {all.map((e) => {
            const t = e.task_id ? byId.get(e.task_id) : undefined;
            return (
              <li key={e.id} className="flex h-9 min-w-0 items-center gap-2 rounded-md border px-3">
                <PaperclipIcon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
                <a href={evidenceURL(e.id)} download={e.filename} className="min-w-0 truncate hover:underline">
                  {e.filename}
                </a>
                <span className="flex-none text-muted-foreground">{sizeText(e.size)}</span>
                {t && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <TaskLink task={t}>
                      <Key>{t.key}</Key>
                    </TaskLink>
                  </>
                )}
                <span className="text-muted-foreground">·</span>
                <span className="hidden min-w-0 items-center gap-1.5 text-muted-foreground sm:inline-flex">
                  <Avatar id={e.attached_by} />
                  <span className="truncate">{name(e.attached_by)}</span>
                </span>
                <span className="ml-auto flex-none text-muted-foreground tabular-nums">
                  <ClockTime at={e.created_at} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function UnreviewedObservations({ detail }: { detail: FeatureDetail }) {
  const { feature } = detail;
  const q = useFeatureObservations(feature.key);
  const name = useMemberName();
  const byId = new Map(detail.tasks.map((t) => [t.id, t]));
  const items = q.data ?? [];
  return (
    <section aria-label="Unreviewed Observations" className="flex flex-col gap-2">
      <SectionHeader title="Unreviewed Observations" count={q.data ? items.length : undefined} />
      {q.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : q.isError ? (
        <Refusal error={q.error} />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">None yet</p>
      ) : (
        items.map((o) => {
          const t = byId.get(o.task_id);
          return (
            <article key={o.id} className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
              <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <OutcomePill outcome={o.outcome} />
                <Avatar id={o.author_id} />
                <span>{name(o.author_id)}</span>
                {t && (
                  <>
                    · <TaskLink task={t} />
                  </>
                )}
                · <ClockTime at={o.created_at} />
              </header>
              <p className="whitespace-pre-wrap">{o.body}</p>
            </article>
          );
        })
      )}
    </section>
  );
}

/** The owner's one split button: Ship, with Pass ownership and Drop Feature in its caret. */
function OwnerActions({ detail }: { detail: FeatureDetail }) {
  const { feature } = detail;
  const qc = useQueryClient();
  const peek = usePeekLink();
  const [open, setOpen] = useState<"pass" | "drop" | null>(null);
  const ship = useMutation({
    mutationFn: () => call(api.POST("/v1/features/{feature}/ship", { params: { path: { feature: feature.id } } })),
    onSuccess: (d) => {
      const retro = d.tasks.find((t) => t.kind === "retrospective" && t.state === "open");
      toast.success(`${feature.key} shipped`, { description: retro && `Filed ${retro.key} ${retro.title}` });
    },
    onError: async (err) => {
      if (!(err instanceof ApiError) || err.code !== "tasks_open") {
        toast.error(`${feature.key} not shipped`, { description: err.message });
        return;
      }
      // The refusal names no Tasks; the Feature's record does.
      const fresh = await qc.fetchQuery({
        queryKey: keys.feature(feature.key),
        queryFn: () => call(api.GET("/v1/features/{feature}", { params: { path: { feature: feature.key } } })),
        staleTime: 0,
      });
      const left = fresh.tasks.filter((t) => t.state === "open");
      toast.error(`Not shipped: ${left.length} ${left.length === 1 ? "Task" : "Tasks"} open`, {
        description: <OpenTasks tasks={left} to={peek} />,
        duration: 10_000,
      });
    },
  });
  if (feature.state !== "open") {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="More">
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setOpen("pass")}>
              <UserRoundIcon />
              Pass ownership
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {open === "pass" && <PassOwnershipDialog detail={detail} onOpenChange={(o) => setOpen(o ? "pass" : null)} />}
      </>
    );
  }
  return (
    <>
      <div className="inline-flex">
        <Button className="rounded-r-none" onClick={() => ship.mutate()} disabled={ship.isPending}>
          Ship
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" className="w-7 rounded-l-none border-l border-primary-foreground/20" aria-label="More Feature actions">
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setOpen("pass")}>
              <UserRoundIcon />
              Pass ownership
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setOpen("drop")}>
              <BanIcon />
              Drop Feature
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open === "pass" && <PassOwnershipDialog detail={detail} onOpenChange={(o) => setOpen(o ? "pass" : null)} />}
      {open === "drop" && <DropFeatureDialog detail={detail} onOpenChange={(o) => setOpen(o ? "drop" : null)} />}
    </>
  );
}

/** F-F2: the open Tasks that stand between a Feature and Ship, each opening its peek. */
function OpenTasks({ tasks, to }: { tasks: Task[]; to: (key: string) => To }) {
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex flex-wrap gap-1">
        {tasks.map((t) => (
          <Link key={t.id} to={to(t.key)} className="rounded-sm border px-1.5 font-mono text-[11.5px] text-foreground hover:bg-accent">
            {t.key}
          </Link>
        ))}
      </span>
      <span>Each must be Done or Dropped</span>
    </span>
  );
}

function PassOwnershipDialog({ detail, onOpenChange }: { detail: FeatureDetail; onOpenChange: (open: boolean) => void }) {
  const { feature } = detail;
  const { memberList } = useDirectory();
  const name = useMemberName();
  const [owner, setOwner] = useState<string | null>(null);
  const pass = useMutation({
    mutationFn: (to: string) => call(api.POST("/v1/features/{feature}/owner", { params: { path: { feature: feature.id } }, body: { owner: to } })),
    onSuccess: () => {
      toast.success(`${name(owner ?? undefined)} owns ${feature.key}`);
      onOpenChange(false);
    },
  });
  const choices = memberList.filter((m) => !m.deactivated_at && m.id !== feature.owner_id);
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={`Pass ownership of ${feature.key}`}
      description={feature.title}
      hint={owner ? `${name(owner)} decides Ship and Drop` : undefined}
      submitLabel="Pass ownership"
      submitDisabled={!owner}
      onSubmit={() => owner && pass.mutate(owner)}
      pending={pass.isPending}
      error={pass.error}
    >
      <Field label="New owner">
        <Command className="rounded-md border" label="New owner">
          <CommandInput placeholder="Find a Member" />
          <CommandList className="max-h-56">
            <CommandEmpty>No Member matches.</CommandEmpty>
            {choices.map((m) => (
              <CommandItem key={m.id} value={m.name} onSelect={() => setOwner(m.id)} data-checked={owner === m.id} className="data-[checked=true]:bg-accent">
                <MemberName id={m.id} />
                {owner === m.id && (
                  <Pill tone="waiting" className="ml-auto">
                    Chosen
                  </Pill>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </Field>
    </FormDialog>
  );
}

/** F-F4: what dropping the Feature ends — its open Tasks and their Claims — and the Retrospective it files. */
function DropFeatureDialog({ detail, onOpenChange }: { detail: FeatureDetail; onOpenChange: (open: boolean) => void }) {
  const { feature } = detail;
  const statuses = useStatuses().data;
  const name = useMemberName();
  const now = useNow();
  const drop = useMutation({
    mutationFn: () => call(api.POST("/v1/features/{feature}/drop", { params: { path: { feature: feature.id } } })),
    onSuccess: () => {
      toast.success(`${feature.key} dropped`);
      onOpenChange(false);
    },
  });
  const open = detail.tasks.filter((t) => t.state === "open");
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={`Drop ${feature.key} ${feature.title}?`}
      submitLabel="Drop Feature"
      destructive
      onSubmit={() => drop.mutate()}
      pending={drop.isPending}
      error={drop.error}
    >
      {open.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Drops {open.length} open {open.length === 1 ? "Task" : "Tasks"}
          </p>
          <ul className="rounded-md border">
            {open.map((t) => {
              const s = statuses?.find((x) => x.id === t.status_id);
              const c = liveClaim(t, now);
              return (
                <li key={t.id} className="flex h-[34px] min-w-0 items-center gap-2.5 border-b px-3 last:border-b-0">
                  {s ? <StatusGlyph glyph={statusGlyph(s, statuses)} label={s.name} /> : <span className="size-3.5" />}
                  <Key className="w-[52px]">{t.key}</Key>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {c && <span className="flex-none text-muted-foreground">{name(c.holder_id)}&apos;s Claim ends</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="flex flex-wrap items-center gap-2">
        <PlusIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Files Retrospective: {feature.title}
        <span className="text-muted-foreground">needs</span>
        <Pill tone="outline">retro</Pill>
      </p>
    </FormDialog>
  );
}
