// W4 Inbox owns this folder: Inbox, My work, Agents and Activity. Placeholders until W4 lands;
// routes.tsx imports what this file exports. The Install checklist that /inbox shows before
// anything is filed is the shell's (src/app/SetupChecklist.tsx).
import { PlaceholderPage } from "@/app/Placeholder";

const owner = "W4 Inbox";

/** /inbox, once the Organisation has a Feature. */
export function InboxPage() {
  return <PlaceholderPage title="Inbox" owner={owner} />;
}

/** /my-work */
export function MyWorkPage() {
  return <PlaceholderPage title="My work" owner={owner} />;
}

/** /agents */
export function AgentsPage() {
  return <PlaceholderPage title="Agents" owner={owner} />;
}

/** /activity */
export function ActivityPage() {
  return <PlaceholderPage title="Activity" owner={owner} />;
}
