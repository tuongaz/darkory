// The top bar's controls on the Board screens: the List | Board switch and Display. The Filter is
// components/filters.
import { CheckIcon, KanbanIcon, LayersIcon, ListIcon, SlidersHorizontalIcon, UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { StatusGlyph } from "@/components/StatusGlyph";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Display, GroupBy, Order } from "./derive";

/** The segmented List | Board switch (kit `.seg`); the other search parameters stay. */
export function ViewSwitch({ view }: { view: "list" | "board" }) {
  const [params] = useSearchParams();
  const to = (v: "list" | "board") => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    next.delete("task");
    return { search: `?${next}` };
  };
  const item = (v: "list" | "board", icon: ReactNode, label: string) => (
    <Link
      to={to(v)}
      aria-current={view === v ? "page" : undefined}
      aria-label={label}
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 rounded-[6px] px-2.5 font-medium text-muted-foreground [&_svg]:size-3.5",
        view === v && "bg-background text-foreground shadow-soft",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
  return (
    <nav aria-label="View" className="inline-flex rounded-md bg-muted p-0.5">
      {item("list", <ListIcon aria-hidden />, "List")}
      {item("board", <KanbanIcon aria-hidden />, "Board")}
    </nav>
  );
}

/** An outline top-bar button whose label hides on a phone. */
function BarButton({ icon, label, ...props }: { icon: ReactNode; label: string } & React.ComponentProps<typeof Button>) {
  return (
    <Button variant="outline" aria-label={label} {...props}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("flex h-[30px] w-full items-center gap-2 rounded-[6px] px-2 text-left hover:bg-accent [&_svg]:size-3.5", on && "bg-accent")}
    >
      {children}
      {on && <CheckIcon className="ml-auto" aria-hidden />}
    </button>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex h-[30px] cursor-pointer items-center gap-2 rounded-[6px] px-2 hover:bg-accent">
      {label}
      <Switch checked={on} onCheckedChange={onChange} aria-label={label} className="ml-auto" />
    </label>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">{children}</div>;
}

/** Display (F-B2): grouping (the list only), the order within a group, and what to show. */
export function DisplayMenu({ display, change, view }: { display: Display; change: (c: Partial<Display>) => void; view: "list" | "board" }) {
  const groups: { by: GroupBy; label: string; icon: ReactNode }[] = [
    {
      by: "status",
      label: "Status",
      icon: (
        <span aria-hidden className="inline-flex">
          <StatusGlyph glyph="todo" className="size-3" />
        </span>
      ),
    },
    { by: "feature", label: "Feature", icon: <LayersIcon aria-hidden /> },
    { by: "holder", label: "Holder", icon: <UserIcon aria-hidden /> },
  ];
  const orders: { order: Order; label: string }[] = [
    { order: "rank", label: "Rank, then waiting time" },
    { order: "waiting", label: "Waiting time" },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarButton icon={<SlidersHorizontalIcon />} label="Display" className="data-[state=open]:bg-accent" />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display" className="w-[300px] p-1">
        {view === "list" && (
          <div role="group" aria-label="Group by">
            <SectionLabel>Group by</SectionLabel>
            {groups.map((g) => (
              <Choice key={g.by} on={display.group === g.by} onClick={() => change({ group: g.by })}>
                {g.icon}
                {g.label}
              </Choice>
            ))}
            <div className="-mx-1 my-1 h-px bg-border" />
          </div>
        )}
        <div role="group" aria-label={view === "list" ? "Order within a group" : "Order within a column"}>
          <SectionLabel>{view === "list" ? "Order within a group" : "Order within a column"}</SectionLabel>
          {orders.map((o) => (
            <Choice key={o.order} on={display.order === o.order} onClick={() => change({ order: o.order })}>
              {o.label}
            </Choice>
          ))}
        </div>
        <div className="-mx-1 my-1 h-px bg-border" />
        <div role="group" aria-label="Show">
          <SectionLabel>Show</SectionLabel>
          <Toggle label="Done" on={display.showDone} onChange={(on) => change({ showDone: on })} />
          <Toggle label="Dropped" on={display.showDropped} onChange={(on) => change({ showDropped: on })} />
          <Toggle label="Shipped and dropped Features' Tasks" on={display.showEndedFeatures} onChange={(on) => change({ showEndedFeatures: on })} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
