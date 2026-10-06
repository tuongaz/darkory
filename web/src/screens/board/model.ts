import { useMemo } from "react";
import type { Feature, Member, Task, Team } from "@/api/client";
import { useDirectory, useTeams } from "@/api/queries";
import { useNow } from "@/clock";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { blocking, statusGlyphs, type Status } from "./derive";
import { useClaimTrails, useStatuses, useTeamFeatures, useTeamTasks } from "./queries";

/** Everything the Team's Tasks views read, joined: the records, lookups by id, and who is looking. */
export type BoardModel = ReturnType<typeof useBoardModel>;

export function useBoardModel(teamRef: string) {
  const teams = useTeams();
  const team: Team | undefined = teams.data?.find((t) => t.key === teamRef || t.id === teamRef);
  const statuses = useStatuses();
  const features = useTeamFeatures(team?.key);
  const tasks = useTeamTasks(team?.key);
  const trails = useClaimTrails(team?.key);
  const dir = useDirectory();
  const me = useCurrentMe();
  const now = useNow();

  const lookups = useMemo(() => {
    const statusList = statuses.data ?? [];
    return {
      statusList,
      statusById: new Map<string, Status>(statusList.map((s) => [s.id, s])),
      glyphs: statusGlyphs(statusList),
      featureList: features.data ?? [],
      featureById: new Map<string, Feature>((features.data ?? []).map((f) => [f.id, f])),
      blocks: blocking(tasks.data ?? []),
    };
  }, [statuses.data, features.data, tasks.data]);

  const inTeam = !!team && me.teams.some((t) => t.id === team.id);
  return {
    team,
    teamsLoaded: !teams.isPending,
    statuses,
    features,
    tasks,
    trails,
    members: dir.members,
    skills: dir.skills,
    me,
    /** Whether the signed-in Member is in the Team, and so may move its Tasks between Statuses. */
    inTeam,
    now,
    ...lookups,
  };
}

/** The Task's Feature, from the model's lookups. */
export function featureOf(model: Pick<BoardModel, "featureById">, task: Task): Feature | undefined {
  return model.featureById.get(task.feature_id);
}

/** The Member holding the Task's live Claim, or for a done Task the one who completed it. */
export function holderOf(task: Task, model: Pick<BoardModel, "members" | "trails" | "now">): Member | undefined {
  const claim = liveClaim(task, model.now);
  if (claim) return model.members.get(claim.holder_id);
  if (task.state === "done") {
    const by = model.trails.get(task.id)?.completedBy;
    return by ? model.members.get(by) : undefined;
  }
  return undefined;
}

/** The Member a Task is aimed at by name, while nobody holds it. */
export function aimedAt(task: Task, model: Pick<BoardModel, "members" | "now">): Member | undefined {
  if (!task.aimed_at_id || task.state !== "open" || liveClaim(task, model.now)) return undefined;
  return model.members.get(task.aimed_at_id);
}
