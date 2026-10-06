import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { FeatureDetail, IssuedToken, LoginLink, TaskDetail } from "../src/api/client";
import startServer from "./server";

// The Board's journeys (docs/build/ui-plan.md, scenarios 1–4, 13 and 14) against the real binary.
// They run on an Install of their own, since this file runs before flow.spec.ts, which needs the
// shared one fresh. ada signs in with a login link she asks /v1 for with her token, as the specs on
// the shared Install do. Records are seeded through /v1 as a human (ada, in the browser) and as an
// agent (builder-1, with a bearer token, as the CLI calls).
test.describe.configure({ mode: "serial" });
// The size of the mockup's frames, so the screenshots pair with them.
test.use({ viewport: { width: 1440, height: 900 } });

const shots = fileURLToPath(new URL("./screenshots/board/", import.meta.url));
// startServer sets these for the Install it starts; the specs after this one read the shared one's.
const env = ["DARKORY_E2E_LOGIN_LINK", "DARKORY_E2E_BASE_URL", "DARKORY_E2E_DATA", "DARKORY_E2E_ADMIN_TOKEN"] as const;

let stop: (() => Promise<void>) | undefined;
let base = "";
let adminToken = "";

test.beforeAll(async () => {
  // Building the binary again is quick (Go caches it); starting it takes a moment.
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

/** What the page logs as an error, less the refusals a scenario provokes on purpose. */
function consoleErrors(page: Page, expected: RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !expected.some((e) => e.test(m.text()))) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Calls /v1 from inside the page as the signed-in Member: the browser sends the cookie and the Origin. */
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

/** An agent Member calling /v1 as the CLI does: a bearer token and the Session it chose. */
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

async function signIn(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
}

/** Drags with the mouse, as dnd-kit needs: press, move past its 5px threshold, travel, release. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 16 });
  await page.mouse.up();
}

const column = (page: Page, status: string) => page.locator("#main").getByRole("region", { name: status, exact: true });
const card = (page: Page, key: string) => page.locator(`[data-task="${key}"]`);

async function markLoaded(page: Page) {
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
}
async function notReloaded(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
}
async function noSidewaysScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBe(client);
}

test("the Board: live Claims, drags that set a Status or are refused, File Task, a phone", async ({ page, browser }) => {
  const errors = consoleErrors(page, [/status of 409/]);
  const ada = agent(adminToken, "ada-e2e-board");
  const adaLink = await ada<LoginLink>("POST", "/v1/members/ada/login-links");
  expect(adaLink.status).toBe(201);
  await signIn(page, adaLink.body!.url);

  // ada (admin) sets up Web; builder-1 is an agent with `build`; mai is a Member outside Web.
  await v1(page, "POST", "/v1/teams", { key: "WEB", name: "Web" });
  await v1(page, "PUT", "/v1/teams/WEB/members/ada");
  await v1(page, "POST", "/v1/skills", { name: "build", kind: "generic", body: "Build what the Task asks for." });
  await v1(page, "POST", "/v1/skills", { name: "review", kind: "generic", body: "Read the change as the next engineer." });
  await v1(page, "PUT", "/v1/members/ada/skills/review");
  await v1(page, "POST", "/v1/members", { name: "builder-1", kind: "agent" });
  await v1(page, "PUT", "/v1/teams/WEB/members/builder-1");
  await v1(page, "PUT", "/v1/members/builder-1/skills/build");
  const issued = await v1<IssuedToken>(page, "POST", "/v1/members/builder-1/tokens", { name: "e2e" });
  const bot = agent(issued.secret, "builder-1-e2e");
  await v1(page, "POST", "/v1/members", { name: "mai", kind: "human" });
  const maiLink = (await v1<LoginLink>(page, "POST", "/v1/members/mai/login-links")).url;

  const filed = await v1<FeatureDetail>(page, "POST", "/v1/features", { team: "WEB", title: "Checkout flow" });
  const featureKey = filed.feature.key;
  const file = async (title: string, skill: string, status?: string) =>
    (await v1<TaskDetail>(page, "POST", "/v1/tasks", { feature: featureKey, title, skill, status })).task.key;
  const cart = await file("Build the cart page", "build");
  const discount = await file("Discount codes", "build", "Backlog");
  const payment = await file("Payment form validation", "review");

  await test.step("1. a bot's Claim appears on the board without reload, with its holder and countdown", async () => {
    await page.goto(`${base}/teams/WEB/tasks?view=board`);
    await expect(column(page, "Todo").locator(`[data-task="${cart}"]`)).toBeVisible();
    await markLoaded(page);

    const claimed = await bot("POST", `/v1/tasks/${cart}/claim`, { heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" });
    expect(claimed.status).toBe(200);

    const held = column(page, "In progress").locator(`[data-task="${cart}"]`);
    await expect(held).toBeVisible();
    await expect(held.getByRole("img", { name: "builder-1 (agent)" })).toBeVisible();
    await expect(held).toContainText(/1[45] min/);
    await expect(held).toContainText("claude-opus-5-5");
    await notReloaded(page);
    await shot(page, "1-live-claim");
  });

  await test.step("2. dragging Backlog → Todo makes the Task takeable: the bot's next returns it", async () => {
    // In Backlog it is not offered.
    expect((await bot("POST", "/v1/tasks/next", { wait_seconds: 0 })).status).toBe(204);

    await expect(column(page, "Backlog").locator(`[data-task="${discount}"]`)).toBeVisible();
    await drag(page, card(page, discount), column(page, "Todo"));
    await expect(column(page, "Todo").locator(`[data-task="${discount}"]`)).toBeVisible();
    await expect.poll(async () => (await v1<TaskDetail>(page, "GET", `/v1/tasks/${discount}`)).status.name).toBe("Todo");
    await shot(page, "2-backlog-to-todo");

    const next = await bot<TaskDetail>("POST", "/v1/tasks/next", { wait_seconds: 0, heartbeat_timeout_seconds: 900 });
    expect(next.status).toBe(200);
    expect(next.body?.task.key).toBe(discount);
    await expect(column(page, "In progress").locator(`[data-task="${discount}"]`)).toBeVisible();
  });

  await test.step("3. dragging to Done without holding the Task is refused: the toast names Claim, the card snaps back", async () => {
    await drag(page, card(page, payment), column(page, "Done"));
    const toast = page.getByRole("region", { name: /Notifications/ }).getByRole("listitem").filter({ hasText: "Not moved to Done" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Done is reached by completing a Task you hold.");
    await expect(toast.getByRole("button", { name: `Claim ${payment}` })).toBeVisible();
    // The card has snapped back: it is in Todo, no longer the faded place of a card in flight.
    await expect(column(page, "Todo").locator(`[data-task="${payment}"]`)).not.toHaveClass(/opacity-40/);
    await expect(column(page, "Done").locator(`[data-task="${payment}"]`)).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, "3-refused-done");

    // The action the toast names resolves it.
    await toast.getByRole("button", { name: `Claim ${payment}` }).click();
    const mine = column(page, "In progress").locator(`[data-task="${payment}"]`);
    await expect(mine.getByRole("img", { name: "ada" })).toBeVisible();
  });

  await test.step("4. a Member outside the Feature's Team cannot drag its cards", async () => {
    const context = await browser.newContext();
    const other = await context.newPage();
    const otherErrors = consoleErrors(other);
    await signIn(other, maiLink);
    const moves: string[] = [];
    other.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/status")) moves.push(r.url());
    });
    await other.goto(`${base}/teams/WEB/tasks?view=board`);
    const theirs = column(other, "In progress").locator(`[data-task="${payment}"]`);
    await expect(theirs).toBeVisible();
    await expect(theirs).toHaveAttribute("data-movable", "false");
    await drag(other, theirs, column(other, "Backlog"));
    await other.waitForTimeout(500);
    await expect(column(other, "In progress").locator(`[data-task="${payment}"]`)).toBeVisible();
    expect(moves).toEqual([]);
    expect((await v1<TaskDetail>(page, "GET", `/v1/tasks/${payment}`)).status.name).toBe("In progress");
    await shot(other, "4-outside-the-team");
    expect(otherErrors).toEqual([]);
    await context.close();
  });

  await test.step("13. C opens File Task, which files into the board", async () => {
    await page.keyboard.press("c");
    const dialog = page.getByRole("dialog", { name: "File a Task" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Feature" }).click();
    await page.getByRole("option", { name: /Checkout flow/ }).click();
    await dialog.getByLabel("Title").fill("Gift cards");
    await dialog.getByRole("combobox", { name: "Who can take it" }).click();
    await page.getByRole("option", { name: "build" }).click();
    await shot(page, "13-file-task");
    await dialog.getByRole("button", { name: "File Task" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(column(page, "Todo").getByRole("link", { name: /Gift cards/ })).toBeVisible();
  });

  await test.step("14. at 390px neither view scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ["list", "board"]) {
      await page.goto(`${base}/teams/WEB/tasks?view=${view}`);
      await expect(page.getByRole("heading", { name: `Tasks, ${view}` })).toBeAttached();
      await expect(page.locator(`[data-task="${cart}"]`)).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, `14-phone-${view}`);
    }
  });

  expect(errors).toEqual([]);
});
