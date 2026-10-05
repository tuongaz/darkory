import { Link } from "react-router";
import type { Claim, FeatureState, Task } from "../api/client";
import { useDirectory } from "../api/queries";
import { useNow } from "../clock";
import { liveClaim } from "../work";
import { Badge, RelativeTime } from "./ui";

export function MemberName({ id }: { id: string | undefined }) {
  const { members } = useDirectory();
  if (!id) return <span className="muted">Darkory</span>;
  const m = members.get(id);
  if (!m) return <span className="muted">{id.slice(0, 8)}</span>;
  return (
    <span className="member">
      {m.name}
      {m.kind === "agent" && <span className="kind"> (agent)</span>}
    </span>
  );
}

export function SkillName({ id }: { id: string | undefined }) {
  const { skills } = useDirectory();
  if (!id) return null;
  return <span className="skill">{skills.get(id)?.name ?? id.slice(0, 8)}</span>;
}

export function FeatureStateBadge({ state }: { state: FeatureState }) {
  return <Badge tone={state}>{state}</Badge>;
}

/** A Task's state, with whether it is held or blocked, which are not states. */
export function TaskStateBadges({ task }: { task: Task }) {
  const now = useNow();
  return (
    <>
      <Badge tone={task.state}>{task.state}</Badge>
      {task.state === "open" && liveClaim(task, now) && <Badge tone="claimed">claimed</Badge>}
      {task.state === "open" && task.blocked && <Badge tone="blocked">blocked</Badge>}
      {task.kind !== "work" && <Badge>{task.kind === "breakdown" ? "Breakdown" : "Retrospective"}</Badge>}
    </>
  );
}

/** What a Task needs: a Skill, or the Member it is aimed at. */
export function Needs({ task }: { task: Task }) {
  if (task.aimed_at_id) {
    return (
      <span>
        aimed at <MemberName id={task.aimed_at_id} />
      </span>
    );
  }
  if (task.skill_id) {
    return (
      <span>
        needs <SkillName id={task.skill_id} />
      </span>
    );
  }
  return null;
}

/** Who holds a Claim and until when. */
export function Holder({ claim }: { claim: Claim }) {
  return (
    <span>
      held by <MemberName id={claim.holder_id} />
      {claim.expires_at ? (
        <>
          , expires <RelativeTime at={claim.expires_at} />
        </>
      ) : (
        ", no expiry"
      )}
    </span>
  );
}

export function TaskLink({ task }: { task: Pick<Task, "key" | "title"> }) {
  return (
    <Link to={`/tasks/${task.key}`}>
      <span className="key">{task.key}</span> {task.title}
    </Link>
  );
}
