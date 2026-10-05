import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, call, type Feature, type FeatureDetail, type TaskCounts } from "../api/client";
import { allPages } from "../api/pages";
import { keys, useDirectory, useTeams } from "../api/queries";
import { Loaded, Refusal } from "../components/ui";
import { FeatureStateBadge, MemberName } from "../components/work";
import { useCurrentMe } from "../me";

/** A Team's Features in Rank order, with their Task counts, ranked by dragging or with the arrow buttons. */
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
  const rank = useMutation({
    mutationFn: ({ feature, position }: { feature: Feature; position: number }) =>
      call(api.POST("/v1/features/{feature}/rank", { params: { path: { feature: feature.id } }, body: { position } })),
  });
  const [dragging, setDragging] = useState<Feature | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

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
                    <li
                      key={f.id}
                      className={rowClass(f, dragging, over)}
                      // Dropping a Feature on another moves it to that one's place, as the buttons do.
                      onDragOver={(e) => {
                        if (!dragging || dragging.id === f.id) return;
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                        setOver(f.id);
                      }}
                      onDragLeave={() => setOver((id) => (id === f.id ? null : id))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragging && dragging.id !== f.id) rank.mutate({ feature: dragging, position: f.rank });
                        endDrag();
                      }}
                    >
                      <span
                        className="drag-handle"
                        draggable={!rank.isPending}
                        aria-hidden="true"
                        title={`Drag ${f.key} to another place in the Rank`}
                        onDragStart={(e) => {
                          setDragging(f);
                          if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", f.key);
                            const row = e.currentTarget.closest("li");
                            if (row) e.dataTransfer.setDragImage(row, 16, 16);
                          }
                        }}
                        onDragEnd={endDrag}
                      >
                        ⠿
                      </span>
                      <span className="rank" aria-label={`Rank ${f.rank}`}>
                        {f.rank}
                      </span>
                      <div className="grow">
                        <Link to={`/features/${f.key}`} draggable={false}>
                          <span className="key">{f.key}</span> {f.title}
                        </Link>
                        <div className="meta">
                          <FeatureStateBadge state={f.state} /> owned by <MemberName id={f.owner_id} />
                          <Counts counts={f.task_counts} />
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
      <FileFeature teamKey={teamKey} />
    </>
  );
}

// A Feature dropped on one below it lands after it, and on one above it lands before it.
function rowClass(f: Feature, dragging: Feature | null, over: string | null): string | undefined {
  const drop = dragging && over === f.id && (dragging.rank < f.rank ? "drop-after" : "drop-before");
  const c = [f.state !== "open" && "ended", dragging?.id === f.id && "dragging", drop];
  return c.filter(Boolean).join(" ") || undefined;
}

function Counts({ counts }: { counts: TaskCounts }) {
  const parts = [`${counts.open} open${counts.claimed ? ` (${counts.claimed} claimed)` : ""}`, `${counts.done} done`];
  if (counts.dropped) parts.push(`${counts.dropped} dropped`);
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
