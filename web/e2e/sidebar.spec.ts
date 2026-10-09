import { expect, test } from "@playwright/test";
import { startInstall, type Install } from "./server";

// The bar's first-row trigger collapses the sidebar from md up and brings it back, against the real
// binary on an Install of its own with init's MAIN only.
let install: Install;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  install = await startInstall();
});

test.afterAll(async () => {
  await install?.stop();
});

test("at 1280 the trigger collapses the sidebar, the page card takes its width, and it holds across pages", async ({ browser }) => {
  const res = await fetch(`${install.base}/v1/members/ada/login-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${install.token}`, "Darkory-Session": "e2e-sidebar-ada", "Idempotency-Key": crypto.randomUUID() },
  });
  const { url } = (await res.json()) as { url: string };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${install.base}/inbox`);

  const sidebar = page.locator("[data-slot=sidebar]");
  const card = page.locator("[data-slot=sidebar-inset]");
  const trigger = page.locator('[data-sidebar="trigger"]');
  await expect(trigger).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  const open = (await card.boundingBox())!;

  await trigger.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(open.width + 200);

  // Moving between pages (a client-side step, as a link makes it) keeps it collapsed.
  await page.evaluate(() => {
    history.pushState({}, "", "/my-work");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(`${install.base}/my-work`);
  await expect(trigger).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  await trigger.click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect.poll(async () => (await card.boundingBox())!.width).toBeCloseTo(open.width, -1);
  await ctx.close();
});
