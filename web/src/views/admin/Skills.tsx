import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, call } from "../../api/client";
import { keys, useDirectory, useSkills } from "../../api/queries";
import { Badge, Loaded, Refusal, Time } from "../../components/ui";
import { MemberName, SkillName } from "../../components/work";

export function SkillsAdmin() {
  const skills = useSkills();
  return (
    <>
      <section aria-labelledby="skills-heading">
        <h2 id="skills-heading">Skills</h2>
        <Loaded query={skills}>
          {(list) => (
            <ul className="list">
              {list.map((s) => (
                <li key={s.id}>
                  <div className="grow">
                    <Link to={`/admin/skills/${s.name}`}>{s.name}</Link>
                    <div className="meta">
                      <Badge>{s.kind}</Badge> {s.builtin && <Badge>built in</Badge>} version {s.current_version}
                      {s.base_skill_id && (
                        <>
                          {" "}
                          · builds on <SkillName id={s.base_skill_id} />
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
      <CreateSkill />
    </>
  );
}

function CreateSkill() {
  const { skillList } = useDirectory();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"generic" | "company">("generic");
  const [base, setBase] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () =>
      call(api.POST("/v1/skills", { body: { name, kind, body, base_skill: kind === "company" ? base : undefined } })),
    onSuccess: () => {
      setName("");
      setBase("");
      setBody("");
    },
  });
  return (
    <section aria-labelledby="create-skill" className="panel">
      <h2 id="create-skill">Create a Skill</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name
          <input
            required
            pattern="[a-z0-9][a-z0-9\-]{0,62}"
            title="Lower-case letters, digits and dashes"
            placeholder="qa"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="row">
          <legend>Kind</legend>
          <label className="check">
            <input type="radio" name="skill-kind" checked={kind === "generic"} onChange={() => setKind("generic")} />
            Generic, what a Member arrives with
          </label>
          <label className="check">
            <input type="radio" name="skill-kind" checked={kind === "company"} onChange={() => setKind("company")} />
            Company, with this Organisation's own knowledge
          </label>
        </fieldset>
        {kind === "company" && (
          <label>
            Builds on
            <select required value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="">Choose a generic Skill</option>
              {skillList
                .filter((s) => s.kind === "generic")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Text, published as version 1
          <textarea required rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div>
          <button type="submit" disabled={create.isPending}>
            Create Skill
          </button>
        </div>
      </form>
      <Refusal error={create.error} />
      {create.isSuccess && (
        <p role="status">
          Created <Link to={`/admin/skills/${create.data.skill.name}`}>{create.data.skill.name}</Link>.
        </p>
      )}
    </section>
  );
}

export function SkillAdmin() {
  const { skill: ref = "" } = useParams();
  const skill = useQuery({
    queryKey: keys.skill(ref),
    queryFn: () => call(api.GET("/v1/skills/{skill}", { params: { path: { skill: ref } } })),
  });
  const versions = useQuery({
    queryKey: keys.skillVersions(ref),
    queryFn: () => call(api.GET("/v1/skills/{skill}/versions", { params: { path: { skill: ref } } })).then((r) => r.items),
  });
  return (
    <Loaded query={skill}>
      {({ skill: s }) => (
        <>
          <h2>
            {s.name} <Badge>{s.kind}</Badge> {s.builtin && <Badge>built in</Badge>}
          </h2>
          {s.base_skill_id && (
            <p>
              Builds on <SkillName id={s.base_skill_id} />.
            </p>
          )}
          <section aria-labelledby="versions-heading">
            <h3 id="versions-heading">Versions</h3>
            <Loaded query={versions}>
              {(list) => (
                <ol className="list">
                  {list.map((v) => (
                    <li key={v.version}>
                      <div className="grow">
                        <strong>Version {v.version}</strong>
                        {v.version === s.current_version && (
                          <>
                            {" "}
                            <Badge tone="open">current</Badge>
                          </>
                        )}
                        <div className="meta">
                          published <Time at={v.published_at} />
                          {v.published_by && (
                            <>
                              {" "}
                              by <MemberName id={v.published_by} />
                            </>
                          )}
                        </div>
                        <pre className="skill-body">{v.body}</pre>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Loaded>
          </section>
        </>
      )}
    </Loaded>
  );
}
