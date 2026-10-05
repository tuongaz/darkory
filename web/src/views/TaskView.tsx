import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, call, fileBody, type Claim, type Note, type Task, type TaskDetail } from "../api/client";
import { keys, useDirectory } from "../api/queries";
import { useNow } from "../clock";
import { EvidenceSection, ObservationItems } from "../components/records";
import { Badge, ConfirmButton, Loaded, Refusal, RelativeTime, Time } from "../components/ui";
import { Holder, MemberName, Needs, SkillName, TaskLink, TaskStateBadges } from "../components/work";
import { isOnReportingLine, useCurrentMe } from "../me";
import { boundTo, liveClaim } from "../work";

/** A Task with its Claims, Notes, Observations, Evidence and blockers, and what the caller can do to it. */
export function TaskView() {
  const { task: ref = "" } = useParams();
  const detail = useQuery({
    queryKey: keys.task(ref),
    queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref } } })),
  });
  // Keyed so the forms start afresh when a link leads to another Task.
  return <Loaded query={detail}>{(d) => <TaskPage key={d.task.id} detail={d} />}</Loaded>;
}

function TaskPage({ detail }: { detail: TaskDetail }) {
  const { task, feature } = detail;
  const now = useNow();
  const claim = liveClaim(task, now);
  return (
    <>
      <header className="record-header">
        <p className="crumbs">
          <Link to={`/features/${feature.key}`}>
            <span className="key">{feature.key}</span> {feature.title}
          </Link>
        </p>
        <h1>
          <span className="key">{task.key}</span> {task.title}
        </h1>
        <p className="meta">
          <TaskStateBadges task={task} /> <Needs task={task} /> · filed by <MemberName id={task.filed_by} />{" "}
          <Time at={task.created_at} /> · waiting since <Time at={task.waiting_since} />
          {task.ended_at && (
            <>
              {" "}
              · ended <Time at={task.ended_at} />
            </>
          )}
        </p>
        {task.description && <p className="body">{task.description}</p>}
      </header>

      <section aria-labelledby="claim-heading" className="panel">
        <h2 id="claim-heading">Claim</h2>
        {claim ? <CurrentClaim claim={claim} /> : <p className="muted">Nobody holds this Task.</p>}
        {task.state === "open" && <Actions detail={detail} claim={claim} />}
      </section>

      <Blockers detail={detail} />
      <Notes notes={detail.notes} />
      <section aria-labelledby="task-observations">
        <h2 id="task-observations">Observations</h2>
        {detail.observations.length === 0 ? (
          <p className="muted">No Observations.</p>
        ) : (
          <ObservationItems observations={detail.observations} />
        )}
      </section>
      <EvidenceSection
        evidence={detail.evidence}
        attach={(file) =>
          call(
            api.POST("/v1/tasks/{task}/evidence", {
              params: { path: { task: task.id }, query: { filename: file.name } },
              ...fileBody(file),
            }),
          )
        }
      />
      <ClaimHistory claims={detail.claims} />
    </>
  );
}

function CurrentClaim({ claim }: { claim: Claim }) {
  return (
    <dl className="facts">
      <dt>Holder</dt>
      <dd>
        <MemberName id={claim.holder_id} />
      </dd>
      <dt>Bound to</dt>
      <dd>
        {boundTo(claim)}
        {claim.heartbeat_timeout_seconds ? ` (Session ${claim.session_id}, Heartbeat every ${claim.heartbeat_timeout_seconds}s)` : ""}
      </dd>
      <dt>Expires</dt>
      <dd>{claim.expires_at ? <RelativeTime at={claim.expires_at} /> : "Never, unless ended"}</dd>
      {claim.skill_id && (
        <>
          <dt>Skill</dt>
          <dd>
            <SkillName id={claim.skill_id} />
            {claim.skill_version !== undefined && ` version ${claim.skill_version}`}
          </dd>
        </>
      )}
      {claim.model_label && (
        <>
          <dt>Model label</dt>
          <dd>{claim.model_label}</dd>
        </>
      )}
      <dt>Since</dt>
      <dd>
        <Time at={claim.started_at} />
      </dd>
    </dl>
  );
}

function Actions({ detail, claim }: { detail: TaskDetail; claim: Claim | undefined }) {
  const me = useCurrentMe();
  const { members } = useDirectory();
  const { task, feature } = detail;
  const mine = claim?.holder_id === me.member.id;
  const isOwner = feature.owner_id === me.member.id;
  const canTakeBack =
    claim !== undefined && !mine && (isOwner || isOnReportingLine(members, me.member.id, claim.holder_id));
  return (
    <div className="actions">
      {!claim && <ClaimButton task={task} />}
      {mine && (
        <>
          <Complete task={task} />
          <Handover task={task} />
          <Release task={task} />
          {task.kind === "retrospective" && <ProposeSkillVersion task={task} />}
        </>
      )}
      {canTakeBack && <TakeBack task={task} />}
      {(!claim || mine) && (
        <>
          <AddNote task={task} />
          <Observe task={task} />
        </>
      )}
      {isOwner && <DropTask task={task} />}
    </div>
  );
}

/** Claims for a human in the browser: no heartbeat timeout, so the Claim is bound to the Member. */
export function ClaimButton({ task, label = "Claim" }: { task: Task; label?: string }) {
  const claim = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: task.id } }, body: { heartbeat_timeout_seconds: 0 } })),
  });
  return (
    <div>
      <button type="button" onClick={() => claim.mutate()} disabled={claim.isPending}>
        {label}
      </button>
      <Refusal error={claim.error} />
    </div>
  );
}

function NoteField({ value, onChange, label = "Note (optional)" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label>
      {label}
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Complete({ task }: { task: Task }) {
  const [note, setNote] = useState("");
  const complete = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.id } }, body: { note: note || undefined } })),
  });
  return (
    <form
      className="action stack"
      aria-label="Complete"
      onSubmit={(e) => {
        e.preventDefault();
        complete.mutate();
      }}
    >
      <h3>Complete</h3>
      <NoteField value={note} onChange={setNote} />
      <div>
        <button type="submit" disabled={complete.isPending}>
          Complete
        </button>
      </div>
      <Refusal error={complete.error} />
    </form>
  );
}

function Handover({ task }: { task: Task }) {
  const { skillList } = useDirectory();
  const [skill, setSkill] = useState("");
  const [note, setNote] = useState("");
  const handover = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/handover", {
          params: { path: { task: task.id } },
          body: { skill, note: note || undefined },
        }),
      ),
  });
  return (
    <form
      className="action stack"
      aria-label="Handover"
      onSubmit={(e) => {
        e.preventDefault();
        handover.mutate();
      }}
    >
      <h3>Hand over</h3>
      <label>
        Skill it needs next
        <select required value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">Choose a Skill</option>
          {skillList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <NoteField value={note} onChange={setNote} />
      <div>
        <button type="submit" disabled={!skill || handover.isPending}>
          Hand over
        </button>
      </div>
      <Refusal error={handover.error} />
    </form>
  );
}

function Release({ task }: { task: Task }) {
  const [note, setNote] = useState("");
  const release = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/release", { params: { path: { task: task.id } }, body: { note: note || undefined } })),
  });
  return (
    <form
      className="action stack"
      aria-label="Release"
      onSubmit={(e) => {
        e.preventDefault();
        release.mutate();
      }}
    >
      <h3>Release</h3>
      <p className="muted">Gives up the Claim; the Task keeps needing the same Skill.</p>
      <NoteField value={note} onChange={setNote} />
      <div>
        <button type="submit" disabled={release.isPending}>
          Release
        </button>
      </div>
      <Refusal error={release.error} />
    </form>
  );
}

function TakeBack({ task }: { task: Task }) {
  const [reason, setReason] = useState("");
  const takeBack = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/take-back", { params: { path: { task: task.id } }, body: { reason: reason || undefined } }),
      ),
  });
  return (
    <form
      className="action stack"
      aria-label="Take back"
      onSubmit={(e) => {
        e.preventDefault();
        takeBack.mutate();
      }}
    >
      <h3>Take back</h3>
      <p className="muted">Ends the holder's Claim; the Task becomes takeable again.</p>
      <NoteField value={reason} onChange={setReason} label="Reason (optional)" />
      <div>
        <button type="submit" disabled={takeBack.isPending}>
          Take back
        </button>
      </div>
      <Refusal error={takeBack.error} />
    </form>
  );
}

function DropTask({ task }: { task: Task }) {
  const [reason, setReason] = useState("");
  const drop = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/drop", { params: { path: { task: task.id } }, body: { reason: reason || undefined } })),
  });
  return (
    <div className="action stack">
      <h3>Drop</h3>
      <p className="muted">Ends the Task dropped and ends any Claim on it.</p>
      <NoteField value={reason} onChange={setReason} label="Reason (optional)" />
      <div>
        <ConfirmButton confirm={`Drop ${task.key}`} onConfirm={() => drop.mutate()} disabled={drop.isPending}>
          Drop Task
        </ConfirmButton>
      </div>
      <Refusal error={drop.error} />
    </div>
  );
}

function AddNote({ task }: { task: Task }) {
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/notes", { params: { path: { task: task.id } }, body: { body } })),
    onSuccess: () => setBody(""),
  });
  return (
    <form
      className="action stack"
      aria-label="Add a Note"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h3>Note</h3>
      <NoteField value={body} onChange={setBody} label="For whoever works the Task next" />
      <div>
        <button type="submit" disabled={!body.trim() || add.isPending}>
          Add Note
        </button>
      </div>
      <Refusal error={add.error} />
    </form>
  );
}

function Observe({ task }: { task: Task }) {
  const [outcome, setOutcome] = useState<"worked" | "didnt_work">("worked");
  const [body, setBody] = useState("");
  const observe = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/tasks/{task}/observations", { params: { path: { task: task.id } }, body: { outcome, body } })),
    onSuccess: () => setBody(""),
  });
  return (
    <form
      className="action stack"
      aria-label="Record an Observation"
      onSubmit={(e) => {
        e.preventDefault();
        observe.mutate();
      }}
    >
      <h3>Observation</h3>
      <fieldset className="row">
        <legend>Outcome</legend>
        <label className="check">
          <input type="radio" name="outcome" checked={outcome === "worked"} onChange={() => setOutcome("worked")} />
          Worked
        </label>
        <label className="check">
          <input type="radio" name="outcome" checked={outcome === "didnt_work"} onChange={() => setOutcome("didnt_work")} />
          Didn't work
        </label>
      </fieldset>
      <NoteField value={body} onChange={setBody} label="What happened" />
      <div>
        <button type="submit" disabled={!body.trim() || observe.isPending}>
          Record Observation
        </button>
      </div>
      <Refusal error={observe.error} />
    </form>
  );
}

/** On a Retrospective: propose a new version of a company Skill, then hand over to skill-review. */
function ProposeSkillVersion({ task }: { task: Task }) {
  const { skillList } = useDirectory();
  const [skill, setSkill] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const current = useQuery({
    queryKey: keys.skill(skill),
    queryFn: () => call(api.GET("/v1/skills/{skill}", { params: { path: { skill } } })),
    enabled: skill !== "",
  });
  const text = body ?? current.data?.current.body ?? "";
  const propose = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks/{task}/skill-proposals", {
          params: { path: { task: task.id } },
          body: { skill, based_on_version: current.data!.current.version, body: text },
        }),
      ),
  });
  return (
    <form
      className="action stack wide"
      aria-label="Propose a Skill version"
      onSubmit={(e) => {
        e.preventDefault();
        propose.mutate();
      }}
    >
      <h3>Propose a Skill version</h3>
      <label>
        Company Skill
        <select
          required
          value={skill}
          onChange={(e) => {
            setSkill(e.target.value);
            setBody(null);
          }}
        >
          <option value="">Choose a Skill</option>
          {skillList
            .filter((s) => s.kind === "company")
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
      {current.data && (
        <label>
          New text, written against version {current.data.current.version}
          <textarea rows={8} value={text} onChange={(e) => setBody(e.target.value)} />
        </label>
      )}
      <Refusal error={current.error} />
      <div>
        <button type="submit" disabled={!current.data || propose.isPending}>
          Propose
        </button>
      </div>
      <Refusal error={propose.error} />
      {propose.isSuccess && (
        <p role="status">
          Proposed against version {propose.data.based_on_version}. Hand the Task over to <code>skill-review</code> next.
        </p>
      )}
    </form>
  );
}

function Blockers({ detail }: { detail: TaskDetail }) {
  const { task, blockers, blocking } = detail;
  const [blocker, setBlocker] = useState("");
  const add = useMutation({
    mutationFn: () => call(api.PUT("/v1/tasks/{task}/blockers/{blocker}", { params: { path: { task: task.id, blocker } } })),
    onSuccess: () => setBlocker(""),
  });
  const remove = useMutation({
    mutationFn: (b: Task) =>
      call(api.DELETE("/v1/tasks/{task}/blockers/{blocker}", { params: { path: { task: task.id, blocker: b.id } } })),
  });
  return (
    <section aria-labelledby="blockers-heading">
      <h2 id="blockers-heading">Blockers</h2>
      {blockers.length === 0 ? (
        <p className="muted">Nothing blocks this Task.</p>
      ) : (
        <ul className="list">
          {blockers.map((b) => (
            <li key={b.id}>
              <div className="grow">
                <TaskLink task={b} />
                <div className="meta">
                  <TaskStateBadges task={b} />
                </div>
              </div>
              {task.state === "open" && (
                <button
                  type="button"
                  aria-label={`Stop ${b.key} blocking ${task.key}`}
                  onClick={() => remove.mutate(b)}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Refusal error={remove.error} />
      {task.state === "open" && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label>
            Blocked by Task
            <input placeholder="WEB-42" value={blocker} onChange={(e) => setBlocker(e.target.value.trim())} />
          </label>
          <button type="submit" disabled={!blocker || add.isPending}>
            Add blocker
          </button>
        </form>
      )}
      <Refusal error={add.error} />
      {blocking.length > 0 && (
        <>
          <h3>This Task blocks</h3>
          <ul className="list">
            {blocking.map((b) => (
              <li key={b.id}>
                <div className="grow">
                  <TaskLink task={b} />
                  <div className="meta">
                    <TaskStateBadges task={b} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Notes({ notes }: { notes: Note[] }) {
  return (
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading">Notes</h2>
      {notes.length === 0 ? (
        <p className="muted">No Notes yet.</p>
      ) : (
        <ol className="list">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="grow">
                <div className="meta">
                  <MemberName id={n.author_id} />
                  {n.skill_id && (
                    <>
                      {" "}
                      under <SkillName id={n.skill_id} />
                    </>
                  )}{" "}
                  <Time at={n.created_at} />
                </div>
                <p className="body">{n.body}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const howEnded: Record<string, string> = {
  released: "released",
  handed_over: "handed over",
  completed: "completed",
  lapsed: "lapsed",
  taken_back: "taken back",
  dropped: "dropped",
  token_revoked: "token revoked",
  session_closed: "Session closed",
};

function ClaimHistory({ claims }: { claims: Claim[] }) {
  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading">Claim history</h2>
      {claims.length === 0 ? (
        <p className="muted">Never claimed.</p>
      ) : (
        <ol className="list">
          {claims.map((c) => (
            <li key={c.id}>
              <div className="grow">
                <MemberName id={c.holder_id} />
                {c.skill_id && (
                  <>
                    {" "}
                    under <SkillName id={c.skill_id} />
                    {c.skill_version !== undefined && <> version {c.skill_version}</>}
                  </>
                )}
                {c.model_label && (
                  <>
                    {" "}
                    using <Badge>{c.model_label}</Badge>
                  </>
                )}
                <div className="meta">
                  {boundTo(c)} · from <Time at={c.started_at} />
                  {c.ended_at ? (
                    <>
                      {" "}
                      to <Time at={c.ended_at} />
                      {c.how_ended && <> · {howEnded[c.how_ended] ?? c.how_ended}</>}
                    </>
                  ) : (
                    c.expires_at && (
                      <>
                        {" "}
                        · <Holder claim={c} />
                      </>
                    )
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
