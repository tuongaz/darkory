import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { Copy, copiedFor } from "./Copy";

const id = "01a11b2b-acc8-7d90-bf1c-5b0a842120d6";

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Copy", () => {
  it("shows the value with a copy button after it, in space kept for it", () => {
    render(
      <Copy value={id} label="Session id">
        <span className="font-mono">{id}</span>
      </Copy>,
    );
    expect(screen.getByText(id)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Copy Session id" });
    // Hidden by opacity, never display: the keyboard still reaches it, and the value never moves.
    expect(button).toHaveClass("absolute", "opacity-0", "group-hover/copy:opacity-100", "focus-visible:opacity-100");
    expect(button.parentElement).toHaveClass("relative", "pr-6");
  });

  it("shows the value itself when given no children", () => {
    render(<Copy value="main-7-support-emoji" label="branch" />);
    expect(screen.getByText("main-7-support-emoji")).toBeInTheDocument();
  });

  it("is reached by the keyboard and copies on Enter", async () => {
    // After userEvent.setup, which puts a clipboard of its own on navigator.
    const user = userEvent.setup();
    const writeText = clipboard();
    render(<Copy value={id} label="Session id" />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy Session id" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith(id);
  });

  it("copies the value on click, shows a check for a moment, then the copy icon again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = clipboard();
    render(<Copy value={id} label="Session id">{`…${id.slice(-8)}`}</Copy>);
    await user.click(screen.getByRole("button", { name: "Copy Session id" }));
    expect(writeText).toHaveBeenCalledWith(id);
    const copied = await screen.findByRole("button", { name: "Copied Session id" });
    expect(copied).toHaveAttribute("data-copied");
    act(() => vi.advanceTimersByTime(copiedFor - 100));
    expect(screen.getByRole("button", { name: "Copied Session id" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("button", { name: "Copy Session id" })).not.toHaveAttribute("data-copied");
  });

  it("copies and nothing else in a row that opens on click", async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    const open = vi.fn();
    render(
      <table>
        <tbody>
          <tr onClick={open}>
            <td>
              <Copy value={id} label="Session id" />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    await user.click(screen.getByRole("button", { name: "Copy Session id" }));
    expect(writeText).toHaveBeenCalledWith(id);
    expect(open).not.toHaveBeenCalled();
  });

  it("shows the value in a toast where the browser refuses the clipboard", async () => {
    const user = userEvent.setup();
    clipboard(vi.fn().mockRejectedValue(new Error("not allowed")));
    render(
      <>
        <Copy value={id} label="Session id" />
        <Toaster />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Copy Session id" }));
    expect(await screen.findByText("Not copied: the browser refused the clipboard")).toBeInTheDocument();
    expect(screen.getAllByText(id)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy Session id" })).not.toHaveAttribute("data-copied");
  });
});
