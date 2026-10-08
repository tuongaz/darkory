import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LiveActivity } from "@/api/live";
import { Providers } from "@/App";
import { newQueryClient } from "@/queryClient";
import { mockApi } from "@/test/api";
import { ada, bob, builder, engineer, memberDetail, review, signedIn, task, web } from "@/test/fixtures";
import { MemberAvatar } from "./MemberAvatar";

function wrap(node: ReactNode) {
  return render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={["/projects/WEB/workflow"]}>{node}</MemoryRouter>
    </Providers>,
  );
}

/** The open hover card, once its 300 ms delay has passed. */
function findCard(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLElement>('[data-slot="hover-card-content"]');
      if (!el) throw new Error("no card open");
      return el;
    },
    { timeout: 2000 },
  );
}

async function openCard(name: RegExp) {
  await userEvent.hover(screen.getByRole("img", { name }));
  return within(await findCard());
}

const builderAgent = { ...builder, agent: { command: "claude", args: [], model: "claude-opus-5-5", env: {}, unattended: true, paused: false } };

describe("MemberCard", () => {
  it("shows an agent's kind, Skills, model, manager and Projects, and that it is not working", async () => {
    const api = mockApi({
      ...signedIn(ada),
      "GET /v1/members": { items: [ada, bob, builderAgent] },
      "GET /v1/members/:member": memberDetail(builderAgent, { skills: [engineer, review] }),
    });
    wrap(<MemberAvatar member={builderAgent} />);
    const c = await openCard(/^builder \(agent\)$/);
    expect(await c.findByText("builder")).toBeInTheDocument();
    expect(c.getByText("Agent")).toBeInTheDocument();
    expect(c.getByText("engineer")).toBeInTheDocument();
    expect(c.getByText("review")).toBeInTheDocument();
    expect(c.getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(await c.findByText("ada")).toBeInTheDocument(); // Reports to
    expect(c.getByText("Web")).toBeInTheDocument();
    expect(await c.findByText("Not working on anything")).toBeInTheDocument();
    // An admin reads: the card links to the agent's page in Settings.
    expect(await c.findByRole("link", { name: "Open profile" })).toHaveAttribute("href", "/settings/organisation/agents/builder");
    // One read of the Member, by id.
    expect(api.calls.filter((x) => x.path === `/v1/members/${builder.id}`)).toHaveLength(1);
  });

  it("shows the Member's Avatar in the mark and in the card's large mark", async () => {
    const withFace = { ...builderAgent, avatar_file_id: "f5" };
    mockApi({
      ...signedIn(ada),
      "GET /v1/members": { items: [ada, bob, withFace] },
      "GET /v1/members/:member": memberDetail(withFace, { skills: [engineer] }),
    });
    wrap(<MemberAvatar member={withFace} />);
    expect(screen.getByRole("img", { name: /^builder \(agent\)$/ })).toHaveAttribute("data-avatar", "image");
    const c = await openCard(/^builder \(agent\)$/);
    await c.findByText("engineer");
    const big = c.getByRole("img", { name: /^builder \(agent\)/ });
    expect(big).toHaveAttribute("data-avatar", "image");
    expect(big.querySelector("img")).toHaveAttribute("src", "/v1/files/f5/content");
  });

  it("shows a human's reports and Admin, and no profile link for a non-admin", async () => {
    mockApi({
      ...signedIn(bob),
      "GET /v1/members/:member": memberDetail(ada, { reports: [bob, builder] }),
    });
    wrap(<MemberAvatar member={ada} />);
    const c = await openCard(/^ada$/);
    expect(await c.findByText("Human")).toBeInTheDocument();
    expect(c.getByText("Admin")).toBeInTheDocument();
    expect(c.getByText("Reports")).toBeInTheDocument();
    expect(c.getByText(/bob, builder/)).toBeInTheDocument();
    expect(c.queryByText("Model")).not.toBeInTheDocument();
    await c.findByText("Not working on anything");
    expect(c.queryByRole("link", { name: "Open profile" })).not.toBeInTheDocument();
  });

  it("opens on keyboard focus", async () => {
    mockApi(signedIn(ada));
    wrap(<MemberAvatar member={bob} />);
    const mark = screen.getByRole("img", { name: "bob" });
    expect(mark).toHaveAttribute("tabindex", "0");
    await userEvent.tab();
    expect(mark).toHaveFocus();
    const c = within(await findCard());
    expect(await c.findByText("Human")).toBeInTheDocument();
  });

  it("shows the Task an agent holds and its session's state for how long", async () => {
    const started = new Date(Date.now() - 20 * 60_000).toISOString();
    const since = new Date(Date.now() - 4 * 60_000 - 5_000).toISOString();
    const held = task(12, {
      title: "Add login",
      claim: { id: "c-1", task_id: "k-12", holder_id: builder.id, session_id: "s-1", started_at: started },
    });
    mockApi({
      ...signedIn(ada),
      "GET /v1/tasks": { items: [held, task(13)] },
      "GET /v1/runner/sessions": {
        runner: true,
        items: [{ task_id: held.id, member_id: builder.id, session_id: "s-1", host: "mac", started_at: started, state: "waiting", state_since: since, log_path: "/tmp/x" }],
      },
    });
    wrap(<MemberAvatar member={builder} />);
    const c = await openCard(/^builder \(agent\)$/);
    const link = await c.findByRole("link", { name: /WEB-12/ });
    expect(link).toHaveTextContent("Add login");
    expect(link.getAttribute("href")).toContain("task=WEB-12");
    expect(await c.findByText("Working, its Shift waiting for 4m")).toBeInTheDocument();
  });

  it("opens nothing for a mark in a picker row, and stays off the tab order inside a button", async () => {
    mockApi(signedIn(ada));
    wrap(
      <>
        <div role="option" aria-selected={false}>
          <MemberAvatar member={bob} />
        </div>
        <button type="button">
          <MemberAvatar member={ada} />
        </button>
      </>,
    );
    expect(screen.getByRole("img", { name: "ada" })).not.toHaveAttribute("tabindex");
    await userEvent.hover(screen.getByRole("img", { name: "bob" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
    // Inside a button, hover still opens it.
    await userEvent.hover(screen.getByRole("img", { name: "ada" }));
    expect(await findCard()).toBeInTheDocument();
  });

  it("is a plain mark with its name on hover when the Member has no id", () => {
    mockApi(signedIn(ada));
    wrap(<MemberAvatar member={{ name: web.name, kind: "human" }} />);
    expect(screen.getByRole("img", { name: "Web" })).toHaveAttribute("title", "Web");
  });
});

