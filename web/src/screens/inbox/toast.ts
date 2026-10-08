import { toast } from "sonner";
import { ApiError } from "@/api/client";

/** What a refusal says in a toast: the API's message, and its code under it. */
export function refusalToast(err: unknown) {
  if (err instanceof ApiError) toast.error(err.message, { description: err.code });
  else toast.error(err instanceof Error ? err.message : String(err));
}
