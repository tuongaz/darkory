import { render, screen, waitFor } from "@testing-library/react";
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
import { InfoTip } from "./InfoTip";
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

  it("rings an agent thick in the AI gradient at every size, inside the same box as a human's", () => {
    render(
      <>
        {(["sm", "md", "lg"] as const).map((size) => (
          <MemberAvatar key={`h-${size}`} member={{ name: `ada-${size}`, kind: "human" }} size={size} />
        ))}
        {(["sm", "md", "lg"] as const).map((size) => (
          <MemberAvatar key={`a-${size}`} member={{ name: `bot-${size}`, kind: "agent" }} size={size} />
        ))}
      </>,
    );
    // The same box for both kinds at a size: the ring is drawn inside it.
    for (const [size, box] of [["sm", "size-5"], ["md", "size-7"], ["lg", "size-10"]]) {
      const human = screen.getByRole("img", { name: `ada-${size}` });
      const agent = screen.getByRole("img", { name: `bot-${size} (agent)` });
      expect(human).toHaveClass(box);
      expect(agent).toHaveClass(box);
      expect(agent.dataset.size).toBe(size);
    }
    // The rules (jsdom draws nothing): a human's hairline; an agent's ring about an eighth of the
    // mark across, in the full-strength AI gradient, a 1px gap inside it and the face shrunk within;
    // a live Claim changes how the ring is drawn, never its width.
    const css = readFileSync("src/globals.css", "utf8");
    const rule = (selector: string) => css.match(new RegExp(`\\n  ${selector.replace(/[[\]".=:]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".avatar-tint")).toMatch(/border: 1px solid transparent;/);
    expect(rule(".avatar-tint")).toMatch(/--mark-gap: 1px;/);
    const agent = rule('.avatar-tint[data-kind="agent"]');
    expect(agent).toMatch(/--mark-line: conic-gradient\(from var\(--spin\), var\(--agent-ring-stops\)\);/);
    expect(agent).toMatch(/padding: calc\(var\(--mark-ring\) \+ var\(--mark-gap\)\);/);
    expect(agent).toMatch(/content-box/);
    const ring = rule('.avatar-tint[data-kind="agent"]::before');
    expect(ring).toMatch(/inset: 0;/);
    expect(ring).toMatch(/background: var\(--mark-line\);/);
    expect(ring).toMatch(/mask: radial-gradient\(closest-side, transparent calc\(100% - var\(--mark-ring\)/);
    const width = (selector: string) => parseFloat(rule(selector).match(/--mark-ring: ([\d.]+)px;/)?.[1] ?? "0");
    for (const [selector, across] of [[".avatar-tint", 20], ['.avatar-tint[data-size="md"]', 28], ['.avatar-tint[data-size="lg"]', 40], ['.avatar-tint[data-size="xl"]', 96]] as const) {
      expect(width(selector) / across, selector).toBeGreaterThanOrEqual(0.12);
    }
    for (const state of ["running", "waiting", "stalled", "ending"]) expect(rule(`.avatar-tint[data-working="${state}"]`)).not.toMatch(/border-width|padding/);
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

describe("InfoTip", () => {
  it("is named About and its label, and opens its explanation on a click, until Esc", async () => {
    render(<InfoTip label="Step">A Task at a hold is not takeable.</InfoTip>);
    const button = screen.getByRole("button", { name: "About Step" });
    expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByText(/not takeable/)).toBeInTheDocument();
    // Pinned: the pointer leaving does not close it.
    await userEvent.unhover(button);
    expect(screen.getByText(/not takeable/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument());
  });

  it("opens on hover and closes when the pointer leaves", async () => {
    render(<InfoTip label="Step">A Task at a hold is not takeable.</InfoTip>);
    const button = screen.getByRole("button", { name: "About Step" });
    await userEvent.hover(button);
    expect(await screen.findByText(/not takeable/)).toBeInTheDocument();
    await userEvent.unhover(button);
    await waitFor(() => expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument());
  });

  it("opens when the keyboard reaches it, leaving the focus where it is", async () => {
    render(
      <>
        <input aria-label="Before" />
        <InfoTip label="Step">A Task at a hold is not takeable.</InfoTip>
      </>,
    );
    screen.getByLabelText("Before").focus();
    await userEvent.tab();
    const button = screen.getByRole("button", { name: "About Step" });
    expect(await screen.findByText(/not takeable/)).toBeInTheDocument();
    expect(button).toHaveFocus();
    await userEvent.tab();
    await waitFor(() => expect(screen.queryByText(/not takeable/)).not.toBeInTheDocument());
  });

  it("moves nothing: the ⓘ is a fixed square and its explanation floats outside the label's line", async () => {
    const { container } = render(
      <span data-testid="line" className="flex items-center gap-1">
        <label htmlFor="x">Step</label>
        <InfoTip label="Step">A Task at a hold is not takeable.</InfoTip>
        <input id="x" />
      </span>,
    );
    const line = screen.getByTestId("line");
    const shape = [...line.children].map((e) => e.tagName);
    const button = screen.getByRole("button", { name: "About Step" });
    const classes = button.className;
    expect(button).toHaveClass("size-4", "flex-none");
    // Outside the <label>: the field's name stays the label's words.
    expect(screen.getByRole("textbox")).toHaveAccessibleName("Step");
    await userEvent.click(button);
    const tip = await screen.findByText(/not takeable/);
    expect(container).not.toContainElement(tip);
    // The line holds only what it held, and the ⓘ keeps its classes: opening adds no box to it.
    expect([...line.children].map((e) => e.tagName)).toEqual(shape);
    expect(button.className).toBe(classes);
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
