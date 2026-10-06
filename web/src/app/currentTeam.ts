import { useEffect, useSyncExternalStore } from "react";
import { useMatch } from "react-router";
import type { Team } from "@/api/client";
import { useTeams } from "@/api/queries";
import { useCurrentMe } from "@/me";

/** Which of a Team's lists a record belongs to: a Task to its Tasks, a Feature to its Features. */
export type TeamArea = "tasks" | "features";

// The Team last shown, remembered by this browser, so G B returns to the board you came from.
const lastTeamKey = "darkory.team";
// The Team of the Task or Feature whose page is showing, which the page reports once it has read it.
let recordTeam: { team: string; area: TeamArea } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function lastTeam(): string | undefined {
  try {
    return localStorage.getItem(lastTeamKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string) {
  if (lastTeam() === key) return;
  try {
    localStorage.setItem(lastTeamKey, key);
  } catch {
    // Storage refused (a private window): G B falls back to the Member's first Team.
  }
  changed();
}

/**
 * A Task's or a Feature's page says which Team it is in, so the sidebar opens that Team and marks
 * its Tasks or Features while the page shows.
 */
export function useReportTeam(teamKey: string | undefined, area: TeamArea) {
  useEffect(() => {
    if (!teamKey) return;
    const mine = { team: teamKey, area };
    recordTeam = mine;
    changed();
    return () => {
      if (recordTeam !== mine) return;
      recordTeam = null;
      changed();
    };
  }, [teamKey, area]);
}

/** On a Task's or a Feature's page, the Team the page reported and which of its lists it is in. */
export function useRecordTeam(): { team: string; area: TeamArea } | undefined {
  useSyncExternalStore(subscribe, () => version);
  const onTask = useMatch("/tasks/:task") !== null;
  const onFeature = useMatch("/features/:feature") !== null;
  return (onTask || onFeature) && recordTeam ? recordTeam : undefined;
}

/**
 * The Team the screen is about: the one in the URL (/teams/:team/…) or of the Task or Feature
 * shown, else the Team last shown in this browser, else the signed-in Member's first Team, else
 * the Organisation's first. Undefined with no Teams.
 */
export function useCurrentTeam(): Team | undefined {
  const me = useCurrentMe();
  const teams = useTeams().data ?? [];
  const inUrl = useMatch("/teams/:team/*")?.params.team;
  const record = useRecordTeam();
  const byKey = (key: string | undefined) => (key ? teams.find((t) => t.key === key || t.id === key) : undefined);
  const shown = byKey(inUrl) ?? byKey(record?.team);
  useEffect(() => {
    if (shown) remember(shown.key);
  }, [shown]);
  return shown ?? byKey(lastTeam()) ?? byKey(me.teams[0]?.key) ?? teams[0];
}

/** The path of a Team's Tasks, as a list or a board. */
export function teamTasksPath(team: Pick<Team, "key">, view?: "list" | "board"): string {
  return `/teams/${encodeURIComponent(team.key)}/tasks${view ? `?view=${view}` : ""}`;
}

export function teamFeaturesPath(team: Pick<Team, "key">): string {
  return `/teams/${encodeURIComponent(team.key)}/features`;
}
