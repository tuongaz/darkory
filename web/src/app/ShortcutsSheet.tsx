import { Fragment } from "react";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { shortcutList } from "./shortcuts";

/** ?: every key the app answers, and nothing else (`shortcutList`). */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[340px]" aria-describedby={undefined}>
        <SheetHeader className="h-11 flex-none flex-row items-center border-b px-4 py-0">
          <SheetTitle className="text-sm">Shortcuts</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
          {shortcutList.map((s) => (
            <section key={s.section} aria-label={s.section}>
              <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">{s.section}</h3>
              <dl className="flex flex-col">
                {s.keys.map((k) => (
                  <div key={k.label} className="flex h-8 items-center gap-2 border-b last:border-b-0">
                    <dt className="min-w-0 flex-1 truncate">{k.label}</dt>
                    <dd className="flex flex-none items-center gap-1 text-2xs text-muted-foreground">
                      {k.ways.map((way, i) => (
                        <Fragment key={way.join(" ")}>
                          {i > 0 && <span>or</span>}
                          {way.map((key, j) => (
                            <Fragment key={key}>
                              {j > 0 && <span>then</span>}
                              <Kbd className="border">{key}</Kbd>
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
