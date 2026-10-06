/**
 * Marks an element that takes every key while it has the focus, such as the Session panel's
 * terminal: the app's shortcuts (J, K, C, ⌘K…) and the peek's Esc leave it alone.
 */
export const ownsKeysAttr = "data-owns-keys";

/** Whether a key press belongs to an element marked `ownsKeysAttr`. */
export function ownsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${ownsKeysAttr}]`) !== null;
}
