const query = "(prefers-color-scheme: dark)";

/**
 * Follows the system's light or dark preference: sets `.dark` on <html>, which shadcn's dark
 * tokens and `dark:` utilities key on, now and whenever the preference changes. Light is the design.
 */
export function followSystemTheme(root: HTMLElement = document.documentElement): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(query);
  const apply = () => root.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
