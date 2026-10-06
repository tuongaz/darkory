import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// The Inbox, Agents and Activity against the real binary e2e/server.ts started, after whatever
// the specs before this one filed. It seeds its own Team, Skill and agent through /v1 with the
// admin token init printed, and plays the agent with that agent's token and a Session of its own.
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

/** The Activity page's rows. */
function activityRows(page: Page) {
  return page.getByRole("list", { name: "Activity" }).locator("li[data-seq]");
}

type Detail = { feature: { key: string }; tasks: { key: string }[] };
type TaskDetail = { task: { key: string; claim?: unknown }; status: { kind: string; name: string } };

let admin: APIRequestContext;
let agent: APIRequestContext;
let feature: string;
let discount: string;
let cart: string;

test.beforeAll(async () => {
  admin = await as(process.env.DARKORY_E2E_ADMIN_TOKEN!, "e2e-inbox-ada");
  await v1(admin, "POST", "/v1/teams", { key: "INB", name: "Inbox" });
  await v1(admin, "PUT", "/v1/teams/INB/members/ada");
  await v1(admin, "POST", "/v1/skills", { name: "inbox-engineer", kind: "generic", body: "Build what the Task asks for." });
  await v1(admin, "POST", "/v1/members", { name: "inbox-builder", kind: "agent" });
  await v1(admin, "PUT", "/v1/teams/INB/members/inbox-builder");
  await v1(admin, "PUT", "/v1/members/inbox-builder/skills/inbox-engineer");
  await v1(admin, "PUT", "/v1/members/inbox-builder/manager", { manager: "ada" });
  // ada has the Skill too, so a Task the agent lets go shows in her My work.
  await v1(admin, "PUT", "/v1/members/ada/skills/inbox-engineer");
  const issued = await v1<{ secret: string }>(admin, "POST", "/v1/members/inbox-builder/tokens", { name: "seed" });
  agent = await as(issued.secret, "sess-inbox-builder");

  const filed = await v1<Detail>(admin, "POST", "/v1/features", { team: "INB", title: "Checkout flow" });
  feature = filed.feature.key;
  discount = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { feature, title: "Discount codes", skill: "inbox-engineer" })).task.key;
  cart = (await v1<TaskDetail>(admin, "POST", "/v1/tasks", { feature, title: "Build the cart page", skill: "inbox-engineer" })).task.key;
});

test.afterAll(async () => {
  await agent?.dispose();
  await admin?.dispose();
});

test("a 2 s Claim lapses: Agents shows Lapsed, the Task returns to Todo, Darkory recorded it", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await page.goto(`${base()}/agents`);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "inbox-builder", exact: true }) });
  await expect(row).toContainText("Nothing held");
  await expect(row).toContainText("reports to ada");
  await markLoaded(page);

  await v1(agent, "POST", `/v1/tasks/${discount}/claim`, { heartbeat_timeout_seconds: 2, model_label: "claude-opus-5-5" });
  // No Heartbeat comes; the server records the lapse within a second of the expiry.
  await expect(row.getByText("Lapsed")).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("Nothing held");
  await expect(row.getByRole("cell").nth(5)).toContainText(`1${discount}`);
  await notReloaded(page);
  await shot(page, "agents-lapsed");

  const after = await v1<TaskDetail>(admin, "GET", `/v1/tasks/${discount}`);
  expect(after.task.claim).toBeUndefined();
  expect(after.status.kind).toBe("todo");
  await page.goto(`${base()}/my-work`);
  const queued = page.getByRole("table", { name: "Takeable now" }).getByRole("row").filter({ hasText: "Discount codes" });
  await expect(queued.getByRole("img", { name: "Todo" })).toBeVisible();
  await shot(page, "my-work");

  await page.goto(`${base()}/activity?kind=task.lapsed`);
  const lapse = activityRows(page).filter({ hasText: discount });
  await expect(lapse).toHaveCount(1);
  await expect(lapse.getByRole("img", { name: "Darkory" })).toBeVisible();
  await expect(lapse).toContainText("Darkory Lapsed");
  await expect(lapse).toContainText("held by inbox-builder");
  await shot(page, "activity-lapse");
  expect(errors).toEqual([]);
});

test("a question the agent aims at the human lands in Aimed at me, live", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await v1(agent, "POST", `/v1/tasks/${cart}/claim`, { heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" });
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Aimed at me" })).toHaveCount(0);
  await markLoaded(page);

  const question = await v1<TaskDetail>(agent, "POST", "/v1/tasks", {
    title: "Stripe keys for staging?",
    description: "Staging has no STRIPE_SECRET_KEY. Which account do we use?",
    aimed_at: "ada",
    blocks: cart,
  });
  const key = question.task.key;
  const aimed = page.getByRole("region", { name: "Aimed at me" });
  await expect(aimed.getByText("Stripe keys for staging?")).toBeVisible();
  // One line per row: the question's text is in its peek.
  await expect(aimed.getByText("Staging has no STRIPE_SECRET_KEY. Which account do we use?")).toHaveCount(0);
  await expect(aimed.getByText(`blocks ${cart}`)).toBeVisible();
  await expect(aimed.getByText("inbox-builder")).toBeVisible();
  await expect(aimed.getByRole("button", { name: `Answer ${key}` })).toBeVisible();
  const questionRow = aimed.getByRole("button", { name: `Answer ${key}` }).locator("xpath=ancestor::div[contains(@class, 'grid')][1]");
  expect((await questionRow.boundingBox())!.height).toBe(36);
  await notReloaded(page);
  await shot(page, "inbox-aimed");

  // On Agents, inbox-builder holds the cart page and is stuck on the question.
  await page.goto(`${base()}/agents`);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "inbox-builder", exact: true }) });
  await expect(row).toContainText("Build the cart page");
  await expect(row.getByText(`Blocked by ${key}`)).toBeVisible();
  await expect(row.getByRole("meter")).toBeVisible();
  await expect(row).toContainText("sess-inbox-builder");
  await expect(row).toContainText("claude-opus-5-5");
  await shot(page, "agents");

  await row.getByRole("link", { name: "inbox-builder", exact: true }).click();
  const peek = page.getByRole("dialog", { name: "Agent inbox-builder" });
  await expect(peek).toBeVisible();
  const claims = peek.getByRole("region", { name: "Claims today" });
  await expect(claims).toContainText("Claims today · 2");
  await expect(claims.getByRole("listitem").filter({ hasText: "Discount codes" })).toContainText("after 2 sLapsed");
  await expect(claims.getByRole("listitem").filter({ hasText: "Build the cart page" }).getByRole("meter")).toBeVisible();
  await expect(peek.getByRole("region", { name: "Tokens" })).toContainText("seed");
  await shot(page, "agent-peek");
  await peek.getByRole("link", { name: /^Activity · \d+ entries/ }).click();
  await expect(page).toHaveURL(`${base()}/activity?member=inbox-builder`);

  // Answer claims the question and opens it to write the Note, with Complete as the primary.
  await page.goto(`${base()}/inbox`);
  await page.getByRole("region", { name: "Aimed at me" }).getByRole("button", { name: `Answer ${key}` }).click();
  const answer = page.getByRole("dialog", { name: `Task ${key}` });
  await expect(answer.getByRole("textbox", { name: "Note" })).toBeFocused();
  await expect(answer.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Held by me" }).getByText("Stripe keys for staging?")).toBeVisible();
  await expect(page.getByRole("region", { name: "Aimed at me" })).toHaveCount(0);
  await shot(page, "inbox-answer");
  expect(errors).toEqual([]);
});

test("Activity narrows to a Member and to a Kind", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await page.goto(`${base()}/activity`);
  await expect(activityRows(page).first()).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await shot(page, "activity");

  await page.getByRole("button", { name: "Member" }).click();
  await page.getByRole("menuitemradio", { name: "inbox-builder" }).click();
  await expect(page).toHaveURL(`${base()}/activity?member=inbox-builder`);
  await expect(page.getByText("Member is")).toBeVisible();
  const rows = activityRows(page);
  await expect(rows.first()).toBeVisible();
  // Its own entries, and the lapse Darkory recorded on its Claim.
  for (const text of await rows.allTextContents()) expect(text).toMatch(/^#\d+(IBinbox-builder|DDarkory Lapsed)/);
  // The Claim's own entry is on this page, so the lapse says how long it waited.
  await expect(rows.filter({ hasText: "Darkory Lapsed" })).toContainText("held by inbox-builder · no Heartbeat in 2 s");
  await expect(rows.filter({ hasText: "inbox-builder filed" })).toHaveCount(1);
  await shot(page, "activity-member");

  await page.getByRole("button", { name: "Clear Member" }).click();
  await expect(page).toHaveURL(`${base()}/activity`);
  await page.getByRole("button", { name: "Kind" }).click();
  await page.getByRole("menuitemradio", { name: "Lapsed" }).click();
  await expect(page).toHaveURL(`${base()}/activity?kind=task.lapsed`);
  await expect(page.getByText("Kind is")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Darkory Lapsed");
  await expect(page.getByText("1 entry loaded", { exact: true })).toBeVisible();
  await shot(page, "activity-kind");
  expect(errors).toEqual([]);
});

test("at phone width the four pages do not scroll sideways", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page, admin, "ada");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/inbox", "/my-work", "/agents", "/activity"]) {
    await page.goto(`${base()}${path}`);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll, path).toBe(client);
  }
  await shot(page, "phone-activity");

  // Agents fits the phone: the table does not scroll inside its frame, and the Heartbeat is whole.
  await page.goto(`${base()}/agents`);
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Heartbeat" })).toBeVisible();
  expect(await table.evaluate((el) => el.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
  // inbox-builder still holds the cart page, so its row draws the meter.
  const meter = (await table.getByRole("meter").first().boundingBox())!;
  expect(meter.x + meter.width).toBeLessThanOrEqual(390);
  const head = (await table.getByRole("columnheader", { name: "Heartbeat" }).boundingBox())!;
  expect(head.x + head.width).toBeLessThanOrEqual(390);
  await shot(page, "phone-agents");
  expect(errors).toEqual([]);
});
