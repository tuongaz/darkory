import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// The tests share the server e2e/server.ts started, and the second depends on the first leaving
// the startup login link unused.
test.describe.configure({ mode: "serial" });

const base = () => process.env.DARKORY_E2E_BASE_URL!;
const shots = fileURLToPath(new URL("./screenshots/", import.meta.url));

// A 1×1 PNG, attached as Evidence.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A link in the main navigation, which other links on a page may share words with. */
function nav(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true });
}

function shot(page: Page, name: string, fullPage = true) {
  return page.screenshot({ path: `${shots}${name}.png`, fullPage });
}

/** Calls /v1 as an agent Member does: a bearer token, a Session id, a JSON body and an Idempotency-Key. */
async function asAgent<T>(secret: string, method: string, path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Darkory-Session": "e2e-agent-run-1",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

type TaskDetail = { task: { id: string; key: string; title: string } };

test("a browser with no cookie sees the signed-out page", async ({ page }) => {
  await page.goto(`${base()}/`);
  await expect(page.getByRole("heading", { name: "Sign in to Darkory" })).toBeVisible();
  await expect(page.getByText("darkory login <member>")).toBeVisible();
  // This Install does not email login links, so it offers no form for one.
  await expect(page.getByRole("heading", { name: "Get a link by email" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await shot(page, "signed-out");
});

test("the MVP flow in the browser, with an agent working through the API", async ({ page }) => {
  let secret = "";
  let workKey = "";
  let retroKey = "";

  await test.step("sign in with the startup link", async () => {
    await page.goto(process.env.DARKORY_E2E_LOGIN_LINK!);
    await expect(page).toHaveURL(`${base()}/`);
    await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
    await expect(page.getByText("There are no Teams yet.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  });

  await test.step("the admin creates a Team and joins it", async () => {
    await nav(page, "Admin").click();
    await page.getByRole("link", { name: "Teams" }).click();
    await page.getByLabel("Key, the prefix of its display keys").fill("WEB");
    await page.getByLabel("Name").fill("Web");
    await page.getByRole("button", { name: "Create Team" }).click();
    await page.getByRole("status").getByRole("link", { name: "Web" }).click();
    await page.getByLabel("Add a Member").selectOption({ label: "ada" });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("region", { name: "Members" }).getByRole("link", { name: "ada" })).toBeVisible();
  });

  await test.step("the admin creates an agent Member, puts it in the Team, grants a Skill and issues a token", async () => {
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Members" }).click();
    await page.getByLabel("Name").fill("builder");
    await page.getByLabel("Agent").check();
    await page.getByRole("button", { name: "Create Member" }).click();
    await page.getByRole("status").getByRole("link", { name: "builder" }).click();
    await expect(page.getByRole("heading", { name: /builder/ })).toBeVisible();

    await page.getByLabel("Add to Team").selectOption({ label: "Web" });
    await page.getByRole("region", { name: "Teams" }).getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("region", { name: "Teams" }).getByRole("link", { name: "Web" })).toBeVisible();

    await page.getByLabel("Grant a Skill").selectOption({ label: "breakdown" });
    await page.getByRole("button", { name: "Grant" }).click();
    await expect(page.getByRole("button", { name: "Take breakdown away" })).toBeVisible();

    const issue = page.getByRole("form", { name: "Issue a token" });
    await issue.getByLabel("Name").fill("e2e");
    await issue.getByRole("button", { name: "Issue token" }).click();
    const field = page.getByLabel("Secret for e2e");
    await expect(field).toHaveValue(/^dk_/);
    secret = await field.inputValue();
    await expect(page.getByText("It is shown only once")).toBeVisible();
    await shot(page, "token-shown-once");
    await page.getByRole("button", { name: "Done" }).click();
    // Only the prefix is shown from now on.
    await expect(page.getByLabel("Secret for e2e")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Tokens" })).toContainText("e2e");
    expect(await page.content()).not.toContain(secret);
  });

  await test.step("the human files two Features; each gets its Break down", async () => {
    await nav(page, "Board").click();
    for (const title of ["Checkout flow", "Search"]) {
      await page.getByLabel("Title").fill(title);
      await page.getByRole("button", { name: "File Feature" }).click();
      await expect(page.getByRole("status").filter({ hasText: "with its Breakdown Task" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Features in Rank order" })).toContainText(title);
    }
    await page.getByRole("link", { name: /Checkout flow/ }).click();
    await expect(page.getByRole("heading", { name: /Checkout flow/ })).toBeVisible();
    const tasks = page.getByRole("region", { name: "Tasks" });
    await expect(tasks.getByRole("listitem")).toHaveCount(1);
    await expect(tasks).toContainText("Breakdown");
    await expect(tasks).toContainText("needs breakdown");
    await shot(page, "feature-filed");
  });

  await test.step("the agent claims the Break down through the API; the page shows it without reloading", async () => {
    const breakdown = page.getByRole("region", { name: "Tasks" }).getByRole("listitem").first();
    const key = (await breakdown.locator(".key").textContent())!;
    await expect(breakdown).not.toContainText("claimed");
    await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));

    await asAgent(secret, "POST", `/v1/tasks/${key}/claim`, { heartbeat_timeout_seconds: 600, model_label: "e2e-model" });

    await expect(breakdown).toContainText("claimed");
    await expect(breakdown).toContainText("held by builder (agent)");
    expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
    await shot(page, "claim-live");

    // Working the Break down, the agent files a Task aimed at the human and completes it.
    const filed = await asAgent<TaskDetail>(secret, "POST", "/v1/tasks", {
      feature: "WEB-1",
      title: "Write the checkout page",
      aimed_at: "ada",
    });
    workKey = filed.task.key;
    await asAgent(secret, "POST", `/v1/tasks/${key}/complete`, { note: "Filed the work." });
    await expect(page.getByRole("region", { name: "Tasks" })).toContainText(workKey);
    await expect(breakdown).toContainText("done");
  });

  await test.step("shipping is refused while a Task is open", async () => {
    await page.getByRole("button", { name: "Ship", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("tasks_open");
    await shot(page, "ship-refused");
  });

  await test.step("the human claims the Task, writes a Note, attaches Evidence and completes it", async () => {
    await page.getByRole("link", { name: new RegExp(workKey) }).click();
    await expect(page.getByRole("heading", { name: /Write the checkout page/ })).toBeVisible();
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByRole("region", { name: "Claim", exact: true })).toContainText("Member-bound");

    await page.getByLabel("For whoever works the Task next").fill("Used the existing cart component.");
    await page.getByRole("button", { name: "Add Note" }).click();
    await expect(page.getByRole("region", { name: "Notes" })).toContainText("Used the existing cart component.");

    await page.getByLabel("Attach a file").setInputFiles({ name: "checkout.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    const evidence = page.getByRole("region", { name: "Evidence" });
    await expect(evidence.getByRole("link", { name: "checkout.png" })).toBeVisible();
    await expect(evidence).toContainText("image/png");
    // The download is the same bytes, always as an attachment.
    const href = (await evidence.getByRole("link", { name: "checkout.png" }).getAttribute("href"))!;
    const download = await page.request.get(`${base()}${href}`);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-disposition"]).toMatch(/^attachment/);
    expect(download.headers()["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(await download.body(), png)).toBe(0);

    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(page.locator(".record-header .badge-done")).toBeVisible();
    await expect(page.getByRole("region", { name: "Claim history", exact: true })).toContainText("completed");
    await shot(page, "task-done");
  });

  await test.step("the human ranks Features by dragging", async () => {
    await nav(page, "Board").click();
    const board = page.getByRole("region", { name: "Features in Rank order" });
    const titles = () => board.getByRole("listitem").locator(".grow > a").allTextContents();
    await expect.poll(titles).toEqual(["WEB-1 Checkout flow", "WEB-3 Search"]);

    await board.getByTitle("Drag WEB-3 to another place in the Rank").dragTo(board.getByRole("listitem").first());

    await expect.poll(titles).toEqual(["WEB-3 Search", "WEB-1 Checkout flow"]);
    await page.reload();
    await expect.poll(titles).toEqual(["WEB-3 Search", "WEB-1 Checkout flow"]);
    await expect(board.getByRole("listitem").first()).toContainText("Tasks: 1 open");
    await expect(board.getByRole("listitem").nth(1)).toContainText("Tasks: 0 open · 2 done");
    await shot(page, "board-ranked");
  });

  await test.step("the owner ships once every Task has ended, and the Retrospective is filed", async () => {
    await page.getByRole("link", { name: /Checkout flow/ }).click();
    await page.getByRole("button", { name: "Ship", exact: true }).click();
    await expect(page.locator(".record-header .badge-shipped")).toBeVisible();
    const retro = page.getByRole("region", { name: "Tasks" }).getByRole("listitem").filter({ hasText: "Retrospective: Checkout flow" });
    await expect(retro).toBeVisible();
    await expect(retro).toContainText("needs retro");
    retroKey = (await retro.locator(".key").textContent())!;
    await shot(page, "shipped-retrospective");
  });

  await test.step("the admin creates a company Skill, and grants retro to the human and skill-review to the agent", async () => {
    await nav(page, "Admin").click();
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Skills" }).click();
    const create = page.getByRole("region", { name: "Create a Skill" });
    await create.getByLabel("Name").fill("frontend");
    await create.getByLabel("Text, published as version 1").fill("Build web pages.");
    await create.getByRole("button", { name: "Create Skill" }).click();
    await expect(page.getByRole("region", { name: "Skills" }).getByRole("link", { name: "frontend" })).toBeVisible();
    await create.getByLabel("Name").fill("checkout-guide");
    await create.getByLabel(/^Company/).check();
    await create.getByLabel("Builds on").selectOption({ label: "frontend" });
    await create.getByLabel("Text, published as version 1").fill("1. Reuse the cart component.\n2. Ship behind a flag.");
    await create.getByRole("button", { name: "Create Skill" }).click();
    await expect(page.getByRole("region", { name: "Skills" }).getByRole("link", { name: "checkout-guide" })).toBeVisible();

    for (const [member, skill] of [
      ["ada", "retro"],
      ["builder", "skill-review"],
    ]) {
      await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Members" }).click();
      await page.getByRole("region", { name: "Members" }).getByRole("link", { name: member, exact: true }).click();
      await page.getByLabel("Grant a Skill").selectOption({ label: skill });
      await page.getByRole("button", { name: "Grant" }).click();
      await expect(page.getByRole("button", { name: `Take ${skill} away` })).toBeVisible();
    }
  });

  await test.step("the human proposes a Skill version from the Retrospective and hands it to skill-review", async () => {
    await page.goto(`${base()}/tasks/${retroKey}`);
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    const propose = page.getByRole("form", { name: "Propose a Skill version" });
    await propose.getByLabel("Company Skill").selectOption({ label: "checkout-guide" });
    const text = propose.getByLabel("New text, written against version 1");
    await expect(text).toHaveValue(/Reuse the cart component/);
    await text.fill("1. Reuse the cart component.\n2. Ship behind a flag.\n3. Watch the checkout error rate for a day.");
    await propose.getByRole("button", { name: "Propose" }).click();
    await expect(propose.getByRole("status")).toContainText("Proposed against version 1");

    const handover = page.getByRole("form", { name: "Handover" });
    await handover.getByLabel("Skill it needs next").selectOption({ label: "skill-review" });
    await handover.getByRole("button", { name: "Hand over" }).click();
    await expect(page.getByRole("region", { name: "Claim", exact: true })).toContainText("Nobody holds this Task.");

    const proposal = page.getByRole("region", { name: "Skill proposal" });
    await expect(proposal).toContainText("checkout-guide");
    await expect(proposal).toContainText("version 1");
    await expect(proposal).toContainText("ada");
    await expect(proposal).toContainText("pending");
    await expect(proposal.getByLabel("Proposed text")).toContainText("3. Watch the checkout error rate for a day.");
    await shot(page, "proposal-pending");
  });

  await test.step("the agent reviews it through the API; the page shows it published without reloading", async () => {
    await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
    await asAgent(secret, "POST", `/v1/tasks/${retroKey}/claim`, { heartbeat_timeout_seconds: 600 });
    await asAgent(secret, "POST", `/v1/tasks/${retroKey}/complete`, { note: "Reads well; published." });

    const proposal = page.getByRole("region", { name: "Skill proposal" });
    await expect(proposal).toContainText("published as version 2");
    await expect(page.locator(".record-header .badge-done")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
    await shot(page, "proposal-published");
  });

  await test.step("Activity reads newest first, in words", async () => {
    await nav(page, "Activity").click();
    const list = page.getByRole("list", { name: "Activity" });
    // Completing the review publishes the version in the same write, numbered after the completion.
    await expect(list.getByRole("listitem").first()).toContainText("builder (agent) published a version of checkout-guide · version 2");
    await expect(list.getByRole("listitem").nth(1)).toContainText(/builder \(agent\) completed WEB-\d+ Retrospective: Checkout flow/);
    await expect(list).toContainText(/builder \(agent\) claimed WEB-2 Break down/);
    await expect(list).toContainText("ada shipped WEB-1 Checkout flow");
    await shot(page, "activity", false);
  });

  await test.step("My account lists the human's own tokens", async () => {
    await nav(page, "My account").click();
    await expect(page.getByRole("list", { name: "Tokens" })).toContainText("init");
    await shot(page, "account");
  });

  await test.step("at phone width the board fits without scrolling sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await nav(page, "Board").click();
    await expect(page.getByRole("region", { name: "Features in Rank order" })).toContainText("Search");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await shot(page, "board-phone");
  });
});
