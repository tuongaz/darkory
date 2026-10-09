import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { web } from "@/test/fixtures";
import { projectCrumb } from "./crumbs";
import { type Crumb, TopBar } from "./TopBar";

// jsdom lays nothing out: these read what the bar renders at each width (the `sm:` classes);
// Playwright's phone boards (workflows.spec.ts, `insideThePhone`) read where it lands at 390 px.
function bar(crumbs: Crumb[]) {
  render(
    <MemoryRouter>
      <SidebarProvider>
        <TopBar crumbs={crumbs} />
      </SidebarProvider>
    </MemoryRouter>,
  );
  return screen.getByRole("navigation", { name: "Breadcrumb" });
}
const chip: Crumb = { label: <button type="button">Bugs</button>, whole: true };
const phoneHidden = (el: Element) => el.classList.contains("hidden") && /\bsm:(inline|flex)\b/.test(el.className);

describe("TopBar on a phone, beside the Workflow chip", () => {
  it("keeps the Project's mark as the link to it, and hides its name and the '/'", () => {
    const nav = bar([projectCrumb(web), chip]);
    const link = within(nav).getByRole("link", { name: web.name });
    expect(link).toHaveAttribute("href", `/projects/${web.key}/tasks`);
    const mark = link.querySelector("[data-hue]")!;
    expect(mark).not.toBeNull();
    expect(phoneHidden(mark)).toBe(false);
    expect(phoneHidden(mark.parentElement!)).toBe(false);
    // About 20px on a phone, the crumb's 14px from `sm` up.
    expect(mark.parentElement!.className).toMatch(/max-sm:\[&>\*\]:size-5/);
    expect(phoneHidden(within(link).getByText(web.name))).toBe(true);
    expect(phoneHidden(within(nav).getByText("/"))).toBe(true);
    // The crumb itself holds its width; the chip is what gives way after the name.
    expect(phoneHidden(link.parentElement!)).toBe(false);
    expect(link.parentElement!.className).toMatch(/\bflex-none\b/);
  });

  it("keeps the mark on the Tasks page, where the crumb is no link", () => {
    const nav = bar([projectCrumb(web, false), chip]);
    expect(within(nav).queryByRole("link")).toBeNull();
    expect(nav.querySelector("[data-hue]")).not.toBeNull();
    expect(phoneHidden(within(nav).getByText(web.name))).toBe(true);
  });

  it("shows the name at every width with no chip", () => {
    const nav = bar([projectCrumb(web), { label: "Activity" }]);
    const link = within(nav).getByRole("link", { name: web.name });
    expect(phoneHidden(within(link).getByText(web.name))).toBe(false);
    expect(link.querySelector("[data-hue]")!.parentElement).toBe(link);
    expect(phoneHidden(within(nav).getByText("/"))).toBe(false);
  });
});
