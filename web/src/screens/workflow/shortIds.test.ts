import { describe, expect, it } from "vitest";
import type { Activity, ActivityKind } from "@/api/client";
import { toShort } from "@/lib/shortid";
import { describe as sentence } from "@/screens/inbox/wording";
import { aboutThisFlow, lineText, trailLine, type FlowContext } from "./flowEvents";

/*
 * Since ADR 0017 every id the API writes, in records and in Activity payloads alike, is 22
 * characters. What's happening, the Activity page and the Inbox join an entry's subject, actor
 * and Steps against the records they read: written short on both sides, they meet.
 */

const id = (n: number) => toShort(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const [project, other, task, builder, build, review] = [1, 2, 3, 4, 5, 6].map(id);

const ctx: FlowContext = {
  projectId: project,
  workflow: {
    steps: [
      { id: build, name: "Build", position: 1 },
      { id: review, name: "Code review", position: 2 },
    ],
    connectors: [{ id: id(7), from: build, to: review, name: "ready for review" }],
  },
  task: (x) => (x === task ? { key: "SW-4", step_id: build, project_id: project } : undefined),
  member: (x) => (x === builder ? { id: builder, name: "builder", kind: "agent" } : undefined),
};

let seq = 1;
const entry = (kind: ActivityKind, payload: Record<string, unknown>): Activity => ({ seq: seq++, at: "2026-10-08T09:30:00Z", kind, subject_type: "task", subject_id: task, actor_id: builder, payload });

describe("Activity written with short ids", () => {
  it("are 22 characters", () => {
    expect([project, task, builder, build].every((x) => x.length === 22)).toBe(true);
  });

  it("finds its Task, its holder and its Steps in What's happening", () => {
    expect(lineText(trailLine(entry("task.claimed", { step_id: build }), ctx)!)).toBe("builder picked up SW-4 at Build");
    expect(lineText(trailLine(entry("task.advanced", { from: build, to: review, outcome: "ready for review" }), ctx)!)).toBe("builder advanced SW-4 along ready for review to Code review");
  });

  it("keeps another Project's entries out", () => {
    expect(aboutThisFlow({ ...entry("task.filed", { key: "MAIN-1", project_id: other }), subject_id: id(9) }, ctx)).toBe(false);
  });

  it("names the Task and the Member on the Activity page and in the Inbox", () => {
    const s = sentence(entry("task.claimed", { step_id: build }), {
      members: new Map([[builder, { name: "builder", kind: "agent" as const }]]),
      skills: new Map(),
      tasks: new Map([[task, { key: "SW-4", title: "Creating a link requires an API key" }]]),
      stepName: (x) => (x === build ? "Build" : undefined),
      projects: new Map([[project, { key: "SW", name: "Software" }]]),
      claims: new Map(),
    })!;
    expect(s.actorName).toBe("builder");
    expect(s.subject).toMatchObject({ type: "task", key: "SW-4" });
  });
});
