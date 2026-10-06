import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// A smoke suite for the shell, against the real binary e2e/server.ts started. The tests share
// that server, and the second depends on the first leaving the startup login link unused. The
// screens' own journeys (Board, Task, Inbox, Admin) are added by the phases that build them.
test.describe.configure({ mode: "serial" });

const base = () => process.env.DARKORY_E2E_BASE_URL!;
const shots = fileURLToPath(new URL("./screenshots/", import.meta.url));

function shot(page: Page, name: string, fullPage = false) {
  // Sheets and dialogs animate in; the picture is of where they come to rest.
  return page.screenshot({ path: `${shots}${name}.png`, fullPage, animations: "disabled" });
}

/** Collects what the page logs as an error, such as a refusal by the Install's Content-Security-Policy. */
function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** The sidebar: on a phone it is a sheet, open only after the top bar's toggle. */
function sidebar(page: Page) {
  return page.locator("[data-slot=sidebar]").filter({ has: page.getByRole("navigation", { name: "Main" }) });
}

/** Writes through /v1 from inside the page, as the signed-in Member: the browser sends the cookie and the Origin. */
async function write(page: Page, method: string, path: string, body: unknown = {}) {
  const res = await page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path as string, {
        method: method as string,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    },
    [method, path, body] as const,
  );
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${res.text}`);
}

/** Marks the page so a later check can tell it was not reloaded. */
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

test("a browser with no cookie sees the signed-out page", async ({ page }) => {
  await page.goto(`${base()}/`);
  await expect(page.getByRole("heading", { name: "Sign in to Darkory" })).toBeVisible();
  await expect(page.getByText("darkory login <member>")).toBeVisible();
  // This Install does not email login links, so it offers no form for one.
  await expect(page.getByRole("heading", { name: "Get a link by email" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await shot(page, "signed-out");
});

test("the shell: sign in, the checklist, live updates, keys, the peek, a phone", async ({ page }) => {
  const errors = consoleErrors(page);
  await test.step("sign in with the startup link and land on the Inbox", async () => {
    await page.goto(process.env.DARKORY_E2E_LOGIN_LINK!);
    // Opening the link only shows its page; its same-origin POST signs in.
    await page.getByRole("button", { name: /^Sign in as / }).click();
    await expect(page).toHaveURL(`${base()}/inbox`);
  });

  await test.step("the shell renders: the places, Admin, the Member and the stream", async () => {
    const main = page.getByRole("navigation", { name: "Main" });
    for (const name of ["Inbox", "My work", "Agents", "Activity"]) await expect(main.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    await expect(sidebar(page).getByRole("link", { name: "Admin" })).toBeVisible();
    const account = sidebar(page).getByRole("link", { name: "Account, ada" });
    await expect(account.getByRole("status")).toHaveText("Connected");
  });

  await test.step("a fresh Install shows the checklist in the Inbox", async () => {
    const setup = page.getByRole("region", { name: "Set up E2E Organisation" });
    await expect(setup).toBeVisible();
    await expect(setup.getByRole("link", { name: "Create Team" })).toHaveAttribute("href", "/admin/teams?new=1");
    await expect(setup.getByRole("button", { name: "File Feature" })).toBeDisabled();
    await expect(sidebar(page).getByRole("link", { name: "Create a Team" })).toBeVisible();
    await shot(page, "checklist");
  });

  await test.step("a Team and a Feature written elsewhere appear without reloading", async () => {
    await markLoaded(page);
    await write(page, "POST", "/v1/teams", { key: "WEB", name: "Web" });
    await expect(sidebar(page).getByRole("button", { name: "Web" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Set up E2E Organisation" }).getByLabel("Step 1, done")).toBeVisible();

    await write(page, "PUT", "/v1/teams/WEB/members/ada");
    await write(page, "POST", "/v1/features", { team: "WEB", title: "Checkout flow" });
    // With a Feature filed the checklist gives way to the Inbox.
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Set up E2E Organisation" })).toHaveCount(0);
    await notReloaded(page);
    await shot(page, "inbox");
  });

  await test.step("⌘K finds a Task by key and by words", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByRole("dialog", { name: "Search" });
    await search.getByRole("combobox").fill("WEB-2");
    await expect(search.getByRole("option", { name: /WEB-2 Break down: Checkout flow/ })).toBeVisible();
    await search.getByRole("combobox").fill("checkout");
    await expect(search.getByRole("option", { name: /WEB-1 Checkout flow/ })).toBeVisible();
    await shot(page, "search");
    await search.getByRole("option", { name: /WEB-2 Break down/ }).click();
    await expect(page).toHaveURL(`${base()}/tasks/WEB-2`);
  });

  await test.step("C opens File Task; G B opens the board", async () => {
    await page.keyboard.press("c");
    await expect(page.getByRole("dialog", { name: "File a Task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("g");
    await page.keyboard.press("b");
    await expect(page).toHaveURL(`${base()}/teams/WEB/tasks?view=board`);
    await expect(page.getByRole("heading", { name: "Tasks, board" })).toBeVisible();
  });

  await test.step("J walks the list, Enter opens the peek beside it, Esc returns to the row; G I and ? answer", async () => {
    await page.goto(`${base()}/teams/WEB/tasks?view=list`);
    const row = page.locator("#main [data-task=WEB-2]");
    await expect(row).toBeVisible();
    await page.keyboard.press("j");
    await expect(row).toHaveAttribute("data-selected", "true");
    await expect(row).toBeFocused();
    await page.keyboard.press("Enter");
    const peek = page.getByRole("dialog", { name: "Task WEB-2" });
    await expect(peek).toBeVisible();
    // Not modal: no scrim, and the row under it keeps the ring.
    await expect(page.locator("[data-slot=sheet-overlay]")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-selected", "true");
    await shot(page, "peek-keys");
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await expect(row).toBeFocused();

    await page.keyboard.press("?");
    const keys = page.getByRole("dialog", { name: "Shortcuts" });
    await expect(keys.getByText("Go to Inbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(keys).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).toHaveURL(`${base()}/inbox`);
  });

  await test.step("?task= opens the peek over the board, and the page from it", async () => {
    await page.goto(`${base()}/teams/WEB/tasks?view=board&task=WEB-2`);
    const peek = page.getByRole("dialog", { name: "Task WEB-2" });
    await expect(peek).toBeVisible();
    await shot(page, "peek");
    await peek.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Open as page" }).click();
    await expect(page).toHaveURL(`${base()}/tasks/WEB-2`);
  });

  await test.step("at phone width nothing scrolls sideways, and the sidebar is a sheet", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/inbox", "/teams/WEB/tasks?view=board", "/admin/members"]) {
      await page.goto(`${base()}${path}`);
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
      await noSidewaysScroll(page);
    }
    await shot(page, "phone-admin");
    await page.goto(`${base()}/teams/WEB/tasks?view=board`);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await noSidewaysScroll(page);
    await shot(page, "phone-sidebar");
  });

  // Nothing the Install's CSP refuses, and no other error.
  expect(errors).toEqual([]);
});
