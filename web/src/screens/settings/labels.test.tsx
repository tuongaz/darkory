import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Label } from "@/api/client";
import { json, mockApi, type Handler } from "@/test/api";
import { ada, bob, bug, clientX, label, me, ops, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { nextColor } from "./model";

const urgent = label("urgent", "#eb5757");

/** The Labels as the server keeps them: a write changes what the next read returns. */
function routes(org: Label[], own: Label[] = [], extra: Record<string, Handler> = {}): Record<string, Handler> {
  const labels = new Map([...org, ...own].map((l) => [l.id, l]));
  const list = (project?: string) => ({ items: [...labels.values()].filter((l) => l.project_id === project).sort((a, b) => a.name.localeCompare(b.name)) });
  return {
    ...signedIn(),
    "GET /v1/labels": () => list(undefined),
    "GET /v1/projects/:project/labels": ({ params }) => list([web, ops].find((p) => p.key === params.project)?.id),
    "POST /v1/labels": ({ body }) => {
      const l = label((body as Label).name, (body as Label).color);
      labels.set(l.id, l);
      return json(201, l);
    },
    "POST /v1/projects/:project/labels": ({ body }) => {
      const l = label((body as Label).name, (body as Label).color, { project_id: web.id });
      labels.set(l.id, l);
      return json(201, l);
    },
    "PATCH /v1/labels/:label": ({ params, body }) => {
      const l = { ...labels.get(params.label)!, ...(body as Partial<Label>) };
      labels.set(l.id, l);
      return l;
    },
    "DELETE /v1/labels/:label": ({ params }) => {
      labels.delete(params.label);
      return undefined;
    },
    "GET /v1/tasks": ({ query }) => ({ items: query.getAll("filter").includes(`label:in:${bug.id}`) ? [task(1), task(2, { state: "done" })] : [] }),
    ...extra,
  };
}

const writes = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method !== "GET");

describe("Settings › Organisation › Labels", () => {
  it("lists the Labels and makes a new one, coloured the first of the set no Label has", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([bug, urgent]));
    renderApp("/settings/organisation/labels");
    const table = await screen.findByRole("table", { name: "Labels" });
    expect(within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label")).filter(Boolean)).toEqual(["bug", "urgent"]);

    await user.click(screen.getByRole("button", { name: "New Label" }));
    const row = within(table).getByRole("row", { name: "New Label" });
    await user.type(within(row).getByRole("textbox", { name: "Name of the new Label" }), "flaky{Enter}");
    await waitFor(() => expect(within(table).getByRole("row", { name: "flaky" })).toBeInTheDocument());
    expect(writes(api.calls)).toEqual([expect.objectContaining({ method: "POST", path: "/v1/labels", body: { name: "flaky", color: nextColor([bug.color, urgent.color]) } })]);
    expect(within(table).queryByRole("row", { name: "New Label" })).not.toBeInTheDocument();
  });

  it("says in words a name another Label has, ignoring case, and sends nothing", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([bug]));
    renderApp("/settings/organisation/labels");
    await user.click(await screen.findByRole("button", { name: "New Label" }));
    await user.type(screen.getByRole("textbox", { name: "Name of the new Label" }), "BUG{Enter}");
    expect(await screen.findByText("The Organisation has a Label bug.")).toBeInTheDocument();
    expect(writes(api.calls)).toEqual([]);
  });

  it("renames a Label in place and recolours it from its dot, one field per write", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([bug]));
    renderApp("/settings/organisation/labels");
    await user.click(await screen.findByRole("button", { name: "Rename bug" }));
    const name = screen.getByRole("textbox", { name: "Name of bug" });
    await user.clear(name);
    await user.type(name, "defect{Enter}");
    const row = await screen.findByRole("row", { name: "defect" });

    await user.click(within(row).getByRole("button", { name: "Colour of defect" }));
    await user.click(await screen.findByRole("radio", { name: "#4cb782" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(2));

    // A colour typed must be #rrggbb.
    await user.click(within(await screen.findByRole("row", { name: "defect" })).getByRole("button", { name: "Colour of defect" }));
    const typed = await screen.findByRole("textbox", { name: "Colour as #rrggbb" });
    await user.clear(typed);
    await user.type(typed, "teal");
    expect(screen.getByRole("button", { name: "Use this colour" })).toBeDisabled();
    await user.clear(typed);
    await user.type(typed, "#123abc{Enter}");
    await waitFor(() => expect(writes(api.calls)).toHaveLength(3));

    expect(writes(api.calls).map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", "/v1/labels/l-bug", { name: "defect" }],
      ["PATCH", "/v1/labels/l-bug", { color: "#4cb782" }],
      ["PATCH", "/v1/labels/l-bug", { color: "#123abc" }],
    ]);
  });

  it("Delete asks first and says how many Tasks, open and ended, stop carrying it", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([bug, urgent]));
    renderApp("/settings/organisation/labels");
    await user.click(await screen.findByRole("button", { name: "More for bug" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete bug?" });
    expect(await within(confirm).findByText("from 2 Tasks, open and ended")).toBeInTheDocument();
    expect(writes(api.calls)).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("row", { name: "bug" })).not.toBeInTheDocument());
    expect(writes(api.calls).map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /v1/labels/l-bug"]);
  });

  it("says what a Label is when there is none", async () => {
    mockApi(routes([]));
    renderApp("/settings/organisation/labels");
    expect(await screen.findByRole("heading", { name: "No Labels yet" })).toBeInTheDocument();
  });
});

describe("Settings › a Project › Labels", () => {
  // bob is in WEB, not in OPS.
  const asBob = (org: Label[], own: Label[] = []) =>
    routes(org, own, {
      "GET /v1/me": me(bob),
      "GET /v1/projects/:project": ({ params }) => (params.project === "WEB" ? { project: web, members: [ada, bob] } : { project: ops, members: [ada] }),
    });

  it("lets a Member of the Project define its own Labels, with the Organisation's under them", async () => {
    const user = userEvent.setup();
    const api = mockApi(asBob([bug], [clientX]));
    renderApp("/settings/projects/WEB/labels");
    const table = await screen.findByRole("table", { name: "Labels" });
    expect(within(table).getByRole("row", { name: "client-x" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "The Organisation's Labels" })).getByText("bug")).toBeInTheDocument();
    // Only an admin is pointed at the Organisation's.
    expect(screen.queryByRole("link", { name: "Change in Organisation" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "New Label" }));
    const name = screen.getByRole("textbox", { name: "Name of the new Label" });
    await user.type(name, "Bug{Enter}");
    expect(await screen.findByText("The Organisation has a Label bug.")).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "client-y{Enter}");
    await waitFor(() => expect(within(table).getByRole("row", { name: "client-y" })).toBeInTheDocument());
    expect(writes(api.calls).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/projects/WEB/labels"]);
  });

  it("shows another Project's Labels to a Member outside it, without changing them", async () => {
    mockApi(asBob([bug], [{ ...clientX, project_id: ops.id }]));
    renderApp("/settings/projects/OPS/labels");
    const table = await screen.findByRole("table", { name: "Labels" });
    expect(within(table).getByRole("row", { name: "client-x" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "New Label" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "More for client-x" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename client-x" })).not.toBeInTheDocument();
  });
});
