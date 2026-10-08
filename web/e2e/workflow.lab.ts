import { expect, test, type Page } from "@playwright/test";
import { mockV1 } from "./workflowMock";

// The Workflow screens under `vite dev` with a mocked /v1 (`npm run lab`): the live canvas and a
// Step's peek, the editing canvas with its panel, and the text view, at desktop and phone sizes in
// light and dark, shot into e2e/screenshots/ for a person to look at. No console error, no
// sideways scroll.

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function noSidewaysScroll(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll).toBe(w.client);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/workflow-${name}.png` });

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`workflow screens, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await mockV1(page);
      const tag = `${size.name}-${scheme}`;

      // Live.
      await page.goto("/projects/WEB/workflow");
      const live = page.getByRole("region", { name: "Workflow", exact: true });
      await expect(live.locator(".react-flow__edge").first()).toBeVisible();
      await expect(live.getByRole("img", { name: "builder-1 (agent), working" }).first()).toBeVisible();
      await page.waitForTimeout(400);
      await noSidewaysScroll(page);
      await shot(page, `live-${tag}`);

      // A Step's peek.
      await live.locator(".react-flow__node").filter({ hasText: "Build" }).first().click();
      const peek = page.getByRole("dialog", { name: "Step Build" });
      await expect(peek.getByRole("list", { name: "Tasks at Build" })).toBeVisible();
      await page.waitForTimeout(800);
      await shot(page, `peek-${tag}`);
      await peek.getByRole("button", { name: "Close" }).click();

      // Text view.
      await page.getByRole("button", { name: "Text" }).click();
      await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, `live-text-${tag}`);

      // Editing, a Step selected.
      await page.goto("/settings/projects/WEB/workflow?step=st-build");
      const edit = page.getByRole("region", { name: "Workflow, editing" });
      await expect(edit.locator(".react-flow__edge").first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Step Build" })).toBeVisible();
      await page.waitForTimeout(400);
      await noSidewaysScroll(page);
      await shot(page, `edit-${tag}`);

      // A Connector selected, then nothing; then the text view.
      await page.goto("/settings/projects/WEB/workflow");
      await expect(edit.locator(".react-flow__edge").first()).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `edit-none-${tag}`);
      await page.getByRole("button", { name: "Text" }).click();
      await page.getByRole("button", { name: /^Edit fail, QA to Build/ }).click();
      await expect(page.getByRole("region", { name: "Connector fail" })).toBeVisible();
      await page.waitForTimeout(300);
      await noSidewaysScroll(page);
      await shot(page, `edit-text-connector-${tag}`);

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("editing: rename, add a step, undo, each one PUT", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockV1(page);
  const puts: unknown[] = [];
  page.on("request", (r) => r.method() === "PUT" && puts.push(r.postDataJSON()));
  await page.goto("/settings/projects/WEB/workflow?step=st-qa");
  const name = page.getByRole("textbox", { name: "Name of QA" });
  await name.fill("Test");
  await name.press("Enter");
  await expect(page.locator(".react-flow__node").filter({ hasText: "Test" }).first()).toBeVisible();
  await expect.poll(() => puts.length).toBe(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".react-flow__node").filter({ hasText: "QA" }).first()).toBeVisible();
  await expect.poll(() => puts.length).toBe(2);

  const qa = page.locator(".react-flow__node").filter({ hasText: "QA" }).first();
  await qa.hover();
  await page.getByRole("button", { name: "Add a step after QA" }).click();
  await expect(page.getByRole("region", { name: "Step New step" })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "edit-added");
  expect(errors).toEqual([]);
});
