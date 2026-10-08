import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { matchRecords } from "@/app/search";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { initials, shortSessionId, tintOf } from "@/lib/members";
import { agoText, untilText } from "@/lib/time";
import { EmptyState } from "./EmptyState";
import { FormDialog, FormRow, FormRows } from "./FormDialog";
import { HeartbeatMeter } from "./HeartbeatMeter";
import { InfoPopover } from "./InfoPopover";
import { Key } from "./Key";
import { MemberAvatar } from "./MemberAvatar";
import { Peek } from "./Peek";
import { Pill } from "./Pill";
import { PropertiesRail, Property } from "./PropertiesRail";
import { RunnerSessionBadge } from "./RunnerSessionBadge";
import { ProjectMark } from "./ProjectMark";
import { Timeline, TimelineDay, TimelineRow } from "./Timeline";
import { WorkGlyph } from "./WorkGlyph";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("WorkGlyph", () => {
  it("names each glyph, and marks a working one by its holder's kind and session", () => {
    render(
      <>
        <WorkGlyph glyph={{ glyph: "waiting" }} />
        <WorkGlyph glyph={{ glyph: "working", holderKind: "agent" }} />
        <WorkGlyph glyph={{ glyph: "working", holderKind: "agent", session: "waiting" }} />
        <WorkGlyph glyph={{ glyph: "working", holderKind: "human" }} />
        <WorkGlyph glyph={{ glyph: "blocked" }} />
        <WorkGlyph glyph={{ glyph: "hold" }} />
        <WorkGlyph glyph={{ glyph: "done" }} />
        <WorkGlyph glyph={{ glyph: "dropped" }} />
        <WorkGlyph glyph={{ glyph: "parent", done: 3, dropped: 1, total: 5 }} />
      </>,
    );
    const glyphs = screen.getAllByRole("img");
    expect(glyphs.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Waiting",
      "Working",
      "Working, its session waiting",
      "Working",
      "Blocked",
      "At a hold",
      "Done",
      "Dropped",
      "3 of 5 Subtasks done, 1 dropped",
    ]);
    // An agent with no session named turns, as running; a human's ring has no session.
    expect(glyphs[1].dataset.session).toBe("running");
    expect(glyphs[2].dataset.session).toBe("waiting");
    expect(glyphs[3].dataset.holder).toBe("human");
    expect(glyphs[3]).not.toHaveAttribute("data-session");
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

  it("draws every Member round, an agent apart by its kind (the gradient ring in globals.css)", () => {
    render(
      <>
        <MemberAvatar member={{ name: "Mai Tran", kind: "human" }} />
        <MemberAvatar member={{ name: "builder-1", kind: "agent" }} size="lg" />
      </>,
    );
    const human = screen.getByRole("img", { name: "Mai Tran" });
    const agent = screen.getByRole("img", { name: "builder-1 (agent)" });
    expect(human).toHaveClass("avatar-tint", "rounded-full");
    expect(agent).toHaveClass("avatar-tint", "rounded-full", "size-10");
    expect(human.dataset.kind).toBe("human");
    expect(agent.dataset.kind).toBe("agent");
    expect(agent).not.toHaveAttribute("data-working");
  });

  it("says that a standalone mark's Member works, and how", () => {
    render(
      <>
        <MemberAvatar member={{ name: "builder-1", kind: "agent" }} working="running" />
        <MemberAvatar member={{ name: "qa-bot", kind: "agent" }} working="stalled" />
        <MemberAvatar member={{ name: "Mai Tran", kind: "human" }} working="held" />
      </>,
    );
    expect(screen.getByRole("img", { name: "builder-1 (agent), working" }).dataset.working).toBe("running");
    expect(screen.getByRole("img", { name: "qa-bot (agent), working, its session stalled" }).dataset.working).toBe("stalled");
    expect(screen.getByRole("img", { name: "Mai Tran, working" }).dataset.working).toBe("held");
  });

  it("tints each avatar by its Member's name, so the same initials still differ", () => {
    render(
      <>
        <MemberAvatar member={{ name: "retro", kind: "agent" }} />
        <MemberAvatar member={{ name: "reviewer-tax", kind: "agent" }} />
        <MemberAvatar member={{ name: "retro", kind: "human" }} />
      </>,
    );
    const [retro, reviewer, human] = screen.getAllByRole("img");
    expect(retro).toHaveTextContent("RT");
    expect(reviewer).toHaveTextContent("RT");
    expect(retro.dataset.tint).not.toBe(reviewer.dataset.tint);
    expect(retro).toHaveClass(`tint-${tintOf("retro")}`);
    // The tint follows the name, whatever the kind.
    expect(human.dataset.tint).toBe(retro.dataset.tint);
  });
});

describe("SessionId", () => {
  it("shows the last 8 characters, where UUIDv7 ids of one day differ, and keeps a short id whole", () => {
    expect(shortSessionId("01a11403-53a4-7b2e-9c1d-3b4dcbb772f3")).toBe("…cbb772f3");
    expect(shortSessionId("sess-1")).toBe("sess-1");
  });
});

describe("HeartbeatMeter", () => {
  it("reads the time left, No expiry, or Lapsed", () => {
    render(
      <>
        <HeartbeatMeter claim={{ expires_at: inMinutes(15), heartbeat_timeout_seconds: 900 }} />
        <HeartbeatMeter claim={{ expires_at: inMinutes(10), heartbeat_timeout_seconds: 900 }} variant="compact" />
        <HeartbeatMeter claim={{ expires_at: new Date(Date.now() + 36_000).toISOString(), heartbeat_timeout_seconds: 60 }} variant="compact" />
        <HeartbeatMeter claim={{}} />
        <HeartbeatMeter claim={{ expires_at: inMinutes(-1), heartbeat_timeout_seconds: 2 }} />
      </>,
    );
    expect(screen.getByText("lapses in 15 min")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    // A card's compact meter reads as the Agents table's does, and says when on hover.
    expect(screen.getByText("lapses in 10 min")).toHaveAttribute("title", expect.stringMatching(/^Lapses at .+ unless a Heartbeat arrives$/));
    expect(screen.getByText("lapses in 36 s")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    expect(screen.getByText("Lapsed")).toBeInTheDocument();
  });

  it("rounds up, so a holding Claim never reads 0", () => {
    expect(untilText(500)).toBe("1 s");
    expect(untilText(61_000)).toBe("2 min");
    expect(untilText(15 * 60_000)).toBe("15 min");
    expect(untilText(3 * 3600_000)).toBe("3 h");
  });

  it("says how long ago, short enough for a narrow column", () => {
    expect(agoText(-200)).toBe("0 s ago");
    expect(agoText(40_000)).toBe("40 s ago");
    expect(agoText(3 * 60_000)).toBe("3 min ago");
    expect(agoText(5 * 3600_000)).toBe("5 h ago");
    expect(agoText(3 * 86400_000)).toBe("3 d ago");
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

describe("RunnerSessionBadge", () => {
  it("says the session's state, since when and where, in one line", () => {
    const started = new Date(2026, 9, 7, 4, 25).toISOString();
    const base = { task_id: "k-12", member_id: "m-builder", session_id: "s", host: "mac-mini", started_at: started, state_since: started, log_path: "/x" };
    const { rerender, container } = render(<RunnerSessionBadge session={{ ...base, state: "running" }} />);
    expect(container).toHaveTextContent("SessionRunningstarted 04:25 · mac-mini");
    expect(screen.getByText("Running")).toHaveAttribute("data-tone", "done");
    for (const [state, name, tone] of [
      ["waiting", "Waiting", "claimed"],
      ["stalled", "Stalled", "blocked"],
      ["ending", "Ending", "dropped"],
    ] as const) {
      rerender(<RunnerSessionBadge session={{ ...base, state }} bare />);
      expect(container).toHaveTextContent(`${name}started 04:25 · mac-mini`);
      expect(screen.getByText(name)).toHaveAttribute("data-tone", tone);
    }
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

describe("ProjectMark", () => {
  it("letters a Project by its name, coloured by its key so it keeps its colour", () => {
    render(
      <>
        <ProjectMark project={{ key: "WEB", name: "web app" }} />
        <ProjectMark project={{ key: "WEB", name: "Storefront" }} size="lg" />
      </>,
    );
    const [a, b] = document.querySelectorAll("[aria-hidden]");
    expect(a).toHaveTextContent("W");
    expect(b).toHaveTextContent("S");
    const fill = (el: Element) => [...el.classList].find((c) => c.startsWith("bg-chart-"));
    expect(fill(a)).toBeDefined();
    expect(fill(a)).toBe(fill(b));
  });
});

describe("InfoPopover", () => {
  it("opens its explanation from the ⓘ", async () => {
    render(<InfoPopover label="About holds">A Task at a hold is not takeable.</InfoPopover>);
    expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "About holds" }));
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
