import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { api, call, type TeamDetail } from "../../api/client";
import { keys, useDirectory, useTeams } from "../../api/queries";
import { Badge, Loaded, Refusal } from "../../components/ui";

export function TeamsAdmin() {
  const teams = useTeams();
  return (
    <>
      <section aria-labelledby="teams-heading">
        <h2 id="teams-heading">Teams</h2>
        <Loaded query={teams}>
          {(list) =>
            list.length === 0 ? (
              <p className="muted">No Teams yet.</p>
            ) : (
              <ul className="list">
                {list.map((t) => (
                  <li key={t.id}>
                    <span className="grow">
                      <Link to={`/admin/teams/${t.key}`}>{t.name}</Link> <span className="key">{t.key}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </section>
      <CreateTeam />
    </>
  );
}

function CreateTeam() {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => call(api.POST("/v1/teams", { body: { key, name } })),
    onSuccess: () => {
      setKey("");
      setName("");
    },
  });
  return (
    <section aria-labelledby="create-team" className="panel">
      <h2 id="create-team">Create a Team</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Key, the prefix of its display keys
          <input
            required
            pattern="[A-Z][A-Z0-9]{1,9}"
            title="2 to 10 capital letters or digits, starting with a letter"
            placeholder="WEB"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
          />
        </label>
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <button type="submit" disabled={create.isPending}>
            Create Team
          </button>
        </div>
      </form>
      <Refusal error={create.error} />
      {create.isSuccess && (
        <p role="status">
          Created <Link to={`/admin/teams/${create.data.key}`}>{create.data.name}</Link>.
        </p>
      )}
    </section>
  );
}

export function TeamAdmin() {
  const { team: ref = "" } = useParams();
  const detail = useQuery({
    queryKey: keys.team(ref),
    queryFn: () => call(api.GET("/v1/teams/{team}", { params: { path: { team: ref } } })),
  });
  return (
    <Loaded query={detail}>
      {(d) => (
        <Fragment key={d.team.id}>
          <h2>
            {d.team.name} <span className="key">{d.team.key}</span>
          </h2>
          <TeamMembers detail={d} />
        </Fragment>
      )}
    </Loaded>
  );
}

function TeamMembers({ detail }: { detail: TeamDetail }) {
  const { memberList } = useDirectory();
  const [member, setMember] = useState("");
  const team = detail.team.id;
  const add = useMutation({
    mutationFn: () => call(api.PUT("/v1/teams/{team}/members/{member}", { params: { path: { team, member } } })),
    onSuccess: () => setMember(""),
  });
  const remove = useMutation({
    mutationFn: (m: string) => call(api.DELETE("/v1/teams/{team}/members/{member}", { params: { path: { team, member: m } } })),
  });
  const inTeam = new Set(detail.members.map((m) => m.id));
  return (
    <section aria-labelledby="team-members" className="panel">
      <h3 id="team-members">Members</h3>
      {detail.members.length === 0 ? (
        <p className="muted">No Members.</p>
      ) : (
        <ul className="list">
          {detail.members.map((m) => (
            <li key={m.id}>
              <span className="grow">
                <Link to={`/admin/members/${m.id}`}>{m.name}</Link> <Badge>{m.kind}</Badge>
              </span>
              <button
                type="button"
                aria-label={`Remove ${m.name} from ${detail.team.name}`}
                onClick={() => remove.mutate(m.id)}
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
          Add a Member
          <select required value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">Choose a Member</option>
            {memberList
              .filter((m) => !inTeam.has(m.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!member || add.isPending}>
          Add
        </button>
      </form>
      <Refusal error={add.error} />
    </section>
  );
}
