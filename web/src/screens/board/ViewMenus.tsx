// The top bar's controls on a Project's Tasks: the List | Board switch and Display. Filters come
// from components/filters.
import { CheckIcon, FolderTreeIcon, KanbanIcon, ListIcon, RowsIcon, SlidersHorizontalIcon, TagIcon, UserIcon, WorkflowIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { BarAction } from "@/app/TopBar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Display, GroupBy, Order } from "./derive";

export type Layout = "list" | "board";

/** The segmented List | Board switch (kit `.seg`); the other search parameters stay. On a narrow bar it is the two icons. */
export function ViewSwitch({ view }: { view: Layout }) {
  const [params] = useSearchParams();
  const to = (v: Layout) => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    next.delete("task");
    return { search: `?${next}` };
  };
  const layouts: { v: Layout; icon: ReactNode; label: string }[] = [
    { v: "list", icon: <ListIcon aria-hidden />, label: "List" },
    { v: "board", icon: <KanbanIcon aria-hidden />, label: "Board" },
  ];
  return (
    <nav aria-label="View" className="inline-flex rounded-md bg-muted p-0.5">
      {layouts.map(({ v, icon, label }) => (
        <Link
          key={v}
          to={to(v)}
          aria-current={view === v ? "page" : undefined}
          aria-label={label}
          className={cn(
            "inline-flex h-[26px] items-center gap-1.5 rounded-[6px] px-2.5 font-medium text-muted-foreground [&_svg]:size-3.5",
            view === v && "bg-background text-foreground shadow-soft",
          )}
        >
          {icon}
          <span className="hidden @2xl/page:inline">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

/** An outline act on the bar: its label hides when the bar's row is narrow. */
function BarButton(props: ComponentProps<typeof BarAction>) {
  return <BarAction variant="outline" {...props} />;
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

const groups: { by: GroupBy; label: string; icon: ReactNode }[] = [
  { by: "step", label: "Step", icon: <WorkflowIcon aria-hidden /> },
  { by: "parent", label: "Parent", icon: <FolderTreeIcon aria-hidden /> },
  { by: "owner", label: "Owner", icon: <UserIcon aria-hidden /> },
  { by: "label", label: "Label", icon: <TagIcon aria-hidden /> },
  { by: "none", label: "No grouping", icon: <RowsIcon aria-hidden /> },
];

const orders: { order: Order; label: string }[] = [
  { order: "rank", label: "Rank" },
  { order: "updated", label: "Updated" },
  { order: "filed", label: "Filed" },
];

/** Display: the layout's grouping (the list), the order within a group or column, and what to show. */
export function DisplayMenu({
  display,
  change,
  view,
}: {
  display: Display;
  change: (c: Partial<Display>) => void;
  view: Layout;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarButton icon={<SlidersHorizontalIcon />} label="Display" className="data-[state=open]:bg-accent" />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display" className="w-[280px] p-1">
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
        <div role="group" aria-label="Order by">
          <SectionLabel>Order by</SectionLabel>
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
          {view === "list" ? (
            <Toggle label="Subtasks" on={display.showSubtasks} onChange={(on) => change({ showSubtasks: on })} />
          ) : (
            <Toggle label="Parents" on={display.showParents} onChange={(on) => change({ showParents: on })} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
