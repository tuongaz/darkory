import { useState } from "react";
import { FoldAnchor, shown, type Fold } from "@/components/BarFold";

/**
 * What a folded bar menu needs: a ref callback for its own trigger, the class that hides that
 * trigger on a phone, the anchor that opens it under the fold's trigger there (its own from `sm`
 * up), and the close that gives the focus back to the trigger shown. Without a fold, nothing
 * changes.
 */
export function useFolded(fold: Fold | undefined) {
  const [own, setOwn] = useState<HTMLButtonElement | null>(null);
  return {
    own: setOwn,
    hide: fold ? "max-sm:hidden" : undefined,
    anchor: fold ? <FoldAnchor own={own} fold={fold.anchor} /> : null,
    onCloseAutoFocus: fold
      ? (e: Event) => {
          if (shown(own)) return;
          e.preventDefault();
          fold.anchor?.focus();
        }
      : undefined,
  };
}
