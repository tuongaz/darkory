// The Filter of a list of Tasks, wired as a page wires it: the axes' values read for the list's
// Projects, the list narrowed through `matches`, old links rewritten, and Views on /v1/views.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import type { Project, Task, View } from "@/api/client";
import { LiveActivity } from "@/api/live";
import { useTasks } from "@/api/queries";
import { Providers } from "@/App";
import { MeContext } from "@/me";
import { newQueryClient } from "@/queryClient";
import { mockApi, refuse, type Call, type Handler } from "@/test/api";
import { ada, bug, builder, me, ops, signedIn, step, task, web } from "@/test/fixtures";
import { FilterChipRow, FilterMenuButton } from "./FilterBar";
import { useSavedViews } from "./useSavedViews";
import { useTaskFilter } from "./useTaskFilter";
import { AppliedView, ViewsMenu } from "./ViewsMenu";

function TaskList({ projects, across }: { projects: Project[]; across?: boolean }) {
  const tasks = useTasks(across ? {} : { project: projects[0].key }).data;
  const filter = useTaskFilter({ projects, tasks, acrossProjects: across });
  const views = useSavedViews({
    entity: "tasks",
    project: across ? undefined : projects[0].key,
    fields: filter.fields,
    pills: filter.pills,
    rest: { sort: "rank", display: { layout: "list" } },
  });
  const bar = { ...filter.bar, onClearAll: views.clear };
  const { search } = useLocation();
  return (
    <>
      <ViewsMenu {...views} />
      <FilterMenuButton {...bar} open={filter.open} onOpenChange={filter.setOpen} />
      <FilterChipRow {...bar} leading={views.applied && <AppliedView name={views.applied.name} edited={views.edited} />} />
      <ul aria-label="Tasks">
        {(tasks ?? []).filter(filter.matches).map((t) => (
          <li key={t.id}>{t.key}</li>
        ))}
      </ul>
      <output aria-label="Address">{decodeURIComponent(search)}</output>
    </>
  );
}

function renderList(path: string, projects: Project[] = [web], across = false) {
  render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={[path]}>
        <MeContext.Provider value={me(ada)}>
          <TaskList projects={projects} across={across} />
        </MeContext.Provider>
      </MemoryRouter>
    </Providers>,
  );
}

const cart = task(3, { title: "Build the cart page", labels: [bug.id] });
const review = task(5, { title: "Review discount codes", step_id: step.review, skill_id: "s-review" });
const opsTask: Task = task(7, { id: "k-ops-7", key: "OPS-7", project_id: ops.id, step_id: `ops-${step.build}`, title: "Rotate keys" });

function routes(views: View[] = [], extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...signedIn(),
    "GET /v1/tasks": ({ query }) => ({ items: query.get("project") === "WEB" ? [cart, review] : [cart, review, opsTask] }),
    "GET /v1/labels": { items: [bug] },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/views": () => ({ items: views }),
    ...extra,
  };
}

const keysShown = () => within(screen.getByRole("list", { name: "Tasks" })).queryAllByRole("listitem").map((li) => li.textContent);
const address = () => screen.getByRole("status", { name: "Address" }).textContent ?? "";

beforeEach(() => localStorage.clear());

describe("a list's Filter", () => {
  it("offers the Project's Steps with their Skill and narrows the list by the one picked", async () => {
    mockApi(routes());
    renderList("/");
    await waitFor(() => expect(keysShown()).toEqual(["WEB-3", "WEB-5"]));
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.click(await screen.findByRole("option", { name: /Step/ }));
    const review = await screen.findByRole("option", { name: /Review/ });
    expect(review).toHaveTextContent("review");
    await userEvent.click(review);
    await waitFor(() => expect(keysShown()).toEqual(["WEB-5"]));
    expect(address()).toContain(`filter.tasks=step:is:${step.review}`);
  });

  it("reads Labels as the Organisation's for every Project", async () => {
    mockApi(routes());
    renderList(`/?filter.tasks=${encodeURIComponent(`label:is:${bug.id}`)}`);
    await waitFor(() => expect(keysShown()).toEqual(["WEB-3"]));
    expect(screen.getByRole("button", { name: "Label: bug" })).toBeInTheDocument();
  });

  it("across Projects offers Project and groups the Steps under each Project's name", async () => {
    mockApi(routes());
    renderList("/", [ops, web], true);
    await waitFor(() => expect(keysShown()).toEqual(["WEB-3", "WEB-5", "OPS-7"]));
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.click(await screen.findByRole("option", { name: /Project/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Ops/ }));
    await waitFor(() => expect(keysShown()).toEqual(["OPS-7"]));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Filter, 1 set" }));
    await userEvent.click(await screen.findByRole("option", { name: /Step/ }));
    const menu = await screen.findByRole("dialog", { name: "Filters" });
    await waitFor(() => expect([...menu.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)).toEqual(["Ops", "Web"]));
  });

  it("rewrites an old link's names into tokens and drops a Status and a Team", async () => {
    mockApi(routes());
    renderList("/?skill=engineer&holder=builder&status=st-todo&team=WEB&view=board");
    await waitFor(() => expect(address()).toBe(`?view=board&filter.tasks=step:is:${step.build}&filter.tasks=holder:is:${builder.id}`));
  });
});

const saved: View = {
  id: "v-1",
  entity: "tasks",
  project_id: web.id,
  name: "Reviews",
  filters: [`step:is:${step.review}`],
  sort: "rank",
  display: { layout: "list" },
  created_at: "2026-10-07T00:00:00Z",
  updated_at: "2026-10-07T00:00:00Z",
};

describe("Views", () => {
  it("lists the Project's Views, applies one, says edited once the pills change, and Reset leaves it", async () => {
    const { calls } = mockApi(routes([saved]));
    renderList("/");
    await waitFor(() => expect(keysShown()).toHaveLength(2));
    expect(calls.find((c: Call) => c.path === "/v1/views")?.query.get("project")).toBe("WEB");
    await userEvent.click(screen.getByRole("button", { name: "Views" }));
    await userEvent.click(await screen.findByRole("option", { name: /Reviews/ }));
    await waitFor(() => expect(keysShown()).toEqual(["WEB-5"]));
    const chips = screen.getByRole("toolbar", { name: "Filters" });
    expect(within(chips).getByLabelText("View Reviews")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Blocked/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Not blocked" }));
    expect(await within(screen.getByRole("toolbar", { name: "Filters" })).findByLabelText("View Reviews, edited")).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole("toolbar", { name: "Filters" })).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(keysShown()).toHaveLength(2));
    expect(address()).toBe("");
  });

  it("saves the pills under a name for the Project, and words a name already taken", async () => {
    const { calls } = mockApi(
      routes([saved], {
        "POST /v1/views": ({ body }) => ((body as { name: string }).name === "Reviews" ? refuse(409, "conflict", "taken") : { ...saved, id: "v-2", name: "Mine" }),
      }),
    );
    renderList(`/?filter.tasks=${encodeURIComponent(`step:is:${step.build}`)}`);
    await waitFor(() => expect(keysShown()).toEqual(["WEB-3"]));
    await userEvent.click(screen.getByRole("button", { name: "Views" }));
    await userEvent.click(await screen.findByRole("button", { name: /Save as view/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "View name" }), "Reviews{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a View named “Reviews” for this list.");
    const post = calls.find((c: Call) => c.method === "POST" && c.path === "/v1/views");
    expect(post?.body).toMatchObject({ entity: "tasks", project: "WEB", name: "Reviews", filters: [`step:is:${step.build}`], sort: "rank" });
  });
});
