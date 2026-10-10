import { describe, expect, it } from "vitest";
import { SOFTWARE } from "./fixtures";
import { lineTopology, tracks } from "./layout";

/* The software Workflow (14 Steps): the biggest shape the line is proved on, in station order. */

describe("the software Workflow (14 Steps)", () => {
  const t = lineTopology(SOFTWARE);

  it("runs Triage to Release on the line; Plan breaks down, Backlog parks, Acceptance, Retro and Skill review come after a Parent", () => {
    expect(t.main).toEqual(["triage", "design", "threat-model", "design-review", "build", "code-review", "security-review", "qa", "release", "done"]);
    expect(t.before).toBe("plan");
    expect(t.holds).toEqual(["backlog"]);
    expect(t.rows.map((r) => r.stations)).toEqual([["acceptance"], ["retro", "skill-review"]]);
  });

  it("says nothing moves from Triage to Design or from Design review to Build: their outcomes lead elsewhere", () => {
    expect(t.segments.filter((s) => !s.connector).map((s) => [s.from, s.hand])).toEqual([
      ["triage", false],
      ["design-review", false],
    ]);
  });

  it("brings the two needs changes, fail and not ready back into Build on one track, the skip past Design on it too", () => {
    const build = tracks(t).find((k) => k.target === "build")!;
    expect(build.connectors.map((c) => c.name).sort()).toEqual(["fail", "needs changes", "needs changes", "no design needed", "not ready"]);
  });
});
