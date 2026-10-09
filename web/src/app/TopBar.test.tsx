import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { web } from "@/test/fixtures";
import { projectCrumb } from "./crumbs";
import { BarAction, type Crumb, TopBar } from "./TopBar";

// jsdom lays nothing out: these check the bar's structure only (what it renders, the `sm:` classes).
// Playwright's test 9 (workflows.spec.ts, the phone boards at 390 px) guards the phone link's name
// and where it lands.
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

describe("TopBar in two rows", () => {
  it("draws the view, the actions and the primary on a second row inside the header, under the crumbs", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} view={<span>View</span>} actions={<button type="button">Filter</button>} primary={<button type="button">Save</button>} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    const header = screen.getByRole("banner");
    const row = within(header).getByRole("group", { name: "Page" });
    expect(row.compareDocumentPosition(within(header).getByRole("navigation", { name: "Breadcrumb" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(row).getByText("View")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("draws a hairline under the crumbs' row when a second row follows", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} view={<span>View</span>} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement).toHaveClass("border-b");
    expect(screen.getByRole("banner")).toHaveClass("border-b");
  });

  it("hides its acts' labels by the row's width, and fades the view only when it overflows", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} view={<span>View</span>} primary={<BarAction icon={<svg aria-hidden />} label="File Task" />} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    const row = screen.getByRole("group", { name: "Page" });
    expect(row).toHaveClass("@container/page");
    const act = within(row).getByRole("button", { name: "File Task" });
    expect(within(act).getByText("File Task")).toHaveClass("hidden", "@2xl/page:inline");
    // jsdom lays nothing out, so nothing overflows: a fitting view is never faded.
    expect(within(row).getByText("View").parentElement).not.toHaveAttribute("data-overflow");
  });

  it("has no second row when the page has nothing for it", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("group", { name: "Page" })).toBeNull();
    // The header alone carries the one hairline then.
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement).not.toHaveClass("border-b");
    expect(screen.getByRole("banner")).toHaveClass("border-b");
  });
});
