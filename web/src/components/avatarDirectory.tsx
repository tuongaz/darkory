import { useMemo, type ReactNode } from "react";
import { useMembers } from "@/api/queries";
import { AvatarContext } from "./avatars";

/** Provides the Avatars of the Organisation's Members, from the Members list (`avatars.ts`). */
export function AvatarDirectory({ children }: { children: ReactNode }) {
  const members = useMembers();
  const avatars = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members.data ?? []) if (x.avatar_file_id) m.set(x.id, x.avatar_file_id);
    return m;
  }, [members.data]);
  return <AvatarContext value={avatars}>{children}</AvatarContext>;
}
