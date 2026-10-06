import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { matchRecords } from "@/app/search";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { initials } from "@/lib/members";
import { glyphFor } from "@/lib/status";
import { untilText } from "@/lib/time";
import { EmptyState } from "./EmptyState";
import { FormDialog, FormRow, FormRows } from "./FormDialog";
import { HeartbeatMeter } from "./HeartbeatMeter";
import { InfoPopover } from "./InfoPopover";
import { Key } from "./Key";
import { MemberAvatar } from "./MemberAvatar";
import { Peek } from "./Peek";
import { Pill } from "./Pill";
import { PropertiesRail, Property } from "./PropertiesRail";
import { StatusGlyph } from "./StatusGlyph";
import { Timeline, TimelineDay, TimelineRow } from "./Timeline";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("StatusGlyph", () => {
  it("names each of the six glyphs", () => {
    render(
      <>
        {(["backlog", "todo", "inprogress", "inreview", "done", "dropped"] as const).map((g) => (
          <StatusGlyph key={g} glyph={g} />
        ))}
      </>,
    );
    const names = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Backlog", "Todo", "In progress", "In review", "Done", "Dropped"]);
  });

  it("draws a later In-progress Status as In review", () => {
    expect(glyphFor("in_progress")).toBe("inprogress");
    expect(glyphFor("in_progress", 1)).toBe("inreview");
    expect(glyphFor("backlog")).toBe("backlog");
  });
});

describe("MemberAvatar", () => {
  it("takes initials as the board draws them", () => {
    expect(initials({ name: "Mai Tran", kind: "human" })).toBe("MT");
    expect(initials({ name: "tuongaz", kind: "human" })).toBe("T");
    expect(initials({ name: "builder-1", kind: "agent" })).toBe("B1");
    expect(initials({ name: "qa-bot", kind: "agent" })).toBe("QB");
    expect(initials({ name: "planner", kind: "agent" })).toBe("PL");
    expect(initials({ name: "reviewer", kind: "agent" })).toBe("RV");
  });

  it("marks an agent apart from a human", () => {
    render(
      <>
        <MemberAvatar member={{ name: "Mai Tran", kind: "human" }} />
        <MemberAvatar member={{ name: "builder-1", kind: "agent" }} size="lg" />
      </>,
    );
    const human = screen.getByRole("img", { name: "Mai Tran" });
    const agent = screen.getByRole("img", { name: "builder-1 (agent)" });
    expect(human).toHaveClass("rounded-full");
    expect(agent).not.toHaveClass("rounded-full");
    expect(agent).toHaveClass("bg-agent-bg", "size-10");
  });
});

describe("HeartbeatMeter", () => {
  it("reads the time left, No expiry, or Lapsed", () => {
    render(
      <>
        <HeartbeatMeter claim={{ expires_at: inMinutes(15), heartbeat_timeout_seconds: 900 }} />
        <HeartbeatMeter claim={{ expires_at: inMinutes(10), heartbeat_timeout_seconds: 900 }} variant="compact" />
        <HeartbeatMeter claim={{}} />
        <HeartbeatMeter claim={{ expires_at: inMinutes(-1), heartbeat_timeout_seconds: 2 }} />
      </>,
    );
    expect(screen.getByText("in 15 min")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("10 min")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    expect(screen.getByText("Lapsed")).toBeInTheDocument();
  });

  it("rounds up, so a holding Claim never reads 0", () => {
    expect(untilText(500)).toBe("1 s");
    expect(untilText(61_000)).toBe("2 min");
    expect(untilText(15 * 60_000)).toBe("15 min");
    expect(untilText(3 * 3600_000)).toBe("3 h");
  });
});

describe("Pill, Key, PropertiesRail, Timeline, EmptyState", () => {
  it("render their parts", () => {
    render(
      <MemoryRouter>
        <Pill tone="blocked">Blocked by WEB-8</Pill>
        <Key to="/tasks/WEB-3">WEB-3</Key>
        <PropertiesRail aria-label="Properties">
          <Property label="Held by">builder-1</Property>
        </PropertiesRail>
        <Timeline aria-label="Activity">
          <TimelineDay>Today</TimelineDay>
          <TimelineRow who={<MemberAvatar member={{ name: "planner", kind: "agent" }} />} when="22:18">
            <b>planner</b> filed the Task
          </TimelineRow>
        </Timeline>
        <EmptyState title="No Tasks">File one.</EmptyState>
      </MemoryRouter>,
    );
    expect(screen.getByText("Blocked by WEB-8")).toHaveAttribute("data-tone", "blocked");
    expect(screen.getByRole("link", { name: "WEB-3" })).toHaveAttribute("href", "/tasks/WEB-3");
    expect(screen.getByRole("term")).toHaveTextContent("Held by");
    expect(screen.getByRole("definition")).toHaveTextContent("builder-1");
    expect(screen.getByRole("list", { name: "Activity" })).toHaveTextContent("planner filed the Task22:18");
    expect(screen.getByRole("heading", { name: "No Tasks" })).toBeInTheDocument();
  });
});

describe("Peek", () => {
  it("is a labelled sheet with its menu and a close button", async () => {
    const onOpenChange = vi.fn();
    const onDrop = vi.fn();
    render(
      <Peek open onOpenChange={onOpenChange} label="WEB-3 Build the cart page" heading="WEB-3" menu={<DropdownMenuItem onSelect={onDrop}>Drop</DropdownMenuItem>}>
        body
      </Peek>,
    );
    const sheet = screen.getByRole("dialog", { name: "WEB-3 Build the cart page" });
    expect(sheet).toHaveTextContent("body");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Drop" }));
    expect(onDrop).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("FormDialog", () => {
  it("lays out labelled fields, submits, cancels and shows a refusal", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <FormDialog open onOpenChange={onOpenChange} title="New Member" submitLabel="Create Member" onSubmit={onSubmit} error={new Error("taken")}>
        <FormRows>
          <FormRow label="Name" htmlFor="name">
            <Input id="name" />
          </FormRow>
        </FormRows>
      </FormDialog>,
    );
    expect(screen.getByRole("dialog", { name: "New Member" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Mai Tran{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("network taken");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("InfoPopover", () => {
  it("opens its explanation from the ⓘ", async () => {
    render(<InfoPopover label="About Statuses">A Task in a Backlog Status is not takeable.</InfoPopover>);
    expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "About Statuses" }));
    expect(await screen.findByText(/not takeable/)).toBeInTheDocument();
  });
});

describe("search matching", () => {
  const records = [
    { key: "WEB-3", title: "Build the cart page" },
    { key: "WEB-30", title: "Search" },
    { key: "WEB-6", title: "Review the cart page" },
  ];
  it("puts the key first, then keys starting with it, then titles with every word", () => {
    expect(matchRecords("web-3", records).map((r) => r.key)).toEqual(["WEB-3", "WEB-30"]);
    expect(matchRecords("cart page", records).map((r) => r.key)).toEqual(["WEB-3", "WEB-6"]);
    expect(matchRecords("  ", records)).toEqual([]);
  });
});
