import { useSearchParams } from "react-router";

/** The live Workflow page's views: the line, the Blocking among its Tasks, or a list. */
export type LineView = "line" | "blocking" | "text";

/** Which view the address asks for (`?view=blocking`, `?view=text`); the line otherwise. */
export function useLineView(): [LineView, (v: LineView) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get("view");
  const view: LineView = asked === "text" || asked === "blocking" ? asked : "line";
  const set = (v: LineView) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "line") next.delete("view");
        else next.set("view", v);
        return next;
      },
      { replace: true },
    );
  return [view, set];
}

/** The `?scope=` the page is narrowed to, and how to change it (pushed, so Back widens again). */
export function useScopeParam(): [string | null, (s: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = (s: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (s) next.set("scope", s);
      else next.delete("scope");
      return next;
    });
  return [params.get("scope"), set];
}
