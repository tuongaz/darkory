import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { intentEvent, sendIntent, useIntent } from "./intents";

describe("intents", () => {
  it("carry a file-task's Team, Status and Feature to whoever listens for that kind", () => {
    const fileTask = vi.fn();
    const fileFeature = vi.fn();
    renderHook(() => {
      useIntent("file-task", fileTask);
      useIntent("file-feature", fileFeature);
    });

    sendIntent({ kind: "file-task", team: "WEB", status: "st-todo", feature: "WEB-1" });
    expect(fileTask).toHaveBeenCalledWith({ kind: "file-task", team: "WEB", status: "st-todo", feature: "WEB-1" });
    // Without them, as C and ⌘K send it.
    sendIntent({ kind: "file-task", team: "WEB" });
    expect(fileTask).toHaveBeenLastCalledWith({ kind: "file-task", team: "WEB" });
    expect(fileFeature).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(intentEvent, { detail: { kind: "file-feature", team: "WEB" } }));
    expect(fileFeature).toHaveBeenCalledWith({ kind: "file-feature", team: "WEB" });
  });
});
