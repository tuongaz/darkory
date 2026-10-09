import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { useActivityStream } from "@/api/live";
import { logout } from "@/api/writes";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "./AppSidebar";
import { CommandMenu } from "./CommandMenu";
import { useIntent } from "./intents";
import { NewProjectDialog } from "./NewProjectDialog";
import { usePeek } from "./peek";
import { rememberAppLocation } from "./returnTo";
import { SelectionContext, taskRow } from "./selection";
import { useShortcuts } from "./shortcuts";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { UpdateBanner } from "./UpdateBanner";

/**
 * What every signed-in screen runs inside, the app and Settings alike: the Activity stream, the
 * shortcuts, Log out (`log-out`), and what opens over any page: ⌘K, the shortcuts sheet, the New Project dialog, the
 * screens' global dialogs (`dialogs`), and the Task Peek for ?task=, which leaves the page under
 * it working. The routes inside draw a `Frame`: the app's sidebar (`AppFrame`) or Settings' own.
 */
export function Shell({ dialogs, peek }: { dialogs?: ReactNode; peek?: (taskKey: string, close: () => void) => ReactNode }) {
  useActivityStream();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useShortcuts({ setSearchOpen, setShortcutsOpen, selected, select: setSelected });
  useIntent("search", () => setSearchOpen(true));
  const signOut = useMutation({ mutationFn: logout });
  useIntent("log-out", () => {
    if (!signOut.isPending) signOut.mutate();
  });
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
          <Outlet />
          <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
          <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <NewProjectDialog />
          {dialogs}
          {taskKey && peek?.(taskKey, closePeek)}
          <Toaster position="bottom-right" />
        </SidebarProvider>
      </SelectionContext>
    </TooltipProvider>
  );
}

/**
 * A sidebar beside the page: the update banner, then the page, which draws its own TopBar. On a
 * phone the sidebar is a sheet the TopBar's button opens.
 */
export function Frame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <>
      {sidebar}
      {/* The page is a card on the window ground from md up: a border, not the kit's shadow; on a phone it fills the screen. */}
      <SidebarInset className="min-w-0 overflow-hidden md:peer-data-[variant=inset]:rounded-lg md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:shadow-none">
        <UpdateBanner />
        <div id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </SidebarInset>
    </>
  );
}

/** The app's pages beside its sidebar. Remembers where it is, so Settings' Back returns here. */
export function AppFrame() {
  const { pathname, search } = useLocation();
  useEffect(() => rememberAppLocation(pathname + search), [pathname, search]);
  return (
    <Frame sidebar={<AppSidebar />}>
      <Outlet />
    </Frame>
  );
}
