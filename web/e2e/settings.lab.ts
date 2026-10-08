import { expect, test, type Page, type Route } from "@playwright/test";

// The shell and Settings in a real browser (`npm run lab`) on a mocked /v1: no console error, no
// sideways scroll on a phone, and screenshots of each page at each size and theme, into
// e2e/screenshots/ (gitignored), for a person to look at.

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

const at = "2026-10-01T09:00:00.000Z";
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const project = (id: string, key: string, name: string, extra: object = {}) => ({ id, key, name, auto_complete: false, acceptance: false, created_at: at, ...extra });
const web = project("p-web", "WEB", "Web storefront", { default_workspace_id: "w-shop", acceptance: true });
const ops = project("p-ops", "OPS", "Operations");
const books = project("p-books", "BOOKS", "Bookkeeping", { auto_complete: true });
const projects = [books, ops, web];

const runner = (model: string, extra: object = {}) => ({
  command: "claude",
  args: ["--session-id", "{session_id}", "--model", "{model}", "--mcp-config", "{mcp_config}"],
  model,
  env: { HTTP_PROXY: "http://proxy.internal:3128" },
  unattended: true,
  paused: false,
  ...extra,
});
type MockMember = { id: string; name: string; kind: "human" | "agent"; manager_id?: string; [field: string]: unknown };
const member = (id: string, name: string, kind: "human" | "agent", extra: object = {}): MockMember => ({ id, name, kind, admin: false, created_at: at, ...extra });
const ada = member("m-ada", "ada", "human", { admin: true, email: "ada@acme.example" });
const bob = member("m-bob", "bob", "human", { manager_id: "m-ada", email: "bob@acme.example" });
const priya = member("m-priya", "priya.r", "human", { manager_id: "m-ada", email: "priya@acme.example" });
const builder = member("m-builder", "builder-1", "agent", { manager_id: "m-bob", agent: runner("claude-sonnet-5-5") });
const qa = member("m-qa", "qa", "agent", { manager_id: "m-bob", agent: runner("claude-opus-5-5", { paused: true }) });
const reviewer = member("m-reviewer", "reviewer", "agent", { manager_id: "m-ada" });
const old = member("m-old", "intern-bot", "agent", { deactivated_at: ago(400) });
const members = [ada, bob, builder, old, priya, qa, reviewer];

const skill = (name: string, extra: object = {}) => ({ id: `s-${name}`, name, kind: "generic", builtin: false, current_version: 1, created_at: at, ...extra });
const engineer = skill("engineer");
const review = skill("review");
const qaSkill = skill("qa");
const webEngineer = skill("web-engineer", { kind: "company", base_skill_id: "s-engineer", current_version: 3 });
const builtins = ["acceptance", "breakdown", "retro", "skill-review"].map((n) => skill(n, { builtin: true }));
const skills = [...builtins, engineer, qaSkill, review, webEngineer].sort((a, b) => a.name.localeCompare(b.name));

const skillsOf: Record<string, object[]> = {
  "m-ada": [review, builtins[3]],
  "m-bob": [review, builtins[0]],
  "m-priya": [engineer],
  "m-builder": [engineer, webEngineer],
  "m-qa": [qaSkill, builtins[0]],
  "m-reviewer": [review],
  "m-old": [],
};
const projectsOf: Record<string, object[]> = {
  "m-ada": [books, ops, web],
  "m-bob": [web],
  "m-priya": [books],
  "m-builder": [ops, web],
  "m-qa": [web],
  "m-reviewer": [web],
  "m-old": [],
};

const label = (id: string, name: string, color: string, project_id?: string) => ({ id, name, color, project_id, created_at: at });
const orgLabels = [label("l-bug", "bug", "#eb5757"), label("l-chore", "chore", "#95a2b3"), label("l-security", "security", "#f2994a"), label("l-ux", "ux", "#8b5cf6")];
const webLabels = [label("l-cx", "client-x", "#4ea7fc", "p-web"), label("l-checkout", "checkout", "#4cb782", "p-web")];

const workspaces = [
  { id: "w-docs", name: "docs", kind: "git", path: "/Users/ada/src/acme/docs", mode: "plain", default_branch: "main", created_at: at },
  { id: "w-shop", name: "shop", kind: "git", path: "/Users/ada/src/acme/storefront-web", mode: "pull_request", default_branch: "main", created_at: at },
];

const task = (n: number, extra: object = {}) => ({
  id: `k-${n}`,
  key: `WEB-${n}`,
  project_id: "p-web",
  kind: "work",
  title: `Task ${n}`,
  description: "",
  state: "open",
  owner_id: "m-ada",
  rank: n,
  step_id: "st-build",
  skill_id: "s-engineer",
  breakdown: false,
  auto_complete: false,
  acceptance: false,
  blocked: false,
  filed_by: "m-ada",
  waiting_since: at,
  created_at: at,
  workspace_ids: ["w-shop"],
  ...extra,
});
const retro = task(31, { kind: "retrospective", title: "Retrospective: Checkout redesign", step_id: "st-retro", skill_id: "s-retro" });
const heldSession = "0199a1f2-7c3e-7b1a-9d2e-5f4c3b2a1d0e";
const held = task(42, {
  title: "Cart drawer keeps focus",
  claim: { id: "c-42", task_id: "k-42", holder_id: "m-builder", session_id: "0199a1f2-7c3e-7b1a-9d2e-5f4c3b2a1d0e", started_at: ago(1), expires_at: soon(12), heartbeat_timeout_seconds: 900, model_label: "claude-sonnet-5-5" },
});
const tasks = [task(12, { skill_id: "s-web-engineer" }), held, retro];

const v = (version: number, body: string) => ({ skill_id: webEngineer.id, version, body, published_by: "m-ada", published_at: ago(24 * (4 - version)) });
const versions = [
  v(3, "1. Reuse the cart component.\n2. Ship behind a feature flag.\n3. Run the e2e suite before asking for review.\n"),
  v(2, "1. Reuse the cart component.\n2. Ship behind a feature flag.\n"),
  v(1, "1. Reuse the cart component.\n"),
];
const proposal = {
  id: "p-1",
  skill_id: webEngineer.id,
  task_id: retro.id,
  based_on_version: 3,
  body: "1. Reuse the cart component.\n2. Ship behind a feature flag.\n3. Run the e2e suite before asking for review.\n4. Point e2e mail at Mailpit, never a real inbox.\n",
  author_id: "m-builder",
  state: "pending",
  created_at: ago(3),
};

const step = (id: string, name: string, position: number, skill_id?: string) => ({ id, name, skill_id, position, x: position * 240, y: 0, tasks: 0, working: 0, takers: [] });
const workflow = {
  project_id: "p-web",
  steps: [
    step("st-backlog", "Backlog", 1),
    step("st-plan", "Plan", 2, "s-breakdown"),
    step("st-build", "Build", 3, "s-engineer"),
    step("st-review", "Review", 4, "s-review"),
    step("st-acceptance", "Acceptance", 5, "s-acceptance"),
    step("st-retro", "Retro", 6, "s-retro"),
  ],
  connectors: [],
};

const tokens = [
  { id: "t-1", member_id: "m-ada", name: "laptop", prefix: "dk_O1vgU1", created_at: ago(300), last_used_at: ago(2) },
  { id: "t-2", member_id: "m-builder", name: "default", prefix: "dk_uxx9Yw", created_at: ago(200), last_used_at: ago(0.2) },
];
const sessions = [
  { id: "browser-ada-1", member_id: "m-ada", kind: "browser", started_at: ago(5), last_seen_at: ago(0.1) },
  { id: "browser-ada-2", member_id: "m-ada", kind: "browser", started_at: ago(50), last_seen_at: ago(20) },
  { id: "0199a1f2-7c3e-7b1a-9d2e-5f4c3b2a1d0e", member_id: "m-builder", kind: "token", token_id: "t-2", started_at: ago(1), last_seen_at: ago(0.05) },
];

const me = {
  organisation: { id: "o-1", name: "Acme", created_at: at },
  member: ada,
  projects: [books, ops, web],
  skills: skillsOf["m-ada"],
  session: sessions[0],
};

function detail(t: ReturnType<typeof task>, extra: object = {}) {
  return { task: t, subtasks: [], connectors: [], labels: [], workspaces: [], claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [], proposals: [], ...extra };
}

/** The mocked /v1: what each page of the shell and Settings reads. */
function answer(method: string, path: string, query: URLSearchParams): unknown {
  if (method !== "GET") return {};
  const parts = path.split("/").slice(2);
  const [root, ref, sub] = parts;
  switch (root) {
    case "health":
      return { status: "ok", version: "v0.9.0", sign_in_modes: ["printed_link"], update_available: true, latest_version: "v0.9.2" };
    case "me":
      return me;
    case "members": {
      if (!ref) return { items: members };
      const m = members.find((x) => x.id === ref || x.name === ref)!;
      if (sub === "tokens") return { items: tokens.filter((t) => t.member_id === m.id) };
      if (sub === "sessions") return { items: sessions.filter((s) => s.member_id === m.id) };
      return { member: m, projects: projectsOf[m.id], skills: skillsOf[m.id], reports: members.filter((x) => x.manager_id === m.id) };
    }
    case "projects": {
      if (!ref) return { items: projects };
      const p = projects.find((x) => x.key === ref || x.id === ref)!;
      if (sub === "workflow") return { ...workflow, project_id: p.id };
      if (sub === "labels") return { items: p.id === web.id ? webLabels : [] };
      return { project: p, members: members.filter((m) => (projectsOf[m.id] as { id: string }[]).some((x) => x.id === p.id)) };
    }
    case "labels":
      return { items: orgLabels };
    case "skills": {
      if (!ref) return { items: skills };
      const s = skills.find((x) => x.name === ref || x.id === ref)!;
      const mine = s.id === webEngineer.id ? versions : [{ ...v(1, `How ${s.name} is done at Acme.`), skill_id: s.id }];
      if (sub === "versions") return { items: mine };
      return { skill: s, current: mine[0] };
    }
    case "workspaces":
      return { items: workspaces };
    case "tasks": {
      if (ref === "takeable") return { items: [] };
      if (ref) return ref === retro.key ? detail(retro, { proposals: [proposal], notes: [{ id: "n-1", task_id: retro.id, author_id: "m-builder", body: "Two runs mailed a real inbox; Mailpit catches them.", created_at: ago(2.9) }] }) : detail(held);
      const filters = query.getAll("filter");
      if (filters.includes("kind:is:retrospective")) return { items: [retro] };
      if (filters.some((f) => f.startsWith("skill:is:s-web-engineer"))) return { items: [tasks[0]] };
      if (filters.some((f) => f.startsWith("skill:is:"))) return { items: [] };
      if (query.get("holder")) return { items: query.get("holder") === "m-builder" ? [held] : [] };
      if (filters.some((f) => f.startsWith("label:in:"))) return { items: [] };
      return { items: tasks };
    }
    case "runner":
      return { items: [{ task_id: "k-42", member_id: "m-builder", session_id: heldSession, host: "mac-mini", tmux: "dk-WEB-42", started_at: ago(1), state: "running", state_since: ago(1), log_path: "/tmp/x" }], runner: true };
    case "activity":
      return { items: [], next_after: 0 };
    case "views":
      return { items: [] };
    default:
      return {};
  }
}

async function mock(page: Page) {
  // The Activity stream, held open and quiet, as a live server's is between entries.
  await page.addInitScript(() => {
    class QuietStream extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor() {
        super();
        setTimeout(() => this.onopen?.(new Event("open")));
      }
      close() {
        this.readyState = 2;
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = QuietStream;
  });
  await page.route("**/v1/**", (route: Route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: answer(route.request().method(), url.pathname, url.searchParams) });
  });
}

/** Waits for what slides or fades in to finish; the turning rings never do. */
function settled(page: Page) {
  return page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const pages: { slug: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  { slug: "shell-inbox", path: "/inbox", ready: async (p) => void (await p.getByRole("navigation", { name: "Breadcrumb" }).waitFor({ state: "attached" })) },
  { slug: "settings-account", path: "/settings/account", ready: async (p) => void (await p.getByRole("row", { name: "This browser" }).waitFor({ state: "attached" })) },
  { slug: "settings-members", path: "/settings/organisation/members", ready: async (p) => void (await p.getByRole("row", { name: "priya.r" }).getByText("Bookkeeping").waitFor({ state: "attached" })) },
  { slug: "settings-member", path: "/settings/organisation/members/m-bob", ready: async (p) => void (await p.getByRole("heading", { name: "bob" }).waitFor({ state: "attached" })) },
  { slug: "settings-agents", path: "/settings/organisation/agents", ready: async (p) => void (await p.getByRole("table", { name: "Agents" }).waitFor({ state: "attached" })) },
  { slug: "settings-agent", path: "/settings/organisation/agents/m-builder", ready: async (p) => void (await p.getByRole("group", { name: "Agent settings of builder-1" }).waitFor({ state: "attached" })) },
  { slug: "settings-new-agent", path: "/settings/organisation/agents?new=1", ready: async (p) => void (await p.getByRole("dialog", { name: "New agent" }).getByRole("checkbox", { name: "Web storefront" }).waitFor({ state: "attached" })) },
  { slug: "settings-skills", path: "/settings/organisation/skills", ready: async (p) => void (await p.getByText("1 proposal").waitFor({ state: "attached" })) },
  { slug: "settings-skill", path: "/settings/organisation/skills/web-engineer", ready: async (p) => void (await p.getByRole("region", { name: "Proposal from WEB-31" }).waitFor({ state: "attached" })) },
  { slug: "settings-labels", path: "/settings/organisation/labels", ready: async (p) => void (await p.getByRole("row", { name: "security" }).waitFor({ state: "attached" })) },
  { slug: "settings-install", path: "/settings/organisation/install", ready: async (p) => void (await p.getByText("Attached").waitFor({ state: "attached" })) },
  { slug: "settings-project-general", path: "/settings/projects/WEB/general", ready: async (p) => void (await p.getByRole("combobox", { name: "Default Workspace" }).getByText("shop").waitFor({ state: "attached" })) },
  { slug: "settings-project-members", path: "/settings/projects/WEB/members", ready: async (p) => void (await p.getByRole("table", { name: "Members of Web storefront" }).waitFor({ state: "attached" })) },
  { slug: "settings-project-labels", path: "/settings/projects/WEB/labels", ready: async (p) => void (await p.getByRole("row", { name: "client-x" }).waitFor({ state: "attached" })) },
  { slug: "settings-project-workspaces", path: "/settings/projects/WEB/workspaces", ready: async (p) => void (await p.getByRole("row", { name: "shop" }).waitFor({ state: "attached" })) },
];

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`shell and Settings, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await mock(page);
      for (const p of pages) {
        await page.goto(p.path);
        await p.ready(page);
        // Let the last reads land and the skeletons go.
        await page.waitForLoadState("networkidle");
        await expect(page.locator("[data-slot=skeleton]")).toHaveCount(0);
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(widths.scroll, `${p.path} scrolls sideways`).toBe(widths.client);
        await page.screenshot({ path: `e2e/screenshots/${p.slug}-${size.name}-${scheme}.png`, fullPage: true });
      }
      // The app's sidebar after Linear's: closed, its Organisation menu open, and Switch Organisation open.
      await page.goto("/projects/WEB/tasks");
      await page.getByRole("navigation", { name: "Breadcrumb" }).waitFor({ state: "attached" });
      await page.waitForLoadState("networkidle");
      if (size.name === "phone") await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      const projects = page.getByRole("navigation", { name: "Projects" });
      await expect(projects.getByRole("list", { name: "Web storefront" })).toBeVisible();
      await settled(page);
      await page.screenshot({ path: `e2e/screenshots/sidebar-closed-${size.name}-${scheme}.png` });
      await page.locator("[data-slot=sidebar-header]").getByRole("button", { name: "Acme" }).click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: /^Log out/ })).toBeVisible();
      await settled(page);
      await page.screenshot({ path: `e2e/screenshots/sidebar-menu-${size.name}-${scheme}.png` });
      await menu.getByRole("menuitem", { name: /^Switch Organisation/ }).press("ArrowRight");
      await expect(page.getByRole("menuitem", { name: "Account settings" })).toBeVisible();
      await settled(page);
      await expect(page.getByRole("menu").nth(1)).toBeInViewport({ ratio: 1 });
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(widths.scroll, "the open menus scroll sideways").toBe(widths.client);
      await page.screenshot({ path: `e2e/screenshots/sidebar-switch-${size.name}-${scheme}.png` });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      if (size.name === "phone") {
        // Settings' nav is the sheet the top bar's button opens.
        await page.goto("/settings/projects/WEB/general");
        await page.getByRole("button", { name: "Toggle Sidebar" }).click();
        await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
        // The sheet has slid in.
        await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
        await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: `e2e/screenshots/settings-nav-${size.name}-${scheme}.png` });
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
