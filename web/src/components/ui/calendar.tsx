import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker } from "react-day-picker"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * shadcn/ui's Calendar on react-day-picker v9, styled by class names alone (none of its own CSS,
 * which the Install's style-src would refuse to inject). Weeks start on Monday.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={1}
      className={cn("relative w-fit p-3", className)}
      classNames={{
        months: "flex flex-col gap-4 sm:flex-row",
        month: "flex flex-col gap-3",
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-3 top-3 z-10 flex items-center justify-between",
        button_previous: cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground"),
        button_next: cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground"),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-2xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "relative size-8 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-8 rounded-md p-0 font-normal aria-selected:opacity-100",
        ),
        range_start: "rounded-l-md bg-accent",
        // A middle day is selected too; the band, not the solid start and end, marks it.
        range_middle: "bg-accent [&>button]:rounded-none [&>button]:bg-transparent! [&>button]:text-foreground! [&>button:hover]:bg-transparent!",
        range_end: "rounded-r-md bg-accent",
        selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
        today: "[&>button]:font-semibold",
        outside: "text-muted-foreground/50 [&>button]:text-muted-foreground/50",
        disabled: "opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevron }) =>
          orientation === "left" ? <ChevronLeftIcon className={cn("size-4", chevron)} /> : <ChevronRightIcon className={cn("size-4", chevron)} />,
      }}
      {...props}
    />
  )
}

export { Calendar }
