import { useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import type { Project, Workflow } from "@/api/client";
import { remember } from "@/components/pickedWorkflow";
import { toShort } from "@/lib/shortid";
import { same } from "./bind";

/**
 * The Workflow an address names (`/projects/:key/workflows/:workflow`, and its editor's at
 * `…/edit`): its id, read long or short, else its name, ignoring case. Undefined when it names
 * none of `workflows` (one since deleted).
 */
export function workflowNamed<W extends Pick<Workflow, "id" | "name">>(workflows: readonly W[], ref: string): W | undefined {
  const id = toShort(ref);
  return workflows.find((w) => w.id === id || w.id === ref) ?? workflows.find((w) => same(w.name, ref));
}

/** The `:workflow` segment of the address, if any. */
export function useWorkflowSegment(): string | undefined {
  return useParams().workflow;
}

/**
 * Going from one Workflow's page to a sibling's: the same page at the sibling's address, keeping
 * what else the address says (`also` changes it in the same step); the pick is remembered in this
 * browser, as the chip on the board remembers it. `replace` says it in place of the address.
 */
export function useGoToWorkflow(path: (workflow: string) => string, project: Pick<Project, "key">, options: { remember?: boolean } = {}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const keep = options.remember !== false;
  return useCallback(
    (next: string, how: { also?: (params: URLSearchParams) => void; replace?: boolean } = {}) => {
      if (keep) remember(project.key, next);
      const params = new URLSearchParams(search);
      params.delete("workflow");
      how.also?.(params);
      const rest = params.toString();
      navigate({ pathname: path(next).split("?")[0], search: rest ? `?${rest}` : "" }, { replace: how.replace });
    },
    [navigate, search, path, project.key, keep],
  );
}

/** What a page opening a Workflow's editor may say: the Workflow was just added, its name to be typed. */
export type EditorState = { rename?: boolean };
