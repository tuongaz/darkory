import { expect, test } from "@playwright/test";
import { lineOverlaps } from "./lineBoxes";
import { mockLine } from "./lineMock";

// The Workflow line on the dense Workflows (`npm run lab -- dense`): Software (14 Steps, the
// software Workflow) and Big (12 Steps, 7 loops), the Workflow page and a Parent's Subtask Line,
// at 1440, 1024 and the phone, dark. On every horizontal drawing no two words, chips or Step
// heads overlap. Shots go to e2e/screenshots/dense/ (DENSE_OUT moves them).

const out = process.env.DENSE_OUT ?? "e2e/screenshots/dense";
const sizes = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  { name: "390", width: 390, height: 844 },
] as const;

const pages = [
  { name: "software-workflow", path: "/projects/SW/workflows/wf-sw", region: "Workflow" },
  { name: "software-parent", path: "/tasks/SW-1?view=line", region: "Subtask line" },
  { name: "big-workflow", path: "/projects/BIG/workflows/wf-big", region: "Workflow" },
  { name: "big-parent", path: "/tasks/BIG-25?view=line", region: "Subtask line" },
] as const;

for (const size of sizes) {
  test(`the dense Workflows at ${size.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: "dark", deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && !m.text().startsWith("WebSocket connection") && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await mockLine(page);
    for (const p of pages) {
      await page.goto(p.path);
      const line = page.getByRole("region", { name: p.region, exact: true });
      await expect(line).toBeVisible();
      await page.waitForTimeout(600);
      if (p.region === "Subtask line") await line.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${p.name}-${size.name}.png` });
      await page.screenshot({ path: `${out}/${p.name}-${size.name}-full.png`, fullPage: true });
      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll, p.name).toBe(w.client);
      if (process.env.DENSE_BEFORE !== "1") expect(await lineOverlaps(page, p.region), `${p.name} at ${size.name}`).toEqual([]);
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}
