import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";

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
});
