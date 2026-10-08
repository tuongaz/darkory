import { useSearchParams } from "react-router";

export type WorkflowView = "canvas" | "text";

/** Which view the address asks for: `?view=text` is the list, anything else the canvas. */
export function useWorkflowView(): [WorkflowView, (v: WorkflowView) => void] {
  const [params, setParams] = useSearchParams();
  const view: WorkflowView = params.get("view") === "text" ? "text" : "canvas";
  const set = (v: WorkflowView) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "text") next.set("view", "text");
        else next.delete("view");
        return next;
      },
      { replace: true },
    );
  return [view, set];
}
