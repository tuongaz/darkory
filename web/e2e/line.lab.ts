import { expect, test, type Page } from "@playwright/test";
import { lineOverlaps } from "./lineBoxes";
import { mockLine } from "./lineMock";

// The Workflow line under `vite dev` with the fixture's /v1 (`npm run lab -- line`): each frame of
// the approved mockups (mock-workflow/shots: r2-final-1/2/5, r2-scope-1..8, d-11) shot at the
// same moment, light and dark, desktop and phone, into e2e/screenshots/line/ to lay beside them.
// No console error, no sideways scroll.

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  // The mocked /v1 runs no terminal: a Session panel's socket is refused, which is not the line's.
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("WebSocket connection") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function noSidewaysScroll(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll).toBe(w.client);
}

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `e2e/screenshots/line/${name}.png`, fullPage });

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`the Workflow line, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await mockLine(page);
      const tag = `${size.name}-${scheme}`;
      const phone = size.name === "phone";

      // r2-final-1: the page at 10:42:05.
      await page.goto("/projects/MAIN/workflows");
      const line = page.getByRole("region", { name: "Workflow", exact: true });
      await expect(line.locator('[data-task="MAIN-10"]')).toBeVisible();
      await page.waitForTimeout(500);
      await noSidewaysScroll(page);
      await shot(page, `page-${tag}`);
      expect(await lineOverlaps(page, "Workflow"), "page").toEqual([]);
      if (phone) await shot(page, `page-full-${tag}`, true);

      // r2-final-2: MAIN-19 selected, its chain and callout.
      await line.locator('[data-task="MAIN-19"]').click();
      await page.waitForTimeout(400);
      await shot(page, `selected-${tag}`);
      await page.keyboard.press("Escape");

      if (!phone) {
        // r2-scope-6: the scope menu open.
        await page.getByRole("button", { name: /^Scope: / }).click();
        await page.waitForTimeout(300);
        await shot(page, `scope-menu-${tag}`);
        // r2-scope-2: scoped to MAIN-7.
        await page.getByRole("option", { name: /MAIN-7/ }).click();
        await expect(page).toHaveURL(/scope=k-7/);
        await page.waitForTimeout(400);
        await shot(page, `scope-parent-${tag}`);
      expect(await lineOverlaps(page, "Workflow"), "scope-parent").toEqual([]);
        // A single Task's path on the Project line (MAIN-9).
        await page.goto("/projects/MAIN/workflows?scope=k-9");
        await page.waitForTimeout(600);
        await shot(page, `scope-task-${tag}`);
        // The Text view.
        await page.goto("/projects/MAIN/workflows?view=text");
        await page.waitForTimeout(300);
        await shot(page, `text-${tag}`);
      }

      // r2-scope-3, -5, -8 (and -7 on a phone): the Task pages.
      await page.goto("/tasks/MAIN-7");
      await expect(page.getByRole("region", { name: "Subtask line" }).locator('[data-task="MAIN-10"]')).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `task-parent-${tag}`);
      expect(await lineOverlaps(page, "Subtask line"), "task-parent").toEqual([]);
      await page.goto("/tasks/MAIN-9");
      await expect(page.getByRole("region", { name: "MAIN-9's way through the Workflow" })).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `task-subtask-${tag}`);
      await page.goto("/tasks/MAIN-6");
      await page.waitForTimeout(700);
      await shot(page, `task-standalone-${tag}`);
      await page.goto("/tasks/MAIN-1");
      await page.waitForTimeout(700);
      await shot(page, `task-done-parent-${tag}`);
      if (!phone) {
        // r2-scope-4: MAIN-9 in the peek over the Tasks board.
        await page.goto("/projects/MAIN/tasks?view=board&task=MAIN-9");
        await page.waitForTimeout(800);
        await shot(page, `peek-${tag}`);
      }

      // d-11: the heavy Workflow.
      await page.goto("/projects/BIG/workflows");
      await expect(page.getByRole("region", { name: "Workflow", exact: true })).toBeVisible();
      await page.waitForTimeout(500);
      await noSidewaysScroll(page);
      await shot(page, `big-${tag}`);
      expect(await lineOverlaps(page, "Workflow"), "big").toEqual([]);

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
