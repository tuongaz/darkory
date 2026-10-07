import { MoonIcon, SunIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { MemberAvatar, type AvatarSize } from "@/components/MemberAvatar";
import { Button } from "@/components/ui/button";
import { WorkGlyph } from "@/components/WorkGlyph";
import { STEP_W, RANK_GAP, tidy } from "@/components/workflow/layout";
import type { Connector, Point, Step, Workflow } from "@/components/workflow/model";
import { defaultWorkflow, sampleSteps, sampleSubtasks, sampleWorkflow } from "@/components/workflow/samples";
import { SubtaskGraph } from "@/components/workflow/SubtaskGraph";
import { WorkflowCanvas } from "@/components/workflow/WorkflowCanvas";
import type { WorkGlyph as Glyph, Working } from "@/lib/work";

/**
 * /dev/design, served by `npm run dev` only (the production build leaves it out): the marks, the
 * WorkGlyph set, the Workflow canvas live and editing, and a Subtask graph, drawn from sample
 * records with no server. The editing canvas applies its own callbacks, and the last few are
 * listed under it, so the payloads M4 will send can be read.
 */
export default function DesignLab() {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 py-6 sm:px-6">
      <header className="flex items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Design lab</h1>
          <p className="text-muted-foreground">Marks, glyphs and the canvases of model v2, on sample records. Dev only.</p>
        </div>
        <ThemeSwitch />
      </header>
      <Section title="Marks" note="Every Member round in a ring: a plain line for a human, the AI gradient for an agent. A standalone mark says its Member works.">
        <AvatarMatrix />
      </Section>
      <Section title="WorkGlyph" note="A Task's derived state at 14px, as rows and cards draw it.">
        <GlyphSet />
      </Section>
      <Section title="Workflow canvas · live" note="Project › Workflow: read-only, the counts and the takers' rings.">
        <WorkflowCanvas workflow={sampleWorkflow} mode="live" className="h-[520px] rounded-lg border" />
      </Section>
      <Section title="Workflow canvas · a new Project" note="The default Workflow at the places darkory init stores: the board's order, ranks 448px apart, rows 128px.">
        <WorkflowCanvas workflow={defaultWorkflow} mode="live" className="h-[420px] rounded-lg border" />
      </Section>
      <Section title="Workflow canvas · editing" note="Settings › Workflow: select, drag, connect, + to add a step, Tidy up.">
        <EditingCanvas />
      </Section>
      <Section title="Subtask graph" note="MAIN-2 Support emoji in names: its Subtasks over the Workflow, Blocking arrows, takeable ones highlighted.">
        <GraphDemo />
      </Section>
    </main>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

function ThemeSwitch() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return (
    <Button
      variant="outline"
      size="xs"
      className="ml-auto"
      onClick={() => {
        document.documentElement.classList.toggle("dark", !dark);
        setDark(!dark);
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
      {dark ? "Light" : "Dark"}
    </Button>
  );
}

const states: (Working | undefined)[] = [undefined, "running", "waiting", "stalled", "ending", "held"];
const stateNames = ["Still", "Running", "Waiting", "Stalled", "Ending", "Held"];
const sizes: AvatarSize[] = ["sm", "md", "lg"];
const people = [
  { name: "builder-1", kind: "agent" as const },
  { name: "Mai Tran", kind: "human" as const },
];

/** Human and agent, each size, each working state a mark can say (a human runs no session). */
function AvatarMatrix() {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[520px] text-xs">
        <thead>
          <tr className="border-b bg-muted text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Member</th>
            {stateNames.map((s) => (
              <th key={s} className="px-3 py-2 text-left font-medium">
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.flatMap((p) =>
            sizes.map((size) => (
              <tr key={`${p.name}-${size}`} className="border-b last:border-0">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {p.kind} · {size}
                </td>
                {states.map((w, i) => (
                  <td key={i} className="px-3 py-2">
                    {w && (p.kind === "human") !== (w === "held") ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <MemberAvatar member={p} size={size} working={w} />
                    )}
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

const glyphs: [Glyph, string][] = [
  [{ glyph: "waiting" }, "waiting"],
  [{ glyph: "working", holderKind: "agent", session: "running" }, "working · running"],
  [{ glyph: "working", holderKind: "agent", session: "waiting" }, "working · waiting"],
  [{ glyph: "working", holderKind: "agent", session: "stalled" }, "working · stalled"],
  [{ glyph: "working", holderKind: "agent", session: "ending" }, "working · ending"],
  [{ glyph: "working", holderKind: "human" }, "working · human"],
  [{ glyph: "blocked" }, "blocked"],
  [{ glyph: "hold" }, "hold"],
  [{ glyph: "done" }, "done"],
  [{ glyph: "dropped" }, "dropped"],
  [{ glyph: "parent", done: 0, dropped: 0, total: 5 }, "parent 0/5"],
  [{ glyph: "parent", done: 2, dropped: 0, total: 5 }, "parent 2/5"],
  [{ glyph: "parent", done: 3, dropped: 1, total: 5 }, "parent 3/5 · 1 dropped"],
  [{ glyph: "parent", done: 5, dropped: 0, total: 5 }, "parent 5/5"],
];

function GlyphSet() {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-2 rounded-lg border p-3">
      {glyphs.map(([g, name]) => (
        <li key={name} className="flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-accent">
          <WorkGlyph glyph={g} />
          <span className="text-xs">{name}</span>
        </li>
      ))}
    </ul>
  );
}

// The sample with a step whose Skill no Member holds, to show its warning.
const editSample: Workflow = (() => {
  const docs: Step = { id: "s-docs", name: "Docs", skill: { id: "k-docs", name: "docs" }, position: 8, x: 0, y: 0, takers: [], tasks: 2, working: 0 };
  const w = { steps: [...sampleWorkflow.steps, docs], connectors: [...sampleWorkflow.connectors, { id: "c-docs-done", from: "s-docs", to: null, name: "done", position: 0 }] };
  const at = tidy(w);
  return { ...w, steps: w.steps.map((s) => ({ ...s, ...at[s.id] })) };
})();

let made = 0;
const newId = (prefix: string) => `${prefix}-new-${++made}`;

/** The editing canvas, applying its own callbacks to a local copy, with the last few listed. */
function EditingCanvas() {
  const [workflow, setWorkflow] = useState(editSample);
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((l) => [line, ...l].slice(0, 5));
  const name = (id: string | null) => (id === null ? "Done" : (workflow.steps.find((s) => s.id === id)?.name ?? id));
  const update = (f: (w: Workflow) => Workflow) => setWorkflow((w) => f(w));
  const nextOutcome = (from: string) => {
    const taken = new Set(workflow.connectors.filter((c) => c.from === from).map((c) => c.name));
    let n = 1;
    while (taken.has(`outcome ${n}`)) n++;
    return `outcome ${n}`;
  };

  return (
    <div className="flex flex-col gap-2">
      <WorkflowCanvas
        workflow={workflow}
        mode="edit"
        className="h-[560px] rounded-lg border"
        onSelect={(step) => say(`onSelect(${step ? step.name : "null"})`)}
        onMove={(step, x, y) => {
          say(`onMove(${step.name}, ${x}, ${y})`);
          update((w) => ({ ...w, steps: w.steps.map((s) => (s.id === step.id ? { ...s, x, y } : s)) }));
        }}
        onAddStep={(from, at?: Point) => {
          say(`onAddStep(${name(from)}${at ? `, {x: ${at.x}, y: ${at.y}}` : ""})`);
          update((w) => {
            const source = w.steps.find((s) => s.id === from)!;
            const id = newId("s");
            const step: Step = {
              id,
              name: `Step ${made}`,
              position: Math.max(...w.steps.map((s) => s.position)) + 1,
              x: at?.x ?? source.x + STEP_W + RANK_GAP,
              y: at?.y ?? source.y,
              takers: [],
              tasks: 0,
              working: 0,
            };
            const connector: Connector = { id: newId("c"), from, to: id, name: nextOutcome(from), position: w.connectors.length };
            return { steps: [...w.steps, step], connectors: [...w.connectors, connector] };
          });
        }}
        onAddConnector={(ends) => {
          say(`onAddConnector(${name(ends.from)} → ${name(ends.to)})`);
          update((w) => ({ ...w, connectors: [...w.connectors, { id: newId("c"), ...ends, name: nextOutcome(ends.from), position: w.connectors.length }] }));
        }}
        onConnectorChange={(c, ends) => {
          say(`onConnectorChange(${c.name}: ${name(ends.from)} → ${name(ends.to)})`);
          update((w) => ({ ...w, connectors: w.connectors.map((x) => (x.id === c.id ? { ...x, ...ends } : x)) }));
        }}
        onDeleteStep={(step, moveTo) => {
          say(`onDeleteStep(${step.name}${moveTo ? `, move to ${name(moveTo)}` : ""})`);
          update((w) => ({
            steps: w.steps.filter((s) => s.id !== step.id).map((s) => (s.id === moveTo ? { ...s, tasks: s.tasks + step.tasks } : s)),
            connectors: w.connectors.filter((c) => c.from !== step.id && c.to !== step.id),
          }));
        }}
        onDeleteConnector={(c) => {
          say(`onDeleteConnector(${c.name}: ${name(c.from)} → ${name(c.to)})`);
          update((w) => ({ ...w, connectors: w.connectors.filter((x) => x.id !== c.id) }));
        }}
        onLayout={(positions) => {
          say(`onLayout(${Object.keys(positions).length} steps)`);
          update((w) => ({ ...w, steps: w.steps.map((s) => ({ ...s, ...positions[s.id] })) }));
        }}
      />
      <ol aria-label="Callbacks" className="min-h-[1lh] font-mono text-xs text-muted-foreground">
        {log.length === 0 ? <li>No callback yet.</li> : log.map((l, i) => <li key={`${i}-${l}`}>{l}</li>)}
      </ol>
    </div>
  );
}

function GraphDemo() {
  const [opened, setOpened] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <SubtaskGraph steps={sampleSteps} subtasks={sampleSubtasks} onOpen={(id) => setOpened(sampleSubtasks.find((s) => s.id === id)?.key)} className="rounded-lg border p-2" />
      <p className="font-mono text-xs text-muted-foreground">{opened ? `onOpen(${opened})` : "Click a Subtask."}</p>
    </div>
  );
}
