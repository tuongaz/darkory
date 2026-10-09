// The Filter, ported from enably-v2's FilterBar onto shadcn: a header button that opens the
// Filters menu (unset axes, drill in to pick values), and the row under the header that shows each
// set axis as a segmented chip, axis · operator ▾ · value · ×, with Reset at its right. The pills
// are the caller's (the address, through useFilterState); the bar only reads and writes them.
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FilterIcon, SearchIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Fold } from "@/components/BarFold";
import { useFolded } from "@/components/useFolded";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow } from "@/clock";
import { cn } from "@/lib/utils";
import { dateBounds, dateText, datePresets, pillDays, presetText } from "./dates";
import type { FilterPill } from "./filterState";
import { filterLabels, type FilterLabels } from "./labels";
import {
  commitOp,
  dateMode,
  defaultOp,
  multiPick,
  opDisabledReason,
  operatorRows,
  pickOp,
  revalue,
  type FilterField,
  type FilterOption,
} from "./operators";

export type FilterBarProps = {
  /** The axes, in the order the menu lists them and the chips read. */
  fields: readonly FilterField[];
  pills: readonly FilterPill[];
  /** The values an axis offers, already in order; the bar fetches nothing. */
  optionsFor: (field: string) => readonly FilterOption[] | undefined;
  onSetFilter: (pill: FilterPill) => void;
  onRemoveFilter: (field: string) => void;
  onClearAll: () => void;
  labels?: FilterLabels;
};

/** The chip's segments: quiet, one hairline group on the page's ground. */
const seg = "border-border bg-background text-foreground";
const segHover = "hover:bg-accent";
/** The axis name, a label rather than a control, the height of the chip's buttons (28px). */
const segLabel = "inline-flex h-7 items-center whitespace-nowrap rounded-l-md border px-2 text-muted-foreground";

/**
 * The chips' layout: under 640px (or always, `stacked`) each chip is a line of its own whose value
 * takes the slack, as enably stacks them on a narrow rail; wider, the chips wrap in a row.
 */
function layout(stacked: boolean) {
  const pick = (narrow: string, wide: string) => (stacked ? narrow : cn(narrow, wide));
  return {
    row: pick("flex-col items-stretch gap-1", "sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5"),
    chip: pick("flex w-full min-w-0", "sm:inline-flex sm:w-auto sm:max-w-full sm:flex-none"),
    value: pick("flex-1 justify-start", "sm:flex-none sm:justify-center"),
    text: pick("truncate", "sm:max-w-56"),
    // On a phone Reset is the Filters menu's alone, as in enably, so the chips keep the lines.
    reset: stacked ? "self-end" : "hidden sm:ml-auto sm:inline-flex",
  };
}
type Layout = ReturnType<typeof layout>;

/** What both halves of the bar read from the props: the axes by key, which are set, which fold. */
function barOf(props: FilterBarProps) {
  const { fields, pills } = props;
  const pillFor = (key: string) => pills.find((p) => p.field === key);
  // The free-text axis (`q`): the menu's Search field and the Search chip, never a checklist.
  const text = fields.find((f) => f.type === "text");
  const known = new Set(fields.map((f) => f.key));
  return {
    labels: props.labels ?? filterLabels,
    pillFor,
    text,
    textValue: text ? (pillFor(text.key)?.values[0] ?? "") : "",
    setText: (value: string) => {
      if (!text) return;
      if (value === "") props.onRemoveFilter(text.key);
      else props.onSetFilter({ field: text.key, op: defaultOp(text), values: [value] });
    },
    set: fields.filter((f) => f.type !== "text" && pillFor(f.key)),
    folded: fields.filter((f) => f.type !== "text" && !pillFor(f.key)),
    // A pill for an axis this page does not know (a hand-edited address) is ignored, not counted.
    activeCount: pills.filter((p) => known.has(p.field)).length,
  };
}

/** The count of Filters set beside Filter, wherever its button is (in the bar, or folded on a phone); none with none set. */
export function FilterCount(props: FilterBarProps) {
  const n = barOf(props).activeCount;
  return n > 0 && <Count n={n} />;
}

function Count({ n }: { n: number }) {
  return (
    <span aria-hidden className="-mr-0.5 inline-grid h-4 min-w-4 place-items-center rounded-[4px] bg-muted px-1 text-2xs font-medium tabular-nums text-foreground">
      {n}
    </span>
  );
}

/** One value's words: its option's label, or the value itself when nothing names it. */
function labelOf(options: readonly FilterOption[] | undefined, value: string): string {
  return options?.find((o) => o.value === value)?.label ?? value;
}

/**
 * The header's Filter button and its menu (enably's CompactAxisMenu, without the hover flyout):
 * the Search field first, then every unset axis; choosing one drills into its operator and values.
 * Open is the caller's to hold when a key (F) opens it.
 */
export function FilterMenuButton({
  open: openProp,
  onOpenChange,
  fold,
  ...props
}: FilterBarProps & { open?: boolean; onOpenChange?: (open: boolean) => void; fold?: Fold }) {
  const { own: foldOwn, hide: foldHide, anchor: foldAnchor, onCloseAutoFocus: foldClose } = useFolded(fold);
  const bar = barOf(props);
  const { labels } = bar;
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [page, setPage] = useState<FilterField | null>(null);
  // The highlighted axis. The Search field keeps the focus, so the arrows move it from here; an
  // arrow must be pressed before Enter drills, so Enter in Search never opens an axis by surprise.
  const [active, setActive] = useState("");
  const [armed, setArmed] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
    // Reopen on the list, never on the last page visited.
    if (!next) {
      setPage(null);
      setArmed(false);
      setActive("");
    }
  };
  const close = () => setOpen(false);

  // Drilling in swaps the content of an open popover, which Radix does not focus again: put the
  // caret in the axis' own search, skipping Back and the operator.
  useEffect(() => {
    if (!page) return;
    panel.current?.querySelector<HTMLElement>("input, button:not([data-panel-back]):not([data-op-trigger])")?.focus();
  }, [page]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    // cmdk handles its own keys when its input has the focus (more than eight axes).
    if (page || e.defaultPrevented) return;
    if (e.key === "Enter") {
      const field = armed ? bar.folded.find((f) => f.key === active) : undefined;
      if (!field) return;
      e.preventDefault();
      setPage(field);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('[cmdk-item=""]:not([aria-disabled="true"])') ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    setArmed(true);
    const step = e.key === "ArrowDown" ? 1 : -1;
    // cmdk highlights the first row on its own; until an arrow moves, that is nobody's choice.
    const at = armed ? rows.findIndex((n) => n.getAttribute("data-value") === active) : -1;
    const to = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(Math.max(at + step, 0), rows.length - 1);
    setActive(rows[to].getAttribute("data-value") ?? "");
    rows[to].scrollIntoView({ block: "nearest" });
  };

  const count = bar.activeCount;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {foldAnchor}
      <PopoverTrigger asChild>
        <Button
          ref={foldOwn}
          variant="outline"
          aria-label={count > 0 ? `${labels.filter}, ${count} set` : labels.filter}
          className={cn("data-[state=open]:bg-accent", foldHide)}
        >
          <FilterIcon />
          <span className="hidden sm:inline">{labels.filter}</span>
          {count > 0 && <Count n={count} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={panel}
        align="end"
        aria-label={labels.filters}
        onKeyDown={onListKeyDown}
        onCloseAutoFocus={foldClose}
        className={cn("flex w-72 flex-col overflow-hidden p-0", page?.type === "date" && "w-auto")}
      >
        {page ? (
          <>
            <div className="flex items-center gap-1 border-b p-1">
              <Button variant="ghost" size="sm" data-panel-back className="font-normal text-muted-foreground" onClick={() => setPage(null)}>
                <ArrowLeftIcon />
                {labels.filters}
              </Button>
              <span className="truncate font-medium">{page.label}</span>
            </div>
            <AxisEditor
              field={page}
              pill={bar.pillFor(page.key)}
              options={props.optionsFor(page.key)}
              labels={labels}
              onCommit={(op, values, keepOpen) => {
                props.onSetFilter({ field: page.key, op, values });
                if (!keepOpen) close();
              }}
              onClear={(keepOpen) => {
                props.onRemoveFilter(page.key);
                if (!keepOpen) close();
              }}
              onDone={close}
            />
          </>
        ) : (
          <>
            {bar.text && <SearchField labels={labels} value={bar.textValue} onChange={bar.setText} />}
            <Command
              ref={list}
              value={active}
              onValueChange={setActive}
              className="min-h-0"
              // Score the axis' label, not its key: cmdk adds the value to the keywords.
              filter={(_value, search, keywords) => ((keywords ?? []).join(" ").toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
            >
              {/* Under nine axes the list is the index; past that, typing beats scanning. A page
                  with Search leads with that field instead: one field in the menu, not two. */}
              {!bar.text && bar.folded.length > 8 && <CommandInput placeholder={labels.searchFields} />}
              <CommandList className="max-h-[min(60vh,420px)]">
                <CommandEmpty>{labels.noneFound}</CommandEmpty>
                <CommandGroup>
                  {bar.folded.map((f) => (
                    <CommandItem key={f.key} value={f.key} keywords={[f.label]} onSelect={() => setPage(f)} className="h-[30px]">
                      {f.icon}
                      <span className="flex-1">{f.label}</span>
                      <ChevronRightIcon />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
            {count > 0 && (
              <div className="border-t p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start font-normal text-muted-foreground"
                  onClick={() => {
                    props.onClearAll();
                    close();
                  }}
                >
                  <XIcon />
                  {labels.reset}
                </Button>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The Filters menu's Search field: it writes the `q` axis as it is typed. */
function SearchField({ labels, value, onChange }: { labels: FilterLabels; value: string; onChange: (value: string) => void }) {
  // Its own state: the address updates in a transition, which a controlled field would lag behind.
  const [text, setText] = useState(value);
  return (
    <div className="flex h-9 items-center gap-2 border-b px-3">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="search"
        aria-label={labels.searchAxis}
        placeholder={labels.searchPlaceholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        className="h-full w-full bg-transparent outline-hidden placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/**
 * The row under the header while anything is set: a chip per set axis (and the Search chip), with
 * Reset at its right; `leading` heads it (the applied View) and keeps it up with no pill set.
 * Nothing renders while nothing is set. On a phone, or `stacked`, each chip takes a line of its
 * own instead of wrapping.
 */
export function FilterChipRow({ stacked = false, leading, ...props }: FilterBarProps & { stacked?: boolean; leading?: ReactNode }) {
  const bar = barOf(props);
  const { labels } = bar;
  const lay = layout(stacked);
  if (bar.activeCount === 0 && !leading) return null;
  return (
    <div role="toolbar" aria-label={labels.filters} data-testid="filter-chips" className={cn("flex flex-none border-b px-4 py-1.5", lay.row)}>
      {leading}
      {bar.text && bar.textValue && <SearchChip labels={labels} value={bar.textValue} onChange={bar.setText} lay={lay} />}
      {bar.set.map((field) => (
        <FieldChip
          key={field.key}
          field={field}
          pill={bar.pillFor(field.key)!}
          options={props.optionsFor(field.key)}
          labels={labels}
          lay={lay}
          onSetFilter={props.onSetFilter}
          onRemoveFilter={props.onRemoveFilter}
        />
      ))}
      <Button variant="ghost" size="sm" className={cn("flex-none font-normal text-muted-foreground", lay.reset)} onClick={props.onClearAll}>
        <XIcon />
        {labels.reset}
      </Button>
    </div>
  );
}

/** The chip's last segment, which takes the axis off the row. */
function ClearSegment({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Button variant="outline" size="icon-sm" aria-label={`Clear ${label}`} onClick={onClear} className={cn("-ml-px rounded-l-none text-muted-foreground shadow-none", seg, segHover)}>
      <XIcon className="size-3" />
    </Button>
  );
}

/** One set axis on the row: axis · operator ▾ · value · ×. The value opens the same editor the menu does. */
function FieldChip({
  field,
  pill,
  options,
  labels,
  lay,
  onSetFilter,
  onRemoveFilter,
}: {
  field: FilterField;
  pill: FilterPill;
  options: readonly FilterOption[] | undefined;
  labels: FilterLabels;
  lay: Layout;
  onSetFilter: (pill: FilterPill) => void;
  onRemoveFilter: (field: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const [first, ...rest] = pill.values;
  // One value is named with its glyph or avatar; several read "first +N"; a date reads its days.
  const lone = rest.length === 0 ? options?.find((o) => o.value === first) : undefined;
  const shown =
    field.type === "date"
      ? dateText(pill.op, pill.values, now)
      : rest.length > 0
        ? `${labelOf(options, first)} ${labels.more(rest.length)}`
        : labelOf(options, first);
  const rows = operatorRows(field, pill.op);
  return (
    <div className={lay.chip}>
      <span className={cn(segLabel, seg)}>{field.label}</span>
      {rows.length > 1 && (
        <OperatorSegment
          field={field}
          pill={pill}
          activeOp={pill.op}
          labels={labels}
          // Same values (a date, the same days), another operator: flipping never loses the pick.
          onChoose={(op) => onSetFilter({ field: field.key, op, values: revalue(field, op, pill.values) })}
        />
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={`${field.label}: ${shown}`}
            title={shown}
            className={cn("-ml-px min-w-0 gap-1.5 rounded-none font-normal shadow-none", seg, segHover, lay.value)}
          >
            {lone?.icon && <span aria-hidden className="inline-flex flex-none">{lone.icon}</span>}
            <span className={lay.text}>{shown}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn("flex w-72 flex-col overflow-hidden p-0", field.type === "date" && "w-auto")}>
          <AxisEditor
            field={field}
            pill={pill}
            options={options}
            labels={labels}
            // The chip carries the operator right beside it.
            showOperator={false}
            onCommit={(op, values, keepOpen) => {
              onSetFilter({ field: field.key, op, values });
              if (!keepOpen) setOpen(false);
            }}
            onClear={(keepOpen) => {
              onRemoveFilter(field.key);
              if (!keepOpen) setOpen(false);
            }}
            onDone={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <ClearSegment label={field.label} onClear={() => onRemoveFilter(field.key)} />
    </div>
  );
}

/** A live search as a chip: Search · its words · ×. The words open a field to change them. */
function SearchChip({ labels, value, onChange, lay }: { labels: FilterLabels; value: string; onChange: (value: string) => void; lay: Layout }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={lay.chip}>
      <span className={cn(segLabel, seg)}>{labels.searchAxis}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={`${labels.searchAxis}: ${value}`}
            className={cn("-ml-px min-w-0 rounded-none font-normal shadow-none", seg, segHover, lay.value)}
          >
            <span className={lay.text}>{value}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1.5">
          <SearchInput labels={labels} value={value} onChange={onChange} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <ClearSegment label={labels.searchAxis} onClear={() => onChange("")} />
    </div>
  );
}

function SearchInput({ labels, value, onChange, onDone }: { labels: FilterLabels; value: string; onChange: (value: string) => void; onDone: () => void }) {
  const [text, setText] = useState(value);
  return (
    <Input
      type="search"
      autoFocus
      aria-label={labels.searchAxis}
      placeholder={labels.searchPlaceholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone();
      }}
      className="h-7"
    />
  );
}

/**
 * The operator picker: a row per operator the axis offers, the one in force ticked. A row the
 * values cannot take (is, with several picked) is disabled and says why, rather than meaning
 * something else. `panel` is the skin at the head of an axis' page in the menu.
 */
function OperatorSegment({
  field,
  pill,
  activeOp,
  labels,
  variant = "chip",
  onChoose,
}: {
  field: FilterField;
  pill: FilterPill | undefined;
  activeOp: string;
  labels: FilterLabels;
  variant?: "chip" | "panel";
  onChoose: (op: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = operatorRows(field, pill?.op);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-op-trigger
          aria-label={`${field.label} — ${labels.op(activeOp)}`}
          className={cn(
            "gap-0.5 px-1.5 font-normal text-muted-foreground shadow-none",
            variant === "chip" ? cn("-ml-px rounded-none", seg, segHover) : "w-full justify-between border-none bg-transparent",
          )}
        >
          <span>{labels.op(activeOp)}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        {/* Held to the operator in force, so the listbox's selected row is the chosen one. */}
        <Command value={activeOp}>
          <CommandList>
            <CommandGroup>
              {rows.map((op) => {
                const reason = opDisabledReason(op, pill, field);
                return (
                  <CommandItem
                    key={op}
                    value={op}
                    disabled={reason !== undefined}
                    data-checked={op === activeOp ? true : undefined}
                    title={reason ? labels.opDisabled(reason) : undefined}
                    onSelect={() => {
                      setOpen(false);
                      if (op !== activeOp) onChoose(op);
                    }}
                  >
                    <span className="flex-1">{labels.op(op)}</span>
                    {reason && (
                      <span aria-hidden className="text-xs text-muted-foreground">
                        {labels.opDisabled(reason)}
                      </span>
                    )}
                    {op === activeOp && <CheckIcon />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type EditorProps = {
  field: FilterField;
  pill: FilterPill | undefined;
  options: readonly FilterOption[] | undefined;
  labels: FilterLabels;
  /** `keepOpen` leaves the editor up: a tick in a multi-pick is not the last. */
  onCommit: (op: string, values: string[], keepOpen?: boolean) => void;
  onClear: (keepOpen?: boolean) => void;
  onDone: () => void;
  /** False on the chip's own editor, which has the operator segment beside it. */
  showOperator?: boolean;
};

/**
 * The editor an axis' type implies, with no trigger of its own, so the chip and the menu's page
 * show the same thing. It holds the operator of an unset axis, so "is not X" is one gesture: the
 * sign is chosen first and the first value lands already negated, with one write.
 */
function AxisEditor(props: EditorProps) {
  const { field, pill, labels, showOperator = true } = props;
  const [pendingOp, setPendingOp] = useState<string>();
  const activeOp = pill?.op ?? pendingOp ?? defaultOp(field);
  const rows = operatorRows(field, pill?.op);
  const operator = showOperator && rows.length > 1 && (
    <div className="border-b p-1">
      <OperatorSegment
        field={field}
        pill={pill}
        activeOp={activeOp}
        labels={labels}
        variant="panel"
        onChoose={(op) => {
          setPendingOp(op);
          // A set axis is amended in place; an unset one has nothing to write yet.
          if (pill) props.onCommit(op, revalue(field, op, pill.values), true);
        }}
      />
    </div>
  );
  return (
    <>
      {operator}
      {field.type === "date" ? <DateEditor {...props} activeOp={activeOp} /> : <ChoiceEditor {...props} activeOp={activeOp} />}
    </>
  );
}

/**
 * A date axis: All and the windows (Last 7, 30 and 90 days) beside a calendar drawn for the
 * operator in force: a span for "is between", where one click is one day and a second makes the
 * span, or one day for the open ends. A window or a day finishes the pick; a span waits for its
 * second click.
 */
function DateEditor({ field, pill, labels, activeOp, onCommit, onClear }: EditorProps & { activeOp: string }) {
  const preset = pill?.op === "last" ? pill.values[0] : undefined;
  const days = pill && !preset ? pillDays(pill.values) : [];
  const presets = pickOp(field, "last") ? datePresets : [];
  return (
    <div className="flex flex-col sm:flex-row">
      <div className="flex flex-none gap-1 overflow-x-auto border-b p-1.5 sm:flex-col sm:border-r sm:border-b-0">
        <Button variant="ghost" size="sm" className="justify-start font-normal" onClick={() => onClear()}>
          {labels.all}
        </Button>
        {presets.map((token) => (
          <Button
            key={token}
            variant={preset === token ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={preset === token}
            className="justify-start font-normal"
            onClick={() => onCommit("last", [token])}
          >
            {presetText(token)}
          </Button>
        ))}
      </div>
      {dateMode(activeOp) === "range" ? (
        <Calendar
          mode="range"
          selected={days.length > 0 ? { from: days[0], to: days[days.length - 1] } : undefined}
          defaultMonth={days[0]}
          onSelect={(range) => {
            if (!range?.from) onClear(true);
            else onCommit("btw", dateBounds("btw", [range.from, range.to ?? range.from]), true);
          }}
        />
      ) : (
        <Calendar
          mode="single"
          selected={days[0]}
          defaultMonth={days[0]}
          onSelect={(day) => (day ? onCommit(activeOp, dateBounds(activeOp, [day])) : onClear())}
        />
      )}
    </div>
  );
}

/** A tick box drawn in the row, which is the control; a real checkbox would take the click. */
function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-3.5 flex-none place-items-center rounded-[4px] border border-input",
        on && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {on && <CheckIcon className="size-2.5 text-primary-foreground" strokeWidth={3} />}
    </span>
  );
}

/**
 * The checklist of an enum, ref or boolean axis: All first (it clears the axis), then the values,
 * grouped when they carry a group. Where the axis takes the plural of the sign in force, a tick
 * adds a value and the editor stays open; else a pick replaces the value and closes. Unticking the
 * last value clears the axis rather than writing an empty one.
 */
function ChoiceEditor({ field, pill, options, labels, onCommit, onClear, activeOp }: EditorProps & { activeOp: string }) {
  const selected = pill?.values ?? [];
  const multi = multiPick(field, activeOp);
  const all = options ?? [];
  // A value from the address that no option names (a Member since removed) is still a row, so it
  // can be unticked.
  const unlisted: FilterOption[] = selected.filter((v) => !all.some((o) => o.value === v)).map((v) => ({ value: v, label: v }));

  const toggle = (value: string) => {
    if (!multi) {
      onCommit(commitOp(field, activeOp, 1), [value]);
      return;
    }
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    if (next.length === 0) onClear(true);
    else onCommit(commitOp(field, activeOp, next.length), next, true);
  };

  const groups: { key?: string; heading?: string; options: FilterOption[] }[] = [];
  for (const o of all) {
    const last = groups[groups.length - 1];
    if (last && last.key === o.group) last.options.push(o);
    else groups.push({ key: o.group, heading: o.groupLabel, options: [o] });
  }

  const row = (o: FilterOption, forceMount?: true) => {
    const on = selected.includes(o.value);
    return (
      <CommandItem
        key={o.value}
        forceMount={forceMount}
        // The id rides along so two values with the same label stay two rows.
        value={[o.label, o.sublabel, o.value].filter(Boolean).join(" ")}
        onSelect={() => toggle(o.value)}
        className="h-[30px]"
      >
        {multi ? <Tick on={on} /> : null}
        {o.icon && (
          <span aria-hidden className="inline-flex flex-none">
            {o.icon}
          </span>
        )}
        <span className="truncate" title={o.label}>
          {o.label}
        </span>
        {o.sublabel && <span className="flex-none text-muted-foreground">{o.sublabel}</span>}
        {o.hint && <span className="ml-auto flex-none text-xs text-muted-foreground">{o.hint}</span>}
        {!multi && on && <CheckIcon className={cn(!o.hint && "ml-auto")} />}
      </CommandItem>
    );
  };

  return (
    <Command className="min-h-0">
      <CommandInput placeholder={labels.searchValues} />
      <CommandList className="max-h-[min(60vh,360px)]">
        <CommandEmpty>{labels.noneFound}</CommandEmpty>
        {/* All and the unlisted values cannot be typed out of reach. */}
        <CommandGroup forceMount>
          <CommandItem forceMount value={labels.all} onSelect={() => onClear()} className="h-[30px]">
            {labels.all}
          </CommandItem>
          {unlisted.map((o) => row(o, true))}
        </CommandGroup>
        {groups.map((g, i) => (
          <Fragment key={g.key ?? i}>
            {i > 0 && <CommandSeparator />}
            <CommandGroup heading={g.heading}>{g.options.map((o) => row(o))}</CommandGroup>
          </Fragment>
        ))}
      </CommandList>
    </Command>
  );
}

