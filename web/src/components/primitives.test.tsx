import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { matchRecords } from "@/app/search";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { initials, tintOf } from "@/lib/members";
import { markHues, projectHue } from "@/lib/projectHue";
import { SessionId } from "./CopyValue";
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
      "Working, its Shift waiting",
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
    expect(screen.getByRole("img", { name: "qa-bot (agent), working, its Shift stalled" }).dataset.working).toBe("stalled");
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
  it("shows the whole id, as the API writes it, in mono with a copy button", () => {
    render(<SessionId id="1CfppqWvwQruvqjgSEtEQt" />);
    expect(screen.getByText("1CfppqWvwQruvqjgSEtEQt")).toHaveClass("font-mono");
    expect(screen.getByRole("button", { name: "Copy Session id" })).toBeInTheDocument();
  });

  it("never breaks an id across lines; cut short only where it cannot fit, whole on hover", () => {
    render(<SessionId id="1CfppqWvwQruvqjgSEtEQt" />);
    const id = screen.getByText("1CfppqWvwQruvqjgSEtEQt");
    expect(id).toHaveClass("whitespace-nowrap", "truncate");
    expect(id).not.toHaveClass("break-all");
    expect(id).toHaveAttribute("title", "1CfppqWvwQruvqjgSEtEQt");
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
    expect(screen.getByText("lapses in 15m")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    // A card's compact meter reads as the Agents table's does, and says when on hover.
    expect(screen.getByText("lapses in 10m")).toHaveAttribute("title", expect.stringMatching(/^Lapses at .+ unless a Heartbeat arrives$/));
    expect(screen.getByText("lapses in 36s")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    expect(screen.getByText("Lapsed")).toBeInTheDocument();
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
    expect(container).toHaveTextContent("ShiftRunningstarted 04:25 · mac-mini");
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
  it("letters a Project by its name on the colour it stores, whatever its key", () => {
    render(
      <>
        <ProjectMark project={{ key: "WEB", name: "web app", color: 3 }} />
        <ProjectMark project={{ key: "OPS", name: "Storefront", color: 3 }} size="lg" />
        <ProjectMark project={{ key: "WEB", name: "web app", color: 9 }} />
      </>,
    );
    const [a, b, c] = document.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(a).toHaveTextContent("W");
    expect(b).toHaveTextContent("S");
    expect(a.dataset.hue).toBe(String(markHues[3]));
    expect(a.style.backgroundColor).toBe(b.style.backgroundColor);
    expect(c.dataset.hue).toBe(String(markHues[9]));
  });

  it("draws twelve stored colours as twelve hues, at least 30° apart", () => {
    render(
      <>
        {markHues.map((_, i) => (
          <ProjectMark key={i} project={{ key: `P${i}`, name: `P${i}`, color: i }} />
        ))}
      </>,
    );
    const hues = [...document.querySelectorAll<HTMLElement>("[aria-hidden]")].map((el) => Number(el.dataset.hue));
    expect(new Set(hues).size).toBe(12);
    const gaps = markHues.map((h, i) => (markHues[(i + 1) % markHues.length] - h + 360) % 360);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(30);
    expect(projectHue(12)).toBe(markHues[0]);
  });

  it("keeps a Project's hue in light and dark: the theme sets only lightness and strength", () => {
    render(<ProjectMark project={{ key: "SAM", name: "Sample", color: 6 }} />);
    const fill = (document.querySelector("[aria-hidden]") as HTMLElement).style.backgroundColor;
    expect(fill).toBe(`oklch(var(--mark-l) var(--mark-c) ${markHues[6]})`);
    const css = readFileSync("src/globals.css", "utf8"); // vitest runs in web/
    // The rule blocks that set the mark's tokens: one per theme, lightness and strength only.
    const blocks = [...css.matchAll(/^([^\s{}/*][^{}\n]*) \{([^{}]*)\}/gm)].filter(([, , body]) => /--mark-[lc]:/.test(body));
    expect(blocks.map(([, selector]) => selector)).toEqual([":root", ".dark"]);
    const value = (body: string, token: string) => body.match(new RegExp(`--mark-${token}: ([\\d.]+);`))?.[1];
    for (const [, , body] of blocks) expect([value(body, "l"), value(body, "c")]).not.toContain(undefined);
    expect(value(blocks[0][2], "l")).not.toBe(value(blocks[1][2], "l"));
    expect(css).not.toMatch(/--mark-h\b/);
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
