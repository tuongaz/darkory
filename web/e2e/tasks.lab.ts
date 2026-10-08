import { expect, test, type Page } from "@playwright/test";
import { mockV1 } from "./tasksMock";

// The Tasks screens on a mocked /v1 (`npm run lab`, under `vite dev`): the list, the board, a
// Parent's page with its Subtask graph, a worked Task's page and peek, and File a Task, at 1440 and
// 390 px in light and dark, into e2e/screenshots/tasks-*. No console error, no sideways scroll.

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

async function noSideways(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll).toBe(w.client);
}

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`Tasks screens, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await mockV1(page);
      const shot = (name: string) => page.screenshot({ path: `e2e/screenshots/tasks-${name}-${size.name}-${scheme}.png`, animations: "disabled" });

      await page.goto("/projects/WEB/tasks?view=list");
      await expect(page.getByRole("link", { name: /WEB-3 Search results/ })).toBeVisible();
      await page.getByRole("button", { name: "Open the Subtasks of WEB-7" }).click();
      await expect(page.getByRole("group", { name: "Subtasks of WEB-7" })).toBeVisible();
      await noSideways(page);
      await shot("list");

      await page.goto("/projects/WEB/tasks?view=board");
      await expect(page.locator("#main [data-task]").first()).toBeVisible();
      await noSideways(page);
      await shot("board");

      await page.goto("/tasks/WEB-7?view=graph");
      await expect(page.getByRole("region", { name: "Subtasks, graph" }).locator(".react-flow__edge").first()).toBeAttached();
      await noSideways(page);
      await shot("parent");

      await page.goto("/tasks/WEB-11");
      await expect(page.getByRole("list", { name: "Path through the Steps" })).toBeVisible();
      await noSideways(page);
      await shot("task");

      if (size.name === "desktop") {
        await page.goto("/projects/WEB/tasks?view=board&task=WEB-12");
        await expect(page.getByRole("dialog", { name: "Task WEB-12" })).toBeVisible();
        await shot("peek");
        await page.goto("/projects/WEB/tasks?view=list");
        await expect(page.getByRole("link", { name: /WEB-3 Search results/ })).toBeVisible();
        await page.keyboard.press("c");
        await expect(page.getByRole("dialog", { name: "File a Task" })).toBeVisible();
        await page.getByRole("switch", { name: "Break down" }).waitFor();
        await shot("file");
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("the holder's page: Advance as a split button over the outcomes", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await mockV1(page, "builder");
  await page.goto("/tasks/WEB-10");
  await expect(page.getByRole("button", { name: "Advance · pass" })).toBeVisible();
  await page.getByRole("button", { name: "More ways to end the Claim" }).click();
  await expect(page.getByRole("menuitem", { name: "Release" })).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/tasks-holder-desktop-light.png", animations: "disabled" });
  expect(errors).toEqual([]);
  await context.close();
});
