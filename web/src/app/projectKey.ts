/** A Project key as /v1 takes it: 2 to 10 capitals or digits, starting with a capital. */
export const projectKeyPattern = /^[A-Z][A-Z0-9]{1,9}$/;

/** A key to offer for a Project's name until one is typed: its first letters, in capitals. */
export function suggestKey(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = letters.replace(/^[0-9]+/, "").slice(0, 3);
  return key.length >= 2 ? key : "";
}
