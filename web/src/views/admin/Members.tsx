import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { api, call, type IssuedToken, type LoginLink, type Member, type MemberDetail } from "../../api/client";
import { keys, useDirectory, useMembers } from "../../api/queries";
import { Badge, CopyField, Loaded, Refusal, Time } from "../../components/ui";
import { MemberName } from "../../components/work";

export function MembersAdmin() {
  const members = useMembers();
  return (
    <>
      <section aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        <Loaded query={members}>
          {(list) => (
            <ul className="list">
              {list.map((m) => (
                <li key={m.id}>
                  <div className="grow">
                    {/* Member names may hold dots, which the server reads as file names; ids never do. */}
                    <Link to={`/admin/members/${m.id}`}>{m.name}</Link>
                    <div className="meta">
                      <Badge>{m.kind}</Badge> {m.admin && <Badge tone="admin">admin</Badge>} {m.email}
                      {m.manager_id && (
                        <>
                          {" "}
                          · reports to <MemberName id={m.manager_id} />
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Loaded>
      </section>
      <CreateMember />
    </>
  );
}

function CreateMember() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<Member | null>(null);
  const create = useMutation({
    mutationFn: () => call(api.POST("/v1/members", { body: { name, kind, email: email || undefined, admin } })),
    onSuccess: (m) => {
      setCreated(m);
      setName("");
      setEmail("");
      setAdmin(false);
    },
  });
  return (
    <section aria-labelledby="create-member" className="panel">
      <h2 id="create-member">Create a Member</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="row">
          <legend>Kind</legend>
          <label className="check">
            <input type="radio" name="kind" checked={kind === "human"} onChange={() => setKind("human")} />
            Human
          </label>
          <label className="check">
            <input type="radio" name="kind" checked={kind === "agent"} onChange={() => setKind("agent")} />
            Agent
          </label>
        </fieldset>
        <label>
          Email (optional)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          Admin
        </label>
        <div>
          <button type="submit" disabled={create.isPending}>
            Create Member
          </button>
        </div>
      </form>
      <Refusal error={create.error} />
      {created && (
        <p role="status">
          Created <Link to={`/admin/members/${created.id}`}>{created.name}</Link>. Issue them a{" "}
          {created.kind === "agent" ? "token" : "login link"} next.
        </p>
      )}
    </section>
  );
}

export function MemberAdmin() {
  const { member: ref = "" } = useParams();
  const detail = useQuery({
    queryKey: keys.member(ref),
    queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: ref } } })),
  });
  return (
    <Loaded query={detail}>
      {(d) => (
        // Keyed so the forms' state starts afresh for another Member.
        <Fragment key={d.member.id}>
          <h2>
            {d.member.name} <Badge>{d.member.kind}</Badge> {d.member.admin && <Badge tone="admin">admin</Badge>}
          </h2>
          <Profile member={d.member} />
          <IssueLoginLink member={d.member} />
          <Tokens member={d.member} />
          <MemberSkills detail={d} />
          <ReportingLine detail={d} />
          <MemberTeams detail={d} />
        </Fragment>
      )}
    </Loaded>
  );
}

function Profile({ member }: { member: Member }) {
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email ?? "");
  const [admin, setAdmin] = useState(member.admin);
  const update = useMutation({
    mutationFn: () =>
      call(
        api.PATCH("/v1/members/{member}", {
          params: { path: { member: member.id } },
          body: { name, email: email || undefined, admin },
        }),
      ),
  });
  return (
    <section aria-labelledby="profile-heading" className="panel">
      <h3 id="profile-heading">Profile</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate();
        }}
      >
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          Admin
        </label>
        <div>
          <button type="submit" disabled={update.isPending}>
            Save
          </button>
        </div>
      </form>
      <Refusal error={update.error} />
      {update.isSuccess && <p role="status">Saved.</p>}
    </section>
  );
}

function IssueLoginLink({ member }: { member: Member }) {
  const [link, setLink] = useState<LoginLink | null>(null);
  const issue = useMutation({
    mutationFn: () => call(api.POST("/v1/members/{member}/login-links", { params: { path: { member: member.id } } })),
    onSuccess: setLink,
  });
  return (
    <section aria-labelledby="login-link-heading" className="panel">
      <h3 id="login-link-heading">Login link</h3>
      <p className="muted">A one-time link that signs a browser in as {member.name}. Send it to them.</p>
      <button type="button" onClick={() => issue.mutate()} disabled={issue.isPending}>
        Issue a login link
      </button>
      <Refusal error={issue.error} />
      {link && (
        <div className="secret">
          <CopyField label={`Login link for ${member.name}`} value={link.url} />
          <p className="muted">
            Works once, until <Time at={link.expires_at} />.
          </p>
        </div>
      )}
    </section>
  );
}

function Tokens({ member }: { member: Member }) {
  const tokens = useQuery({
    queryKey: keys.tokens(member.id),
    queryFn: () => call(api.GET("/v1/members/{member}/tokens", { params: { path: { member: member.id } } })).then((r) => r.items),
  });
  const revoke = useMutation({
    mutationFn: (token: string) => call(api.POST("/v1/tokens/{token}/revoke", { params: { path: { token } } })),
  });
  return (
    <section aria-labelledby="tokens-heading" className="panel">
      <h3 id="tokens-heading">Tokens</h3>
      <Loaded query={tokens}>
        {(list) =>
          list.length === 0 ? (
            <p className="muted">No tokens.</p>
          ) : (
            <ul className="list" aria-label="Tokens">
              {list.map((t) => (
                <li key={t.id} className={t.revoked_at ? "ended" : undefined}>
                  <div className="grow">
                    {t.name} <code>{t.prefix}…</code>
                    <div className="meta">
                      issued <Time at={t.created_at} />
                      {t.default_heartbeat_timeout_seconds !== undefined && (
                        <> · Heartbeat timeout {t.default_heartbeat_timeout_seconds}s by default</>
                      )}
                      {t.last_used_at && (
                        <>
                          {" "}
                          · last used <Time at={t.last_used_at} />
                        </>
                      )}
                      {t.revoked_at && (
                        <>
                          {" "}
                          · revoked <Time at={t.revoked_at} />
                        </>
                      )}
                    </div>
                  </div>
                  {!t.revoked_at && (
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Revoke token ${t.name}`}
                      onClick={() => revoke.mutate(t.id)}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <Refusal error={revoke.error} />
      <IssueToken member={member} />
    </section>
  );
}

/** Issues a token and shows its secret this once; the API never shows it again. */
function IssueToken({ member }: { member: Member }) {
  const [name, setName] = useState("");
  const [timeout, setTimeoutSeconds] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const issue = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/members/{member}/tokens", {
          params: { path: { member: member.id } },
          body: { name, default_heartbeat_timeout_seconds: timeout ? Number(timeout) : undefined },
        }),
      ),
    onSuccess: (t) => {
      setIssued(t);
      setName("");
      setTimeoutSeconds("");
    },
  });
  if (issued) {
    return (
      <div className="secret" role="region" aria-label="New token secret">
        <p>
          <strong>Copy this secret now.</strong> It is shown only once; Darkory keeps only its hash.
        </p>
        <CopyField label={`Secret for ${issued.token.name}`} value={issued.secret} />
        <button type="button" onClick={() => setIssued(null)}>
          Done
        </button>
      </div>
    );
  }
  return (
    <form
      className="stack"
      aria-label="Issue a token"
      onSubmit={(e) => {
        e.preventDefault();
        issue.mutate();
      }}
    >
      <h4>Issue a token</h4>
      <label>
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Default Heartbeat timeout, seconds (optional)
        <input
          type="number"
          min={1}
          max={86400}
          value={timeout}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
        />
      </label>
      <div>
        <button type="submit" disabled={issue.isPending}>
          Issue token
        </button>
      </div>
      <Refusal error={issue.error} />
    </form>
  );
}

function MemberSkills({ detail }: { detail: MemberDetail }) {
  const { skillList } = useDirectory();
  const [skill, setSkill] = useState("");
  const member = detail.member.id;
  const grant = useMutation({
    mutationFn: () => call(api.PUT("/v1/members/{member}/skills/{skill}", { params: { path: { member, skill } } })),
    onSuccess: () => setSkill(""),
  });
  const revoke = useMutation({
    mutationFn: (s: string) =>
      call(api.DELETE("/v1/members/{member}/skills/{skill}", { params: { path: { member, skill: s } } })),
  });
  const has = new Set(detail.skills.map((s) => s.id));
  return (
    <section aria-labelledby="member-skills" className="panel">
      <h3 id="member-skills">Skills</h3>
      {detail.skills.length === 0 ? (
        <p className="muted">No Skills.</p>
      ) : (
        <ul className="list">
          {detail.skills.map((s) => (
            <li key={s.id}>
              <span className="grow">{s.name}</span>
              <button
                type="button"
                aria-label={`Take ${s.name} away`}
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending}
              >
                Take away
              </button>
            </li>
          ))}
        </ul>
      )}
      <Refusal error={revoke.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          grant.mutate();
        }}
      >
        <label>
          Grant a Skill
          <select required value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">Choose a Skill</option>
            {skillList
              .filter((s) => !has.has(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!skill || grant.isPending}>
          Grant
        </button>
      </form>
      <Refusal error={grant.error} />
    </section>
  );
}

function ReportingLine({ detail }: { detail: MemberDetail }) {
  const { memberList } = useDirectory();
  const [manager, setManager] = useState("");
  const member = detail.member.id;
  const set = useMutation({
    mutationFn: () => call(api.PUT("/v1/members/{member}/manager", { params: { path: { member } }, body: { manager } })),
    onSuccess: () => setManager(""),
  });
  const clear = useMutation({
    mutationFn: () => call(api.DELETE("/v1/members/{member}/manager", { params: { path: { member } } })),
  });
  return (
    <section aria-labelledby="reporting-line" className="panel">
      <h3 id="reporting-line">Reporting line</h3>
      <p>
        {detail.member.manager_id ? (
          <>
            Reports to <MemberName id={detail.member.manager_id} />.{" "}
            <button type="button" className="link" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Remove
            </button>
          </>
        ) : (
          "Reports to no one."
        )}
      </p>
      <Refusal error={clear.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate();
        }}
      >
        <label>
          Reports to
          <select required value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">Choose a Member</option>
            {memberList
              .filter((m) => m.id !== member)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!manager || set.isPending}>
          Set
        </button>
      </form>
      <Refusal error={set.error} />
      {detail.reports.length > 0 && (
        <p>
          Directs:{" "}
          {detail.reports.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <Link to={`/admin/members/${r.id}`}>{r.name}</Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function MemberTeams({ detail }: { detail: MemberDetail }) {
  const { teamList } = useDirectory();
  const [team, setTeam] = useState("");
  const member = detail.member.id;
  const add = useMutation({
    mutationFn: () => call(api.PUT("/v1/teams/{team}/members/{member}", { params: { path: { team, member } } })),
    onSuccess: () => setTeam(""),
  });
  const remove = useMutation({
    mutationFn: (t: string) => call(api.DELETE("/v1/teams/{team}/members/{member}", { params: { path: { team: t, member } } })),
  });
  const inTeam = new Set(detail.teams.map((t) => t.id));
  return (
    <section aria-labelledby="member-teams" className="panel">
      <h3 id="member-teams">Teams</h3>
      {detail.teams.length === 0 ? (
        <p className="muted">In no Team.</p>
      ) : (
        <ul className="list">
          {detail.teams.map((t) => (
            <li key={t.id}>
              <span className="grow">
                <Link to={`/admin/teams/${t.key}`}>{t.name}</Link> <span className="key">{t.key}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove from ${t.name}`}
                onClick={() => remove.mutate(t.id)}
                disabled={remove.isPending}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <Refusal error={remove.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label>
          Add to Team
          <select required value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">Choose a Team</option>
            {teamList
              .filter((t) => !inTeam.has(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!team || add.isPending}>
          Add
        </button>
      </form>
      <Refusal error={add.error} />
    </section>
  );
}
