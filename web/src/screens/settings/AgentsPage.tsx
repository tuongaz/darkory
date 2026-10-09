import { BotIcon, PlusIcon } from "lucide-react";
import { Link } from "react-router";
import { BarAction } from "@/app/TopBar";
import type { Member, MemberDetail } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SettingsFrame, tableHead, tableRow } from "./frame";
import { NewMemberDialog } from "./NewMember";
import { MemberName, ProjectsCell } from "./parts";
import { memberPath, useNewParam } from "./paths";
import { useMemberDetails } from "./queries";

// Agent · Runner · Model · Projects · Skills. A phone keeps Agent and Runner.
const cols = "grid-cols-[minmax(0,1fr)_120px] md:grid-cols-[200px_120px_minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[200px_120px_180px_minmax(0,1fr)_minmax(0,1fr)]";
const wide = "hidden md:flex";
const wider = "hidden lg:flex";

/**
 * Settings › Organisation › Agents: the agent Members and how each works: started by the Runner on
 * a model, paused, or bringing its own session through its token. New agent is New Member of kind
 * agent: its token shown once, its Runner settings, its Projects.
 */
export function AgentsPage() {
  const { open, setOpen } = useNewParam();
  const { members, details, pending } = useMemberDetails();
  const agents = (members.data ?? []).filter((m) => m.kind === "agent");
  const newAgent = (
    <Button onClick={() => setOpen(true)}>
      <PlusIcon />
      New agent
    </Button>
  );

  return (
    <SettingsFrame crumbs={[{ label: "Agents" }]} pad={false} primary={<BarAction icon={<PlusIcon />} label="New agent" onClick={() => setOpen(true)} />}>
      {members.isError ? (
        <Refusal error={members.error} className="px-6 py-4" />
      ) : members.isPending ? (
        <Skeleton className="m-6 h-8" />
      ) : agents.length === 0 ? (
        <EmptyState icon={<BotIcon />} title="No agents yet" action={newAgent}>
          An agent is a Member like any other: it takes Tasks at the Steps whose Skills it has.
        </EmptyState>
      ) : (
        <div role="table" aria-label="Agents" className="min-w-0">
          <div role="row" className={cn(tableHead, cols)}>
            <span role="columnheader">Agent</span>
            <span role="columnheader">Runner</span>
            <span role="columnheader" className={wider}>
              Model
            </span>
            <span role="columnheader" className={wide}>
              Projects
            </span>
            <span role="columnheader" className={wide}>
              Skills
            </span>
          </div>
          {agents.map((m) => (
            <AgentRow key={m.id} member={m} detail={details.get(m.id)} loading={pending} />
          ))}
        </div>
      )}
      {open && <NewMemberDialog kind="agent" fixedKind onClose={() => setOpen(false)} />}
    </SettingsFrame>
  );
}

/** How the agent works, in two words: its row's Runner pill. */
function RunnerPill({ member }: { member: Member }) {
  if (member.deactivated_at) return <Pill tone="dropped">Deactivated</Pill>;
  if (!member.agent) return <Pill tone="outline">Own token</Pill>;
  if (member.agent.paused) return <Pill tone="claimed">Paused</Pill>;
  return <Pill tone="agent">Runner</Pill>;
}

function AgentRow({ member, detail, loading }: { member: Member; detail?: MemberDetail; loading: boolean }) {
  const dim = !!member.deactivated_at && "opacity-60";
  return (
    <div role="row" aria-label={member.name} className={cn(tableRow, "hover:bg-accent/60", cols)}>
      <span role="cell" className="min-w-0">
        <Link to={memberPath(member)} className={cn("flex min-w-0 font-medium after:absolute after:inset-0 focus-visible:outline-none", dim)}>
          <MemberName member={member} />
        </Link>
      </span>
      <span role="cell">
        <RunnerPill member={member} />
      </span>
      <span role="cell" className={cn(wider, "min-w-0", dim)}>
        {member.agent ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{member.agent.model}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-3 overflow-hidden", dim)}>
        {detail && <ProjectsCell projects={detail.projects} />}
        {!detail && loading && <Skeleton className="h-4 w-20" />}
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5 overflow-hidden", dim)}>
        {detail?.skills.map((s) => (
          <Pill key={s.id} tone="outline">
            {s.name}
          </Pill>
        ))}
        {detail?.skills.length === 0 && <span className="text-muted-foreground">None</span>}
      </span>
    </div>
  );
}
