import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { intentEvent, sendIntent, useIntent } from "./intents";

describe("intents", () => {
  it("carry a file-task's Project, Step and Parent to whoever listens for that kind", () => {
    const fileTask = vi.fn();
    const newProject = vi.fn();
    renderHook(() => {
      useIntent("file-task", fileTask);
      useIntent("new-project", newProject);
    });

    sendIntent({ kind: "file-task", project: "WEB", step: "st-backlog", parent: "WEB-1" });
    expect(fileTask).toHaveBeenCalledWith({ kind: "file-task", project: "WEB", step: "st-backlog", parent: "WEB-1" });
    // Without them, as C and ⌘K send it.
    sendIntent({ kind: "file-task", project: "WEB" });
    expect(fileTask).toHaveBeenLastCalledWith({ kind: "file-task", project: "WEB" });
    expect(newProject).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(intentEvent, { detail: { kind: "new-project" } }));
    expect(newProject).toHaveBeenCalledWith({ kind: "new-project" });
  });
});
