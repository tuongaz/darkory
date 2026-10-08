// Saved Views (enably's useSavedFilters, on /v1/views): the Member's Views of a list, applying one
// into the address and the page's Display, and saving, overwriting and deleting them. The address
// names the View last applied (?view.<entity>=<id>), so the chips row can say which it is and
// whether the pills have changed since. Views write no Activity, so nothing arrives on the stream
// when one changes; the list is refetched after this tab's own writes.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiError, api, call, type View, type ViewEntity } from "@/api/client";
import { keys, useViews } from "@/api/queries";
import type { FilterPill } from "./filterState";
import type { FilterField } from "./operators";
import { sameFilters, viewPills, viewTokens } from "./views";
import type { ViewsMenuProps } from "./ViewsMenu";

/** What a View keeps beside its filters: an opaque sort and Display, as the page writes them. */
export type ViewRest = { sort?: string; display?: Record<string, unknown> };

/** The words for a refused save: a name already taken is the one a person can fix. */
function refusal(err: unknown, name?: string): string {
  if (err instanceof ApiError && err.code === "conflict") return `You already have a View named “${name}” for this list.`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Views control's wiring for one list: a Project's (`project`, its key) or one across
 * Projects (none). `rest` is what a save keeps beside the pills; applying a View writes its pills
 * and its id into the address in one write, with what `restParams` adds there (a layout), then
 * hands it to `onApplied` (the page's Display).
 */
export function useSavedViews(cfg: {
  entity: ViewEntity;
  project?: string;
  fields: readonly FilterField[];
  pills: readonly FilterPill[];
  rest: ViewRest;
  restParams?: (view: View, params: URLSearchParams) => void;
  onApplied?: (view: View) => void;
}): ViewsMenuProps & { applied: View | undefined; clear: () => void } {
  const { entity, project, fields, pills, rest, restParams, onApplied } = cfg;
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const filterKey = `filter.${entity}`;
  const appliedKey = `view.${entity}`;

  const list = useViews(entity, project);
  const refetch = () => qc.invalidateQueries({ queryKey: keys.views(entity, project) });
  const tokens = viewTokens(pills);
  const applied = list.data?.find((v) => v.id === params.get(appliedKey));
  const edited = !!applied && !sameFilters(applied.filters, tokens);

  const write = useCallback(
    (change: (next: URLSearchParams) => void) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          change(next);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const create = useMutation({
    mutationFn: (name: string) => call(api.POST("/v1/views", { body: { entity, project, name, filters: tokens, ...rest } })),
  });
  const update = useMutation({
    mutationFn: (id: string) =>
      call(api.PATCH("/v1/views/{view}", { params: { path: { view: id } }, body: { filters: tokens, sort: rest.sort ?? "", display: rest.display } })),
  });
  const remove = useMutation({
    mutationFn: (id: string) => call(api.DELETE("/v1/views/{view}", { params: { path: { view: id } } })),
  });

  return {
    views: list.data,
    appliedId: applied?.id,
    edited,
    applied,
    onApply: (id) => {
      const view = list.data?.find((v) => v.id === id);
      if (!view) return;
      write((next) => {
        next.delete(filterKey);
        for (const t of viewTokens(viewPills(view.filters, fields))) next.append(filterKey, t);
        next.set(appliedKey, view.id);
        restParams?.(view, next);
      });
      onApplied?.(view);
    },
    onSaveNew: async (name) => {
      setError(null);
      try {
        const saved = await create.mutateAsync(name);
        write((next) => next.set(appliedKey, saved.id));
        await refetch();
        return true;
      } catch (err) {
        setError(refusal(err, name));
        return false;
      }
    },
    onOverwrite: async (id) => {
      setError(null);
      try {
        await update.mutateAsync(id);
        write((next) => next.set(appliedKey, id));
        await refetch();
        return true;
      } catch (err) {
        setError(refusal(err));
        return false;
      }
    },
    onDelete: (id) => {
      setError(null);
      remove.mutate(id, {
        onSuccess: () => {
          write((next) => {
            if (next.get(appliedKey) === id) next.delete(appliedKey);
          });
          void refetch();
        },
        onError: (err) => setError(refusal(err)),
      });
    },
    error,
    onClearError: () => setError(null),
    saving: create.isPending || update.isPending,
    // Reset leaves the View too, in the same write as the pills.
    clear: () =>
      write((next) => {
        next.delete(filterKey);
        next.delete(appliedKey);
      }),
  };
}
