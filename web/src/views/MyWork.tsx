import { useQuery } from "@tanstack/react-query";
import { api, call } from "../api/client";
import { allPages } from "../api/pages";
import { keys } from "../api/queries";
import { useNow } from "../clock";
import { Loaded } from "../components/ui";
import { Holder, Needs, TaskLink, TaskStateBadges } from "../components/work";
import { useCurrentMe } from "../me";
import { liveClaim } from "../work";
import { ClaimButton } from "./TaskView";

/** The Tasks the caller holds, and the ones they could take now. */
export function MyWork() {
  const me = useCurrentMe();
  const now = useNow();
  const held = useQuery({
    queryKey: keys.heldTasks(me.member.id),
    queryFn: () =>
      allPages((cursor) =>
        call(api.GET("/v1/tasks", { params: { query: { holder: me.member.id, state: "open", limit: 500, cursor } } })),
      ),
  });
  const takeable = useQuery({
    queryKey: keys.takeable,
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 100 } } })).then((r) => r.items),
  });
  return (
    <>
      <h1>My work</h1>
      <section aria-labelledby="held-heading">
        <h2 id="held-heading">My Claims</h2>
        <Loaded query={held}>
          {(tasks) =>
            tasks.length === 0 ? (
              <p className="muted">You hold no Claims.</p>
            ) : (
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
            )
          }
        </Loaded>
      </section>
      <section aria-labelledby="takeable-heading">
        <h2 id="takeable-heading">Takeable now</h2>
        <p className="muted">
          In the order <code>darkory next</code> would offer them: by Rank, then by how long each has waited.
        </p>
        <Loaded query={takeable}>
          {(tasks) =>
            tasks.length === 0 ? (
              <p className="muted">Nothing is takeable by you right now.</p>
            ) : (
              <ul className="list">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <div className="grow">
                      <TaskLink task={t} />
                      <div className="meta">
                        <TaskStateBadges task={t} /> <Needs task={t} />
                      </div>
                    </div>
                    <ClaimButton task={t} label={`Claim ${t.key}`} />
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </section>
    </>
  );
}
