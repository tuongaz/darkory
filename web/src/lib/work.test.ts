import { describe, expect, it } from "vitest";
import { glyphFor, glyphLabel, workingOf } from "./work";

const counts = { open: 2, working: 1, done: 2, dropped: 1 };

describe("glyphFor", () => {
  it("draws an open Task nobody holds as waiting", () => {
    expect(glyphFor({ state: "open" })).toEqual({ glyph: "waiting" });
  });

  it("draws an ended Task as how it ended, a Parent too", () => {
    expect(glyphFor({ state: "done", held: true, holderKind: "agent" })).toEqual({ glyph: "done" });
    expect(glyphFor({ state: "dropped", blocked: true })).toEqual({ glyph: "dropped" });
    expect(glyphFor({ state: "done", counts })).toEqual({ glyph: "done" });
  });

  it("draws an open Parent as its Subtasks' progress, out of all of them", () => {
    expect(glyphFor({ state: "open", counts })).toEqual({ glyph: "parent", done: 2, dropped: 1, total: 5 });
    // A Parent is at no step and is neither held nor blocked: its counts win over anything passed.
    expect(glyphFor({ state: "open", counts, held: true, blocked: true, atHold: true }).glyph).toBe("parent");
  });

  it("draws a held Task as working, in the holder's kind and its session's state", () => {
    expect(glyphFor({ state: "open", held: true, holderKind: "agent", session: "stalled" })).toEqual({
      glyph: "working",
      holderKind: "agent",
      session: "stalled",
    });
    expect(glyphFor({ state: "open", held: true, holderKind: "agent" })).toEqual({ glyph: "working", holderKind: "agent" });
    // A human runs no session: whatever is passed, their ring is still.
    expect(glyphFor({ state: "open", held: true, holderKind: "human", session: "running" })).toEqual({ glyph: "working", holderKind: "human" });
  });

  it("puts held before blocked, and blocked before a hold", () => {
    // An agent that escalated still holds the Task its question blocks.
    expect(glyphFor({ state: "open", held: true, holderKind: "agent", blocked: true }).glyph).toBe("working");
    expect(glyphFor({ state: "open", blocked: true, atHold: true })).toEqual({ glyph: "blocked" });
    expect(glyphFor({ state: "open", atHold: true })).toEqual({ glyph: "hold" });
  });
});

describe("workingOf", () => {
  it("turns an agent's ring unless its session says otherwise; a human's is held", () => {
    expect(workingOf("agent")).toBe("running");
    expect(workingOf("agent", "waiting")).toBe("waiting");
    expect(workingOf("human", "running")).toBe("held");
  });
});

describe("glyphLabel", () => {
  it("says each glyph in words", () => {
    expect(glyphLabel({ glyph: "working", holderKind: "agent", session: "stalled" })).toBe("Working, its Shift stalled");
    expect(glyphLabel({ glyph: "working", holderKind: "human" })).toBe("Working");
    expect(glyphLabel({ glyph: "hold" })).toBe("At a hold");
    expect(glyphLabel({ glyph: "parent", done: 3, dropped: 0, total: 5 })).toBe("3 of 5 Subtasks done");
    expect(glyphLabel({ glyph: "parent", done: 2, dropped: 1, total: 5 })).toBe("2 of 5 Subtasks done, 1 dropped");
  });
});
