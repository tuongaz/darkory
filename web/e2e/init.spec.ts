import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall, type Install } from "./server";

// Scenario 11 of docs/build/model-v2-plan.md in the browser: a fresh `darkory init` with its roster
// (outside a git repository, so no Workspace) makes the Organisation, the builtin Skills,
// engineer and review, the agents, and MAIN on the default Workflow, and prints a login link; the
// Install checklist leads from there to the first Task. Init on each engine is e2e/init_test.go's
// (`make e2e`, `make e2e-pg`); this is the SQLite Install the web suite runs.
const shots = fileURLToPath(new URL("./screenshots/init/", import.meta.url));

let install: Install;

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  install = await startInstall({ roster: true });
});

test.afterAll(async () => {
  await install?.stop();
});

async function ask<T>(path: string): Promise<T> {
  const res = await fetch(`${install.base}${path}`, { headers: { Authorization: `Bearer ${install.token}`, "Darkory-Session": "e2e-init-ada" } });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

test("scenario 11: a fresh init's record, its printed link, and the checklist to the first Task", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await test.step("init says what it made", async () => {
    expect(install.init).toContain('Initialised the Organisation "E2E Organisation"');
    expect(install.init).toContain("First Member: ada (human, admin)");
    expect(install.init).toContain("Project MAIN (Main), on the default Workflow, holds ada and the agents below.");
    expect(install.init).toContain("No Workspace: init ran outside a git repository.");
    for (const line of [/planner\s+breakdown/, /builder\s+engineer/, /reviewer\s+review, skill-review/, /retro\s+retro/]) expect(install.init).toMatch(line);
    expect(install.init).toMatch(/http:\/\/\S+\/v1\/login-links\/\S+/);
  });

  await test.step("the record: the builtin Skills, engineer and review, the roster, MAIN's default Workflow", async () => {
    const skills = (await ask<{ items: { name: string; builtin: boolean }[] }>("/v1/skills")).items;
    expect(skills.filter((s) => s.builtin).map((s) => s.name).sort()).toEqual(["acceptance", "breakdown", "retro", "skill-review"]);
    expect(skills.filter((s) => !s.builtin).map((s) => s.name).sort()).toEqual(["engineer", "review"]);
    const members = (await ask<{ items: { name: string; kind: string; manager_id?: string; id: string }[] }>("/v1/members")).items;
    const ada = members.find((m) => m.name === "ada")!;
    const agents = members.filter((m) => m.kind === "agent");
    expect(agents.map((m) => m.name).sort()).toEqual(["builder", "planner", "retro", "reviewer"]);
    expect(agents.every((m) => m.manager_id === ada.id)).toBe(true);
    const projects = (await ask<{ items: { key: string }[] }>("/v1/projects")).items;
    expect(projects.map((p) => p.key)).toEqual(["MAIN"]);
    const wf = await ask<{ steps: { name: string }[] }>("/v1/projects/MAIN/workflow");
    expect(wf.steps.map((s) => s.name)).toEqual(["Backlog", "Plan", "Build", "Review", "Retro", "Skill review"]);
  });

  await test.step("init's printed link signs in once serve runs", async () => {
    // init names the address it will listen on; this serve took a free port.
    const printed = new URL(/http:\/\/\S+\/v1\/login-links\/\S+/.exec(install.init)![0]);
    const link = new URL(printed.pathname, install.base).toString();
    await page.goto(link);
    await expect(page.getByRole("button", { name: "Sign in as ada" })).toBeVisible();
    await shot(page, "01-init-link");
    await page.getByRole("button", { name: "Sign in as ada" }).click();
    await expect(page).toHaveURL(`${install.base}/inbox`);
  });

  const setup = page.getByRole("region", { name: "Set up E2E Organisation" });
  await test.step("the checklist: a Project and Members already, File Task next", async () => {
    await expect(setup.getByLabel("1 of 3, done")).toBeVisible();
    await expect(setup.getByLabel("2 of 3, done")).toBeVisible();
    await expect(setup.getByRole("button", { name: "File Task" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Project: Main" })).toBeVisible();
    await shot(page, "02-checklist");
  });

  await test.step("File Task files MAIN-1 at Build, where builder takes it; the Inbox replaces the checklist", async () => {
    await setup.getByRole("button", { name: "File Task" }).click();
    const dialog = page.getByRole("dialog", { name: "File a Task" });
    await expect(dialog).toContainText("In MAIN.");
    const stepField = dialog.getByRole("combobox", { name: "Step" });
    await expect(stepField).toContainText("Build");
    await expect(stepField.getByLabel("Taken by builder")).toBeVisible();
    await dialog.getByLabel("Title").fill("Write the README");
    await shot(page, "03-file-first-task");
    await dialog.getByRole("button", { name: "File Task" }).click();
    await expect(setup).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeAttached();
    await page.goto(`${install.base}/projects/MAIN/tasks?view=board`);
    await expect(page.getByRole("region", { name: "Build", exact: true }).locator("[data-task=MAIN-1]")).toContainText("Write the README");
    await shot(page, "04-first-task-on-the-board");
    await page.goto(`${install.base}/projects/MAIN/workflow`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await shot(page, "05-default-workflow");
  });

  expect(errors).toEqual([]);
});
