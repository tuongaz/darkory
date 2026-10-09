import { describe, expect, it } from "vitest";
import type { Activity, RunnerSession, Task } from "@/api/client";
import type { Workflow as Model } from "@/components/workflow/model";
import { ada, bob, builder, parentTask, step, subtask, task, web, workflow } from "@/test/fixtures";
import type { FlowContext } from "../flowEvents";
import { shownWorkflow } from "@/components/pickedWorkflow";
import { entriesOf, isQuiet, segmentsOf, storiesOf, type StoriesInput } from "./stories";

const now = Date.parse("2026-10-08T10:42:05");
const at = (hms: string) => new Date(`2026-10-08T${hms}`).toISOString();
const ms = (hms: string) => Date.parse(at(hms));
const startOfToday = Date.parse("2026-10-08T00:00:00");

// WEB's default Workflow as the canvas model has it: Backlog · Plan · Build · Review · Retro · Skill review.
const record = workflow(web);
const model: Model = {
  workflows: record.workflows,
  steps: record.steps.map((s) => ({ id: s.id, workflow_id: s.workflow_id, name: s.name, position: s.position, x: s.x, y: s.y, takers: [], tasks: 0, working: 0, skill: s.skill_id ? { id: s.skill_id, name: s.skill_id } : undefined })),
  connectors: record.connectors.map((c) => ({ id: c.id, from: c.from_step_id, to: c.to_step_id ?? null, name: c.name, position: c.position })),
};

let seq = 0;
function e(kind: Activity["kind"], subject: Task, hms: string, actor?: string, payload: Record<string, unknown> = {}): Activity {
  seq += 1;
  return { seq, at: at(hms), kind, subject_type: "task", subject_id: subject.id, actor_id: actor, payload };
}
const claim = (t: Task, holder: string, hms: string) => ({ ...t, claim: { id: `c-${t.id}`, task_id: t.id, holder_id: holder, session_id: "s", started_at: at(hms) } });

// The morning of r2-final F1, on WEB: builder just picked up WEB-10; WEB-9 went Build → Review
// and ada picked it up; bob sent WEB-12 back to Build; ada filed WEB-18 under the Parent WEB-7;
// WEB-13 (a question) is in Needs you; builder picked up WEB-6 before ada last looked, its
// session waiting; WEB-2 moved yesterday.
function morning() {
  seq = 0;
  const t10 = claim(task(10, { title: "Show reaction counts", step_since: at("09:59:00") }), builder.id, "10:42:00");
  const t9 = claim(task(9, { title: "Reaction picker on a message", step_id: step.review, step_since: at("10:29:30") }), ada.id, "10:36:50");
  const t12 = task(12, { title: "Admin can remove a reaction", step_since: at("10:36:40") });
  const p7 = parentTask(7, { open: 5, working: 0, done: 1, dropped: 0 }, { title: "Emoji reactions on support messages" });
  const s18 = subtask(18, p7, { title: "Export reactions" });
  const q13 = task(13, { aimed_at_id: ada.id, step_id: undefined });
  const t6 = claim(task(6, { title: "Invoice PDF shows the wrong ABN", step_id: step.review, step_since: at("10:00:00") }), builder.id, "10:20:03");
  const t2 = task(2, { title: "Yesterday's" });
  const entries: Activity[] = [
    { ...e("task.advanced", t2, "16:00:00", bob.id, { from: step.build, to: step.review, outcome: "pass" }), at: new Date(startOfToday - 8 * 3600_000).toISOString() },
    e("task.filed", t9, "09:58:30", ada.id, { step_id: step.build }),
    e("task.claimed", t9, "10:20:30", builder.id),
    e("task.claimed", t6, "10:20:03", builder.id),
    e("task.advanced", t9, "10:29:30", builder.id, { from: step.build, to: step.review, outcome: "pass", since: ms("09:58:30") }),
  ];
  const seenSeq = seq;
  entries.push(
    e("task.filed", s18, "10:33:00", ada.id, { step_id: step.build, parent_id: p7.id }),
    e("task.filed", q13, "10:34:00", builder.id, { aimed_at_id: ada.id }),
    e("task.advanced", t12, "10:36:40", bob.id, { from: step.review, to: step.build, outcome: "needs changes", since: ms("10:13:40") }),
    e("task.claimed", t9, "10:36:50", ada.id),
    e("task.claimed", t10, "10:42:00", builder.id),
  );
  const tasks = new Map([t10, t9, t12, p7, s18, q13, t6, t2].map((t) => [t.id, t]));
  const members = new Map([ada, bob, builder].map((m) => [m.id, m]));
  const ctx: FlowContext = { projectId: web.id, workflow: model, task: (id) => tasks.get(id), member: (id) => members.get(id) };
  const sessions: RunnerSession[] = [{ task_id: t6.id, member_id: builder.id, session_id: "s", host: "h", started_at: at("10:20:00"), state: "waiting", state_since: at("10:39:00"), log_path: "/l" }];
  const input: StoriesInput = { entries, tasks, ctx, exclude: new Set([q13.id]), sessions, now, from: startOfToday, seenSeq };
  return { input, t9, ctx };
}

const pathText = (s: ReturnType<typeof storiesOf>[number]) =>
  [s.path.map((p) => (p.current ? p.name : `${p.name}${p.ms !== undefined ? ` ${Math.round(p.ms / 60_000)}m` : ""}`)).join(" → "), s.tail].filter(Boolean).join(" · ");

describe("What's happening", () => {
  it("tells one story per Task, newest change first, in the glossary's words with its path today", () => {
    const stories = storiesOf(morning().input);
    expect(stories.map((s) => [s.key, s.verb, pathText(s), s.fresh])).toEqual([
      ["WEB-10", "builder picked up", "Build · waited 43m", true],
      ["WEB-9", "ada picked up", "Build 31m → Review · waited 7m", true],
      ["WEB-12", "bob sent back along needs changes", "Review 23m → Build · waiting 5m", true],
      ["WEB-7", "ada filed WEB-18", "1 of 6 done", true],
      ["WEB-6", "builder picked up", "Review · waited 20m", false],
    ]);
  });

  it("on the page of one Workflow of several, tells only the stories of the Tasks its board shows", () => {
    const { input } = morning();
    // As if WEB's Steps were split: the page shows a Workflow of Build alone, after the rest,
    // placing the Tasks it has as the board does (the page's one placement, `useLineData`'s).
    const split = (tasks: Map<string, Task>) =>
      shownWorkflow(
        "wf-shown",
        { workflows: [{ id: "wf-other", position: 1 }, { id: "wf-shown", position: 2 }], steps: record.steps.map((s) => ({ ...s, workflow_id: s.id === step.build ? "wf-shown" : "wf-other" })) },
        [...tasks.values()],
      );
    const shown = split(input.tasks);
    // WEB-9 and WEB-6 are at Review now, another Workflow's; the Parent WEB-7 is where its open
    // Subtask WEB-18 is, at Build.
    expect(storiesOf({ ...input, shown }).map((s) => s.key)).toEqual(["WEB-10", "WEB-12", "WEB-7"]);
    // With WEB-18 at Review, WEB-7 is on Review's page, as on its board.
    const s18 = [...input.tasks.values()].find((t) => t.key === "WEB-18")!;
    const moved = new Map(input.tasks).set(s18.id, { ...s18, step_id: step.review });
    expect(storiesOf({ ...input, tasks: moved, shown: split(moved) }).map((s) => s.key)).toEqual(["WEB-10", "WEB-12"]);
    // A Task not read yet goes by the Step its latest entry leaves it at.
    const unknown = { ...input, tasks: new Map(), shown };
    expect(storiesOf(unknown).map((s) => s.key)).not.toContain("WEB-9");
  });

  it("reads 'now' for a change under a minute old, flags a waiting session as nudged, and gives a Needs-you Task no row", () => {
    const stories = storiesOf(morning().input);
    expect(stories.filter((s) => s.now).map((s) => s.key)).toEqual(["WEB-10"]);
    expect(stories.filter((s) => s.nudged).map((s) => s.key)).toEqual(["WEB-6"]);
    expect(stories.map((s) => s.key)).not.toContain("WEB-13");
  });

  it("before a first look, every row is new", () => {
    expect(storiesOf({ ...morning().input, seenSeq: null }).every((s) => s.fresh)).toBe(true);
  });

  it("folds a run of Subtasks filed by one Member into one change on the Parent's row", () => {
    const { input } = morning();
    const p7 = [...input.tasks.values()].find((t) => t.key === "WEB-7")!;
    const s19 = subtask(19, p7);
    const s20 = subtask(20, p7);
    input.tasks.set(s19.id, s19).set(s20.id, s20);
    const more = [e("task.filed", s19, "10:42:01", ada.id, { parent_id: p7.id }), e("task.filed", s20, "10:42:02", ada.id, { parent_id: p7.id })];
    const stories = storiesOf({ ...input, entries: [...input.entries, ...more] });
    expect(stories[0]).toMatchObject({ key: "WEB-7", verb: "ada filed 3 Subtasks" });
  });

  it("tells an ended Subtask's whole story on its Parent's row", () => {
    const { input } = morning();
    const p7 = [...input.tasks.values()].find((t) => t.key === "WEB-7")!;
    const s20 = subtask(20, p7, { state: "done" });
    input.tasks.set(s20.id, s20);
    const more = [e("task.claimed", s20, "10:41:00", builder.id), e("task.completed", s20, "10:41:30", builder.id, { from: step.build, outcome: "pass" })];
    const stories = storiesOf({ ...input, entries: [...input.entries, ...more] });
    expect(stories.map((s) => s.key)).not.toContain("WEB-20");
    expect(stories.find((s) => s.key === "WEB-7")).toMatchObject({ verb: "builder completed WEB-20" });
  });

  it("goes quiet after an hour without a change, unless something changed since I looked", () => {
    const { input } = morning();
    const later = now + 61 * 60_000;
    const newest = input.entries.at(-1)!.seq;
    expect(isQuiet(input.entries, now, newest)).toBe(false);
    expect(isQuiet(input.entries, later, newest)).toBe(true);
    expect(isQuiet(input.entries, later, newest - 1)).toBe(false);
    expect(isQuiet(input.entries, later, null)).toBe(true);
    expect(isQuiet([], now, null)).toBe(true);
  });
});

describe("a story opened into its path", () => {
  it("splits each stay into waiting and worked time, the live edge last", () => {
    const { input, t9, ctx } = morning();
    const own = input.entries.filter((x) => x.subject_id === t9.id);
    const { segments, stays } = segmentsOf(own, t9, ctx, now, startOfToday);
    expect(segments.map((g) => [g.name, g.kind, Math.round((g.to - g.from) / 60_000), !!g.live])).toEqual([
      ["Build", "wait", 22, false],
      ["Build", "work", 9, false],
      ["Review", "wait", 7, false],
      ["Review", "work", 5, true],
    ]);
    expect(stays.map((s) => [s.name, Math.round((s.to - s.from) / 60_000)])).toEqual([
      ["Build", 31],
      ["Review", 13],
    ]);
  });

  it("lists its entries with the time each closed, and how it stands now", () => {
    const { input, t9, ctx } = morning();
    const own = input.entries.filter((x) => x.subject_id === t9.id);
    expect(entriesOf(own, t9, ctx, now).map((x) => [x.text, x.detail, !!x.live])).toEqual([
      ["ada filed it", "Build", false],
      ["builder picked up", "waited 22m", false],
      ["builder advanced along pass", "9m", false],
      ["ada picked up", "waited 7m · 5m so far", true],
    ]);
  });

  it("names the Subtasks a Parent's run of filings brought, on one line", () => {
    seq = 100;
    const p = parentTask(7, { open: 2, working: 0, done: 0, dropped: 0 });
    const [a, b] = [subtask(18, p), subtask(19, p)];
    const tasks = new Map([p, a, b].map((t) => [t.id, t]));
    const ctx: FlowContext = { projectId: web.id, workflow: model, task: (id) => tasks.get(id), member: () => ada };
    const own = [e("task.filed", a, "10:00:00", ada.id, { parent_id: p.id }), e("task.filed", b, "10:00:05", ada.id, { parent_id: p.id })];
    expect(entriesOf(own, p, ctx, now).map((x) => x.text)).toEqual(["ada filed WEB-18, WEB-19"]);
  });

  it("closes a Task that waits with how long it has waited", () => {
    const { ctx } = morning();
    const waiting = task(40, { step_since: at("10:30:00") });
    const own = [e("task.filed", waiting, "10:30:00", ada.id, { step_id: step.build })];
    expect(entriesOf(own, waiting, ctx, now).at(-1)).toMatchObject({ text: "still waiting", detail: "12m so far", live: true });
    const { segments } = segmentsOf(own, { ...waiting, blocked: true }, ctx, now, startOfToday);
    expect(segments.map((g) => g.kind)).toEqual(["blocked"]);
  });
});
