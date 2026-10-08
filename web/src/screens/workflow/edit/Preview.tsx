import type { Skill } from "@/api/client";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "../bind";
import { inOrder, type Group } from "./draft";

/*
 * The line the list makes, drawn small above it while editing: the main Steps left to right in the
 * Workflow's order and Done, each outcome to the next Step on the line, loops back as arcs under it
 * nested so none cross, forward skips dashed over it; the Steps after a Parent named under it.
 * What the draft changed is amber. A stand-in until the Workflow line lands, which replaces it.
 */

const W = 1200;
const PAD = 70;
const LINE_Y = 104;
const TRACK = 17;

type Arc = { id: string; from: number; to: number; name: string; changed: boolean; level: number };

export function Preview({
  draft,
  base,
  skills,
  groups,
  className,
}: {
  draft: WorkflowRecord;
  base: WorkflowRecord;
  skills: Map<string, Pick<Skill, "name">>;
  groups: (s: RecordStep) => Group;
  className?: string;
}) {
  const steps = inOrder(draft.steps);
  const main = steps.filter((s) => groups(s) === "main");
  const after = steps.filter((s) => groups(s) === "after");
  const n = main.length + 1;
  const xAt = (i: number) => (n === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
  const index = new Map(main.map((s, i) => [s.id, i]));
  const at = (id: string | undefined) => (id === undefined ? main.length : index.get(id));
  const baseC = new Map(base.connectors.map((c) => [c.id, c]));
  const baseIds = new Set(base.steps.map((s) => s.id));
  const changed = (c: WorkflowRecord["connectors"][number]) => {
    const was = baseC.get(c.id);
    return !was || was.to_step_id !== c.to_step_id || was.name !== c.name.trim();
  };

  const segments = new Map<number, { name: string; changed: boolean }>();
  const under: Arc[] = [];
  const over: Arc[] = [];
  for (const c of [...draft.connectors].sort((a, b) => a.position - b.position)) {
    const from = index.get(c.from_step_id);
    const to = at(c.to_step_id);
    if (from === undefined || to === undefined) continue;
    const arc = { id: c.id, from, to, name: c.name.trim(), changed: changed(c), level: 0 };
    if (to === from + 1) {
      if (!segments.has(from)) segments.set(from, arc);
    } else if (to < from) under.push(arc);
    else if (to > from) over.push(arc);
  }
  nest(under);
  nest(over);
  const deepest = Math.max(0, ...under.map((a) => a.level));
  const H = LINE_Y + 22 + deepest * TRACK + 14;

  return (
    <figure aria-label="Preview of the line" className={cn("min-w-0", className)}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-md:min-w-[760px]" role="img" aria-label={describe(main, segments)}>
          {main.map((s, i) => (
            <line
              key={`seg-${s.id}`}
              x1={xAt(i)}
              x2={xAt(i + 1)}
              y1={LINE_Y}
              y2={LINE_Y}
              strokeWidth={segments.has(i) ? 2.5 : 1.2}
              strokeDasharray={segments.has(i) ? (segments.get(i)!.changed ? "6 4" : undefined) : "3 4"}
              className={segments.get(i)?.changed ? "stroke-state-claimed" : segments.has(i) ? "stroke-foreground" : "stroke-muted-foreground"}
            />
          ))}
          {[...segments].map(([i, seg]) =>
            seg.name ? <Label key={`segl-${i}`} x={(xAt(i) + xAt(i + 1)) / 2} y={LINE_Y} text={seg.name} changed={seg.changed} /> : null,
          )}
          {under.map((a) => {
            const y = LINE_Y + 18 + a.level * TRACK;
            const x1 = xAt(a.from) - 4 - a.level * 7;
            const x2 = xAt(a.to) + 6 + a.level * 7;
            return (
              <g key={a.id} className={a.changed ? "stroke-state-claimed" : "stroke-foreground"}>
                <path d={`M${x1} ${LINE_Y + 8} V${y} H${x2} V${LINE_Y + 10}`} fill="none" strokeWidth={1.4} strokeDasharray={a.changed ? "5 3" : undefined} />
                <path d={`M${x2 - 3.5} ${LINE_Y + 15} L${x2} ${LINE_Y + 9} L${x2 + 3.5} ${LINE_Y + 15}`} fill="none" strokeWidth={1.4} />
                {a.name && <Label x={(x1 + x2) / 2} y={y} text={a.name} changed={a.changed} />}
              </g>
            );
          })}
          {over.map((a) => {
            const y = 16 + (Math.max(0, ...over.map((o) => o.level)) - a.level) * 14;
            const x1 = xAt(a.from);
            const x2 = xAt(a.to);
            return (
              <g key={a.id} className={a.changed ? "stroke-state-claimed" : "stroke-muted-foreground"}>
                <path d={`M${x1} 48 V${y} H${x2} V48`} fill="none" strokeWidth={1.1} strokeDasharray="4 3" />
                <path d={`M${x2 - 3.5} 43 L${x2} 49 L${x2 + 3.5} 43`} fill="none" strokeWidth={1.1} />
                {a.name && <Label x={(x1 + x2) / 2} y={y} text={a.name} changed={a.changed} small />}
              </g>
            );
          })}
          {main.map((s, i) => {
            const fresh = !baseIds.has(s.id);
            const hold = !s.skill_id;
            const skill = s.skill_id ? (skills.get(s.skill_id)?.name ?? s.skill_id.replace(/^new-skill:/, "")) : undefined;
            return (
              <g key={s.id}>
                <text
                  x={xAt(i)}
                  y={60}
                  textAnchor="middle"
                  className={cn("text-[13px] font-semibold", fresh ? "fill-state-claimed" : "fill-foreground", !s.name.trim() && "italic")}
                >
                  {s.name.trim() || "New Step"}
                </text>
                {skill && (
                  <text x={xAt(i)} y={74} textAnchor="middle" className="fill-muted-foreground font-mono text-[11px]">
                    {skill}
                  </text>
                )}
                <circle
                  cx={xAt(i)}
                  cy={LINE_Y}
                  r={7}
                  strokeWidth={2}
                  strokeDasharray={hold || fresh ? "2.5 2.5" : undefined}
                  className={cn("fill-background", fresh ? "stroke-state-claimed" : "stroke-foreground")}
                />
              </g>
            );
          })}
          <text x={xAt(main.length)} y={60} textAnchor="middle" className="fill-foreground text-[13px] font-semibold">
            Done
          </text>
          <circle cx={xAt(main.length)} cy={LINE_Y} r={8} className="fill-state-done" />
        </svg>
      </div>
      {after.length > 0 && (
        <figcaption className="px-5 pb-2.5 text-xs text-muted-foreground">
          After a Parent ·{" "}
          {after.map((s, i) => {
            const prev = after[i - 1];
            const joined = prev && draft.connectors.some((c) => c.from_step_id === prev.id && c.to_step_id === s.id);
            return (
              <span key={s.id}>
                {i > 0 && (joined ? " → " : " · ")}
                <span className={cn(!baseIds.has(s.id) && "text-state-claimed")}>{s.name.trim() || "New Step"}</span>
              </span>
            );
          })}
        </figcaption>
      )}
    </figure>
  );
}

function Label({ x, y, text, changed, small }: { x: number; y: number; text: string; changed: boolean; small?: boolean }) {
  const w = text.length * (small ? 6 : 6.4) + 12;
  return (
    <g>
      <rect x={x - w / 2} y={y - 8} width={w} height={16} className="fill-background stroke-none" />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        className={cn("stroke-none", small ? "text-[10.5px]" : "text-[11px]", changed ? "fill-state-claimed" : "fill-muted-foreground")}
      >
        {text}
      </text>
    </g>
  );
}

/** Levels so that no two arcs cross: an arc sits outside every arc whose span lies within its own. */
function nest(arcs: Arc[]) {
  const span = (a: Arc) => [Math.min(a.from, a.to), Math.max(a.from, a.to)] as const;
  const sorted = [...arcs].sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]));
  const placed: Arc[] = [];
  for (const a of sorted) {
    const [lo, hi] = span(a);
    const inside = placed.filter((p) => {
      const [plo, phi] = span(p);
      return plo <= hi && phi >= lo;
    });
    a.level = inside.length ? Math.max(...inside.map((p) => p.level)) + 1 : 0;
    placed.push(a);
  }
}

function describe(main: RecordStep[], segments: Map<number, { name: string }>): string {
  const names = main.map((s) => s.name.trim() || "New Step");
  return `The line: ${[...names, "Done"].map((name, i) => (i > 0 && segments.has(i - 1) ? `→ ${name}` : i > 0 ? `· ${name}` : name)).join(" ")}`;
}
