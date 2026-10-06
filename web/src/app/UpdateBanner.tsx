import { ArrowUpCircleIcon } from "lucide-react";
import { useState } from "react";
import { useHealth } from "@/api/queries";
import { Button } from "@/components/ui/button";

const dismissedKey = "darkory.update-dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(dismissedKey);
  } catch {
    return null;
  }
}

/** Says when a newer release exists, until dismissed; this browser remembers the dismissed version. */
export function UpdateBanner() {
  const health = useHealth();
  const [dismissed, setDismissed] = useState(readDismissed);
  const h = health.data;
  if (!h?.update_available || !h.latest_version || h.latest_version === dismissed) return null;
  const latest = h.latest_version;
  return (
    <aside aria-label="Update available" className="flex flex-none items-center gap-2 border-b bg-state-waiting-bg px-4 py-1.5 text-xs">
      <ArrowUpCircleIcon className="size-3.5 flex-none text-state-waiting" aria-hidden />
      <p className="min-w-0">
        <b className="font-semibold">Update available: {latest}</b>. This server runs {h.version}; run <code>darkory update</code> where it
        runs.
      </p>
      <Button
        variant="ghost"
        size="xs"
        className="ml-auto"
        onClick={() => {
          try {
            localStorage.setItem(dismissedKey, latest);
          } catch {
            // Dismissed for this page load only.
          }
          setDismissed(latest);
        }}
      >
        Dismiss
      </Button>
    </aside>
  );
}
