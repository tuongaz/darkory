import { useQuery } from "@tanstack/react-query";
import { api, call } from "@/api/client";

/** Whether the Organisation has any Feature yet: until it does, /inbox shows the SetupChecklist. */
export function useAnyFeature() {
  return useQuery({
    queryKey: ["features", { any: true }],
    queryFn: () => call(api.GET("/v1/features", { params: { query: { limit: 1 } } })).then((r) => r.items.length > 0),
  });
}
