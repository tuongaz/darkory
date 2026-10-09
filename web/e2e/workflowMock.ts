import type { Page, Route } from "@playwright/test";

// A mocked /v1 for the Workflow screens under `vite dev` (`npm run lab`): WEB with Sacca's
// Workflow (a QA and an Acceptance step beside the default's), its Members human and agent, Tasks
// waiting and worked at its Steps, and Runner sessions in each state. `PUT …/workflow` answers
// with the body as the record, so the editing canvas can be driven and shot.

const at = "2026-10-08T09:00:00Z";
const human = (id: string, name: string, admin = false) => ({ id, name, kind: "human", admin, created_at: at });
const agent = (id: string, name: string) => ({ id, name, kind: "agent", admin: false, created_at: at, agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: {}, unattended: true, paused: false } });

export const members = [
  human("m-ada", "ada", true),
  human("m-mai", "Mai Tran"),
  agent("m-planner", "planner"),
  agent("m-builder-1", "builder-1"),
  agent("m-builder-2", "builder-2"),
  agent("m-qa", "qa-bot"),
  agent("m-reviewer", "reviewer"),
  agent("m-retro", "retro"),
];
const m = (id: string) => {
  const x = members.find((y) => y.id === id)!;
  return { id: x.id, name: x.name, kind: x.kind };
};

const skill = (name: string, builtin = false) => ({ id: `s-${name}`, name, kind: "generic", builtin, current_version: 1, created_at: at });
export const skills = [
  skill("acceptance", true),
  skill("breakdown", true),
  skill("engineer"),
  skill("qa"),
  skill("retro", true),
  skill("review"),
  skill("skill-review", true),
  skill("docs"),
];

export const project = { id: "p-web", key: "WEB", name: "Web", color: 0, auto_complete: true, acceptance: true, created_at: at };

type WorkflowRec = { id: string; name: string; position: number };
type StepRec = {
  id: string;
  workflow_id: string;
  name: string;
  skill_id?: string;
  position: number;
  x: number;
  y: number;
  tasks: number;
  working: number;
  takers: { id: string; name: string; kind: string }[];
  median_ms?: number;
};
type ConnectorRec = { id: string; from_step_id: string; to_step_id?: string; name: string; position: number };

const st = (id: string, name: string, position: number, x: number, y: number, skillName: string | undefined, takers: string[], tasks: number, working: number, median?: number): StepRec => ({
  id,
  workflow_id: "wf-work",
  name,
  skill_id: skillName ? `s-${skillName}` : undefined,
  position,
  x,
  y,
  tasks,
  working,
  takers: takers.map(m),
  median_ms: median,
});

export function initialWorkflow(): { project_id: string; workflows: WorkflowRec[]; steps: StepRec[]; connectors: ConnectorRec[] } {
  return {
    project_id: project.id,
    workflows: [{ id: "wf-work", name: "Work", position: 1 }],
    steps: [
      st("st-backlog", "Backlog", 1, 0, 0, undefined, [], 3, 0),
      st("st-plan", "Plan", 2, 0, 128, "breakdown", ["m-planner"], 1, 1, 25 * 60_000),
      st("st-build", "Build", 3, 0, 256, "engineer", ["m-builder-1", "m-builder-2", "m-mai"], 4, 2, 3 * 3_600_000),
      st("st-qa", "QA", 4, 448, 256, "qa", ["m-qa"], 1, 1, 50 * 60_000),
      st("st-review", "Review", 5, 896, 256, "review", ["m-reviewer", "m-ada"], 2, 0, 70 * 60_000),
      st("st-acceptance", "Acceptance", 6, 448, 416, "acceptance", [], 1, 0),
      st("st-retro", "Retro", 7, 0, 576, "retro", ["m-retro"], 0, 0, 40 * 60_000),
      st("st-skill-review", "Skill review", 8, 448, 576, "skill-review", ["m-reviewer", "m-ada"], 0, 0),
    ],
    connectors: [
      { id: "c-plan-done", from_step_id: "st-plan", name: "done", position: 1 },
      { id: "c-build-qa", from_step_id: "st-build", to_step_id: "st-qa", name: "pass", position: 1 },
      { id: "c-qa-review", from_step_id: "st-qa", to_step_id: "st-review", name: "pass", position: 1 },
      { id: "c-qa-build", from_step_id: "st-qa", to_step_id: "st-build", name: "fail", position: 2 },
      { id: "c-review-done", from_step_id: "st-review", name: "pass", position: 1 },
      { id: "c-review-build", from_step_id: "st-review", to_step_id: "st-build", name: "needs changes", position: 2 },
      { id: "c-acceptance-done", from_step_id: "st-acceptance", name: "pass", position: 1 },
      { id: "c-acceptance-build", from_step_id: "st-acceptance", to_step_id: "st-build", name: "fail", position: 2 },
      { id: "c-retro-done", from_step_id: "st-retro", name: "done", position: 1 },
      { id: "c-retro-skill-review", from_step_id: "st-retro", to_step_id: "st-skill-review", name: "propose", position: 2 },
      { id: "c-skill-review-done", from_step_id: "st-skill-review", name: "publish", position: 1 },
      { id: "c-skill-review-retro", from_step_id: "st-skill-review", to_step_id: "st-retro", name: "needs changes", position: 2 },
    ],
  };
}

const claim = (n: number, holder: string, minutesAgo = 20) => ({
  id: `cl-${n}`,
  task_id: `k-${n}`,
  holder_id: holder,
  session_id: `sess-${n}`,
  heartbeat_timeout_seconds: 300,
  started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
});

const stepSkill: Record<string, string | undefined> = { "st-plan": "s-breakdown", "st-build": "s-engineer", "st-qa": "s-qa", "st-review": "s-review", "st-acceptance": "s-acceptance" };
const task = (n: number, title: string, stepId: string, extra: Record<string, unknown> = {}) => ({
  id: `k-${n}`,
  key: `WEB-${n}`,
  project_id: project.id,
  kind: "work",
  title,
  description: "",
  state: "open",
  owner_id: "m-ada",
  rank: n,
  step_id: stepId,
  step_since: at,
  workflow_id: "wf-work",
  skill_id: stepSkill[stepId],
  breakdown: false,
  auto_complete: false,
  acceptance: false,
  blocked: false,
  filed_by: "m-ada",
  waiting_since: at,
  created_at: at,
  ...extra,
});

export const tasks = [
  task(1, "Support emoji in names", "st-backlog"),
  task(2, "Export the ledger as CSV", "st-backlog"),
  task(3, "Dark mode for the invoice page", "st-backlog"),
  task(4, "Break down: Checkout", "st-plan", { kind: "breakdown", claim: claim(4, "m-planner") }),
  task(5, "Normalise names on input", "st-build", { claim: claim(5, "m-builder-1") }),
  task(6, "Render emoji in the sidebar", "st-build", { claim: claim(6, "m-builder-2") }),
  task(7, "Store names as NFC", "st-build"),
  task(8, "Fix the avatar tint for two RTs", "st-build", { blocked: true }),
  task(9, "Test emoji across the app", "st-qa", { claim: claim(9, "m-qa") }),
  task(10, "Review the CSV export", "st-review"),
  task(11, "Review the sidebar", "st-review"),
  task(12, "Acceptance: Support emoji", "st-acceptance", { kind: "acceptance" }),
  task(13, "Export the ledger totals", "st-review", { state: "done", step_id: undefined, last_step_id: "st-review" }),
];

const session = (n: number, member: string, state: string) => ({
  task_id: `k-${n}`,
  member_id: member,
  session_id: `sess-${n}`,
  host: "mac-mini",
  tmux: `dk-WEB-${n}`,
  started_at: at,
  state,
  state_since: at,
  log_path: `/tmp/WEB-${n}.log`,
});
export const sessions = [session(4, "m-planner", "running"), session(5, "m-builder-1", "running"), session(6, "m-builder-2", "stalled"), session(9, "m-qa", "waiting")];

/** WEB's recent moves, in sequence order, as `GET /v1/activity?project=WEB` answers: what the trail opens on. */
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const moved = (seq: number, kind: string, subject: string, actor: string | undefined, payload: Record<string, unknown>, ago: number) => ({
  seq,
  at: minutesAgo(ago),
  kind,
  subject_type: "task",
  subject_id: subject,
  ...(actor ? { actor_id: actor } : {}),
  payload,
});
export const activity = [
  moved(41, "task.filed", "k-7", "m-ada", { key: "WEB-7", title: "Store names as NFC", project_id: project.id, step_id: "st-backlog" }, 52),
  moved(42, "task.moved", "k-7", "m-ada", { from: "st-backlog", to: "st-build" }, 48),
  moved(43, "task.claimed", "k-5", "m-builder-1", { step_id: "st-build", skill_id: "s-engineer" }, 40),
  moved(44, "task.advanced", "k-11", "m-builder-2", { from: "st-build", to: "st-qa", outcome: "pass" }, 36),
  moved(45, "task.advanced", "k-11", "m-qa", { from: "st-qa", to: "st-review", outcome: "pass" }, 31),
  moved(46, "task.claimed", "k-6", "m-builder-2", { step_id: "st-build", skill_id: "s-engineer" }, 24),
  moved(47, "task.lapsed", "k-8", undefined, { holder_id: "m-builder-1", claim_id: "cl-x" }, 19),
  moved(48, "task.claimed", "k-9", "m-qa", { step_id: "st-qa", skill_id: "s-qa" }, 12),
  moved(49, "task.completed", "k-13", "m-reviewer", { from: "st-review", outcome: "pass" }, 6),
  moved(50, "task.claimed", "k-4", "m-planner", { step_id: "st-plan", skill_id: "s-breakdown" }, 3),
];

/**
 * Stands in for the browser's EventSource on the page, so a lab can deliver Activity as the
 * stream would: `window.__darkoryEmit(entry)` sends one entry to every open stream.
 */
function fakeStream() {
  type Listener = (e: MessageEvent) => void;
  const open: FakeSource[] = [];
  class FakeSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: Listener | null = null;
    constructor(readonly url: string) {
      super();
      open.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
      }, 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
  (window as unknown as { __darkoryEmit: (entry: unknown) => void }).__darkoryEmit = (entry) => {
    for (const s of open) if (s.readyState === 1) s.dispatchEvent(new MessageEvent("activity", { data: JSON.stringify(entry) }));
  };
}

/** Delivers `entry` over the page's fake stream (`mockV1`), as the server would. */
export async function emit(page: Page, entry: Record<string, unknown>) {
  await page.evaluate((e) => (window as unknown as { __darkoryEmit: (entry: unknown) => void }).__darkoryEmit(e), entry);
}

type Body = {
  workflows: { id?: string; name: string; position?: number }[];
  steps: { id?: string; workflow: string; name: string; skill?: string; position?: number; x?: number; y?: number }[];
  connectors: { id?: string; from: string; to?: string; name: string; position?: number }[];
};

/**
 * The record a `PUT …/workflow` body makes of `wf`: a Workflow sent without an id keeps the id of
 * the one with its name, ignoring case; ids for new Workflows, Steps and Connectors; a position
 * left out is the item's place in its list; the facts kept.
 */
export function applyBody(wf: ReturnType<typeof initialWorkflow>, body: Body): ReturnType<typeof initialWorkflow> {
  let n = 0;
  const workflows = body.workflows.map((w, i) => ({
    id: w.id ?? wf.workflows.find((x) => x.name.toLowerCase() === w.name.toLowerCase())?.id ?? `wf-new-${Date.now()}-${n++}`,
    name: w.name,
    position: w.position || i + 1,
  }));
  const placed = new Map<string, number>();
  const steps = body.steps.map((s) => {
    const was = wf.steps.find((x) => x.id === s.id);
    const id = s.id ?? `st-new-${Date.now()}-${n++}`;
    const workflowId = workflows.find((w) => w.id === s.workflow || w.name === s.workflow)?.id ?? s.workflow;
    placed.set(workflowId, (placed.get(workflowId) ?? 0) + 1);
    const position = s.position || placed.get(workflowId)!;
    const skillId = s.skill ? (skills.find((k) => k.id === s.skill || k.name === s.skill)?.id ?? s.skill) : undefined;
    const takers = skillId === was?.skill_id ? (was?.takers ?? []) : [];
    return {
      id,
      workflow_id: workflowId,
      name: s.name,
      skill_id: skillId,
      position,
      x: s.x ?? was?.x ?? (position - 1) * 448,
      y: s.y ?? was?.y ?? 0,
      tasks: was?.tasks ?? 0,
      working: was?.working ?? 0,
      takers,
      median_ms: was?.median_ms,
    };
  });
  const ref = (r: string | undefined) => (r === undefined ? undefined : (steps.find((s) => s.id === r || s.name === r)?.id ?? r));
  const out = new Map<string, number>();
  const connectors = body.connectors.map((c) => {
    const from = ref(c.from)!;
    out.set(from, (out.get(from) ?? 0) + 1);
    return { id: c.id ?? `c-new-${Date.now()}-${n++}`, from_step_id: from, to_step_id: ref(c.to), name: c.name, position: c.position || out.get(from)! };
  });
  // The Project's order: by Workflow position, then Step position.
  const at = (s: StepRec) => workflows.find((w) => w.id === s.workflow_id)?.position ?? 0;
  return {
    project_id: wf.project_id,
    workflows: workflows.sort((a, b) => a.position - b.position),
    steps: steps.sort((a, b) => at(a) - at(b) || a.position - b.position),
    connectors,
  };
}

/** Answers every /v1 read the shell and the Workflow screens make, as `who`; returns the Tasks it serves, to change. */
export async function mockV1(page: Page, who: "ada" | "bob" = "ada") {
  let wf = initialWorkflow();
  const skillList = skills.map((x) => ({ ...x }));
  // This page's own Tasks, which a lab may change before it delivers the entry that says so.
  const list: Record<string, unknown>[] = tasks.map((t) => ({ ...t }));
  await page.addInitScript(fakeStream);
  const me = who === "ada" ? members[0] : { ...human("m-bob", "bob"), admin: false };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path.endsWith("/seen")) return json(route, { seq: 0, at });
    if (path === "/v1/activity/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" });
    if (method === "GET") {
      if (path === "/v1/health") return json(route, { status: "ok", version: "v2.0.0", sign_in_modes: ["printed_link"] });
      if (path === "/v1/me")
        return json(route, {
          organisation: { id: "o-1", name: "Sacca", created_at: at },
          member: me,
          projects: [project],
          skills: [],
          session: { id: "browser-1", member_id: me.id, kind: "browser", started_at: at, last_seen_at: at },
        });
      if (path === "/v1/members") return json(route, { items: [...members, human("m-bob", "bob")] });
      if (path.startsWith("/v1/members/") && path.split("/").length === 4) {
        const id = path.split("/")[3];
        const m = [...members, human("m-bob", "bob")].find((x) => x.id === id || x.name === id);
        if (!m) return json(route, { code: "not_found", message: `No Member ${id}` }, 404);
        // A Member holds each Skill of a Step whose takers name them.
        const held = new Set(initialWorkflow().steps.filter((x) => x.takers.some((t) => t.id === m.id)).map((x) => x.skill_id));
        return json(route, { member: m, projects: [project], skills: skillList.filter((k) => held.has(k.id)), reports: [] });
      }
      if (path === "/v1/projects") return json(route, { items: [project] });
      if (path === "/v1/projects/WEB" || path === "/v1/projects/p-web") return json(route, { project, members: members.filter((x) => x.id !== "m-mai") });
      if (path.endsWith("/workflow")) return json(route, wf);
      if (path.endsWith("/labels") || path === "/v1/labels") return json(route, { items: [] });
      if (path === "/v1/skills") return json(route, { items: skillList });
      if (path === "/v1/tasks") {
        const step = url.searchParams.get("step");
        const state = url.searchParams.get("state");
        const items = list.filter((t) => (!step || t.step_id === step) && (!state || t.state === state));
        return json(route, { items });
      }
      if (path === "/v1/runner/sessions") return json(route, { items: sessions, runner: true });
      if (path === "/v1/workspaces" || path === "/v1/views") return json(route, { items: [] });
      if (path === "/v1/tasks/takeable") return json(route, { items: [] });
      if (path === "/v1/activity") return json(route, { items: activity, last_seq: 50, first_seq: 41 });
    }
    if (method === "POST" && path === "/v1/skills") {
      const body = req.postDataJSON() as { name: string; body: string };
      const made = { ...skill(body.name), id: `s-${body.name}` };
      skillList.push(made);
      return json(route, { skill: made, current: { skill_id: made.id, version: 1, body: body.body, published_by: "m-ada", published_at: at } }, 201);
    }
    if (method === "PUT" && path.endsWith("/workflow")) {
      wf = applyBody(wf, req.postDataJSON() as Body);
      return json(route, wf);
    }
    return json(route, { code: "not_found", message: `${method} ${path} is not mocked` }, 404);
  });
  return { tasks: list };
}
