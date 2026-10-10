import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// The Inbox, My work, a Project's Agents and Activity, and the marks (scenario 9), against the
// real binary e2e/server.ts started, after whatever the specs before this one filed. It seeds its
// own Project, Skill and agent through /v1 with the admin token init printed, and plays the agent
// with that agent's token and a Session of its own. The Install runs no Runner, so the marks'
// session colours are drawn from GET /v1/runner/sessions answered by the page's route.
test.describe.configure({ mode: "serial" });

const base = () => process.env.DARKORY_E2E_BASE_URL!;
const shots = fileURLToPath(new URL("./screenshots/inbox/", import.meta.url));

function shot(page: Page, name: string) {
  return page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });
}

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** A /v1 client for a token: the Member it belongs to, in a Session it names. */
function as(token: string, session: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL: base(), extraHTTPHeaders: { Authorization: `Bearer ${token}`, "Darkory-Session": session } });
}

async function v1<T = Record<string, unknown>>(api: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, data, headers: method === "GET" ? {} : { "Idempotency-Key": randomUUID() } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} answered ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Signs the page in as `member` with a login link an admin asked /v1 for. */
async function signIn(page: Page, admin: APIRequestContext, member: string) {
  const link = await v1<{ url: string }>(admin, "POST", `/v1/members/${member}/login-links`);
  await page.goto(link.url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base()}/inbox`);
}

async function markLoaded(page: Page) {
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
}
async function notReloaded(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
}

/** The Runner's sessions as GET /v1/runner/sessions would list them, for an Install with no Runner. */
async function runnerSays(page: Page, items: unknown[]) {
  await page.unroute("**/v1/runner/sessions");
  await page.route("**/v1/runner/sessions", (route) => route.fulfill({ json: { items, runner: true } }));
}

/** The Activity page's rows. */
function activityRows(page: Page) {
  return page.getByRole("list", { name: "Activity" }).locator("li[data-seq]");
}

type Task = { id: string; key: string; parent_id?: string; claim?: { id: string } };
type TaskDetail = { task: Task };

let admin: APIRequestContext;
let agent: APIRequestContext;
let cart: Task;
let discount: Task;
let checkout: Task;

test.beforeAll(async () => {
  admin = await as(process.env.DARKORY_E2E_ADMIN_TOKEN!, "e2e-inbox-ada");
  await v1(admin, "POST", "/v1/members", { name: "inbox-builder", kind: "agent" });
  await v1(admin, "PUT", "/v1/members/inbox-builder/manager", { manager: "ada" });
  // INB has init's default Workflow: Build carries engineer, which inbox-builder and ada hold.
  await v1(admin, "POST", "/v1/projects", { key: "INB", name: "Inbox", members: ["ada", "inbox-builder"] });
  await v1(admin, "PUT", "/v1/members/inbox-builder/skills/engineer");
  await v1(admin, "PUT", "/v1/members/ada/skills/engineer");
  const issued = await v1<{ secret: string }>(admin, "POST", "/v1/members/inbox-builder/tokens", { name: "seed" });
  agent = await as(issued.secret, "sess-inbox-builder");

  checkout = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { project: "INB", title: "Checkout flow" })).task;
  cart = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { parent: checkout.key, title: "Build the cart page" })).task;
  discount = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { parent: checkout.key, title: "Discount codes" })).task;
});

test.afterAll(async () => {
  await agent?.dispose();
  await admin?.dispose();
});

test("a question the agent aims at the human lands in the Inbox, live, with its Project", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await v1(agent, "POST", `/v1/tasks/${cart.key}/claim`, { heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" });
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeAttached();
  await markLoaded(page);

  const question = await v1<TaskDetail>(agent, "POST", "/v1/tasks", { title: "Stripe keys for staging?", aim: "ada", blocks: cart.key });
  const key = question.task.key;
  const aimed = page.getByRole("region", { name: "Needs you" });
  const row = aimed.locator(`[data-task="${key}"]`);
  await expect(row).toContainText("Stripe keys for staging?");
  await expect(row).toContainText(`unblocks ${cart.key}`);
  await expect(row).toContainText("inbox-builder");
  await expect(row).toContainText("With you");
  await expect(row.getByTitle("Inbox", { exact: true })).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(36);
  await notReloaded(page);
  await shot(page, "inbox-aimed");

  // Opening it is its peek over the Inbox, and the app follows it into its Project.
  await row.getByRole("link", { name: "Stripe keys for staging?" }).click();
  await expect(page).toHaveURL(`${base()}/inbox?task=${key}`);
  await expect(page.getByRole("dialog", { name: new RegExp(key) })).toBeVisible();

  // Answer claims it; it moves to My work, held by me.
  await page.goto(`${base()}/inbox`);
  await page.getByRole("button", { name: `Answer ${key}` }).click();
  await page.goto(`${base()}/my-work`);
  await expect(page.getByRole("region", { name: "Held by you" }).locator(`[data-task="${key}"]`)).toBeVisible();
  // The question joined the Parent beside the Task it blocks (scenario 5), so it owns three.
  await expect(page.getByRole("region", { name: "You own" }).locator(`[data-task="${checkout.key}"]`)).toContainText("0 of 3 done");
  await shot(page, "my-work");

  // Scenario 5, from a Subtask: the question is a Subtask of the same Parent, and blocks the cart page.
  expect(question.task.parent_id).toBe(checkout.id);
  await page.goto(`${base()}/tasks/${checkout.key}?view=list`);
  const subtasks = page.getByRole("region", { name: "Subtasks" });
  await expect(subtasks.getByRole("link", { name: /Stripe keys for staging\?/ })).toBeVisible();
  await expect(subtasks.getByRole("link", { name: /Build the cart page/ })).toContainText("Blocked");
  await shot(page, "question-beside-its-task");
  expect(errors).toEqual([]);
});

test("marks: an agent's gradient ring turns while its session runs, stops in its colour, and a human's is plain (scenario 9)", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  const session = { task_id: cart.id, member_id: "", session_id: "sess-inbox-builder", host: "e2e-host", tmux: `dk-${cart.key}`, started_at: new Date().toISOString(), state_since: new Date().toISOString(), log_path: "/tmp/x" };
  const members = await v1<{ items: { id: string; name: string }[] }>(admin, "GET", "/v1/members");
  session.member_id = members.items.find((m) => m.name === "inbox-builder")!.id;
  await runnerSays(page, [{ ...session, state: "running" }]);
  await page.goto(`${base()}/projects/INB/agents`);

  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "inbox-builder", exact: true }) });
  const mark = row.getByRole("img", { name: "inbox-builder (agent), working" });
  await expect(mark).toHaveAttribute("data-working", "running");
  await expect(row).toContainText("Build the cart page");
  await expect(row).toContainText("Build");
  await expect(row).toContainText("e2e-host");
  const spin = () => mark.evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));
  const first = await spin();
  await page.waitForTimeout(300);
  expect(await spin()).not.toBe(first);
  await shot(page, "agents-running");

  // Stalled: the ring stops, in the session's colour.
  await runnerSays(page, [{ ...session, state: "stalled" }]);
  await expect(row.getByRole("img", { name: "inbox-builder (agent), working, its Shift stalled" })).toHaveAttribute("data-working", "stalled", { timeout: 10_000 });
  const still = await row.getByRole("img", { name: /inbox-builder \(agent\)/ }).evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));
  await page.waitForTimeout(300);
  expect(await row.getByRole("img", { name: /inbox-builder \(agent\)/ }).evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"))).toBe(still);
  await shot(page, "agents-stalled");

  await runnerSays(page, [{ ...session, state: "waiting" }]);
  await expect(row.getByRole("img", { name: /inbox-builder \(agent\), working, its Shift waiting/ })).toHaveAttribute("data-working", "waiting", { timeout: 10_000 });

  // A human's mark: a plain round border, no gradient.
  await page.goto(`${base()}/projects/INB/activity`);
  const human = activityRows(page).getByRole("img", { name: "ada", exact: true }).first();
  await expect(human).toHaveAttribute("data-kind", "human");
  // Round: a radius of at least half its size (Tailwind's rounded-full computes to an infinite one).
  expect(await human.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius) >= el.getBoundingClientRect().width / 2)).toBe(true);
  expect(await human.evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain("conic-gradient");
  // The agent's, the AI gradient, once its session no longer colours it.
  await runnerSays(page, []);
  await page.goto(`${base()}/projects/INB/agents`);
  const agentMark = page.getByRole("img", { name: /^inbox-builder \(agent\)/ }).first();
  await expect(agentMark).toHaveAttribute("data-kind", "agent");
  // The ring is drawn by ::before over the mark's edge, a 1px gap inside it, the face shrunk within.
  expect(await agentMark.evaluate((el) => getComputedStyle(el, "::before").backgroundImage)).toContain("conic-gradient");
  expect(await agentMark.evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain("conic-gradient");
  const [box, face] = await agentMark.evaluate((el) => [el.getBoundingClientRect().width, parseFloat(getComputedStyle(el).paddingLeft)]);
  expect(face / box).toBeGreaterThanOrEqual(0.12);
  await shot(page, "marks");
  expect(errors).toEqual([]);
});

test("the agent's peek: its session, the Steps it takes, and Pause from the ⋯ menu", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await page.goto(`${base()}/projects/INB/agents?agent=inbox-builder`);
  const peek = page.getByRole("dialog", { name: "Agent inbox-builder" });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("region", { name: "Claims today" })).toContainText(cart.key);
  await expect(peek).toContainText("Steps in Inbox");
  await expect(peek.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/projects/INB/agents");
  await shot(page, "agent-peek");
  await peek.getByRole("link", { name: /^Activity · / }).click();
  await expect(page).toHaveURL(`${base()}/projects/INB/activity?member=inbox-builder`);
  await expect(activityRows(page).first()).toContainText("inbox-builder");
  expect(errors).toEqual([]);
});

test("a lapse on my Task that its Step's agent can take up clears itself; Activity words it and an advance, and narrows by Kind and Task", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  // The agent advances the cart page along pass to Review, then lets a 2 s Claim on Discount codes lapse.
  await v1(agent, "POST", `/v1/tasks/${cart.key}/advance`, { outcome: "pass" });
  await v1(agent, "POST", `/v1/tasks/${discount.key}/claim`, { heartbeat_timeout_seconds: 2 });
  await page.goto(`${base()}/projects/INB/activity`);
  await expect(activityRows(page).filter({ hasText: "Darkory" }).first()).toContainText("held by inbox-builder", { timeout: 15_000 });
  // inbox-builder can take Discount codes up again, so the Inbox does not list the lapse (Needs you's rule).
  await page.goto(`${base()}/inbox`);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeAttached();
  await expect(page.locator(`[data-task="${discount.key}"]`).filter({ hasText: "Lapsed" })).toHaveCount(0);
  await shot(page, "inbox-after-lapse");

  await page.goto(`${base()}/projects/INB/activity`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const advanced = activityRows(page).filter({ hasText: "advanced" });
  await expect(advanced.first()).toContainText(`inbox-builder advanced ${cart.key} Build the cart page along pass to Review`);
  await expect(advanced.first().getByRole("link", { name: "Review" })).toHaveAttribute("href", /\/projects\/INB\/tasks\?filter\.tasks=step%3Ais%3A/);
  await expect(activityRows(page).filter({ hasText: "Darkory" }).first()).toContainText(`held by inbox-builder`);
  await shot(page, "activity");

  await page.getByRole("button", { name: "Kind" }).click();
  await page.getByRole("menuitemradio", { name: "Advanced" }).click();
  await expect(page).toHaveURL(`${base()}/projects/INB/activity?kind=task.advanced`);
  await expect(activityRows(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Clear Kind" }).click();
  await expect(page).toHaveURL(`${base()}/projects/INB/activity`);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(discount.key) }).click();
  await expect(page).toHaveURL(`${base()}/projects/INB/activity?about=${discount.key}`);
  await expect(activityRows(page).filter({ hasNotText: discount.key })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("my Done Task whose pull request is open waits in Needs you for my merge; with no Runner its act opens the pull request", async ({ page }) => {
  const errors = consoleErrors(page);
  // PRQ lands its branches through pull requests: its default Workspace is in pull_request mode.
  await v1(admin, "POST", "/v1/workspaces", { name: "prq-repo", path: "/srv/prq", mode: "pull_request", default_branch: "main" });
  await v1(admin, "POST", "/v1/projects", { key: "PRQ", name: "Pull requests", members: ["ada", "inbox-builder"], default_workspace: "prq-repo" });
  const filed = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { project: "PRQ", title: "A sidebar trigger on desktop" })).task;
  // The agent builds it; at Review nobody in PRQ has review, so its Owner, ada, takes it into Done.
  await v1(agent, "POST", `/v1/tasks/${filed.id}/claim`, {});
  await v1(agent, "POST", `/v1/tasks/${filed.id}/advance`, { outcome: "pass" });
  await v1(admin, "POST", `/v1/tasks/${filed.id}/claim`, {});
  await v1(admin, "POST", `/v1/tasks/${filed.id}/advance`, { outcome: "pass" });
  const url = "https://github.com/o/r/pull/7";
  await v1(admin, "PUT", `/v1/tasks/${filed.id}/pull-request`, { number: 7, url, state: "open" });

  await signIn(page, admin, "ada");
  const row = page.getByRole("region", { name: "Needs you" }).locator(`[data-task="${filed.key}"]`);
  await expect(row).toContainText("A sidebar trigger on desktop");
  await expect(row).toContainText("Awaits your merge");
  await expect(row.getByRole("link", { name: "#7 open" })).toHaveAttribute("href", url);
  // --runner=off: nothing beside the server merges, so the act is the pull request on GitHub.
  await expect(row.getByRole("link", { name: "Open #7" })).toHaveAttribute("href", url);
  await expect(row.getByRole("button", { name: /Merge/ })).toHaveCount(0);
  await shot(page, "merge-row");

  // Merged on GitHub: the row leaves.
  await v1(admin, "PUT", `/v1/tasks/${filed.id}/pull-request`, { number: 7, url, state: "merged" });
  await page.reload();
  const loaded = page.getByRole("region", { name: "Needs you" }).or(page.getByRole("region", { name: "Takeable by you" })).or(page.getByRole("heading", { name: "Nothing needs you" }));
  await expect(loaded.first()).toBeVisible();
  await expect(page.locator(`[data-task="${filed.key}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Inbox, My work, Agents and Activity fit a phone without a sideways scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  const screens = [
    { path: "/inbox", ready: () => page.getByRole("region", { name: "Needs you" }).or(page.getByRole("region", { name: "Takeable by you" })).or(page.getByRole("heading", { name: "Nothing needs you" })).first() },
    { path: "/my-work", ready: () => page.getByRole("region", { name: "You own" }) },
    { path: "/projects/INB/agents", ready: () => page.getByRole("link", { name: "inbox-builder", exact: true }) },
    { path: "/projects/INB/activity", ready: () => page.getByRole("list", { name: "Activity" }) },
  ];
  for (const { path, ready } of screens) {
    await page.goto(`${base()}${path}`);
    await expect(ready()).toBeVisible();
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll, path).toBe(widths.client);
    await shot(page, `phone${path.replaceAll("/", "-")}`);
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("a Project's Agents table fits a 1280px laptop beside the sidebar, with no sideways scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await signIn(page, admin, "ada");
  await page.goto(`${base()}/projects/INB/agents`);
  const table = page.getByRole("table");
  await expect(table.getByRole("link", { name: "inbox-builder", exact: true })).toBeVisible();
  const scroller = table.locator("xpath=ancestor::div[contains(@class,'overflow-auto')][1]");
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await shot(page, "agents-laptop");
  await context.close();
});
