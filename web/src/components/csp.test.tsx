import { act, fireEvent, render, screen } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Calendar } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { sampleSteps, sampleSubtasks, sampleWorkflow } from "@/components/workflow/samples";
import { SubtaskGraph } from "@/components/workflow/SubtaskGraph";
import { WorkflowCanvas } from "@/components/workflow/WorkflowCanvas";

// The Install's Content-Security-Policy is style-src 'self': a <style> element added at run time
// is refused and logged as an error. These parts of the kit would add one; vite.config.ts
// (noInjectedStyles) stops them, here as in the build, and globals.css carries their CSS.
describe("no <style> at run time", () => {
  let added: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (n instanceof HTMLStyleElement) added.push(n.textContent ?? "");
        if (n instanceof Element) for (const s of n.querySelectorAll("style")) added.push(s.textContent ?? "");
      }
  });
  beforeEach(() => {
    added = [];
    observer.observe(document, { childList: true, subtree: true });
  });
  afterEach(() => observer.disconnect());

  const styles = () => [...added, ...Array.from(document.querySelectorAll("style"), (s) => s.textContent ?? "")];

  it("from an open Select", async () => {
    render(
      <Select defaultOpen defaultValue="todo">
        <SelectTrigger aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="backlog">Backlog</SelectItem>
          <SelectItem value="todo">Todo</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(styles()).toEqual([]);
  });

  it("from a ScrollArea, a Dialog's scroll lock and a toast", async () => {
    render(
      <>
        <ScrollArea className="h-20">rows</ScrollArea>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>File a Task</DialogTitle>
          </DialogContent>
        </Dialog>
        <Toaster />
      </>,
    );
    act(() => void toast("Not moved to Done"));
    expect(await screen.findByText("Not moved to Done")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "File a Task" })).toBeInTheDocument();
    expect(styles()).toEqual([]);
  });

  it("from the Filter's calendar, nor a style attribute", () => {
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    render(<Calendar mode="range" defaultMonth={new Date(2026, 9, 1)} selected={{ from: new Date(2026, 9, 4), to: new Date(2026, 9, 6) }} />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(styles()).toEqual([]);
    expect(setAttribute.mock.calls.filter(([name]) => name === "style")).toEqual([]);
  });

  // React Flow (@xyflow/react) places nodes, edges and labels with style props, which React
  // writes through the CSSOM; its own CSS is base.css, bundled from globals.css.
  it("from the Workflow canvas and the Subtask graph, nor a style attribute", async () => {
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    render(
      <>
        <WorkflowCanvas workflow={sampleWorkflow} mode="live" />
        <WorkflowCanvas workflow={sampleWorkflow} mode="edit" onDeleteStep={() => {}} />
        <SubtaskGraph steps={sampleSteps} subtasks={sampleSubtasks} onOpen={() => {}} />
      </>,
    );
    const build = screen.getAllByRole("group", { hidden: true }).filter((n) => n.getAttribute("aria-label")?.startsWith("Build:"))[1];
    act(() => build.focus());
    fireEvent.keyDown(build, { key: "Enter" });
    // Its panel, with the Select that asks where Build's Tasks go.
    expect(await screen.findByRole("button", { name: "Delete Build", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Step that receives the Tasks at Build", hidden: true })).toBeInTheDocument();
    expect(document.querySelectorAll(".react-flow__edge").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^MAIN-5 /, hidden: true })).toBeInTheDocument();
    expect(styles()).toEqual([]);
    expect(setAttribute.mock.calls.filter(([name]) => name === "style")).toEqual([]);
  });

  // xterm.js computes its theme and cell size into <style> elements and a truecolor cell's colour
  // into a style attribute, which the policy refuses too; noInjectedStyles writes both through
  // the CSSOM instead.
  it("from the Session panel's terminal, nor a style attribute", async () => {
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    const el = document.createElement("div");
    document.body.append(el);
    const term = new Terminal({ fontSize: 13 });
    term.loadAddon(new FitAddon());
    term.open(el);
    await new Promise<void>((done) => term.write("plain \x1b[31mred\x1b[0m \x1b[38;2;255;120;0mtruecolor\x1b[0m\r\n", done));
    await new Promise((done) => requestAnimationFrame(done));
    expect(el.querySelector(".xterm-rows")).toHaveTextContent("plain red truecolor");
    expect(styles()).toEqual([]);
    expect(setAttribute.mock.calls.filter(([name]) => name === "style")).toEqual([]);
    term.dispose();
    el.remove();
  });
});
