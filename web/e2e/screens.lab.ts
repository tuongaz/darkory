import { expect, test, type Page } from "@playwright/test";
import { mockOrganisation } from "./inboxLab";

// The Inbox, My work, a Project's Agents (with an agent's peek) and Activity in a real browser
// under `vite dev` (`npm run lab`), /v1 answered by the page's routes: no console error, no
// sideways scroll on a phone, and screenshots of each size and theme for a person to look at.

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

const screens = [
  { name: "inbox", path: "/inbox", ready: (p: Page) => p.getByRole("region", { name: "Aimed at you" }) },
  { name: "my-work", path: "/my-work", ready: (p: Page) => p.getByRole("region", { name: "You own" }) },
  { name: "agents", path: "/projects/WEB/agents", ready: (p: Page) => p.getByRole("link", { name: "builder-1", exact: true }) },
  { name: "agent-peek", path: "/projects/WEB/agents?agent=builder-1", ready: (p: Page) => p.getByRole("region", { name: "Runner session" }) },
  { name: "activity", path: "/projects/WEB/activity", ready: (p: Page) => p.getByRole("list", { name: "Activity" }) },
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`Inbox, My work, Agents and Activity: ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      await mockOrganisation(page);
      for (const s of screens) {
        await page.goto(s.path);
        await expect(s.ready(page)).toBeVisible();
        await page.waitForTimeout(200);
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(widths.scroll, s.path).toBe(widths.client);
        await page.screenshot({ path: `e2e/screenshots/m4d-${s.name}-${size.name}-${scheme}.png`, animations: "disabled" });
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}
