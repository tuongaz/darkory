import { useCallback, useId, type ReactNode } from "react";

/**
 * Choosing a file from the computer: a hidden file input and whatever opens it. `children` gets
 * `open`, to call from a button or a menu item; `onPick` gets the chosen file. The input is
 * cleared after each pick, so the same file can be chosen again. Pair it with `useUploadFile`
 * (api/files.ts) to send what was picked.
 */
export function FileUpload({
  accept,
  onPick,
  label,
  children,
}: {
  /** The types the browser's chooser offers, as the input's `accept` says them. */
  accept?: string;
  onPick: (file: File) => void;
  /** The input's accessible name, for tests and assistive technology. */
  label: string;
  children: (open: () => void) => ReactNode;
}) {
  const id = useId();
  // Found by id when called, not held in a ref: children may be handed `open` while rendering.
  const open = useCallback(() => document.getElementById(id)?.click(), [id]);
  return (
    <>
      <input
        id={id}
        type="file"
        accept={accept}
        aria-label={label}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (f) onPick(f);
        }}
      />
      {children(open)}
    </>
  );
}
