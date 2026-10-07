import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isUnauthenticated } from "@/api/client";
import { LiveActivity, LiveActivityContext } from "@/api/live";
import { useMe } from "@/api/queries";
import { AppRoutes, DevScreens } from "@/app/routes";
import { SignedOut } from "@/app/SignedOut";
import { Refusal } from "@/components/Refusal";
import { MeContext } from "@/me";
import { newQueryClient } from "@/queryClient";

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
      {router(
        <DevScreens>
          <Root />
        </DevScreens>,
      )}
    </Providers>
  );
}

/** Asks /v1/me who is signed in: the app when someone is, the signed-out page on 401. */
export function Root() {
  const me = useMe();
  if (me.isPending) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (me.isError) {
    if (isUnauthenticated(me.error)) return <SignedOut />;
    return (
      <main className="mx-auto flex max-w-[520px] flex-col gap-3 px-4 pt-[72px]">
        <h1 className="text-xl font-semibold">Darkory</h1>
        <p>The server did not say who is signed in.</p>
        <Refusal error={me.error} />
      </main>
    );
  }
  return (
    <MeContext.Provider value={me.data}>
      <AppRoutes />
    </MeContext.Provider>
  );
}
