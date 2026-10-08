import { createContext, useContext } from "react";

/**
 * Which Members show an Avatar, by id: the file id of each one's. Many marks are drawn from a
 * brief shape of a Member (a Workflow line's holder, a Step's takers) that carries no Avatar;
 * MemberAvatar looks them up here, so every mark of a Member shows the same face. Outside the
 * provider (`AvatarDirectory`; a test, the signed-out page) it is empty and marks show initials.
 */
export const AvatarContext = createContext<ReadonlyMap<string, string>>(new Map());

/** The file id of a Member's Avatar: the one it carries, else the directory's; none for none. */
export function useAvatarFile(member: { id?: string; avatar_file_id?: string }): string | undefined {
  const avatars = useContext(AvatarContext);
  return member.avatar_file_id ?? (member.id ? avatars.get(member.id) : undefined);
}
