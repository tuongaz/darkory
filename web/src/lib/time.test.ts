import { describe, expect, it } from "vitest";
import { ageText, agoText, durationText, lastedText, spanText, untilText } from "./time";

const s = 1000;
const m = 60 * s;
const h = 60 * m;

describe("durationText", () => {
  it("writes every duration one way: seconds, minutes, hours with their minutes under ten, then hours, then days", () => {
    expect([40 * s, 12 * m, 62 * m, 89 * m, 10 * h, 18 * h, 47 * h, 50 * h].map((ms) => durationText(ms))).toEqual(["40s", "12m", "1h 2m", "1h 29m", "10h", "18h", "47h", "2d"]);
  });

  it("rounds each part the way it is asked", () => {
    expect(durationText(89 * s)).toBe("1m");
    expect(durationText(89 * s, "nearest")).toBe("1m");
    expect(durationText(91 * s, "nearest")).toBe("2m");
    expect(durationText(61 * s, "up")).toBe("2m");
  });
});

describe("the duration's readings", () => {
  it("until: rounds up, so a holding Claim never reads 0", () => {
    expect([500, 61 * s, 15 * m, 3 * h].map(untilText)).toEqual(["1s", "2m", "15m", "3h"]);
  });

  it("lasted and span: at least a second, never 0s", () => {
    expect(lastedText(0)).toBe("1s");
    expect(spanText(0)).toBe("1s");
    expect(spanText(300)).toBe("1s");
    expect([40 * s, 12 * m, 3 * h, 50 * h].map(spanText)).toEqual(["40s", "12m", "3h", "2d"]);
  });

  it("age: now under a minute, as the cards say it", () => {
    expect([0.5 * m, 36 * m, 62 * m, 600 * m].map(ageText)).toEqual(["now", "36m", "1h 2m", "10h"]);
  });

  it("ago: the duration and ago, short enough for a narrow column", () => {
    expect([-200, 40 * s, 3 * m, 5 * h, 72 * h].map(agoText)).toEqual(["0s ago", "40s ago", "3m ago", "5h ago", "3d ago"]);
  });
});
