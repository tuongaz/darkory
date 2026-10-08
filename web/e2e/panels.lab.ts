import { expect, test } from "@playwright/test";
import { clockOf, mockPanels, type Day } from "./panelsMock";

// The Workflow page's panels, Needs you and What's happening, in a real browser under `vite dev`
// (`npm run lab`) on the mockup's fixture: no console error, no sideways scroll on a phone, and
// screenshots of each day, size and theme to set beside r2-final, r2-n and r2-h. It needs the
// Workflow page to lay the panels out (the line's page builder wires them in).

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

const days: Day[] = ["now", "heavy", "quiet"];

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    for (const day of days) {
      test(`Workflow panels: ${day}, ${size.name}, ${scheme}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2, timezoneId: "UTC" });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(clockOf[day]));
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("pageerror", (e) => errors.push(e.message));
        await mockPanels(page, day);
        await page.goto("/projects/MAIN/workflow");
        await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible();
        await expect(page.getByRole("region", { name: "What's happening" })).toBeVisible();
        if (day === "quiet") await expect(page.getByText("Nothing needs you")).toBeVisible();
        else await expect(page.getByRole("article").first()).toBeVisible();
        await page.waitForTimeout(400);
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(widths.scroll).toBe(widths.client);
        const shot = `e2e/screenshots/panels-${day}-${size.name}-${scheme}`;
        await page.screenshot({ path: `${shot}.png`, animations: "disabled" });
        if (size.name === "phone") {
          await page.getByRole("region", { name: "What's happening" }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${shot}-stories.png`, animations: "disabled" });
          if (day !== "quiet") {
            // "+N more · keys · 1 agent waiting" opens the rest as a sheet.
            await page.getByRole("button", { name: /more/ }).filter({ hasText: "agent waiting" }).click();
            await expect(page.getByRole("dialog", { name: "Needs you" })).toBeVisible();
            await page.waitForTimeout(300);
            await page.screenshot({ path: `${shot}-sheet.png`, animations: "disabled" });
          }
        }
        if (day === "now" && size.name === "desktop") {
          // Following one Task: MAIN-9's row opened into its path.
          await page.getByRole("listitem", { name: /MAIN-9 Reaction picker/ }).click();
          await expect(page.getByRole("list", { name: "MAIN-9's entries" })).toBeVisible();
          await page.screenshot({ path: `${shot}-opened.png`, animations: "disabled" });
          // Answering MAIN-13 in its card, as typed.
          await page.getByRole("textbox", { name: "Your answer to MAIN-13" }).fill("CSV, one row per shift");
          await page.screenshot({ path: `${shot}-typing.png`, animations: "disabled" });
        }
        if (day === "heavy" && size.name === "desktop") {
          await page.getByRole("region", { name: "Needs you" }).getByRole("button", { name: /^\+\d+ more$/ }).click();
          await page.screenshot({ path: `${shot}-more.png`, animations: "disabled" });
        }
        expect(errors).toEqual([]);
        await context.close();
      });
    }
  }
}
