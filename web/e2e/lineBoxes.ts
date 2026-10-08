import type { Page } from "@playwright/test";

/**
 * Every drawn word, chip and Step head inside a Workflow line running across, as boxes: the pairs
 * that overlap, and what the layout itself says met (a word on a line it does not sit on). A line
 * run down the page draws none of these.
 */
export async function lineOverlaps(page: Page, region: string): Promise<string[]> {
  return page.getByRole("region", { name: region, exact: true }).evaluate((root) => {
    if (root.getAttribute("data-orientation") === "vertical") return [];
    const clashes = root.querySelector("[data-clashes]")?.getAttribute("data-clashes");
    const els = [...root.querySelectorAll<HTMLElement>("[data-box]")];
    if (els.length === 0) return ["no boxes drawn"];
    const boxes = els
      .map((el) => ({ el, r: el.getBoundingClientRect(), text: el.textContent?.trim() ?? "" }))
      .filter((b) => b.r.width > 0 && b.r.height > 0);
    const found: string[] = clashes ? [`layout: ${clashes}`] : [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 0.5 && h > 0.5) found.push(`"${a.text}" × "${b.text}"`);
      }
    }
    return found;
  });
}
