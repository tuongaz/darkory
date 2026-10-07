import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { FeatureDetail, IssuedToken, LoginLink, TaskDetail } from "../src/api/client";
import startServer from "./server";

// The Filter against the real binary: F opens the Filters menu, a Status and a holder become
// chips, the person flips an operator, a reload keeps it all (the address holds the pills, by id),
// and Reset clears it; then the date axes, Claim, Team › Features and a phone. On an Install of
// its own, as board.spec.ts runs.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const shots = fileURLToPath(new URL("./screenshots/filters/", import.meta.url));
const env = ["DARKORY_E2E_LOGIN_LINK", "DARKORY_E2E_BASE_URL", "DARKORY_E2E_DATA", "DARKORY_E2E_ADMIN_TOKEN"] as const;

let stop: (() => Promise<void>) | undefined;
let base = "";
let adminToken = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const saved = env.map((k) => process.env[k]);
  try {
    stop = await startServer();
    base = process.env.DARKORY_E2E_BASE_URL!;
    adminToken = process.env.DARKORY_E2E_ADMIN_TOKEN!;
  } finally {
    env.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test.afterAll(async () => {
  await stop?.();
});

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

/** Calls /v1 from inside the page as the signed-in Member. */
async function v1<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path as string, {
        method: method as string,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    },
    [method, path, body] as const,
  );
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${res.text}`);
  return (res.text ? JSON.parse(res.text) : undefined) as T;
}

/** A Member calling /v1 as the CLI does, with a bearer token and a Session. */
function agent(token: string, session: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Darkory-Session": session,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T | undefined };
  };
}

const row = (page: Page, key: string) => page.locator(`#main [data-task="${key}"]`);
const chips = (page: Page) => page.getByRole("toolbar", { name: "Filters" });

test("the Filter: F, a Status and a holder, an operator flipped, a reload, Reset", async ({ page }) => {
  const errors = consoleErrors(page);
  const ada = agent(adminToken, "ada-e2e-filters");
  const link = await ada<LoginLink>("POST", "/v1/members/ada/login-links");
  expect(link.status).toBe(201);
  await page.goto(link.body!.url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);

  // Web, with builder-1 (an agent with `build`) holding the cart Task; the others nobody holds.
  await v1(page, "POST", "/v1/teams", { key: "WEB", name: "Web" });
  await v1(page, "PUT", "/v1/teams/WEB/members/ada");
  await v1(page, "POST", "/v1/skills", { name: "build", kind: "generic", body: "Build what the Task asks for." });
  await v1(page, "POST", "/v1/members", { name: "builder-1", kind: "agent" });
  await v1(page, "PUT", "/v1/teams/WEB/members/builder-1");
  await v1(page, "PUT", "/v1/members/builder-1/skills/build");
  const issued = await v1<IssuedToken>(page, "POST", "/v1/members/builder-1/tokens", { name: "e2e" });
  const bot = agent(issued.secret, "builder-1-e2e-filters");
  const filed = await v1<FeatureDetail>(page, "POST", "/v1/features", { team: "WEB", title: "Checkout flow" });
  const file = async (title: string, status?: string) =>
    (await v1<TaskDetail>(page, "POST", "/v1/tasks", { feature: filed.feature.key, title, skill: "build", status })).task.key;
  const cart = await file("Build the cart page");
  const discount = await file("Discount codes", "Backlog");
  const payment = await file("Payment form validation");
  expect((await bot("POST", `/v1/tasks/${cart}/claim`, { heartbeat_timeout_seconds: 900 })).status).toBe(200);

  await page.goto(`${base}/teams/WEB/tasks?view=list`);
  await expect(row(page, cart)).toBeVisible();
  await expect(chips(page)).toHaveCount(0);

  await test.step("F opens the Filters menu; Status takes Todo and In progress", async () => {
    await page.keyboard.press("f");
    const menu = page.getByRole("dialog", { name: "Filters" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("searchbox", { name: "Search" })).toBeFocused();
    await shot(page, "1-menu");
    await menu.getByRole("option", { name: "Status" }).click();
    await menu.getByRole("option", { name: "Todo" }).click();
    await menu.getByRole("option", { name: "In progress" }).click();
    await shot(page, "2-status-values");
    await page.keyboard.press("Escape");
    await expect(chips(page).getByRole("button", { name: "Status: Todo +1" })).toBeVisible();
    await expect(chips(page).getByRole("button", { name: "Status — is one of" })).toBeVisible();
    await expect(row(page, discount)).toHaveCount(0);
  });

  await test.step("Held by builder-1 leaves the Task it holds", async () => {
    await page.getByRole("button", { name: "Filter, 1 set" }).click();
    const menu = page.getByRole("dialog", { name: "Filters" });
    await menu.getByRole("option", { name: "Held by" }).click();
    await expect(menu.getByRole("option").nth(1)).toHaveAccessibleName("Nobody");
    await menu.getByRole("option", { name: "builder-1" }).click();
    await page.keyboard.press("Escape");
    await expect(chips(page).getByRole("button", { name: "Held by: builder-1" })).toBeVisible();
    await expect(row(page, cart)).toBeVisible();
    await expect(row(page, payment)).toHaveCount(0);
    await shot(page, "3-two-chips");
  });

  await test.step("flipping the operator keeps the value: is not builder-1", async () => {
    await chips(page).getByRole("button", { name: "Held by — is" }).click();
    await page.getByRole("option", { name: "is not" }).click();
    await expect(chips(page).getByRole("button", { name: "Held by — is not" })).toBeVisible();
    await expect(row(page, payment)).toBeVisible();
    await expect(row(page, cart)).toHaveCount(0);
  });

  await test.step("a reload keeps the pills, which name ids", async () => {
    const filters = new URL(page.url()).searchParams.getAll("filter.tasks");
    expect(filters).toHaveLength(2);
    expect(filters.find((f) => f.startsWith("holder:not:"))).not.toContain("builder-1");
    expect(filters.find((f) => f.startsWith("status:in:"))).not.toMatch(/Todo/);
    await page.reload();
    await expect(chips(page).getByRole("button", { name: "Status: Todo +1" })).toBeVisible();
    await expect(chips(page).getByRole("button", { name: "Held by — is not" })).toBeVisible();
    await expect(row(page, payment)).toBeVisible();
    await expect(row(page, cart)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filter, 2 set" })).toBeVisible();
  });

  await test.step("the board keeps the Filter", async () => {
    await page.getByRole("link", { name: "Board" }).click();
    await expect(page.getByRole("heading", { name: "Tasks, board" })).toBeAttached();
    await expect(chips(page).getByRole("button", { name: "Held by: builder-1" })).toBeVisible();
    await expect(row(page, payment)).toBeVisible();
    await expect(row(page, cart)).toHaveCount(0);
    await shot(page, "4-board");
  });

  await test.step("Reset clears every pill", async () => {
    await chips(page).getByRole("button", { name: "Reset" }).click();
    await expect(chips(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.getAll("filter.tasks")).toEqual([]);
    await expect(row(page, cart)).toBeVisible();
    await expect(row(page, discount)).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();
  });

  expect(errors).toEqual([]);
});

test("the Filter's dates and Claim, Team › Features, and a phone", async ({ page }) => {
  const errors = consoleErrors(page);
  const ada = agent(adminToken, "ada-e2e-filters-2");
  const link = await ada<LoginLink>("POST", "/v1/members/ada/login-links");
  await page.goto(link.body!.url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  // The first test filed these, and builder-1 still holds the cart Task.
  const tasks = (await v1<{ items: { key: string; title: string }[] }>(page, "GET", "/v1/tasks?team=WEB")).items;
  const key = (title: string) => tasks.find((t) => t.title === title)!.key;
  const [cart, payment] = [key("Build the cart page"), key("Payment form validation")];
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  await page.goto(`${base}/teams/WEB/tasks?view=list`);
  await expect(row(page, cart)).toBeVisible();

  await test.step("Filed is before today leaves nothing; flipped to is between, today's Tasks are back", async () => {
    await page.keyboard.press("f");
    const menu = page.getByRole("dialog", { name: "Filters" });
    await menu.getByRole("option", { name: "Filed", exact: true }).click();
    await menu.getByRole("button", { name: "Filed — is between" }).click();
    await page.getByRole("option", { name: "is before" }).click();
    await shot(page, "5-date-axis");
    await menu.locator(`[data-day="${today}"] button`).click();
    await expect(menu).toHaveCount(0);
    await expect(chips(page).getByRole("button", { name: /^Filed: before / })).toBeVisible();
    await expect(row(page, cart)).toHaveCount(0);
    // The day's start, with the browser's offset, on the wire.
    expect(new URL(page.url()).searchParams.get("filter.tasks")).toMatch(new RegExp(`^filed_at:before:${today}T00%3A00%3A00\\.000%2B|^filed_at:before:${today}T00%3A00%3A00\\.000-`));

    await chips(page).getByRole("button", { name: "Filed — is before" }).click();
    await page.getByRole("option", { name: "is between" }).click();
    await expect(row(page, cart)).toBeVisible();
    await expect(row(page, payment)).toBeVisible();
    await chips(page).getByRole("button", { name: "Clear Filed" }).click();
  });

  await test.step("a window from the presets, and Claim is Held", async () => {
    await page.getByRole("button", { name: "Filter" }).click();
    await page.getByRole("dialog", { name: "Filters" }).getByRole("option", { name: "Filed", exact: true }).click();
    await page.getByRole("button", { name: "Last 7 days" }).click();
    await expect(chips(page).getByRole("button", { name: "Filed: Last 7 days" })).toBeVisible();
    await page.getByRole("button", { name: "Filter, 1 set" }).click();
    await page.getByRole("dialog", { name: "Filters" }).getByRole("option", { name: "Claim", exact: true }).click();
    await page.getByRole("option", { name: "Held", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(chips(page).getByRole("button", { name: "Claim: Held" })).toBeVisible();
    await expect(row(page, cart)).toBeVisible();
    await expect(row(page, payment)).toHaveCount(0);
    await shot(page, "6-window-and-claim");
  });

  await test.step("at 390px each chip takes a line, and nothing scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const lines = chips(page).locator(":scope > div");
    await expect(lines).toHaveCount(2);
    const widths = await lines.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll).toBe(client);
    await shot(page, "7-phone");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("Team › Features: State is Shipped leaves nothing, is not Shipped the open Feature", async () => {
    await page.goto(`${base}/teams/WEB/features`);
    const list = page.getByRole("list", { name: "Features in Rank order" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.keyboard.press("f");
    await page.getByRole("dialog", { name: "Filters" }).getByRole("option", { name: "State", exact: true }).click();
    await page.getByRole("option", { name: "Shipped", exact: true }).click();
    await expect(chips(page).getByRole("button", { name: "State: Shipped" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(0);
    await chips(page).getByRole("button", { name: "State — is" }).click();
    await page.getByRole("option", { name: "is not" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.getAll("filter.features")).toEqual(["state:not:shipped"]);
    await shot(page, "8-features");
  });

  expect(errors).toEqual([]);
});

test("a View: save the Filter, reload, apply it again, delete it", async ({ page }) => {
  const errors = consoleErrors(page);
  const ada = agent(adminToken, "ada-e2e-filters-3");
  const link = await ada<LoginLink>("POST", "/v1/members/ada/login-links");
  await page.goto(link.body!.url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  const tasks = (await v1<{ items: { key: string; title: string }[] }>(page, "GET", "/v1/tasks?team=WEB")).items;
  const key = (title: string) => tasks.find((t) => t.title === title)!.key;
  const [cart, payment] = [key("Build the cart page"), key("Payment form validation")];

  await page.goto(`${base}/teams/WEB/tasks?view=list`);
  await expect(row(page, payment)).toBeVisible();
  await page.keyboard.press("f");
  await page.getByRole("dialog", { name: "Filters" }).getByRole("option", { name: "Held by" }).click();
  await page.getByRole("option", { name: "builder-1" }).click();
  await page.keyboard.press("Escape");
  await expect(row(page, payment)).toHaveCount(0);

  await test.step("Save as view names the list's Filter and Display", async () => {
    await page.getByRole("button", { name: "Views" }).click();
    await expect(page.getByText("No Views yet.")).toBeVisible();
    await page.getByRole("button", { name: "Save as view…" }).click();
    await page.getByRole("textbox", { name: "View name" }).fill("The builder's");
    await page.getByRole("button", { name: "Save View" }).click();
    await expect(chips(page).getByLabel("View The builder's")).toBeVisible();
    const views = (await v1<{ items: { name: string; filters: string[]; sort?: string; display?: Record<string, unknown> }[] }>(page, "GET", "/v1/views?entity=tasks&team=WEB")).items;
    expect(views).toHaveLength(1);
    expect(views[0].filters).toHaveLength(1);
    expect(views[0].filters[0]).toMatch(/^holder:is:/);
    expect(views[0]).toMatchObject({ name: "The builder's", sort: "rank", display: { layout: "list" } });
    await shot(page, "9-view-saved");
  });

  await test.step("a reload keeps it applied", async () => {
    await page.reload();
    await expect(chips(page).getByLabel("View The builder's")).toBeVisible();
    await expect(row(page, cart)).toBeVisible();
  });

  await test.step("Reset leaves it; applying it brings its Filter back", async () => {
    await chips(page).getByRole("button", { name: "Reset" }).click();
    await expect(chips(page)).toHaveCount(0);
    await expect(row(page, payment)).toBeVisible();
    await page.getByRole("button", { name: "Views" }).click();
    await expect(page.getByRole("option", { name: /The builder's/ })).toBeVisible();
    await shot(page, "10-views-menu");
    await page.getByRole("option", { name: /The builder's/ }).click();
    await expect(chips(page).getByLabel("View The builder's")).toBeVisible();
    await expect(chips(page).getByRole("button", { name: "Held by: builder-1" })).toBeVisible();
    await expect(row(page, payment)).toHaveCount(0);
    await expect(row(page, cart)).toBeVisible();
    await shot(page, "11-view-applied");
  });

  await test.step("deleting it leaves the Filter as it is", async () => {
    await page.getByRole("button", { name: "Views" }).click();
    await page.getByRole("option", { name: /The builder's/ }).hover();
    await page.getByRole("button", { name: "Delete The builder's" }).click();
    await expect(page.getByText("No Views yet.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chips(page).getByLabel(/^View /)).toHaveCount(0);
    await expect(chips(page).getByRole("button", { name: "Held by: builder-1" })).toBeVisible();
    expect((await v1<{ items: unknown[] }>(page, "GET", "/v1/views?entity=tasks&team=WEB")).items).toEqual([]);
  });

  expect(errors).toEqual([]);
});
