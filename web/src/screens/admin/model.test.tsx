import { describe, expect, it } from "vitest";
import type { Claim, Token } from "@/api/client";
import { ada, bob, builder, task } from "@/test/fixtures";
import { boundToSession, deactivateSummary, groupByKind, heldClaims, lineDiff, revokeSummary, suggestKey, type Session } from "./model";

const at = "2026-10-01T09:00:00Z";
const token = (id: string, extra: Partial<Token> = {}): Token => ({ id, member_id: builder.id, name: id, prefix: "dk_abc", created_at: at, ...extra });
const session = (id: string, token_id?: string): Session => ({ id, member_id: builder.id, kind: token_id ? "token" : "browser", token_id, started_at: at, last_seen_at: at });
const claim = (session_id: string, timeout?: number): Claim => ({
  id: `c-${session_id}`,
  task_id: "k",
  holder_id: builder.id,
  session_id,
  started_at: at,
  heartbeat_timeout_seconds: timeout,
});

describe("groupByKind", () => {
  it("puts humans in one group and agents in the other, keeping the order given", () => {
    const zed = { ...bob, id: "m-zed", name: "zed" };
    const { humans, agents } = groupByKind([ada, builder, bob, zed]);
    expect(humans.map((m) => m.name)).toEqual(["ada", "bob", "zed"]);
    expect(agents.map((m) => m.name)).toEqual(["builder"]);
  });
});

describe("what deactivating a Member stops", () => {
  const tokens = [token("live"), token("old", { revoked_at: at })];
  const sessions = [session("sess-1", "live"), session("browser-1")];
  const held = heldClaims([
    task(3, "f-1", { claim: claim("sess-1", 900) }),
    task(4, "f-1", { claim: claim("browser-1") }),
    task(5, "f-1", { claim: { ...claim("sess-1", 900), ended_at: at } }),
  ]);

  it("counts the live tokens, every open Session and every Claim held, however bound", () => {
    const s = deactivateSummary(tokens, sessions, held);
    expect(s.tokens.map((t) => t.name)).toEqual(["live"]);
    expect(s.sessions.map((x) => x.id)).toEqual(["sess-1", "browser-1"]);
    expect(s.claims.map((h) => h.task.key)).toEqual(["WEB-3", "WEB-4"]);
  });

  it("revoking one token closes its Sessions and ends only the Claims bound to them", () => {
    const s = revokeSummary(tokens[0], sessions, held);
    expect(s.sessions.map((x) => x.id)).toEqual(["sess-1"]);
    expect(s.claims.map((h) => h.task.key)).toEqual(["WEB-3"]);
  });

  it("a Claim made without a Heartbeat timeout is bound to the Member, not the Session", () => {
    expect(boundToSession(held, "browser-1")).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("marks the lines a proposal adds and removes", () => {
    const before = "1. Reuse the cart component.\n2. Ship behind a flag.\n";
    const after = "1. Reuse the cart component.\n2. Ship behind a flag.\n3. Point e2e at Mailpit.\n";
    expect(lineDiff(before, after)).toEqual([
      { op: "same", text: "1. Reuse the cart component." },
      { op: "same", text: "2. Ship behind a flag." },
      { op: "add", text: "3. Point e2e at Mailpit." },
    ]);
    expect(lineDiff("a\nb\nc", "a\nc").map((l) => l.op)).toEqual(["same", "del", "same"]);
  });
});

describe("suggestKey", () => {
  it("offers the name's first capitals, when there are at least two", () => {
    expect(suggestKey("Mobile apps")).toBe("MOB");
    expect(suggestKey("Platform")).toBe("PLA");
    expect(suggestKey("Q")).toBe("");
    expect(suggestKey("42 ops")).toBe("OPS");
  });
});
