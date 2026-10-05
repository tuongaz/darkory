import { QueryClientProvider, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { NavLink, Outlet, Route, Routes } from "react-router";
import { api, call, isUnauthenticated } from "./api/client";
import { LiveActivity, LiveActivityContext, useActivityStream, useStreamState } from "./api/live";
import { useMe } from "./api/queries";
import { Refusal } from "./components/ui";
import { MeContext, useCurrentMe } from "./me";
import { newQueryClient } from "./queryClient";
import { ActivityView } from "./views/ActivityView";
import { AdminRoutes } from "./views/admin/AdminRoutes";
import { Board } from "./views/Board";
import { FeatureView } from "./views/FeatureView";
import { MyWork } from "./views/MyWork";
import { NotFound } from "./views/NotFound";
import { SignedOut } from "./views/SignedOut";
import { TaskView } from "./views/TaskView";

/** The query cache and the live Activity store the app runs inside. */
export function Providers({ client, live, children }: { client: QueryClient; live: LiveActivity; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <LiveActivityContext.Provider value={live}>{children}</LiveActivityContext.Provider>
    </QueryClientProvider>
  );
}

export function App({ router }: { router: (children: ReactNode) => ReactNode }) {
  const [client] = useState(newQueryClient);
  const [live] = useState(() => new LiveActivity());
  return (
    <Providers client={client} live={live}>
      {router(<Root />)}
    </Providers>
  );
}

/** Asks /v1/me who is signed in: the app when someone is, the signed-out page on 401. */
export function Root() {
  const me = useMe();
  if (me.isPending) return <p className="page muted">Loading…</p>;
  if (me.isError) {
    if (isUnauthenticated(me.error)) return <SignedOut />;
    return (
      <main className="page">
        <h1>Darkory</h1>
        <p>The server did not say who is signed in.</p>
        <Refusal error={me.error} />
      </main>
    );
  }
  return (
    <MeContext.Provider value={me.data}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Board />} />
          <Route path="features/:feature" element={<FeatureView />} />
          <Route path="tasks/:task" element={<TaskView />} />
          <Route path="my-work" element={<MyWork />} />
          <Route path="activity" element={<ActivityView />} />
          <Route path="admin/*" element={<AdminRoutes />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </MeContext.Provider>
  );
}

function Shell() {
  useActivityStream();
  const me = useCurrentMe();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="brand">
          <span className="logo">Darkory</span>
          <span className="org">{me.organisation.name}</span>
        </div>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/my-work">My work</NavLink>
          <NavLink to="/activity">Activity</NavLink>
          {me.member.admin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="who">
          <StreamIndicator />
          <span>{me.member.name}</span>
          <SignOut />
        </div>
      </header>
      <main id="main" className="page">
        <Outlet />
      </main>
    </>
  );
}

function StreamIndicator() {
  const state = useStreamState();
  const label = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", closed: "Live updates off" }[state];
  return (
    <span className={`stream stream-${state}`} role="status" title="Live updates from the Activity stream">
      {label}
    </span>
  );
}

function SignOut() {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => call(api.POST("/v1/logout")),
    // Forget everything read as this Member; /v1/me then answers 401.
    onSuccess: () => qc.resetQueries(),
  });
  return (
    <>
      <button type="button" className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
        Sign out
      </button>
      {logout.isError && <Refusal error={logout.error} />}
    </>
  );
}
