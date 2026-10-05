import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, isUnauthenticated } from "./api/client";
import { invalidateAll, keys } from "./api/queries";

export function newQueryClient(): QueryClient {
  const qc: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // A refusal will not change on retry; a dropped connection might.
        retry: (count, err) => !(err instanceof ApiError) && count < 2,
        staleTime: 15_000,
      },
    },
    // A lost sign-in anywhere sends the app back to the signed-out page.
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (isUnauthenticated(err) && query.queryKey[0] !== "me") void qc.invalidateQueries({ queryKey: keys.me });
      },
    }),
    mutationCache: new MutationCache({
      onSuccess: () => invalidateAll(qc),
      onError: (err) => {
        if (isUnauthenticated(err)) void qc.invalidateQueries({ queryKey: keys.me });
      },
    }),
  });
  return qc;
}
