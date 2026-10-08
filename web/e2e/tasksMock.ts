import type { Page, Route } from "@playwright/test";

// A mocked /v1 for shooting the Tasks screens under `vite dev` (`npm run lab`): one Project, WEB,
// on the default Workflow with a QA Step and an Acceptance Step, its Members (ada, bob, and the
// agents builder and reviewer), Labels, and Tasks at every Step: a Parent with Subtasks worked by
// agents, a question, a hold, a lapse, done and dropped ones. Nothing here is a real record.

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const created = "2026-10-01T09:00:00Z";

const member = (id: string, name: string, kind: "human" | "agent", extra: Record<string, unknown> = {}) => ({ id, name, kind, admin: false, created_at: created, ...extra });
const ada = member("m-ada", "ada", "human", { admin: true, email: "ada@example.com" });
const bob = member("m-bob", "bob", "human", { manager_id: "m-ada" });
const builder = member("m-builder", "builder", "agent", { manager_id: "m-ada" });
const reviewer = member("m-reviewer", "reviewer", "agent", { manager_id: "m-ada" });
const members = [ada, bob, builder, reviewer];

const web = { id: "p-web", key: "WEB", name: "Web shop", color: 0, auto_complete: true, acceptance: true, created_at: created, default_workspace_id: "w-shop" };
const ops = { id: "p-ops", key: "OPS", name: "Ops", color: 6, auto_complete: false, acceptance: false, created_at: created };

const skill = (name: string, builtin = false) => ({ id: `s-${name}`, name, kind: "generic", builtin, current_version: 1, created_at: created });
const skills = [skill("acceptance", true), skill("breakdown", true), skill("engineer"), skill("qa"), skill("retro", true), skill("review"), skill("skill-review", true)];

const taker = (m: { id: string; name: string; kind: string }) => ({ id: m.id, name: m.name, kind: m.kind });
const st = (id: string, name: string, position: number, x: number, y: number, skillName?: string, takers: { id: string; name: string; kind: string }[] = [], facts = { tasks: 0, working: 0 }) => ({
  id,
  name,
  skill_id: skillName ? `s-${skillName}` : undefined,
  position,
  x,
  y,
  takers: takers.map(taker),
  ...facts,
});
const workflow = {
  project_id: web.id,
  steps: [
    st("st-backlog", "Backlog", 1, 0, 0),
    st("st-plan", "Plan", 2, 0, 128, "breakdown", [ada]),
    st("st-build", "Build", 3, 0, 256, "engineer", [builder], { tasks: 3, working: 2 }),
    st("st-qa", "QA", 4, 448, 256, "qa", []),
    st("st-review", "Review", 5, 448, 384, "review", [reviewer, ada], { tasks: 2, working: 1 }),
    st("st-accept", "Acceptance", 6, 896, 256, "acceptance", [bob]),
    st("st-retro", "Retro", 7, 0, 384, "retro", [ada]),
    st("st-skill-review", "Skill review", 8, 448, 512, "skill-review", [ada]),
  ],
  connectors: [
    { id: "c1", from_step_id: "st-plan", name: "done", position: 1 },
    { id: "c2", from_step_id: "st-build", to_step_id: "st-qa", name: "pass", position: 1 },
    { id: "c3", from_step_id: "st-qa", to_step_id: "st-review", name: "pass", position: 1 },
    { id: "c4", from_step_id: "st-qa", to_step_id: "st-build", name: "fail", position: 2 },
    { id: "c5", from_step_id: "st-review", name: "pass", position: 1 },
    { id: "c6", from_step_id: "st-review", to_step_id: "st-build", name: "needs changes", position: 2 },
    { id: "c7", from_step_id: "st-accept", name: "pass", position: 1 },
    { id: "c8", from_step_id: "st-accept", to_step_id: "st-build", name: "fail", position: 2 },
    { id: "c9", from_step_id: "st-retro", name: "done", position: 1 },
  ],
};

const label = (id: string, name: string, color: string, project?: string) => ({ id, name, color, project_id: project, created_at: created });
const orgLabels = [label("l-bug", "bug", "#d1453b"), label("l-perf", "performance", "#c27c0e")];
const webLabels = [label("l-client", "client-acme", "#3b82d1", web.id), label("l-copy", "copy", "#7c5cd1", web.id)];

const claim = (id: string, holder: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${id}`,
  task_id: id,
  holder_id: holder,
  session_id: `sess-${id}`,
  started_at: ago(12),
  expires_at: ahead(4),
  heartbeat_timeout_seconds: 300,
  ...extra,
});

let n = 0;
type T = Record<string, unknown> & { id: string; key: string; title: string };
function task(num: number, title: string, extra: Record<string, unknown> = {}): T {
  n++;
  return {
    id: `k-${num}`,
    key: `WEB-${num}`,
    project_id: web.id,
    kind: "work",
    title,
    description: "",
    state: "open",
    owner_id: ada.id,
    rank: num,
    step_id: "st-build",
    step_since: ago(40 + n * 7),
    skill_id: "s-engineer",
    breakdown: false,
    auto_complete: false,
    acceptance: false,
    blocked: false,
    filed_by: ada.id,
    waiting_since: ago(40 + n * 7),
    created_at: ago(600 + n * 30),
    workspace_ids: ["w-shop"],
    ...extra,
  };
}
const sub = (num: number, parent: T, title: string, extra: Record<string, unknown> = {}) => task(num, title, { parent_id: parent.id, rank: undefined, owner_id: parent.owner_id, ...extra });
const parentOf = (num: number, title: string, counts: Record<string, number>, extra: Record<string, unknown> = {}) =>
  task(num, title, { step_id: undefined, step_since: undefined, skill_id: undefined, subtask_counts: counts, auto_complete: true, acceptance: true, ...extra });

const checkout = parentOf(7, "Checkout with saved cards", { open: 5, working: 2, done: 2, dropped: 0 }, { owner_id: bob.id, labels: ["l-client"], description: "Customers pay with a card they saved before, in one step." });
const subs = [
  sub(8, checkout, "Break down: Checkout with saved cards", { kind: "breakdown", state: "done", step_id: undefined, filed_by: undefined, ended_at: ago(300) }),
  sub(9, checkout, "Card vault API client", { state: "done", step_id: undefined, ended_at: ago(120) }),
  sub(10, checkout, "Saved cards list on checkout", { claim: claim("k-10", builder.id, { model_label: "claude-opus-5-5", skill_id: "s-engineer" }), labels: ["l-perf"] }),
  sub(11, checkout, "3-D Secure challenge", { step_id: "st-review", skill_id: "s-review", claim: claim("k-11", reviewer.id, { skill_id: "s-review" }) }),
  sub(12, checkout, "Remove a saved card", { blocked: true, open_blockers: [{ id: "k-14", key: "WEB-14", title: "Which PSP keeps the token?" }] }),
  sub(13, checkout, "Copy for the card picker", { step_id: "st-qa", skill_id: "s-qa", labels: ["l-copy"] }),
];
const question = task(14, "Which PSP keeps the token?", { step_id: undefined, skill_id: undefined, aimed_at_id: bob.id, filed_by: builder.id, parent_id: checkout.id, rank: undefined, owner_id: bob.id });
const tasks: T[] = [
  task(1, "Gift wrapping option", { step_id: "st-backlog", skill_id: undefined, labels: ["l-client"] }),
  task(2, "Order history export", { step_id: "st-backlog", skill_id: undefined }),
  task(3, "Search results are slow on mobile", { labels: ["l-bug", "l-perf"], claim: claim("k-3", ada.id, { expires_at: undefined, heartbeat_timeout_seconds: undefined }) }),
  task(4, "Newsletter footer link", { step_id: "st-review", skill_id: "s-review" }),
  task(5, "Address autocomplete", { step_id: "st-plan", skill_id: "s-breakdown", kind: "work" }),
  task(6, "Product page reviews", { owner_id: bob.id }),
  checkout,
  ...subs,
  question,
  task(15, "Shipping estimate on cart", { state: "done", step_id: undefined, step_since: undefined, ended_at: ago(200) }),
  task(16, "Wishlist sharing", { state: "dropped", step_id: undefined, step_since: undefined, ended_at: ago(900) }),
];

const shop = { id: "w-shop", name: "shop", kind: "git", path: "/Users/ada/src/shop", mode: "pull_request", default_branch: "main", created_at: created };

const runnerSessions = [
  { task_id: "k-10", member_id: builder.id, session_id: "sess-k-10", host: "mac-mini", tmux: "dk-WEB-10", started_at: ago(12), state: "running", state_since: ago(12), log_path: "/tmp/WEB-10.log" },
  { task_id: "k-11", member_id: reviewer.id, session_id: "sess-k-11", host: "mac-mini", tmux: "dk-WEB-11", started_at: ago(12), state: "waiting", state_since: ago(12), log_path: "/tmp/WEB-11.log" },
];

let seq = 0;
const entry = (kind: string, subject: string, at: string, payload: Record<string, unknown> = {}, actor?: string) => ({
  seq: ++seq,
  at,
  kind,
  subject_type: "task",
  subject_id: subject,
  actor_id: actor,
  payload,
});
const activity = [
  entry("task.filed", "k-11", ago(240), { step_id: "st-build" }, bob.id),
  entry("task.claimed", "k-11", ago(200), {}, builder.id),
  entry("task.advanced", "k-11", ago(150), { from: "st-build", to: "st-qa", outcome: "pass", since: Date.parse(ago(240)) }, builder.id),
  entry("task.advanced", "k-11", ago(90), { from: "st-qa", to: "st-build", outcome: "fail", since: Date.parse(ago(150)) }, ada.id),
  entry("task.advanced", "k-11", ago(40), { from: "st-build", to: "st-review", outcome: "pass", since: Date.parse(ago(90)) }, builder.id),
  entry("task.claimed", "k-1", ago(100), {}, builder.id),
  entry("task.lapsed", "k-1", ago(60)),
  entry("task.evidence_attached", "k-9", ago(130), {}, builder.id),
  entry("task.evidence_attached", "k-9", ago(125), {}, builder.id),
  entry("task.evidence_attached", "k-13", ago(20), {}, builder.id),
];

function detailOf(t: T) {
  const step = workflow.steps.find((s) => s.id === t.step_id);
  const children = tasks.filter((x) => x.parent_id === t.id);
  const parent = tasks.find((x) => x.id === t.parent_id);
  const claims = t.claim ? [t.claim] : [];
  const extra: Record<string, unknown> = {};
  if (t.id === "k-11") {
    Object.assign(extra, {
      claims: [
        claim("k-11a", builder.id, { started_at: ago(200), ended_at: ago(150), how_ended: "advanced", skill_id: "s-engineer", skill_version: 3, model_label: "claude-opus-5-5" }),
        claim("k-11b", builder.id, { started_at: ago(85), ended_at: ago(40), how_ended: "advanced", skill_id: "s-engineer", skill_version: 3, model_label: "claude-opus-5-5" }),
        claim("k-11", reviewer.id, { started_at: ago(12), skill_id: "s-review", skill_version: 2 }),
      ],
      notes: [
        { id: "n1", task_id: t.id, author_id: ada.id, skill_id: "s-qa", body: "The challenge iframe does not resize on a phone; see the screenshot.", created_at: ago(90) },
        { id: "n2", task_id: t.id, author_id: builder.id, skill_id: "s-engineer", body: "Resized the frame with the PSP's onResize; added a test at 390 px.", created_at: ago(40) },
      ],
      evidence: [{ id: "e1", task_id: t.id, filename: "challenge-390.png", content_type: "image/png", size: 182_000, sha256: "x", attached_by: ada.id, created_at: ago(91) }],
      observations: [{ id: "o1", task_id: t.id, author_id: builder.id, skill_id: "s-engineer", outcome: "didnt_work", body: "The PSP sandbox rejects test cards after ten tries a minute.", created_at: ago(100) }],
    });
  }
  return {
    task: t,
    parent: parent && { id: parent.id, key: parent.key, title: parent.title },
    subtasks: children,
    step: step && { id: step.id, name: step.name, skill_id: step.skill_id, position: step.position, x: step.x, y: step.y },
    connectors: workflow.connectors.filter((c) => c.from_step_id === t.step_id),
    labels: [...orgLabels, ...webLabels].filter((l) => ((t.labels as string[] | undefined) ?? []).includes(l.id)),
    workspaces: [shop],
    claims,
    notes: [],
    evidence: [],
    blockers: tasks.filter((x) => ((t.open_blockers as { id: string }[] | undefined) ?? []).some((b) => b.id === x.id)),
    blocking: tasks.filter((x) => ((x.open_blockers as { id: string }[] | undefined) ?? []).some((b) => b.id === t.id)),
    observations: [],
    proposals: [],
    ...extra,
  };
}

const me = (who: typeof ada) => ({
  organisation: { id: "o-1", name: "Acme", created_at: created },
  member: who,
  projects: [web, ops],
  skills: [skills[2]],
  session: { id: "browser-1", member_id: who.id, kind: "browser", started_at: created, last_seen_at: created },
});

/** Answers every /v1 request the Tasks screens make, signed in as `who` (ada by default). */
export async function mockV1(page: Page, who: "ada" | "builder" = "ada") {
  const signedIn = who === "ada" ? ada : builder;
  await page.route("**/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/activity/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": open\n\n" });
    if (route.request().method() !== "GET") return json({ code: "not_implemented", message: "the lab writes nothing" }, 501);
    const task = /^\/v1\/tasks\/([^/]+)$/.exec(path)?.[1];
    if (task && task !== "takeable") {
      const t = tasks.find((x) => x.key === task || x.id === task);
      return t ? json(detailOf(t)) : json({ code: "not_found", message: "No such Task" }, 404);
    }
    switch (path) {
      case "/v1/health":
        return json({ status: "ok", version: "v2.0.0", sign_in_modes: ["printed_link"] });
      case "/v1/me":
        return json(me(signedIn));
      case "/v1/members":
        return json({ items: members });
      case "/v1/projects":
        return json({ items: [ops, web] });
      case "/v1/skills":
        return json({ items: skills });
      case "/v1/labels":
        return json({ items: orgLabels });
      case "/v1/tasks":
        return json({ items: url.searchParams.get("project") === "OPS" ? [] : url.searchParams.get("parent") ? tasks.filter((t) => t.parent_id === "k-7") : tasks });
      case "/v1/tasks/takeable":
        return json({ items: [] });
      case "/v1/activity":
        return json({ items: activity, last_seq: seq, first_seq: 1 });
      case "/v1/runner/sessions":
        return json({ items: runnerSessions, runner: true });
      case "/v1/workspaces":
        return json({ items: [shop] });
      case "/v1/views":
        return json({ items: [] });
    }
    if (/^\/v1\/projects\/[^/]+$/.test(path)) return json({ project: path.endsWith("OPS") ? ops : web, members });
    if (/^\/v1\/projects\/[^/]+\/workflow$/.test(path)) return json(workflow);
    if (/^\/v1\/projects\/[^/]+\/labels$/.test(path)) return json({ items: webLabels });
    if (/^\/v1\/skills\/[^/]+\/versions$/.test(path)) return json({ items: [] });
    return json({ code: "not_implemented", message: `${path} is not mocked` }, 501);
  });
}
