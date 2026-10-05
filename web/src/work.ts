import type { Claim, Task } from "./api/client";

/** The Task's Claim while it holds at `now` (Unix ms): not ended and not past its expiry. */
export function liveClaim(task: Task, now: number): Claim | undefined {
  const c = task.claim;
  if (!c || c.ended_at || task.state !== "open") return undefined;
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return undefined;
  return c;
}

export function boundTo(claim: Claim): string {
  return claim.heartbeat_timeout_seconds ? "Session-bound" : "Member-bound";
}
