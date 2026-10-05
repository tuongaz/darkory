import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { api, call, fileBody, type Feature, type Task } from "../api/client";
import { keys, useDirectory } from "../api/queries";
import { useNow } from "../clock";
import { EvidenceSection, ObservationItems } from "../components/records";
import { ConfirmButton, Loaded, Refusal, Time } from "../components/ui";
import { FeatureStateBadge, Holder, MemberName, Needs, TaskLink, TaskStateBadges } from "../components/work";
import { isOnReportingLine, useCurrentMe } from "../me";
import { liveClaim } from "../work";

/** A Feature: its Tasks, Evidence and unreviewed Observations, and its owner's decisions. */
export function FeatureView() {
  const { feature: ref = "" } = useParams();
  const detail = useQuery({
    queryKey: keys.feature(ref),
    queryFn: () => call(api.GET("/v1/features/{feature}", { params: { path: { feature: ref } } })),
  });
  return (
    <Loaded query={detail}>
      {({ feature, tasks, evidence }) => (
        // Keyed so the forms start afresh when a link leads to another Feature.
        <Fragment key={feature.id}>
          <FeatureHeader feature={feature} />
          <OwnerActions feature={feature} />
          <section aria-labelledby="tasks-heading">
            <h2 id="tasks-heading">Tasks</h2>
            <TaskList tasks={tasks} />
          </section>
          {feature.state === "open" && <FileTask feature={feature} tasks={tasks} />}
          <EvidenceSection
            evidence={evidence}
            attach={(file) =>
              call(
                api.POST("/v1/features/{feature}/evidence", {
                  params: { path: { feature: feature.id }, query: { filename: file.name } },
                  ...fileBody(file),
                }),
              )
            }
          />
          <UnreviewedObservations feature={feature} tasks={tasks} />
        </Fragment>
      )}
    </Loaded>
  );
}

function FeatureHeader({ feature }: { feature: Feature }) {
  const { teams } = useDirectory();
  const team = teams.get(feature.team_id);
  return (
    <header className="record-header">
      <p className="crumbs">
        <Link to={team ? `/?team=${team.key}` : "/"}>{team ? `${team.name} Board` : "Board"}</Link>
      </p>
      <h1>
        <span className="key">{feature.key}</span> {feature.title}
      </h1>
      <p className="meta">
        <FeatureStateBadge state={feature.state} /> Rank {feature.rank} · owned by <MemberName id={feature.owner_id} /> ·
        filed by <MemberName id={feature.filed_by} /> <Time at={feature.created_at} />
        {feature.ended_at && (
          <>
            {" "}
            · ended <Time at={feature.ended_at} />
          </>
        )}
        {feature.from_retrospective_task_id && (
          <>
            {" "}
            · filed by a <Link to={`/tasks/${feature.from_retrospective_task_id}`}>Retrospective</Link>
          </>
        )}
      </p>
      {feature.description && <p className="body">{feature.description}</p>}
    </header>
  );
}

function OwnerActions({ feature }: { feature: Feature }) {
  const me = useCurrentMe();
  const { members, memberList } = useDirectory();
  const [owner, setOwner] = useState("");
  const isOwner = feature.owner_id === me.member.id;
  const canPass = isOwner || isOnReportingLine(members, me.member.id, feature.owner_id);
  const ship = useMutation({
    mutationFn: () => call(api.POST("/v1/features/{feature}/ship", { params: { path: { feature: feature.id } } })),
  });
  const drop = useMutation({
    mutationFn: () => call(api.POST("/v1/features/{feature}/drop", { params: { path: { feature: feature.id } } })),
  });
  const pass = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/features/{feature}/owner", { params: { path: { feature: feature.id } }, body: { owner } })),
    onSuccess: () => setOwner(""),
  });
  if (!canPass) return null;
  return (
    <section aria-label="Owner's decisions" className="panel">
      {isOwner && feature.state === "open" && (
        <div className="row">
          <button type="button" onClick={() => ship.mutate()} disabled={ship.isPending}>
            Ship
          </button>
          <ConfirmButton confirm="Drop the Feature and its open Tasks" onConfirm={() => drop.mutate()} disabled={drop.isPending}>
            Drop
          </ConfirmButton>
        </div>
      )}
      <Refusal error={ship.error} />
      <Refusal error={drop.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          pass.mutate();
        }}
      >
        <label>
          Pass ownership to
          <select required value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Choose a Member</option>
            {memberList
              .filter((m) => m.id !== feature.owner_id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!owner || pass.isPending}>
          Pass ownership
        </button>
      </form>
      <Refusal error={pass.error} />
    </section>
  );
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const now = useNow();
  if (tasks.length === 0) return <p className="muted">No Tasks.</p>;
  return (
    <ul className="list">
      {tasks.map((t) => {
        const claim = liveClaim(t, now);
        return (
          <li key={t.id}>
            <div className="grow">
              <TaskLink task={t} />
              <div className="meta">
                <TaskStateBadges task={t} /> <Needs task={t} />
                {claim && (
                  <>
                    {" "}
                    · <Holder claim={claim} />
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FileTask({ feature, tasks }: { feature: Feature; tasks: Task[] }) {
  const { memberList, skillList } = useDirectory();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState<"skill" | "member">("skill");
  const [skill, setSkill] = useState("");
  const [aimedAt, setAimedAt] = useState("");
  const [blocks, setBlocks] = useState("");
  const [filed, setFiled] = useState<Task | null>(null);
  const file = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks", {
          body: {
            feature: feature.id,
            title,
            description: description || undefined,
            skill: target === "skill" ? skill : undefined,
            aimed_at: target === "member" ? aimedAt : undefined,
            blocks: blocks || undefined,
          },
        }),
      ),
    onSuccess: (detail) => {
      setFiled(detail.task);
      setTitle("");
      setDescription("");
      setBlocks("");
    },
  });
  const open = tasks.filter((t) => t.state === "open");
  return (
    <section aria-labelledby="file-task" className="panel">
      <h2 id="file-task">File a Task</h2>
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
        <fieldset>
          <legend>Who can take it</legend>
          <label className="check">
            <input type="radio" name="target" checked={target === "skill"} onChange={() => setTarget("skill")} />A
            Member with a Skill
          </label>
          <label className="check">
            <input type="radio" name="target" checked={target === "member"} onChange={() => setTarget("member")} />
            One Member, by name
          </label>
          {target === "skill" ? (
            <label>
              Skill
              <select required value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">Choose a Skill</option>
                {skillList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Aimed at
              <select required value={aimedAt} onChange={(e) => setAimedAt(e.target.value)}>
                <option value="">Choose a Member</option>
                {memberList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <label>
          Blocks
          <select value={blocks} onChange={(e) => setBlocks(e.target.value)}>
            <option value="">Nothing</option>
            {open.map((t) => (
              <option key={t.id} value={t.id}>
                {t.key} {t.title}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="submit" disabled={file.isPending}>
            File Task
          </button>
        </div>
      </form>
      <Refusal error={file.error} />
      {filed && (
        <p role="status">
          Filed <TaskLink task={filed} />.
        </p>
      )}
    </section>
  );
}

function UnreviewedObservations({ feature, tasks }: { feature: Feature; tasks: Task[] }) {
  const observations = useQuery({
    queryKey: keys.featureObservations(feature.id),
    queryFn: () =>
      call(
        api.GET("/v1/features/{feature}/observations", {
          params: { path: { feature: feature.id }, query: { reviewed: false } },
        }),
      ).then((r) => r.items),
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <section aria-labelledby="observations-heading">
      <h2 id="observations-heading">Unreviewed Observations</h2>
      <Loaded query={observations}>
        {(items) =>
          items.length === 0 ? (
            <p className="muted">None waiting for the Retrospective.</p>
          ) : (
            <ObservationItems
              observations={items}
              showTask={(id) => {
                const t = byId.get(id);
                return t ? <TaskLink task={t} /> : null;
              }}
            />
          )
        }
      </Loaded>
    </section>
  );
}
