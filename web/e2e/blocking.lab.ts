import { expect, test, type Page } from "@playwright/test";

// The Blocking view and the Subtask graph's outside stubs in the design lab (`npm run lab`), on
// the deps round's samples: MAIN, BIG, MAIN-7 scoped, MAIN-19 selected. Shot into
// e2e/screenshots/ at desktop and phone sizes in light and dark, to set beside the mockups
// (r2-deps-6, 7, 8, 14, 15). No console error, no sideways scroll.

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

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`blocking, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await page.goto("/dev/design");
      await expect(page.getByRole("heading", { name: "Design lab" })).toBeVisible();
      const tag = `${size.name}-${scheme}`;
      const shot = (name: string, section: string) => page.getByRole("region", { name: section, exact: true }).screenshot({ path: `e2e/screenshots/blocking-${name}-${tag}.png` });

      const main = page.getByRole("region", { name: "Blocking · MAIN", exact: true });
      await main.scrollIntoViewIfNeeded();
      await expect(main.locator("[data-edge]")).toHaveCount(5);
      await expect(main.locator("[data-longest][data-task]")).toHaveCount(3);
      await shot("main", "Blocking · MAIN");

      // MAIN-19 selected: its chain lit, the rest dimmed, the card under it.
      await main.getByRole("button", { name: /^MAIN-19 / }).click();
      const card = main.getByRole("dialog", { name: "MAIN-19, its chain" });
      await expect(card).toContainText("by MAIN-12, MAIN-4");
      await expect(card).toContainText("First: answer MAIN-13");
      await page.waitForTimeout(200);
      await shot("main-selected", "Blocking · MAIN");
      await card.getByRole("button", { name: "Show on line" }).click();
      await expect(main.getByText("onShowOnLine(MAIN-19)")).toBeVisible();
      await page.keyboard.press("Escape");

      const big = page.getByRole("region", { name: "Blocking · BIG", exact: true });
      await big.scrollIntoViewIfNeeded();
      await expect(big.locator("[data-edge]")).toHaveCount(9);
      await shot("big", "Blocking · BIG");

      const scoped = page.getByRole("region", { name: "Blocking · MAIN-7", exact: true });
      await scoped.scrollIntoViewIfNeeded();
      await shot("scoped", "Blocking · MAIN-7");

      const graph = page.getByRole("region", { name: "Subtask graph", exact: true });
      await graph.scrollIntoViewIfNeeded();
      await expect(graph.getByRole("button", { name: /^Blocks MAIN-19 / })).toBeVisible();
      await shot("subtask-graph", "Subtask graph");

      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll).toBe(w.client);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
