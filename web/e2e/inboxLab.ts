// A small Organisation for screenshots of the Inbox, My work, Agents and Activity under `vite dev`
// with /v1 answered by the page's routes (screens.lab.ts): two Projects, two agents (one running,
// one stalled), a question, a Parent awaiting its Owner, a lapse, takeable work and a day of
// Activity in the v2 kinds.
import type { Page, Route } from "@playwright/test";

const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();
const ahead = (m: number) => new Date(now + m * 60_000).toISOString();

const member = (id: string, name: string, kind: "human" | "agent", extra: Record<string, unknown> = {}) => ({ id, name, kind, admin: false, created_at: ago(9000), ...extra });
const agentSettings = (model: string) => ({ command: "claude", args: [], model, env: {}, unattended: true, paused: false });
const ada = member("m-ada", "ada", "human", { admin: true, email: "ada@example.com" });
const bob = member("m-bob", "bob", "human", { manager_id: "m-ada" });
const builder = member("m-builder", "builder-1", "agent", { manager_id: "m-ada", agent: agentSettings("claude-sonnet-5-5") });
const reviewer = member("m-reviewer", "reviewer", "agent", { manager_id: "m-ada", agent: agentSettings("claude-opus-5-5") });
const planner = member("m-planner", "planner", "agent", { manager_id: "m-ada", agent: agentSettings("claude-sonnet-5-5") });
const members = [ada, bob, builder, reviewer, planner];

// The colours the server gives Projects in the order they are made (core.pickProjectColor).
const colors = [0, 6, 3, 9, 1, 2, 4, 5, 7, 8, 10, 11];
let made = 0;
const project = (id: string, key: string, name: string) => ({ id, key, name, color: colors[made++ % colors.length], auto_complete: false, acceptance: true, created_at: ago(9000) });
const web = project("p-web", "WEB", "Web shop");
const ops = project("p-ops", "OPS", "Operations");
const projects = [ops, web];

const skill = (name: string, builtin = false, current = 1) => ({ id: `s-${name}`, name, kind: "generic", builtin, current_version: current, created_at: ago(9000) });
const skills = [skill("acceptance", true), skill("breakdown", true), skill("engineer", false, 3), skill("retro", true), skill("review"), skill("skill-review", true)];

const taker = (m: { id: string; name: string; kind: string }) => ({ id: m.id, name: m.name, kind: m.kind });
function workflow(p: { id: string; key: string }) {
  const id = (s: string) => `${p.key.toLowerCase()}-${s}`;
  const step = (s: string, name: string, position: number, skillName?: string, takers: object[] = [], tasks = 0, working = 0) => ({
    id: id(s),
    name,
    skill_id: skillName && `s-${skillName}`,
    position,
    x: 0,
    y: position * 128,
    tasks,
    working,
    takers,
  });
  return {
    project_id: p.id,
    steps: [
      step("backlog", "Backlog", 1),
      step("plan", "Plan", 2, "breakdown", [taker(planner)]),
      step("build", "Build", 3, "engineer", [taker(builder), taker(bob)], 4, 1),
      step("review", "Review", 4, "review", [taker(reviewer), taker(ada)], 1, 1),
      step("retro", "Retro", 5, "retro"),
      step("skill-review", "Skill review", 6, "skill-review", [taker(ada)]),
    ],
    connectors: [
      { id: id("c1"), from_step_id: id("build"), to_step_id: id("review"), name: "pass", position: 1 },
      { id: id("c2"), from_step_id: id("review"), name: "pass", position: 1 },
    ],
  };
}

type LabTask = { id: string; key: string; project_id: string; state: string; owner_id: string; aimed_at_id?: string; claim?: { holder_id: string } } & Record<string, unknown>;
const task = (n: number, title: string, extra: Record<string, unknown> = {}): LabTask => ({
  id: `k-${n}`,
  key: `WEB-${n}`,
  project_id: web.id,
  kind: "work",
  title,
  description: "",
  state: "open",
  owner_id: ada.id,
  rank: n,
  step_id: "web-build",
  step_since: ago(200),
  skill_id: "s-engineer",
  breakdown: false,
  auto_complete: false,
  acceptance: false,
  blocked: false,
  filed_by: ada.id,
  waiting_since: ago(180 - n),
  created_at: ago(600 - n),
  ...extra,
});
const claim = (t: string, holder: string, extra: Record<string, unknown> = {}) => ({ id: `c-${t}`, task_id: t, holder_id: holder, session_id: `sess-${holder}`, started_at: ago(12), ...extra });

const checkout = task(1, "Checkout flow", { step_id: undefined, step_since: undefined, skill_id: undefined, subtask_counts: { open: 0, working: 0, done: 4, dropped: 0 }, acceptance: true });
const payments = task(2, "Payments rework", { step_id: undefined, step_since: undefined, skill_id: undefined, subtask_counts: { open: 3, working: 1, done: 2, dropped: 1 } });
const cart = task(3, "Build the cart page", {
  parent_id: "k-2",
  rank: undefined,
  blocked: true,
  open_blockers: [{ id: "k-9", key: "WEB-9", title: "Which currency for staging?" }],
  claim: claim("k-3", builder.id, { expires_at: ahead(4), heartbeat_timeout_seconds: 300, skill_id: "s-engineer", model_label: "claude-sonnet-5-5" }),
});
const review = task(4, "Review discount codes", { step_id: "web-review", skill_id: "s-review", claim: claim("k-4", reviewer.id, { expires_at: ahead(1), heartbeat_timeout_seconds: 300, skill_id: "s-review" }) });
const receipts = task(5, "Email receipts", { parent_id: "k-2", rank: undefined, labels: ["l-bug"] });
const search = task(6, "Search by SKU", { owner_id: bob.id });
const copy = task(7, "Rewrite the empty cart copy", { claim: claim("k-7", ada.id) });
const lapsed = task(8, "Tax by region");
const question = task(9, "Which currency for staging?", { step_id: undefined, skill_id: undefined, aimed_at_id: ada.id, filed_by: builder.id, parent_id: "k-2", rank: undefined, created_at: ago(7) });
const opsTask = { ...task(12, "Rotate the API keys", { owner_id: bob.id }), id: "k-ops-12", key: "OPS-12", project_id: ops.id, step_id: "ops-build" };
const retro = task(10, "Retrospective: Checkout flow", { kind: "retrospective", step_id: "web-retro", skill_id: "s-retro", filed_by: undefined, parent_id: "k-1", rank: undefined });
const tasks = [checkout, payments, cart, review, receipts, search, copy, lapsed, question, retro, opsTask];

const entry = (seq: number, kind: string, subject: string, actor: string | undefined, payload: Record<string, unknown>, minutesAgo: number) => ({
  seq,
  at: ago(minutesAgo),
  kind,
  subject_type: kind.split(".")[0],
  subject_id: subject,
  actor_id: actor,
  payload,
});
const activity = [
  entry(1, "task.filed", "k-2", ada.id, { key: "WEB-2", title: "Payments rework", breakdown: true }, 60 * 26),
  entry(2, "task.became_parent", "k-2", planner.id, { from: "web-plan" }, 60 * 25),
  entry(3, "workflow.changed", web.id, ada.id, { steps: [1, 2, 3, 4, 5, 6], tasks_moved: 2 }, 60 * 24),
  entry(4, "label.created", "l-bug", ada.id, { name: "bug", color: "#d1453b" }, 60 * 23),
  entry(5, "task.claimed", "k-8", builder.id, { claim_id: "c-old", skill_id: "s-engineer", heartbeat_timeout_seconds: 300 }, 90),
  entry(6, "task.lapsed", "k-8", undefined, { claim_id: "c-old", holder_id: builder.id }, 84),
  entry(7, "task.moved", "k-6", ada.id, { from: "web-backlog", to: "web-build" }, 70),
  entry(8, "task.claimed", "k-4", reviewer.id, { claim_id: "c-k-4", skill_id: "s-review" }, 40),
  entry(9, "task.advanced", "k-5", builder.id, { claim_id: "c-x", from: "web-build", to: "web-review", outcome: "pass" }, 30),
  entry(10, "task.labels_set", "k-5", bob.id, { added: ["l-bug"], removed: [] }, 25),
  entry(11, "task.split", "k-2", builder.id, { claim_id: "c-y", holder_id: builder.id }, 20),
  entry(12, "task.claimed", "k-3", builder.id, { claim_id: "c-k-3", skill_id: "s-engineer", model_label: "claude-sonnet-5-5" }, 12),
  entry(13, "task.filed", "k-9", builder.id, { key: "WEB-9", title: "Which currency for staging?", aimed_at_id: ada.id, blocks: "k-3", parent_id: "k-2" }, 7),
  entry(14, "task.completed", "k-11", reviewer.id, { claim_id: "c-z", from: "web-review", outcome: "pass" }, 3),
];

const sessions = [
  { task_id: "k-3", member_id: builder.id, session_id: "sess-m-builder", host: "mac-mini", tmux: "dk-WEB-3", started_at: ago(12), state: "running", state_since: ago(12), log_path: "/tmp/a" },
  { task_id: "k-4", member_id: reviewer.id, session_id: "sess-m-reviewer", host: "mac-mini", tmux: "dk-WEB-4", started_at: ago(40), state: "stalled", state_since: ago(40), log_path: "/tmp/b" },
];

const detail = (t: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  task: t,
  subtasks: [],
  connectors: [],
  labels: [],
  workspaces: [],
  claims: [],
  notes: [],
  evidence: [],
  blockers: [],
  blocking: [],
  observations: [],
  proposals: [],
  ...extra,
});
const details: Record<string, object> = {
  "WEB-1": detail(checkout, { subtasks: [{ ...task(13, "Acceptance: Checkout flow", { kind: "acceptance", parent_id: "k-1", state: "done" }) }] }),
  "WEB-10": detail(retro, {
    proposals: [{ id: "pr-1", skill_id: "s-engineer", task_id: "k-10", based_on_version: 2, body: "", author_id: ada.id, state: "pending", created_at: ago(30) }],
  }),
};

const memberDetail = (m: { id: string }) => ({
  member: m,
  projects: m.id === planner.id ? [ops] : m.id === bob.id ? [web, ops] : [web],
  skills: m.id === builder.id ? [skills[2]] : m.id === reviewer.id ? [skills[4]] : m.id === planner.id ? [skills[1]] : [],
  reports: [],
});

function openOnly(query: URLSearchParams) {
  return tasks.filter((t) => {
    if (query.get("state") && t.state !== query.get("state")) return false;
    if (query.get("aimed_at") && t.aimed_at_id !== query.get("aimed_at")) return false;
    if (query.get("holder") && t.claim?.holder_id !== query.get("holder")) return false;
    if (query.get("project") && t.project_id !== (query.get("project") === "OPS" ? ops.id : web.id)) return false;
    const owner = query.getAll("filter").find((f) => f.startsWith("owner:is:"));
    if (owner && t.owner_id !== owner.slice("owner:is:".length)) return false;
    return true;
  });
}

/** Answers every /v1 read the four screens make from the record above. */
export async function mockOrganisation(page: Page) {
  await page.route("**/v1/**", (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/v1/activity/stream") return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: ": connected\n\n" });
    if (path === "/v1/health") return json({ status: "ok", version: "v2.0.0", sign_in_modes: ["printed_link"] });
    if (path === "/v1/me")
      return json({ organisation: { id: "o-1", name: "Acme", created_at: ago(9000) }, member: ada, projects: [web], skills: [skills[2]], session: { id: "browser-1", member_id: ada.id, kind: "browser", started_at: ago(60), last_seen_at: ago(1) } });
    if (path === "/v1/members") return json({ items: members });
    if (path.startsWith("/v1/members/") && path.endsWith("/sessions")) return json({ items: [{ id: `0199a1b2-${path.split("/")[3]}-session-0001`, member_id: path.split("/")[3], kind: "token", started_at: ago(50), last_seen_at: ago(1) }] });
    if (path.startsWith("/v1/members/")) {
      const m = members.find((x) => x.id === path.split("/")[3] || x.name === decodeURIComponent(path.split("/")[3]));
      return m ? json(memberDetail(m)) : route.fulfill({ status: 404, json: { code: "not_found", message: "No Member" } });
    }
    if (path === "/v1/projects") return json({ items: projects });
    if (/^\/v1\/projects\/[^/]+$/.test(path)) {
      const p = path.endsWith("OPS") ? ops : web;
      return json({ project: p, members: p === web ? [ada, bob, builder, reviewer] : [ada, bob, planner] });
    }
    if (path.endsWith("/workflow")) return json(workflow(path.includes("OPS") ? ops : web));
    if (path.endsWith("/labels")) return json({ items: path.includes("/projects/") ? [] : [{ id: "l-bug", name: "bug", color: "#d1453b", created_at: ago(9000) }] });
    if (path === "/v1/skills") return json({ items: skills });
    if (path === "/v1/tasks/takeable") return json({ items: [lapsed, receipts, opsTask, search] });
    if (path === "/v1/tasks") return json({ items: q.get("limit") === "1" ? tasks.slice(0, 1) : openOnly(q) });
    if (path.startsWith("/v1/tasks/")) {
      const key = decodeURIComponent(path.split("/")[3]);
      const t = tasks.find((x) => x.key === key);
      return t ? json(details[key] ?? detail(t)) : route.fulfill({ status: 404, json: { code: "not_found", message: "No Task" } });
    }
    if (path === "/v1/activity") {
      const kinds = q.getAll("kind");
      const memberRef = q.get("member");
      const items = activity
        .filter((e) => kinds.length === 0 || kinds.includes(e.kind))
        .filter((e) => !memberRef || e.actor_id === memberRef || e.payload.holder_id === memberRef || members.find((m) => m.name === memberRef)?.id === e.actor_id);
      return json({ items, last_seq: items.at(-1)?.seq ?? 0, first_seq: items[0]?.seq });
    }
    if (path === "/v1/runner/sessions") return json({ items: sessions, runner: true });
    if (path === "/v1/workspaces" || path === "/v1/views") return json({ items: [] });
    return route.fulfill({ status: 501, json: { code: "not_implemented", message: `${path} is not mocked` } });
  });
}
