import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord, Member, MemberDetail } from "@/api/client";
import { AvatarContext } from "@/components/avatars";
import { MemberAvatar } from "@/components/MemberAvatar";
import { mockApi, refuse, type Handler } from "@/test/api";
import { ada, bob, builder, engineer, signedIn, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const at = "2026-10-01T09:00:00Z";
const record = (id: string, name: string): FileRecord => ({
  id,
  name,
  content_type: "image/png",
  size: 900,
  sha256: "x",
  purpose: "avatar",
  created_by: "m-ada",
  created_at: at,
});

/** The Members as the server keeps them: a PATCH of an Avatar changes what the next read returns. */
function routes(members: Member[], me: Member = ada, extra: Record<string, Handler> = {}): Record<string, Handler> {
  const byId = new Map(members.map((m) => [m.id, m]));
  let n = 0;
  return {
    ...signedIn(me),
    "GET /v1/members": () => ({ items: [...byId.values()] }),
    "GET /v1/members/:member": ({ params }): MemberDetail => ({ member: byId.get(params.member)!, projects: [web], skills: [engineer], reports: [] }),
    "GET /v1/members/:member/tokens": { items: [] },
    "GET /v1/members/:member/sessions": { items: [] },
    "POST /v1/files": ({ query }) => record(`f${++n}`, query.get("name") ?? ""),
    "PATCH /v1/members/:member": ({ params, body }) => {
      const id = (body as { avatar_file_id: string }).avatar_file_id;
      const m: Member = { ...byId.get(params.member)!, avatar_file_id: id || undefined };
      byId.set(m.id, m);
      return m;
    },
    ...extra,
  };
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "face.png", { type: "image/png" });

describe("Avatars", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  });

  it("an admin uploads an agent's Avatar from its settings header: chosen, previewed, saved", async () => {
    const api = mockApi(routes([ada, bob, builder]));
    renderApp("/settings/organisation/agents/m-builder");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Upload an Avatar for builder" });
    await user.upload(screen.getByLabelText("Avatar image for builder"), png());
    const dialog = await screen.findByRole("dialog", { name: "New Avatar for builder" });
    expect(within(dialog).getByText("face.png")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save Avatar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const upload = api.calls.find((c) => c.method === "POST" && c.path === "/v1/files")!;
    expect(upload.query.get("purpose")).toBe("avatar");
    expect(upload.query.get("name")).toBe("face.png");
    const patch = api.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/v1/members/m-builder");
    expect(patch.body).toEqual({ avatar_file_id: "f1" });
    // The header's mark now shows the image, in the agent's ring.
    const mark = await screen.findByRole("button", { name: "Change the Avatar of builder" });
    await waitFor(() => expect(within(mark).getByRole("img", { name: "builder (agent)" })).toHaveAttribute("data-avatar", "image"));
    expect(mark.querySelector("img")).toHaveAttribute("src", "/v1/files/f1/content");
  });

  it("refuses what cannot be an Avatar before sending anything", async () => {
    const api = mockApi(routes([ada, builder]));
    renderApp("/settings/organisation/agents/m-builder");
    const user = userEvent.setup({ applyAccept: false });
    await screen.findByRole("button", { name: "Upload an Avatar for builder" });
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    await user.upload(screen.getByLabelText("Avatar image for builder"), svg);
    expect(await screen.findByRole("alert")).toHaveTextContent("An Avatar is a PNG, JPEG, WebP or GIF image.");
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Avatar image for builder"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent("An Avatar is at most 2 MB.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/v1/files")).toBe(false);
  });

  it("shows a refusal of the upload in the preview", async () => {
    mockApi(routes([ada, builder], ada, { "POST /v1/files": refuse(400, "invalid", "an avatar is a PNG, JPEG, WebP or GIF image") }));
    renderApp("/settings/organisation/agents/m-builder");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Upload an Avatar for builder" });
    await user.upload(screen.getByLabelText("Avatar image for builder"), png());
    const dialog = await screen.findByRole("dialog", { name: "New Avatar for builder" });
    await user.click(within(dialog).getByRole("button", { name: "Save Avatar" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("an avatar is a PNG");
  });

  it("removes an Avatar, back to initials", async () => {
    const api = mockApi(routes([ada, { ...builder, avatar_file_id: "f9" }]));
    renderApp("/settings/organisation/agents/m-builder");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Change the Avatar of builder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove Avatar" }));
    await waitFor(() => expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ avatar_file_id: "" }));
    const mark = await screen.findByRole("button", { name: "Upload an Avatar for builder" });
    await waitFor(() => expect(within(mark).getByRole("img", { name: "builder (agent)" })).not.toHaveAttribute("data-avatar"));
    expect(within(mark).getByText("BL")).toBeInTheDocument();
  });

  it("a human sets their own Avatar on the Account page; nobody else's page offers it to them", async () => {
    mockApi(routes([ada, bob, builder], bob));
    renderApp("/settings/account");
    expect(await screen.findByRole("button", { name: "Upload an Avatar for bob" })).toBeInTheDocument();
  });

  it("an agent's Account page offers no Avatar control to the agent", async () => {
    mockApi(routes([ada, builder], builder));
    renderApp("/settings/account");
    await screen.findByRole("heading", { name: "builder" });
    expect(screen.queryByRole("button", { name: /Avatar/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Avatar image for builder")).not.toBeInTheDocument();
  });

  it("the Agents list shows an agent's Avatar", async () => {
    mockApi(routes([ada, bob, { ...builder, avatar_file_id: "f7" }]));
    renderApp("/settings/organisation/agents");
    const marks = await screen.findAllByRole("img", { name: "builder (agent)" });
    await waitFor(() => expect(marks[0]).toHaveAttribute("data-avatar", "image"));
    expect(marks[0].querySelector("img")).toHaveAttribute("src", "/v1/files/f7/content");
  });
});

describe("MemberAvatar", () => {
  it("finds the Avatar of a brief shape by id, and falls back to initials when the image fails", async () => {
    const { container } = render(
      <AvatarContext value={new Map([["m-builder", "f3"]])}>
        <MemberAvatar member={{ id: "m-builder", name: "builder", kind: "agent" }} />
        <MemberAvatar member={{ id: "m-bob", name: "bob", kind: "human" }} />
      </AvatarContext>,
    );
    const [agent, human] = screen.getAllByRole("img", { name: /builder|bob/ });
    expect(agent).toHaveAttribute("data-avatar", "image");
    expect(agent.querySelector("img")).toHaveAttribute("src", "/v1/files/f3/content");
    expect(human).not.toHaveAttribute("data-avatar");
    fireEvent.error(container.querySelector("img")!);
    expect(await within(agent).findByText("BL")).toBeInTheDocument();
  });
});
