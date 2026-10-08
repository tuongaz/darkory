import type { Page, Route } from "@playwright/test";

// A mocked /v1 for the Workflow page's panels under `vite dev` (`npm run lab`), on the mockup's
// fixture (mock-workflow/fixture.md): Main (MAIN) at 10:42:05 on 8 Oct 2026, tuongaz signed in, the
// agents builder, qa, reviewer, planner and retro (paused). Three days: `now` (r2-final F1),
// `heavy` (F3: five need tuongaz) and `quiet` (F4: 14:20, nothing since 13:12). Times are UTC; the
// lab's browser runs in UTC with its clock fixed at the day's moment.

export type Day = "now" | "heavy" | "quiet";

const T = (hms: string, day = "2026-10-08") => `${day}T${hms}Z`;
const Y = (hms: string) => T(hms, "2026-10-07");
const ms = (iso: string) => Date.parse(iso);
export const clockOf: Record<Day, string> = { now: T("10:42:05"), heavy: T("10:42:05"), quiet: T("14:20:00") };

const created = Y("08:00:00");
const human = (id: string, name: string, admin = false) => ({ id, name, kind: "human", admin, created_at: created });
const agent = (id: string, name: string, paused = false) => ({
  id,
  name,
  kind: "agent",
  admin: false,
  manager_id: "m-tuongaz",
  created_at: created,
  agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: {}, unattended: true, paused },
});

const skill = (name: string, builtin = false, current = 1) => ({ id: `s-${name}`, name, kind: "generic", builtin, current_version: current, created_at: created });
const skills = [
  skill("acceptance", true),
  skill("breakdown", true),
  skill("engineer", false, 2),
  skill("qa"),
  skill("retro", true),
  skill("review"),
  skill("skill-review", true),
];

const project = { id: "p-main", key: "MAIN", name: "Main", auto_complete: false, acceptance: true, created_at: created };

function membersOf(day: Day) {
  return [
    human("m-tuongaz", "tuongaz", true),
    agent("m-builder", "builder"),
    agent("m-qa", "qa"),
    agent("m-reviewer", "reviewer"),
    agent("m-planner", "planner"),
    agent("m-retro", "retro", day !== "quiet"),
  ];
}
const taker = (id: string, name: string) => ({ id, name, kind: "agent" });

function workflowOf() {
  const st = (id: string, name: string, position: number, x: number, y: number, skillName: string | undefined, takers: { id: string; name: string; kind: string }[], median?: number) => ({
    id,
    name,
    skill_id: skillName ? `s-${skillName}` : undefined,
    position,
    x,
    y,
    tasks: 0,
    working: 0,
    takers,
    median_ms: median,
  });
  return {
    project_id: project.id,
    steps: [
      st("st-backlog", "Backlog", 1, 0, 0, undefined, []),
      st("st-plan", "Plan", 2, 0, 128, "breakdown", [taker("m-planner", "planner")], 6 * 60_000),
      st("st-build", "Build", 3, 0, 256, "engineer", [taker("m-builder", "builder")], 18 * 60_000),
      st("st-qa", "QA", 4, 448, 256, "qa", [taker("m-qa", "qa")], 9 * 60_000),
      st("st-review", "Review", 5, 896, 256, "review", [taker("m-reviewer", "reviewer")], 12 * 60_000),
      st("st-acceptance", "Acceptance", 6, 448, 416, "acceptance", [taker("m-qa", "qa")]),
      st("st-retro", "Retro", 7, 0, 576, "retro", [taker("m-retro", "retro")]),
      st("st-skill-review", "Skill review", 8, 448, 576, "skill-review", [taker("m-reviewer", "reviewer")]),
    ],
    connectors: [
      { id: "c1", from_step_id: "st-plan", name: "done", position: 1 },
      { id: "c2", from_step_id: "st-build", to_step_id: "st-qa", name: "pass", position: 1 },
      { id: "c3", from_step_id: "st-build", to_step_id: "st-review", name: "no UI change", position: 2 },
      { id: "c4", from_step_id: "st-qa", to_step_id: "st-review", name: "pass", position: 1 },
      { id: "c5", from_step_id: "st-qa", to_step_id: "st-build", name: "fail", position: 2 },
      { id: "c6", from_step_id: "st-review", name: "pass", position: 1 },
      { id: "c7", from_step_id: "st-review", to_step_id: "st-qa", name: "needs QA", position: 2 },
      { id: "c8", from_step_id: "st-review", to_step_id: "st-build", name: "needs changes", position: 3 },
      { id: "c9", from_step_id: "st-acceptance", name: "pass", position: 1 },
      { id: "c10", from_step_id: "st-acceptance", to_step_id: "st-build", name: "fail", position: 2 },
      { id: "c11", from_step_id: "st-retro", name: "done", position: 1 },
      { id: "c12", from_step_id: "st-retro", to_step_id: "st-skill-review", name: "propose", position: 2 },
      { id: "c13", from_step_id: "st-skill-review", name: "publish", position: 1 },
      { id: "c14", from_step_id: "st-skill-review", to_step_id: "st-retro", name: "needs changes", position: 2 },
    ],
  };
}

type Rec = Record<string, unknown>;
const stepSkill: Record<string, string | undefined> = {
  "st-plan": "s-breakdown",
  "st-build": "s-engineer",
  "st-qa": "s-qa",
  "st-review": "s-review",
  "st-acceptance": "s-acceptance",
  "st-retro": "s-retro",
  "st-skill-review": "s-skill-review",
};
function task(n: number, title: string, stepId: string | undefined, since: string, extra: Rec = {}): Rec {
  return {
    id: `k-${n}`,
    key: `MAIN-${n}`,
    project_id: project.id,
    kind: "work",
    title,
    description: "",
    state: "open",
    owner_id: "m-tuongaz",
    rank: n,
    step_id: stepId,
    step_since: stepId ? since : undefined,
    skill_id: stepId ? stepSkill[stepId] : undefined,
    breakdown: false,
    auto_complete: false,
    acceptance: false,
    blocked: false,
    filed_by: "m-tuongaz",
    waiting_since: since,
    created_at: since,
    ...extra,
  };
}
const claim = (n: number, holder: string, started: string) => ({ id: `cl-${n}`, task_id: `k-${n}`, holder_id: holder, session_id: `sess-${n}`, heartbeat_timeout_seconds: 600, started_at: started, expires_at: T("23:59:00") });
const brief = (n: number, title: string) => ({ id: `k-${n}`, key: `MAIN-${n}`, title });

let seq = 0;
const entry = (at: string, kind: string, n: number, actor: string | undefined, payload: Rec = {}) => ({
  seq: ++seq,
  at,
  kind,
  subject_type: "task",
  subject_id: `k-${n}`,
  ...(actor ? { actor_id: actor } : {}),
  payload: { project_id: project.id, ...payload },
});

/** The day's Tasks, Activity, Runner sessions, seen mark and Task records. */
export function dayOf(day: Day) {
  seq = 100;
  if (day === "quiet") {
    const tasks = [
      task(4, "Coordinator export times out", "st-qa", T("13:12:00")),
      task(19, "Export reactions", "st-build", T("10:34:20"), { blocked: true, open_blockers: [brief(4, "Coordinator export times out")] }),
    ];
    const activity = [
      entry(T("12:30:15"), "task.completed", 14, "m-retro", { from: "st-retro", outcome: "done", since: ms(T("12:20:00")) }),
      entry(T("12:51:02"), "task.claimed", 4, "m-builder"),
      entry(T("13:12:00"), "task.advanced", 4, "m-builder", { from: "st-build", to: "st-qa", outcome: "pass", since: ms(T("12:40:00")) }),
    ];
    return { tasks, activity, sessions: [], seen: { seq: activity.at(-1)!.seq, at: T("13:40:00") }, details: {} as Record<string, Rec> };
  }
  const tasks: Rec[] = [
    task(5, "Participant search ignores accents", "st-backlog", Y("16:42:00")),
    task(10, "Show reaction counts", "st-build", T("09:59:05"), { claim: claim(10, "m-builder", T("10:42:05")) }),
    task(4, "Coordinator export", "st-build", T("09:40:05"), { blocked: true, open_blockers: [brief(13, "Which export format do coordinators use?")] }),
    task(11, "Reaction search in the picker", "st-build", T("09:59:05"), { blocked: true, open_blockers: [brief(10, "Show reaction counts")] }),
    task(19, "Export reactions", "st-build", T("10:34:20"), { blocked: true, open_blockers: [brief(12, "Admin can remove a reaction"), brief(4, "Coordinator export")] }),
    task(9, "Reaction picker on a message", "st-qa", T("10:29:30"), { claim: claim(9, "m-qa", T("10:36:50")) }),
    task(6, "Invoice PDF shows the wrong ABN", "st-review", T("10:05:00"), { claim: claim(6, "m-reviewer", T("10:20:03")) }),
    task(12, "Admin can remove a reaction", "st-review", T("10:36:40")),
    task(13, "Which export format do coordinators use?", undefined, T("10:06:05"), { aimed_at_id: "m-tuongaz", filed_by: "m-builder" }),
    task(14, "Retrospective: Saved cards", "st-retro", Y("17:42:00"), { kind: "retrospective", filed_by: undefined }),
    task(7, "Emoji reactions on support messages", undefined, T("08:02:00"), { subtask_counts: { open: 5, working: 0, done: 1, dropped: 0 } }),
    task(18, "Reaction counts in the export", "st-build", T("10:33:00"), { parent_id: "k-7", rank: undefined, blocked: true, open_blockers: [brief(11, "Reaction search in the picker")] }),
  ];
  const activity: Rec[] = [
    entry(T("08:02:00"), "task.filed", 7, "m-tuongaz", {}),
    entry(T("09:40:05"), "task.filed", 4, "m-tuongaz", { step_id: "st-build" }),
    entry(T("09:58:15"), "task.filed", 12, "m-tuongaz", { step_id: "st-build" }),
    entry(T("09:58:30"), "task.filed", 9, "m-planner", { step_id: "st-build" }),
    entry(T("09:59:05"), "task.filed", 10, "m-tuongaz", { step_id: "st-build" }),
    entry(T("10:06:05"), "task.filed", 13, "m-builder", { aimed_at_id: "m-tuongaz", blocks: ["k-4"] }),
    entry(T("10:13:40"), "task.claimed", 12, "m-builder"),
    entry(T("10:18:50"), "task.advanced", 12, "m-builder", { from: "st-build", to: "st-qa", outcome: "pass", since: ms(T("09:58:15")) }),
    entry(T("10:20:03"), "task.claimed", 6, "m-reviewer"),
    entry(T("10:21:15"), "task.claimed", 12, "m-qa"),
    entry(T("10:21:20"), "task.claimed", 9, "m-builder"),
  ];
  const seen = { seq, at: T("10:25:00") };
  activity.push(
    entry(T("10:29:30"), "task.advanced", 9, "m-builder", { from: "st-build", to: "st-qa", outcome: "pass", since: ms(T("09:58:30")) }),
    entry(T("10:33:00"), "task.filed", 18, "m-tuongaz", { step_id: "st-build", parent_id: "k-7" }),
    entry(T("10:34:20"), "task.filed", 19, "m-tuongaz", { step_id: "st-build" }),
    entry(T("10:36:40"), "task.advanced", 12, "m-qa", { from: "st-qa", to: "st-review", outcome: "pass", since: ms(T("10:18:50")) }),
    entry(T("10:36:50"), "task.claimed", 9, "m-qa"),
    entry(T("10:42:05"), "task.claimed", 10, "m-builder"),
  );
  const sessions = [
    { task_id: "k-10", member_id: "m-builder", session_id: "sess-10", host: "mac-mini", tmux: "dk-MAIN-10", started_at: T("10:42:05"), state: "running", log_path: "/tmp/MAIN-10.log" },
    { task_id: "k-9", member_id: "m-qa", session_id: "sess-9", host: "mac-mini", tmux: "dk-MAIN-9", started_at: T("10:36:50"), state: "running", log_path: "/tmp/MAIN-9.log" },
    { task_id: "k-6", member_id: "m-reviewer", session_id: "sess-6", host: "mac-mini", tmux: "dk-MAIN-6", started_at: T("10:20:03"), state: "waiting", log_path: "/tmp/MAIN-6.log" },
  ];
  const details: Record<string, Rec> = { "MAIN-14": { proposals: [] } };
  if (day === "heavy") {
    tasks.push(
      task(16, "Coordinator dashboard filters", undefined, T("07:30:00"), { subtask_counts: { open: 0, working: 0, done: 2, dropped: 1 } }),
      task(17, "Retrospective: Bulk invite coordinators", "st-retro", T("10:40:00", "2026-10-06"), { kind: "retrospective", filed_by: undefined }),
      task(15, "Refund email links the wrong order", "st-qa", T("07:55:00")),
    );
    const ended = [
      task(20, "Filter by site", undefined, T("08:00:00"), { parent_id: "k-16", rank: undefined, state: "done", ended_at: T("08:40:00") }),
      task(21, "Filter by shift", undefined, T("08:00:00"), { parent_id: "k-16", rank: undefined, state: "done", ended_at: T("09:12:00") }),
      task(22, "Filter by role", undefined, T("08:00:00"), { parent_id: "k-16", rank: undefined, state: "dropped", ended_at: T("09:02:00") }),
    ];
    tasks.push(...ended);
    details["MAIN-16"] = { subtasks: ended };
    details["MAIN-17"] = {
      proposals: [{ id: "pr-1", skill_id: "s-engineer", task_id: "k-17", based_on_version: 1, body: "", author_id: "m-retro", state: "pending", created_at: T("10:40:00", "2026-10-06") }],
    };
    activity.unshift(
      entry(T("07:55:00"), "task.filed", 15, "m-tuongaz", { step_id: "st-qa" }),
      entry(T("08:02:00"), "task.claimed", 20, "m-builder"),
      entry(T("08:40:00"), "task.completed", 20, "m-builder", { parent_id: "k-16" }),
      entry(T("09:02:00"), "task.dropped", 22, "m-tuongaz", { parent_id: "k-16" }),
      entry(T("09:12:00"), "task.completed", 21, "m-builder", { parent_id: "k-16" }),
    );
    activity.push(entry(T("10:12:00"), "task.claimed", 15, "m-qa"), entry(T("10:30:05"), "task.lapsed", 15, undefined, { holder_id: "m-qa" }));
    activity.sort((a, b) => ms(a.at as string) - ms(b.at as string));
    activity.forEach((e, i) => (e.seq = 101 + i));
    seen.seq = activity.filter((e) => ms(e.at as string) <= ms(T("10:25:00"))).at(-1)!.seq as number;
  }
  return { tasks, activity, sessions, seen, details };
}

function detailOf(t: Rec, extra: Rec = {}) {
  return { task: t, subtasks: [], connectors: [], labels: [], workspaces: [], claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [], proposals: [], ...extra };
}

/** Answers every /v1 read the shell, the Workflow page and its panels make, on `day`. */
export async function mockPanels(page: Page, day: Day) {
  const d = dayOf(day);
  const members = membersOf(day);
  const wf = workflowOf();
  const me = members[0];
  await page.addInitScript(() => {
    class Quiet extends EventTarget {
      readyState = 1;
      onopen: unknown = null;
      onerror: unknown = null;
      close() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = Quiet;
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const q = url.searchParams;
    if (req.method() === "PUT" && path.endsWith("/seen")) return json(route, d.seen);
    if (req.method() !== "GET") return json(route, { code: "not_found", message: `${req.method()} ${path} is not mocked` }, 404);
    if (path === "/v1/health") return json(route, { status: "ok", version: "v2.0.0", sign_in_modes: ["printed_link"] });
    if (path === "/v1/me")
      return json(route, {
        organisation: { id: "o-1", name: "Sacca", created_at: created },
        member: me,
        projects: [project],
        skills: [],
        session: { id: "browser-1", member_id: me.id, kind: "browser", started_at: created, last_seen_at: created },
      });
    if (path === "/v1/members") return json(route, { items: members });
    if (path.startsWith("/v1/members/")) return json(route, { member: me, projects: [project], skills: [], reports: [] });
    if (path === "/v1/projects") return json(route, { items: [project] });
    if (path === "/v1/projects/MAIN" || path === "/v1/projects/p-main") return json(route, { project, members });
    if (path.endsWith("/seen")) return json(route, d.seen);
    if (path.endsWith("/workflow")) return json(route, wf);
    if (path.endsWith("/labels") || path === "/v1/labels") return json(route, { items: [] });
    if (path === "/v1/skills") return json(route, { items: skills });
    if (path === "/v1/tasks/takeable") return json(route, { items: [] });
    if (path.startsWith("/v1/tasks/")) {
      const ref = decodeURIComponent(path.split("/")[3]);
      const t = d.tasks.find((x) => x.key === ref || x.id === ref);
      return t ? json(route, detailOf(t, d.details[t.key as string])) : json(route, { code: "not_found", message: "No such Task" }, 404);
    }
    if (path === "/v1/tasks") {
      const state = q.get("state");
      const aimed = q.get("aimed_at");
      const holder = q.get("holder");
      const items = d.tasks.filter(
        (t) => (!state || t.state === state) && (!aimed || t.aimed_at_id === aimed) && (!holder || (t.claim as Rec | undefined)?.holder_id === holder),
      );
      return json(route, { items });
    }
    if (path === "/v1/runner/sessions") return json(route, { items: d.sessions, runner: true });
    if (path === "/v1/workspaces" || path === "/v1/views") return json(route, { items: [] });
    if (path === "/v1/activity") {
      const kinds = q.getAll("kind");
      const ref = q.get("task");
      const about = ref ? d.tasks.find((t) => t.key === ref || t.id === ref) : undefined;
      const items = d.activity.filter(
        (e) =>
          (kinds.length === 0 || kinds.includes(e.kind as string)) &&
          (!about || e.subject_id === about.id || (e.payload as Rec).parent_id === about.id),
      );
      return json(route, { items, last_seq: items.at(-1)?.seq ?? 0, first_seq: items[0]?.seq });
    }
    return json(route, { code: "not_found", message: `${path} is not mocked` }, 404);
  });
}
