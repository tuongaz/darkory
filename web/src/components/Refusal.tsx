import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/api/client";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A refusal or failure from /v1: the API's stable code beside its message. */
export function Refusal({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : "network";
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className={cn("flex items-baseline gap-2 text-xs text-state-blocked", className)}>
      <code className="rounded-sm bg-state-blocked-bg px-1">{code}</code> <span>{message}</span>
    </p>
  );
}

/** Renders a query's data, or a skeleton while it loads, or its refusal. */
export function Loaded<T>({
  query,
  children,
  loading,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (query.isPending) return <>{loading ?? <Skeleton className="h-8 w-full" />}</>;
  if (query.isError) return <Refusal error={query.error} />;
  return <>{children(query.data)}</>;
}
