import { useState, type ReactNode } from "react";
import { Outlet } from "react-router";
import { useActivityStream } from "@/api/live";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "./AppSidebar";
import { CommandMenu } from "./CommandMenu";
import { usePeek } from "./peek";
import { useShortcuts } from "./shortcuts";
import { UpdateBanner } from "./UpdateBanner";

/**
 * The frame of every signed-in screen: the sidebar, the update banner, then the page, which draws
 * its own TopBar. It holds the Activity stream open, answers the shortcuts, and mounts what opens
 * over any page: ⌘K, the screens' global dialogs (`dialogs`), and the Task Peek for ?task=.
 */
export function Shell({ dialogs, peek }: { dialogs?: ReactNode; peek?: (taskKey: string, close: () => void) => ReactNode }) {
  useActivityStream();
  const [searchOpen, setSearchOpen] = useState(false);
  useShortcuts(setSearchOpen);
  const { taskKey, close } = usePeek();
  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider className="h-svh overflow-hidden">
        <AppSidebar onSearch={() => setSearchOpen(true)} />
        <SidebarInset className="min-w-0 overflow-hidden">
          <UpdateBanner />
          <div id="main" className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </SidebarInset>
        <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
        {dialogs}
        {taskKey && peek?.(taskKey, close)}
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
