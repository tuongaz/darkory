import { Link, type To } from "react-router";
import { cn } from "@/lib/utils";

const keyClass = "font-mono text-[11.5px] whitespace-nowrap text-muted-foreground";

/** A display key such as WEB-3, in mono. With `to`, it is a link. */
export function Key({ children, to, className }: { children: string; to?: To; className?: string }) {
  if (to) {
    return (
      <Link to={to} className={cn(keyClass, "hover:text-foreground hover:underline", className)}>
        {children}
      </Link>
    );
  }
  return <span className={cn(keyClass, className)}>{children}</span>;
}
