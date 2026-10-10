import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { refuse } from "@/test/api";
import { ada, builder, task } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { claim, recordApi } from "./testing";

const blocked = task(3, { title: "Cannot delete a Workflow", blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8", title: "Which currency?" }] });
const question = task(8, {
  aimed_at_id: ada.id,
  step_id: undefined,
  skill_id: undefined,
  filed_by: builder.id,
  owner_id: builder.id,
  title: "Which currency should the cart show, and should it follow the browser?",
  description: "Today it is `USD` everywhere.",
});

function answerApi(extra: Parameters<typeof recordApi>[0]["extra"] = {}) {
  return recordApi({ tasks: [blocked, question], details: { "WEB-8": { blocking: [blocked] } }, extra });
}

async function openDialog() {
  renderApp("/inbox");
  const needs = await screen.findByRole("region", { name: "Needs you" });
  await waitFor(() => expect(needs.querySelector('[data-task="WEB-8"]')).not.toBeNull());
  await userEvent.click(within(needs).getByRole("button", { name: "Answer WEB-8" }));
  return screen.findByRole("dialog", { name: "Answer WEB-8" });
}

const posts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST").map((c) => c.path);

describe("Answer", () => {
  it("shows the question in full, who asked and what it blocks, and says what Answer does", async () => {
    answerApi();
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent("Which currency should the cart show, and should it follow the browser?");
    // The body through Markdown: the code span is code.
    await waitFor(() => expect(within(dialog).getByText("USD").tagName).toBe("CODE"));
    expect(dialog).toHaveTextContent("From builder · blocks WEB-3 Cannot delete a Workflow");
    expect(within(dialog).getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Answers and ends WEB-8");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Answer" })).toBeDisabled();
  });

  it("claims, then completes with the answer as its Note, and closes", async () => {
    const { calls } = answerApi({
      "POST /v1/tasks/:task/claim": () => ({ task: { ...question, claim: claim(question.id, ada.id) } }),
      "POST /v1/tasks/:task/complete": () => ({ ...question, state: "done" }),
    });
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your answer" }), "EUR, from the browser.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls)).toEqual(["/v1/tasks/WEB-8/claim", "/v1/tasks/WEB-8/complete"]);
    expect(calls.find((c) => c.path === "/v1/tasks/WEB-8/complete")!.body).toEqual({ note: "EUR, from the browser." });
  });

  it("stops at a refused claim, with the dialog open and the refusal under the field", async () => {
    const { calls } = answerApi({ "POST /v1/tasks/:task/claim": () => refuse(409, "already_claimed", "bob holds WEB-8") });
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your answer" }), "EUR.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Answer" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("bob holds WEB-8");
    expect(posts(calls)).toEqual(["/v1/tasks/WEB-8/claim"]);
    expect(screen.getByRole("dialog", { name: "Answer WEB-8" })).toBeInTheDocument();
  });

  it("says where I stand when the claim landed and the complete was refused", async () => {
    const { calls } = answerApi({
      "POST /v1/tasks/:task/claim": () => ({ task: { ...question, claim: claim(question.id, ada.id) } }),
      "POST /v1/tasks/:task/complete": () => refuse(409, "conflict", "WEB-8 changed meanwhile"),
    });
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your answer" }), "EUR.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Answer" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("WEB-8 changed meanwhile");
    expect(dialog).toHaveTextContent("You hold WEB-8; complete it from its page");
    expect(within(dialog).getByRole("link", { name: "its page" })).toHaveAttribute("href", "/tasks/WEB-8");
    expect(posts(calls)).toEqual(["/v1/tasks/WEB-8/claim", "/v1/tasks/WEB-8/complete"]);
  });

  it("only completes on a second try once the claim has landed", async () => {
    let refusals = 1;
    const { calls } = answerApi({
      "POST /v1/tasks/:task/claim": () => ({ task: { ...question, claim: claim(question.id, ada.id) } }),
      "POST /v1/tasks/:task/complete": () => (refusals-- > 0 ? refuse(503, "unavailable", "Try again") : { ...question, state: "done" }),
    });
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your answer" }), "EUR.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Answer" }));
    await within(dialog).findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(calls)).toEqual(["/v1/tasks/WEB-8/claim", "/v1/tasks/WEB-8/complete", "/v1/tasks/WEB-8/complete"]);
  });
});
