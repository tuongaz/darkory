import { useCallback, useState, type ReactNode } from "react";
import { Outlet } from "react-router";
import { useActivityStream } from "@/api/live";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "./AppSidebar";
import { CommandMenu } from "./CommandMenu";
import { usePeek } from "./peek";
import { SelectionContext, taskRow } from "./selection";
import { useShortcuts } from "./shortcuts";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { UpdateBanner } from "./UpdateBanner";

/**
 * The frame of every signed-in screen: the sidebar, the update banner, then the page, which draws
 * its own TopBar. It holds the Activity stream open, answers the shortcuts, and mounts what opens
 * over any page: ⌘K, the shortcuts sheet, the screens' global dialogs (`dialogs`), and the Task
 * Peek for ?task=, which leaves the page under it working.
 */
export function Shell({ dialogs, peek }: { dialogs?: ReactNode; peek?: (taskKey: string, close: () => void) => ReactNode }) {
  useActivityStream();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useShortcuts({ setSearchOpen, setShortcutsOpen, selected, select: setSelected });
  const { taskKey, close } = usePeek();
  // Closing the peek (Esc, ×) leaves its Task selected, and its row takes the focus back: the
  // sheet's own focus handling has nothing to return to.
  const closePeek = useCallback(() => {
    if (!taskKey) return;
    setSelected(taskKey);
    close();
    setTimeout(() => taskRow(taskKey)?.focus({ preventScroll: true }));
  }, [taskKey, close]);
  return (
    <TooltipProvider delayDuration={300}>
      <SelectionContext value={{ selected, select: setSelected }}>
        <SidebarProvider className="h-svh overflow-hidden">
          <AppSidebar onSearch={() => setSearchOpen(true)} />
          <SidebarInset className="min-w-0 overflow-hidden">
            <UpdateBanner />
            <div id="main" className="flex min-h-0 flex-1 flex-col">
              <Outlet />
            </div>
          </SidebarInset>
          <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
          <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          {dialogs}
          {taskKey && peek?.(taskKey, closePeek)}
          <Toaster position="bottom-right" />
        </SidebarProvider>
      </SelectionContext>
    </TooltipProvider>
  );
}

