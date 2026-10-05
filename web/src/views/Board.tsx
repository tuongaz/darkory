import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, call, type Feature, type FeatureDetail, type Task } from "../api/client";
import { allPages } from "../api/pages";
import { keys, useDirectory, useTeams } from "../api/queries";
import { useNow } from "../clock";
import { Loaded, Refusal } from "../components/ui";
import { FeatureStateBadge, MemberName } from "../components/work";
import { useCurrentMe } from "../me";
import { liveClaim } from "../work";

/** A Team's Features in Rank order, with their Task counts. */
export function Board() {
  const me = useCurrentMe();
  const teams = useTeams();
  const [params, setParams] = useSearchParams();
  const teamKey = params.get("team") ?? me.teams[0]?.key ?? teams.data?.[0]?.key;

  return (
    <>
      <div className="title-row">
        <h1>Board</h1>
        <Loaded query={teams}>
          {(list) =>
            list.length > 0 && (
              <label className="inline">
                Team
                <select value={teamKey} onChange={(e) => setParams({ team: e.target.value })}>
                  {list.map((t) => (
                    <option key={t.id} value={t.key}>
                      {t.name} ({t.key})
                    </option>
                  ))}
                </select>
              </label>
            )
          }
        </Loaded>
      </div>
      {teamKey ? (
        <TeamBoard key={teamKey} teamKey={teamKey} />
      ) : (
        teams.isSuccess && (
          <p>
            There are no Teams yet.{" "}
            {me.member.admin ? <Link to="/admin/teams">Create one</Link> : "An admin creates them."}
          </p>
        )
      )}
    </>
  );
}

function TeamBoard({ teamKey }: { teamKey: string }) {
  const [showEnded, setShowEnded] = useState(false);
  const features = useQuery({
    queryKey: keys.features(teamKey),
    queryFn: () =>
      allPages((cursor) => call(api.GET("/v1/features", { params: { query: { team: teamKey, limit: 500, cursor } } }))),
  });
  // A Feature carries no Task counts, so the board counts the Team's Tasks itself.
  const tasks = useQuery({
    queryKey: keys.teamTasks(teamKey),
    queryFn: () =>
      allPages((cursor) => call(api.GET("/v1/tasks", { params: { query: { team: teamKey, limit: 500, cursor } } }))),
  });
  const now = useNow();
  const counts = useMemo(() => countByFeature(tasks.data ?? [], now), [tasks.data, now]);
  const rank = useMutation({
    mutationFn: ({ feature, position }: { feature: Feature; position: number }) =>
      call(api.POST("/v1/features/{feature}/rank", { params: { path: { feature: feature.id } }, body: { position } })),
  });

  return (
    <>
      <Loaded query={features}>
        {(all) => {
          const shown = [...all].sort((a, b) => a.rank - b.rank).filter((f) => showEnded || f.state === "open");
          return (
            <section aria-label="Features in Rank order">
              <div className="toolbar">
                <label className="check">
                  <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
                  Show shipped and dropped
                </label>
              </div>
              <Refusal error={rank.error} />
              {shown.length === 0 ? (
                <p className="muted">No Features{showEnded ? "" : " open"} in this Team.</p>
              ) : (
                <ol className="list board">
                  {shown.map((f, i) => (
                    <li key={f.id} className={f.state !== "open" ? "ended" : undefined}>
                      <span className="rank" aria-label={`Rank ${f.rank}`}>
                        {f.rank}
                      </span>
                      <div className="grow">
                        <Link to={`/features/${f.key}`}>
                          <span className="key">{f.key}</span> {f.title}
                        </Link>
                        <div className="meta">
                          <FeatureStateBadge state={f.state} /> owned by <MemberName id={f.owner_id} />
                          <Counts counts={counts.get(f.id)} />
                        </div>
                      </div>
                      <div className="rank-buttons">
                        <button
                          type="button"
                          aria-label={`Move ${f.key} up`}
                          disabled={i === 0 || rank.isPending}
                          onClick={() => rank.mutate({ feature: f, position: shown[i - 1].rank })}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${f.key} down`}
                          disabled={i === shown.length - 1 || rank.isPending}
                          onClick={() => rank.mutate({ feature: f, position: shown[i + 1].rank })}
                        >
                          ↓
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        }}
      </Loaded>
      <Refusal error={tasks.error} />
      <FileFeature teamKey={teamKey} />
    </>
  );
}

type TaskCounts = { open: number; claimed: number; done: number; dropped: number };

function countByFeature(tasks: Task[], now: number): Map<string, TaskCounts> {
  const m = new Map<string, TaskCounts>();
  for (const t of tasks) {
    const c = m.get(t.feature_id) ?? { open: 0, claimed: 0, done: 0, dropped: 0 };
    if (t.state === "open") c[liveClaim(t, now) ? "claimed" : "open"]++;
    else c[t.state]++;
    m.set(t.feature_id, c);
  }
  return m;
}

function Counts({ counts }: { counts: TaskCounts | undefined }) {
  const c = counts ?? { open: 0, claimed: 0, done: 0, dropped: 0 };
  const parts = [`${c.open} open`, `${c.claimed} claimed`, `${c.done} done`];
  if (c.dropped) parts.push(`${c.dropped} dropped`);
  return <span className="counts"> · Tasks: {parts.join(" · ")}</span>;
}

function FileFeature({ teamKey }: { teamKey: string }) {
  const { memberList } = useDirectory();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [filed, setFiled] = useState<FeatureDetail | null>(null);
  const file = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/features", {
          body: { team: teamKey, title, description: description || undefined, owner: owner || undefined },
        }),
      ),
    onSuccess: (detail) => {
      setFiled(detail);
      setTitle("");
      setDescription("");
      setOwner("");
    },
  });
  return (
    <section aria-labelledby="file-feature" className="panel">
      <h2 id="file-feature">File a Feature</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          file.mutate();
        }}
      >
        <label>
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Me</option>
            {memberList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="submit" disabled={file.isPending}>
            File Feature
          </button>
        </div>
      </form>
      <Refusal error={file.error} />
      {filed && (
        <p role="status">
          Filed <Link to={`/features/${filed.feature.key}`}>{filed.feature.key}</Link>, with its Breakdown Task.
        </p>
      )}
    </section>
  );
}
