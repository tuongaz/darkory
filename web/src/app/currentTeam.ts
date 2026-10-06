import { useEffect } from "react";
import { useMatch } from "react-router";
import type { Team } from "@/api/client";
import { useTeams } from "@/api/queries";
import { useCurrentMe } from "@/me";

// The Team last shown, so G B from the Inbox returns to the board you came from.
let lastTeamKey: string | undefined;

/**
 * The Team the screen is about: the one in the URL (/teams/:team/…), else the Team last shown,
 * else the signed-in Member's first Team, else the Organisation's first. Undefined with no Teams.
 */
export function useCurrentTeam(): Team | undefined {
  const me = useCurrentMe();
  const teams = useTeams().data ?? [];
  const inUrl = useMatch("/teams/:team/*")?.params.team;
  const byKey = (key: string | undefined) => (key ? teams.find((t) => t.key === key || t.id === key) : undefined);
  const fromUrl = byKey(inUrl);
  useEffect(() => {
    if (fromUrl) lastTeamKey = fromUrl.key;
  }, [fromUrl]);
  return fromUrl ?? byKey(lastTeamKey) ?? byKey(me.teams[0]?.key) ?? teams[0];
}

/** The path of a Team's Tasks, as a list or a board. */
export function teamTasksPath(team: Pick<Team, "key">, view?: "list" | "board"): string {
  return `/teams/${encodeURIComponent(team.key)}/tasks${view ? `?view=${view}` : ""}`;
}

export function teamFeaturesPath(team: Pick<Team, "key">): string {
  return `/teams/${encodeURIComponent(team.key)}/features`;
}
